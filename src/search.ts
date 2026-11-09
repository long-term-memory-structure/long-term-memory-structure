// ============================================================================
//  search.ts: exact search over a Claude Code transcript, on the parser's own reading of it.
//
//  Plain TypeScript with no dependencies and no Node imports, like parser.ts, so it runs unchanged in Node and in a
//  browser. Every string outside ASCII is built from code points, never typed: an editor or a tool can turn a typed
//  escape into the character it names.
//
//  ---- WHAT IS SEARCHED ---------------------------------------------------------
//  A turn's records are exactly the ones `ltms skeleton` shows for it: its prompt, its live-path records up to the
//  next prompt, and the call and result records of every tool call turnsOf() gives it, wherever they sit (a parallel
//  call's result is often off the path). A path record that is the call or the result of a call given to another turn
//  goes to that call's turn. Path records before the first prompt belong to T001; in a file with no input turn they
//  are counted as beforeFirstTurn. Each record's text is read by KIND:
//    input       the record that opens a turn (any channel), and a queued_command attachment whose commandMode is prompt
//    summary     a compaction summary
//    reply       assistant text (an isApiErrorMessage record's text is system)
//    thinking    thinking text
//    call        a tool_use input's string values, recursively (keys are not searched)
//    result      a tool_result block's text
//    system      every string value of a system record except the envelope keys, its subtype and its level
//    meta        other user text: isMeta records, command output, caveats            (off unless named)
//    attachment  the string values of the record's attachment object, never the envelope   (off unless named)
//  Not searched, and counted: rewound branches (offPath), toolUseResult, wireToolInputs, redacted thinking, side
//  records, images, spilled results (their preview is searched), replayed copies, records before the first turn,
//  unreadable lines, and records whose only text is of a kind left out. records parsed = searched + offPath +
//  replays + beforeFirstTurn + sidecars + kindsOff, in every file.
//
//  ---- THE TOKENS (one function for the query and the text) ---------------------
//  1. The raw text is split into runs of letters, marks, digits and format characters.
//  2. A run holding a letter of a spaceless script (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar) is split by
//     Intl.Segmenter (word), on its NFC text, before any mark is removed: ICU's dictionary needs the marks.
//  3. Each piece is normalized: NFKD, lower case, final sigma to sigma, U+200B a break, marks, the other format
//     characters and U+0640 removed, then NFC.
//  4. Each piece is split again into runs of letters and digits, and between two adjacent letters whose Script values
//     differ (Common and Inherited join either side).
//  Every token keeps the UTF-16 offset of its first character in the raw field. A field that holds JSON escapes is
//  also read with them decoded (escape by escape); a word matches when either form holds it, a phrase must sit
//  within one form. --substring reads each field normalized the same way, without steps 2 and 4, with every run of
//  anything else made one space, and finds each term as a substring of it.
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

import { inputChannel, isInputTurn, isToolResultRecord, parseTranscript, repairedLivePath, turnsOf } from './parser.js';
import type { FileKind, Transcript, TreeNode } from './parser.js';

// ---- 1. The vocabulary -------------------------------------------------------

/** A kind of text, as the README's table names them. */
export type SearchKind = 'input' | 'summary' | 'reply' | 'thinking' | 'call' | 'result' | 'system' | 'meta' | 'attachment';
/** Every kind, in the table's order: the order of one record's entries in a hit, and of `hits.byKind`. */
export const SEARCH_KINDS: readonly SearchKind[] = Object.freeze(['input', 'summary', 'reply', 'thinking', 'call', 'result', 'system', 'meta', 'attachment'] as const);
/** The kinds searched when none are named: every kind but meta and attachment, which hold the harness's own text. */
export const SEARCH_DEFAULT_KINDS: readonly SearchKind[] = Object.freeze(['input', 'summary', 'reply', 'thinking', 'call', 'result', 'system'] as const);
/** `words`: a term matches a field holding its tokens. `substring`: a term matches a field holding it as a substring. */
export type SearchMode = 'words' | 'substring';
/** `icu`: spaceless runs are split into dictionary words. `no-dictionary`: they stay whole. */
export type SearchSegmenter = 'icu' | 'no-dictionary';
/** The scripts with a known gap, and which gap: words with attached clitics, or no spaces between words. */
export const SEARCH_GAP_SCRIPTS: Readonly<Record<string, 'clitics' | 'spaceless'>> = Object.freeze({
  Hebrew: 'clitics', Arabic: 'clitics', Hangul: 'clitics',
  Han: 'spaceless', Hiragana: 'spaceless', Katakana: 'spaceless', Thai: 'spaceless', Lao: 'spaceless', Khmer: 'spaceless', Myanmar: 'spaceless',
});

/** A token, and the UTF-16 offset of its first character in the string it was read from. */
export interface SearchToken { token: string; at: number }

/** One term of a query, as parseSearchQuery read it. */
export interface SearchTerm {
  /** The term as typed, without the quotes of a phrase. */
  text: string;
  /** True when the term was written between quotes. */
  quoted: boolean;
  /** Words mode: the term's tokens. Substring mode: one string, the term normalized and trimmed. Never empty. */
  tokens: string[];
  /** True when the term is matched as a phrase: it was quoted, or it has several tokens (or, in substring mode, holds
   *  a space once normalized). */
  phrase: boolean;
  /** The scripts of SEARCH_GAP_SCRIPTS that the term holds letters of, in that list's order. */
  gapScripts: string[];
}

/** A parsed query: the terms kept, ANDed per turn, and what was dropped. */
export interface SearchQuery {
  /** The terms kept, in the order typed. A hit's `w` indexes this list. */
  terms: SearchTerm[];
  /** The terms that normalized to nothing, as typed, in the order typed. */
  dropped: string[];
  /** True when a phrase's opening quote has no closing one: the phrase ran to the end of the query. */
  unbalanced: boolean;
  mode: SearchMode;
  /** The segmenter the terms were read with; searchTranscript reads the text with the same. */
  segmenter: SearchSegmenter;
  /** The scripts of SEARCH_GAP_SCRIPTS that the kept terms hold letters of, in that list's order. */
  gapScripts: string[];
}

/** How parseSearchQuery reads a query. */
export interface SearchQueryOptions {
  /** Default `words`. */
  mode?: SearchMode;
  /** Default: what checkSearchSupport() found (`no-dictionary` when it found nothing usable). */
  segmenter?: SearchSegmenter;
}

/** How searchTranscript searches a file. */
export interface SearchOptions {
  /** The kinds searched. Default SEARCH_DEFAULT_KINDS. */
  kinds?: readonly SearchKind[];
  /** The address prefix of `a` and `ta` (the CLI's prefixOf(file)). Without one, addresses are `L<n>` and `T<nnn>`. */
  prefix?: string;
}

/** One record and kind, in a matching turn, holding at least one term. */
export interface SearchEntry {
  /** The record's address: `<prefix>:L<line>`, its 1-based line in the file. */
  a: string;
  kind: SearchKind;
  /** The key path, from the record, of the first field of this kind holding a term: key names and array indices. Keys
   *  are named down to a tool's parameter (the first level of its input), a system record's own keys and an attachment
   *  object's own keys, each one passing the label rule (else `(withheld)`); a key below them is data a tool or the
   *  model wrote, and is `(withheld)`. */
  field: (string | number)[];
  /** The UTF-16 offset, in that field's string as written, of its earliest match (a match in the escape-decoded form
   *  is given at the offset of the escape or character it came from). */
  at: number;
  /** The indices, into SearchQuery.terms, of the terms found in any field of this kind in this record, ascending. */
  w: number[];
}

/** A turn that holds every term. */
export interface SearchTurnHit {
  /** The turn's id, as skeleton numbers it: `<prefix>:T<nnn>`. */
  ta: string;
  /** The turn's channel, as skeleton prints it (the label rule applied). */
  ch: string;
  /** Its records and kinds holding a term: by line, then by kind in SEARCH_KINDS order. */
  entries: SearchEntry[];
}

/** What was not searched, in records unless named. */
export interface SearchNotSearched {
  /** Records on no turn: rewound branches, after the turn rule. */
  offPath: number;
  /** Turn records carrying a toolUseResult (its structured copy of the result is not searched). */
  toolUseResult: number;
  /** Turn records carrying wireToolInputs (the inputs as the model wrote them). */
  wireInputs: number;
  /** Redacted thinking blocks in turn records (blocks). */
  redactedThinking: number;
  /** Records with no envelope (no uuid): last-prompt, queue-operation, api-request and the like. */
  sidecars: number;
  /** Images in turn records (blocks, and image objects met inside a searched value). */
  images: number;
  /** Turn records holding a result whose text begins with <persisted-output> after leading whitespace: the output was
   *  written to a file, and only the preview in the transcript is searched. */
  spilled: number;
  /** Later copies of a record already written (the parser's replayedCopies). */
  replays: number;
  /** Path records of a file with no input turn. */
  beforeFirstTurn: number;
  /** Lines that are not a JSON object (or nested deeper than 1,000 levels) (lines). */
  unreadableLines: number;
  /** Turn records holding text, all of it of kinds not searched. */
  kindsOff: number;
}

/** The matching turns, counted. */
export interface SearchHitCounts {
  /** Turns holding every term. */
  turns: number;
  /** Records with an entry in those turns. */
  records: number;
  /** For each kind searched, the matching turns with an entry of that kind. */
  byKind: Partial<Record<SearchKind, number>>;
}

/** One file's counts. */
export interface SearchCounts {
  /** Records the parser read (lines that are JSON objects): searched + offPath + replays + beforeFirstTurn +
   *  sidecars + kindsOff. */
  parsed: number;
  /** Input turns: skeleton's turns. */
  turns: number;
  /** Turn records not counted in kindsOff (one holding no text at all is here: there was nothing in it to search). */
  searched: number;
  notSearched: SearchNotSearched;
  hits: SearchHitCounts;
  /** For each script in SearchQuery.gapScripts, its letters in the searched text, before normalization (a field that
   *  holds escapes is counted in its decoded form, which holds every letter of the written one). Empty otherwise. */
  gapScripts: Record<string, number>;
}

/** What one file contributes to a search. */
export interface SearchResult {
  /** The matching turns, in path order. */
  turns: SearchTurnHit[];
  counts: SearchCounts;
  /** The file's latest record timestamp (the parser's stats.lastTimestamp), or null: the string as the transcript
   *  holds it, unchecked (the CLI prints it only when it is an ISO 8601 time). */
  last: string | null;
  /** The parser's fileKind: transcript, journal, empty or unknown. */
  fileKind: FileKind;
}

/** Whether this runtime can run the search, and how it splits spaceless scripts. */
export interface SearchSupport {
  /** False when the search cannot run at all; `missing` then says why. */
  ok: boolean;
  /** `icu` when Intl.Segmenter splits a known Thai and a known Chinese string into their known words; else
   *  `no-dictionary`. Null when not ok. */
  segmenter: SearchSegmenter | null;
  /** What is missing: `Intl`, `unicode property escapes` or `String.prototype.normalize`. Null when ok. */
  missing: string | null;
}

// ---- 2. Constants, built from code points -------------------------------------

const cp = (...c: number[]): string => String.fromCodePoint(...c);
const BS = String.fromCharCode(92);
const FINAL_SIGMA = cp(0x3c2), SIGMA = cp(0x3c3), ZWSP = cp(0x200b), TATWEEL = cp(0x640);
const OPEN_CURLY = cp(0x201c), CLOSE_CURLY = cp(0x201d);
/** The Segmenter check: the Thai for "the Thai language" (4 + 3 code points) and the Chinese for "Peking University"
 *  (2 + 2), split so by ICU 78 on Node 20.20, 22.23 and 26.12. */
const THAI_CHECK = cp(0xe20, 0xe32, 0xe29, 0xe32, 0xe44, 0xe17, 0xe22);
const CHINESE_CHECK = cp(0x5317, 0x4eac, 0x5927, 0x5b66);
/** A JSON string escape written inside a string value: a short one (backslash and n t r b f " / or a backslash), or a
 *  backslash, u and four hex digits. */
const ESCAPE = new RegExp(BS + BS + '(?:([ntrbf"/' + BS + BS + '])|u([0-9A-Fa-f]{4}))', 'g');
const HAS_ESCAPE = new RegExp(ESCAPE.source);
const SHORT_ESCAPE: Record<string, string> = {
  n: String.fromCharCode(10), t: String.fromCharCode(9), r: String.fromCharCode(13), b: String.fromCharCode(8),
  f: String.fromCharCode(12), '"': '"', '/': '/', [BS]: BS,
};
const NON_ASCII = new RegExp('[^' + String.fromCharCode(0) + '-' + String.fromCharCode(127) + ']');
const ASCII_TOKEN = /[A-Za-z0-9]+/g;
/** The beginning of a result whose output was spilled to a file (its preview is what the transcript holds). */
const SPILLED = /^\s*<persisted-output>/;
/** The envelope keys (parser.ts's Envelope), never searched in a system record. */
const ENVELOPE = new Set(['uuid', 'parentUuid', 'sessionId', 'timestamp', 'version', 'cwd', 'gitBranch', 'userType', 'entrypoint', 'isSidechain', 'type']);
/** A system record's names from a fixed list (its kind, and how loud it is): not text, so never searched. */
const SYSTEM_NAMES = new Set(['subtype', 'level']);
/** cli.ts's label rule, applied to the two values a hit takes from the transcript: the channel, and each key of a
 *  field's path. A value that does not pass prints as (withheld). */
const LABEL = /^[\w.:+-]{1,64}$/;
const WITHHELD = '(withheld)';
const label = (v: unknown, fallback: string): string => (!v ? fallback : typeof v === 'string' && LABEL.test(v) ? v : WITHHELD);
const pad3 = (n: number): string => String(n).padStart(3, '0');
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The Unicode Script values (Unicode 17.0, as Perl's Unicode::UCD lists them) but Common, Inherited and Unknown, the
 *  most frequent first. Only whether two letters' values DIFFER is used: the rule names no script. */
const SCRIPT_NAMES = [
  'Latin', 'Hebrew', 'Arabic', 'Cyrillic', 'Greek', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Lao', 'Khmer',
  'Myanmar', 'Devanagari', 'Armenian', 'Georgian', 'Ethiopic', 'Bengali', 'Tamil', 'Syriac', 'Adlam', 'Ahom',
  'Anatolian_Hieroglyphs', 'Avestan', 'Balinese', 'Bamum', 'Bassa_Vah', 'Batak', 'Beria_Erfe', 'Bhaiksuki',
  'Bopomofo', 'Brahmi', 'Braille', 'Buginese', 'Buhid', 'Canadian_Aboriginal', 'Carian', 'Caucasian_Albanian',
  'Chakma', 'Cham', 'Cherokee', 'Chorasmian', 'Coptic', 'Cuneiform', 'Cypriot', 'Cypro_Minoan', 'Deseret',
  'Dives_Akuru', 'Dogra', 'Duployan', 'Egyptian_Hieroglyphs', 'Elbasan', 'Elymaic', 'Garay', 'Glagolitic', 'Gothic',
  'Grantha', 'Gujarati', 'Gunjala_Gondi', 'Gurmukhi', 'Gurung_Khema', 'Hanifi_Rohingya', 'Hanunoo', 'Hatran',
  'Imperial_Aramaic', 'Inscriptional_Pahlavi', 'Inscriptional_Parthian', 'Javanese', 'Kaithi', 'Kannada', 'Kawi',
  'Kayah_Li', 'Kharoshthi', 'Khitan_Small_Script', 'Khojki', 'Khudawadi', 'Kirat_Rai', 'Lepcha', 'Limbu', 'Linear_A',
  'Linear_B', 'Lisu', 'Lycian', 'Lydian', 'Mahajani', 'Makasar', 'Malayalam', 'Mandaic', 'Manichaean', 'Marchen',
  'Masaram_Gondi', 'Medefaidrin', 'Meetei_Mayek', 'Mende_Kikakui', 'Meroitic_Cursive', 'Meroitic_Hieroglyphs',
  'Miao', 'Modi', 'Mongolian', 'Mro', 'Multani', 'Nabataean', 'Nag_Mundari', 'Nandinagari', 'New_Tai_Lue', 'Newa',
  'Nko', 'Nushu', 'Nyiakeng_Puachue_Hmong', 'Ogham', 'Ol_Chiki', 'Ol_Onal', 'Old_Hungarian', 'Old_Italic',
  'Old_North_Arabian', 'Old_Permic', 'Old_Persian', 'Old_Sogdian', 'Old_South_Arabian', 'Old_Turkic', 'Old_Uyghur',
  'Oriya', 'Osage', 'Osmanya', 'Pahawh_Hmong', 'Palmyrene', 'Pau_Cin_Hau', 'Phags_Pa', 'Phoenician',
  'Psalter_Pahlavi', 'Rejang', 'Runic', 'Samaritan', 'Saurashtra', 'Sharada', 'Shavian', 'Siddham', 'Sidetic',
  'SignWriting', 'Sinhala', 'Sogdian', 'Sora_Sompeng', 'Soyombo', 'Sundanese', 'Sunuwar', 'Syloti_Nagri', 'Tagalog',
  'Tagbanwa', 'Tai_Le', 'Tai_Tham', 'Tai_Viet', 'Tai_Yo', 'Takri', 'Tangsa', 'Tangut', 'Telugu', 'Thaana', 'Tibetan',
  'Tifinagh', 'Tirhuta', 'Todhri', 'Tolong_Siki', 'Toto', 'Tulu_Tigalari', 'Ugaritic', 'Vai', 'Vithkuqi', 'Wancho',
  'Warang_Citi', 'Yezidi', 'Yi', 'Zanabazar_Square',
];
const SPACELESS_SCRIPTS = ['Han', 'Hiragana', 'Katakana', 'Thai', 'Lao', 'Khmer', 'Myanmar'];

// ---- 3. The runtime: regexes built on first use, the Segmenter check -----------
// A regex with \p{...} is compiled where it is first needed, never at load: on a runtime without Unicode property
// escapes a regex literal would stop this module, and with it every command of the CLI, from loading at all.

interface UnicodeRegexes {
  run: RegExp; ln: RegExp; letter: RegExp; mark: RegExp; strip: RegExp; stripOne: RegExp; spaceless: RegExp; joins: RegExp;
}
let unicode: UnicodeRegexes | null = null;
function rx(): UnicodeRegexes {
  if (unicode) return unicode;
  const stripClass = '[\\p{M}\\p{Cf}' + TATWEEL + ']';
  unicode = {
    run: new RegExp('[\\p{L}\\p{M}\\p{N}\\p{Cf}]+', 'gu'),
    ln: new RegExp('[\\p{L}\\p{N}]+', 'gu'),
    letter: new RegExp('^\\p{L}', 'u'),
    mark: new RegExp('^\\p{M}', 'u'),
    strip: new RegExp(stripClass, 'gu'),
    stripOne: new RegExp(stripClass, 'u'),
    spaceless: new RegExp('(?=\\p{L})[' + SPACELESS_SCRIPTS.map((s) => `\\p{Script=${s}}`).join('') + ']', 'u'),
    joins: new RegExp('^[\\p{Script=Common}\\p{Script=Inherited}]', 'u'),
  };
  return unicode;
}

let support: SearchSupport | null = null;
/** Whether this runtime can run the search (Unicode property escapes, Intl, String.prototype.normalize), and whether
 *  its Intl.Segmenter splits spaceless scripts into dictionary words: a known Thai and a known Chinese string, built
 *  from code points, must split into their known words for `icu`. Computed once. */
export function checkSearchSupport(): SearchSupport {
  if (support) return support;
  let missing: string | null = null;
  try { new RegExp('\\p{L}', 'u'); } catch { missing = 'unicode property escapes'; }
  if (!missing && typeof Intl !== 'object') missing = 'Intl';
  if (!missing) {
    try { if (cp(0xfb01).normalize('NFKD') !== 'fi') missing = 'String.prototype.normalize'; } catch { missing = 'String.prototype.normalize'; }
  }
  support = missing ? { ok: false, segmenter: null, missing } : { ok: true, segmenter: segmenterSplits() ? 'icu' : 'no-dictionary', missing: null };
  return support;
}
function segmenterSplits(): boolean {
  try {
    const S = (Intl as any).Segmenter;
    if (typeof S !== 'function') return false;
    const seg = new S(undefined, { granularity: 'word' });
    const lengths = (s: string): string => [...seg.segment(s)].map((x: any) => x.segment.length).join(',');
    return lengths(THAI_CHECK) === '4,3' && lengths(CHINESE_CHECK) === '2,2';
  } catch { return false; }
}

let wordSegmenter: Intl.Segmenter | null = null;
function segmenters(): { word: Intl.Segmenter } {
  if (typeof Intl !== 'object' || typeof (Intl as any).Segmenter !== 'function') throw new Error('Intl.Segmenter is not available on this runtime: read the text with segmenter no-dictionary');
  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  return { word: wordSegmenter };
}

// ---- 4. Scripts ------------------------------------------------------------------

/** A letter that joins either side: Common, Inherited, or a script this runtime does not name. */
const JOIN = -1;
let scriptRegexes: (RegExp | null)[] | null = null;
const scriptCache = new Map<number, number>();
const oneScriptCache = new Map<number, RegExp>();
/** The index in SCRIPT_NAMES of a LETTER's Script value, or JOIN. */
function scriptOf(c: number): number {
  if (c < 0x80) return 0;                                    // an ASCII letter is Latin
  const known = scriptCache.get(c);
  if (known !== undefined) return known;
  const ch = String.fromCodePoint(c);
  let s = JOIN;
  if (!rx().joins.test(ch)) {
    // a name this runtime's regexes do not know (a script newer than its Unicode) is passed over
    scriptRegexes ??= SCRIPT_NAMES.map((n) => { try { return new RegExp(`^\\p{Script=${n}}`, 'u'); } catch { return null; } });
    for (let i = 0; i < scriptRegexes.length; i++) if (scriptRegexes[i]?.test(ch)) { s = i; break; }
  }
  scriptCache.set(c, s);
  return s;
}
/** A string whose letters are all of script s, or Common, or Inherited. */
function oneScript(s: number): RegExp {
  let r = oneScriptCache.get(s);
  if (!r) { r = new RegExp(`^(?:[\\p{Script=${SCRIPT_NAMES[s]}}\\p{Script=Common}\\p{Script=Inherited}]|\\P{L})*$`, 'u'); oneScriptCache.set(s, r); }
  return r;
}
const NO_CUTS: number[] = [];
/** Where a run of letters and digits is cut: between two adjacent letters, neither joining, whose scripts differ. */
function scriptCuts(x: string): number[] {
  if (!NON_ASCII.test(x)) return NO_CUTS;
  const r = rx();
  let first = JOIN;
  for (let i = 0; i < x.length && first === JOIN;) {
    const c = x.codePointAt(i)!, n = c > 0xffff ? 2 : 1;
    if (r.letter.test(x.slice(i, i + n))) first = scriptOf(c);
    i += n;
  }
  if (first === JOIN || oneScript(first).test(x)) return NO_CUTS;
  const cuts: number[] = [];
  let prevLetter = false, prevScript = JOIN;
  for (let i = 0; i < x.length;) {
    const c = x.codePointAt(i)!, n = c > 0xffff ? 2 : 1;
    const isLetter = r.letter.test(x.slice(i, i + n));
    const s = isLetter ? scriptOf(c) : JOIN;
    if (isLetter && prevLetter && s !== JOIN && prevScript !== JOIN && s !== prevScript) cuts.push(i);
    prevLetter = isLetter; prevScript = s;
    i += n;
  }
  return cuts;
}

// ---- 5. Normalization, with the offsets kept ------------------------------------

/** A piece folded per code point (step 3 before its NFC): the text, and for each of its code units the raw offset of
 *  the character it came from; `off` null when that offset is `base` plus the code unit's index. Done per code point,
 *  this equals the whole piece's NFKD, lower case and strip: every character with a non-zero combining class is a
 *  mark (so the canonical reordering NFKD does moves only what is then removed), and a final sigma becomes sigma
 *  either way (measured over every code point: NOTES.md). */
interface Folded { x: string; off: number[] | null }
function foldPiece(s: string, base: number): Folded {
  if (!NON_ASCII.test(s)) return { x: s.toLowerCase(), off: null };
  const r = rx();
  if (s.normalize('NFKD') === s) {
    const lower = s.toLowerCase();
    if (lower.length === s.length) {               // one code unit for one: only U+0130 grows under toLowerCase
      const y = lower.replaceAll(FINAL_SIGMA, SIGMA).replaceAll(ZWSP, ' ');
      if (!r.stripOne.test(y)) return { x: y, off: null };
      let x = '';
      const off: number[] = [];
      for (let i = 0; i < y.length;) {
        const c = y.codePointAt(i)!, n = c > 0xffff ? 2 : 1, ch = y.slice(i, i + n);
        if (!r.stripOne.test(ch)) { x += ch; for (let k = 0; k < n; k++) off.push(base + i + k); }
        i += n;
      }
      return { x, off };
    }
  }
  let x = '';
  const off: number[] = [];
  for (let i = 0; i < s.length;) {
    const c = s.codePointAt(i)!, n = c > 0xffff ? 2 : 1;
    const d = s.slice(i, i + n).normalize('NFKD').toLowerCase().replaceAll(FINAL_SIGMA, SIGMA).replaceAll(ZWSP, ' ').replace(r.strip, '');
    x += d;
    for (let k = 0; k < d.length; k++) off.push(base + i);
    i += n;
  }
  return { x, off };
}

/** A spaceless run split into the Segmenter's words, as [start, end) offsets in the raw run. The Segmenter reads the
 *  NFC text. When the run is not NFC already, that text is built piece by piece, a piece starting at each character
 *  that is not a mark and that NFC joins to nothing before it, so each boundary maps back to its place in the run (a
 *  grapheme cluster is too coarse: ICU can put a word boundary inside one, between a leading jamo and a syllable). */
function segmentRun(run: string): [number, number][] {
  const { word } = segmenters();
  const out: [number, number][] = [];
  if (run.normalize('NFC') === run) {
    for (const s of word.segment(run)) out.push([s.index, s.index + s.segment.length]);
    return out;
  }
  const r = rx();
  let text = '', start = 0;
  const rawAt: number[] = [];
  const cut = (end: number): void => {
    const n = run.slice(start, end).normalize('NFC');
    text += n;
    for (let k = 0; k < n.length; k++) rawAt.push(start);
    start = end;
  };
  for (let i = 0; i < run.length;) {
    const n = run.codePointAt(i)! > 0xffff ? 2 : 1, ch = run.slice(i, i + n);
    if (i > start && !r.mark.test(ch)) {
      const before = run.slice(start, i);
      if ((before + ch).normalize('NFC') === before.normalize('NFC') + ch.normalize('NFC')) cut(i);
    }
    i += n;
  }
  cut(run.length);
  rawAt.push(run.length);
  for (const s of word.segment(text)) {
    const a = rawAt[s.index], b = rawAt[s.index + s.segment.length];
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** One token-sized piece of normalized text: `text` is NFC; it was read from `x` at [xi, xi + its folded length),
 *  whose code units map to raw offsets through `off` (or `base` plus the index). */
interface Piece { text: string; x: string; xi: number; xlen: number; off: number[] | null; base: number }
const rawOf = (p: Piece, k: number): number => (p.off ? p.off[p.xi + k] : p.base + p.xi + k);

/** Steps 1 to 4 over a raw string, calling `emit` for each piece in order. `segment` applies step 2, `cut` step 4's
 *  script cuts (words mode); --substring reads with neither. */
function eachPiece(s: string, segment: boolean, cut: boolean, emit: (p: Piece) => void): void {
  const r = rx();
  // this call's own copies of the two global regexes, so no other reader shares their lastIndex
  const run = new RegExp(r.run.source, 'gu'), ln = new RegExp(r.ln.source, 'gu');
  const fold = (raw: string, base: number): void => {
    const { x, off } = foldPiece(raw, base);
    ln.lastIndex = 0;
    for (let m = ln.exec(x); m; m = ln.exec(x)) {
      const sub = m[0], i = m.index;
      const cuts = cut ? scriptCuts(sub) : NO_CUTS;
      let a = 0;
      for (let k = 0; k <= cuts.length; k++) {
        const b = k < cuts.length ? cuts[k] : sub.length;
        const part = sub.slice(a, b);
        emit({ text: NON_ASCII.test(part) ? part.normalize('NFC') : part, x, xi: i + a, xlen: b - a, off, base });
        a = b;
      }
    }
  };
  for (let m = run.exec(s); m; m = run.exec(s)) {
    // an ASCII run is letters and digits only: one token, lower-cased, with no Segmenter, no fold and no script cut
    if (!NON_ASCII.test(m[0])) emit({ text: m[0].toLowerCase(), x: m[0], xi: 0, xlen: m[0].length, off: null, base: m.index });
    else if (segment && r.spaceless.test(m[0])) for (const [a, b] of segmentRun(m[0])) fold(m[0].slice(a, b), m.index + a);
    else fold(m[0], m.index);
  }
}

/** Words mode's tokens of a raw string, each with the UTF-16 offset of its first character in it. */
function tokensOf(s: string, segment: boolean): SearchToken[] {
  const out: SearchToken[] = [];
  if (!NON_ASCII.test(s)) {                        // ASCII: the runs are [A-Za-z0-9]+, and folding is lower case
    ASCII_TOKEN.lastIndex = 0;
    for (let m = ASCII_TOKEN.exec(s); m; m = ASCII_TOKEN.exec(s)) out.push({ token: m[0].toLowerCase(), at: m.index });
    return out;
  }
  eachPiece(s, segment, true, (p) => out.push({ token: p.text, at: rawOf(p, 0) }));
  return out;
}

/** --substring's reading of a raw string: its pieces joined by one space, and the raw offset of any offset in it. */
function substringText(s: string): { text: string; rawAt: (j: number) => number } {
  const pieces: Piece[] = [], starts: number[] = [];
  let text = '';
  eachPiece(s, false, false, (p) => {
    if (pieces.length) text += ' ';
    starts.push(text.length); pieces.push(p); text += p.text;
  });
  const rawAt = (j: number): number => {
    let lo = 0, hi = pieces.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= j) lo = mid; else hi = mid - 1; }
    const p = pieces[lo], k = Math.min(j - starts[lo], p.text.length);
    // a piece NFC recomposed (Hangul from jamo) is mapped through its decomposed prefix
    const xk = p.text.length === p.xlen ? k : p.text.slice(0, k).normalize('NFD').length;
    return rawOf(p, Math.min(xk, p.xlen - 1));
  };
  return { text, rawAt };
}

/** A string with its JSON escapes decoded, escape by escape with one regex (never JSON.parse, which would throw on a
 *  stray quote or an invalid escape): a short escape, or a backslash-u escape with four hex digits, whose surrogate
 *  pairs join and whose lone surrogates stay. `off[j]` is the raw offset of the escape or character decoded code
 *  unit j came from. An invalid escape stays as written. */
function decodeEscapes(s: string): { text: string; off: number[] } {
  const off: number[] = [];
  let text = '', last = 0;
  ESCAPE.lastIndex = 0;
  for (let m = ESCAPE.exec(s); m; m = ESCAPE.exec(s)) {
    for (let i = last; i < m.index; i++) off.push(i);
    text += s.slice(last, m.index) + (m[1] !== undefined ? SHORT_ESCAPE[m[1]] : String.fromCharCode(parseInt(m[2], 16)));
    off.push(m.index);
    last = m.index + m[0].length;
  }
  for (let i = last; i < s.length; i++) off.push(i);
  return { text: text + s.slice(last), off };
}

/** The whole string folded at once (NFKD, lower case, sigma, the strip): every token's NFKD form is a substring of it,
 *  so a term whose tokens are not all in it cannot match (the exact test below then never runs). */
function foldWhole(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase();
  return s.normalize('NFKD').toLowerCase().replaceAll(FINAL_SIGMA, SIGMA).replace(rx().strip, '');
}

// ---- 6. The exported functions over strings -----------------------------------

const segmentOf = (segmenter: SearchSegmenter | undefined): boolean =>
  (segmenter ?? checkSearchSupport().segmenter ?? 'no-dictionary') === 'icu';

/** The text as --substring reads it: each run of letters, marks, digits and format characters normalized (NFKD, lower
 *  case, final sigma to sigma, marks, format characters and U+0640 removed, U+200B a break, NFC), the runs of letters
 *  and digits joined by one space, so every run of anything else has become one space and none is at either end. */
export function normalizeForSearch(text: string): string {
  return substringText(text).text;
}

/** Words mode's tokens of a string, each with the UTF-16 offset of its first character in it (steps 1 to 4 above).
 *  The same function reads the query and the text. */
export function tokenizeForSearch(text: string, options: { segmenter?: SearchSegmenter } = {}): SearchToken[] {
  return tokensOf(text, segmentOf(options.segmenter));
}

/** The query, read: words separated by white space, ANDed. A `"` or a U+201C where a word starts opens a phrase, which
 *  ends at the matching `"` or U+201D, or runs to the end of the query (`unbalanced`); a quote inside a word is part of
 *  the word. Each term is read by the same function as the text: in words mode, its tokens (several make it a
 *  phrase); in substring mode, normalizeForSearch of it. A term that reads as nothing is dropped. */
export function parseSearchQuery(query: string, options: SearchQueryOptions = {}): SearchQuery {
  const mode: SearchMode = options.mode ?? 'words';
  const segmenter: SearchSegmenter = options.segmenter ?? checkSearchSupport().segmenter ?? 'no-dictionary';
  const raw: { text: string; quoted: boolean }[] = [];
  let unbalanced = false;
  for (let i = 0; i < query.length;) {
    if (/\s/.test(query[i])) { i++; continue; }
    const q = query[i];
    if (q === '"' || q === OPEN_CURLY) {
      const close = q === '"' ? '"' : CLOSE_CURLY, end = query.indexOf(close, i + 1);
      if (end < 0) { unbalanced = true; raw.push({ text: query.slice(i + 1), quoted: true }); break; }
      raw.push({ text: query.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < query.length && !/\s/.test(query[j])) j++;
    raw.push({ text: query.slice(i, j), quoted: false });
    i = j;
  }
  const terms: SearchTerm[] = [], dropped: string[] = [];
  for (const { text, quoted } of raw) {
    const tokens = mode === 'words' ? tokensOf(text, segmenter === 'icu').map((t) => t.token) : [normalizeForSearch(text)].filter((s) => s !== '');
    if (!tokens.length) { dropped.push(text); continue; }
    const phrase = quoted || tokens.length > 1 || (mode === 'substring' && tokens[0].includes(' '));
    terms.push({ text, quoted, tokens, phrase, gapScripts: gapScriptsOf(text) });
  }
  const held = new Set(terms.flatMap((t) => t.gapScripts));
  return { terms, dropped, unbalanced, mode, segmenter, gapScripts: Object.keys(SEARCH_GAP_SCRIPTS).filter((s) => held.has(s)) };
}

const gapLetterRegexes = new Map<string, RegExp>();
function gapLetters(script: string): RegExp {
  let r = gapLetterRegexes.get(script);
  if (!r) { r = new RegExp(`(?=\\p{L})\\p{Script=${script}}`, 'gu'); gapLetterRegexes.set(script, r); }
  return r;
}
function gapScriptsOf(text: string): string[] {
  if (!NON_ASCII.test(text)) return [];
  return Object.keys(SEARCH_GAP_SCRIPTS).filter((s) => { const r = gapLetters(s); r.lastIndex = 0; return r.test(text); });
}
function countLetters(text: string, script: string): number {
  if (!NON_ASCII.test(text)) return 0;
  const r = gapLetters(script);
  r.lastIndex = 0;
  let n = 0;
  while (r.exec(text)) n++;
  return n;
}

// ---- 7. One field: does it hold the terms, and where ---------------------------

interface Compiled {
  words: boolean; segment: boolean;
  /** words mode: each term's tokens; substring mode: each term's normalized text (one element) */
  tokens: string[][];
  /** what the folded field must contain for each term to be possible */
  needles: string[][];
  /** for a term whose tokens are ASCII, the regex that finds it in an ASCII field (null for any other term: an ASCII
   *  field reads as ASCII tokens only, so it cannot hold one) */
  ascii: (RegExp | null)[];
}
/** In an ASCII field the tokens are exactly its runs of [A-Za-z0-9], lower-cased, and --substring's reading is those
 *  runs joined by one space. So an ASCII term is found by one case-insensitive regex, its parts joined by a run of
 *  anything else (which also makes every inner part a whole run), and its first match is the term's first match.
 *  Words mode adds the outer edges: the first token begins a run and the last ends one; in --substring the first part
 *  may begin inside a run and the last may end inside one. */
function asciiRegex(parts: string[], words: boolean): RegExp | null {
  if (!parts.every((x) => /^[a-z0-9]+$/.test(x))) return null;
  const body = parts.join('[^A-Za-z0-9]+');
  return new RegExp(words ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, 'i');
}
function compile(q: SearchQuery): Compiled {
  const words = q.mode === 'words';
  const tokens = q.terms.map((t) => t.tokens);
  const parts = tokens.map((ts) => (words ? ts : ts[0].split(' ')).filter((x) => x));
  const needles = parts.map((ps) => [...new Set(ps.map((x) => x.normalize('NFKD')))]);
  return { words, segment: q.segmenter === 'icu', tokens, needles, ascii: parts.map((ps) => asciiRegex(ps, words)) };
}

/** The first index in `toks` where `term`'s tokens stand adjacent and in order, or -1. */
function phraseAt(toks: SearchToken[], term: string[]): number {
  outer: for (let i = 0; i + term.length <= toks.length; i++) {
    for (let k = 0; k < term.length; k++) if (toks[i + k].token !== term[k]) continue outer;
    return i;
  }
  return -1;
}

/** Which terms one field holds, in either of its forms, and the raw offset of its earliest match; null when none. */
function searchField(v: string, c: Compiled): { found: number[]; at: number } | null {
  const forms: { text: string; off: number[] | null }[] = [{ text: v, off: null }];
  if (v.includes(BS) && HAS_ESCAPE.test(v)) { const d = decodeEscapes(v); forms.push({ text: d.text, off: d.off }); }
  const found = new Set<number>();
  let at = Infinity;
  for (const f of forms) {
    if (!NON_ASCII.test(f.text)) {                 // an ASCII form: one regex per term, no tokens read
      for (let i = 0; i < c.ascii.length; i++) {
        const r = c.ascii[i];
        const j = r ? f.text.search(r) : -1;
        if (j < 0) continue;
        found.add(i);
        const raw = f.off ? f.off[j] : j;
        if (raw < at) at = raw;
      }
      continue;
    }
    const folded = foldWhole(f.text);
    const possible: number[] = [];
    for (let i = 0; i < c.needles.length; i++) if (c.needles[i].every((nd) => folded.includes(nd))) possible.push(i);
    if (!possible.length) continue;
    for (const [i, local] of firstMatches(f.text, folded, possible, c)) {
      found.add(i);
      const raw = f.off ? f.off[local] : local;
      if (raw < at) at = raw;
    }
  }
  return found.size ? { found: [...found], at } : null;
}

const NL = String.fromCharCode(10);
/** The offset of every new line in s, in order. */
function newlines(s: string): number[] {
  const out: number[] = [];
  for (let i = s.indexOf(NL); i >= 0; i = s.indexOf(NL, i + 1)) out.push(i);
  return out;
}
/** How many of the ascending numbers in `sorted` are below p. */
function countBelow(sorted: number[], p: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < p) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The offset of the first match of each term that the text (not ASCII) holds, read by lines. A run of letters never
 *  crosses a new line, and the text folded whole keeps each of its new lines, in order (nothing folds to one or from
 *  one). So a term's first match starts on a line whose folded text holds the NFKD form of its first token (in
 *  --substring, its first part), and only those lines are read, with the lines after one that a phrase reaches. The
 *  lines are read in order, so the first match found for a term is its first in the text. */
function firstMatches(text: string, folded: string, terms: number[], c: Compiled): Map<number, number> {
  const out = new Map<number, number>();
  const nlText = newlines(text), nlFolded = newlines(folded);
  if (nlFolded.length !== nlText.length) {         // never measured; read the whole text as one line rather than guess
    nlText.length = 0; nlFolded.length = 0;
  }
  const lines = nlText.length + 1;
  const start = (k: number): number => (k === 0 ? 0 : nlText[k - 1] + 1);
  const end = (k: number): number => (k < nlText.length ? nlText[k] : text.length);
  const candidates = new Set<number>();
  for (const i of terms) {
    const head = (c.words ? c.tokens[i][0] : c.tokens[i][0].split(' ')[0]).normalize('NFKD');
    for (let p = folded.indexOf(head); p >= 0;) {
      const k = countBelow(nlFolded, p);
      candidates.add(k);
      if (k >= nlFolded.length) break;
      p = folded.indexOf(head, nlFolded[k] + 1);     // the next line: one hit per line is enough to read it
    }
  }
  const readingByLine = new Map<number, number>();
  const lineReading = (k: number): number => {
    let n = readingByLine.get(k);
    if (n === undefined) { n = substringText(text.slice(start(k), end(k))).text.length; readingByLine.set(k, n); }
    return n;
  };
  const tokensByLine = new Map<number, SearchToken[]>();
  const lineTokens = (k: number): SearchToken[] => {
    let t = tokensByLine.get(k);
    if (!t) { const base = start(k); t = tokensOf(text.slice(base, end(k)), c.segment).map((x) => ({ token: x.token, at: x.at + base })); tokensByLine.set(k, t); }
    return t;
  };
  for (const k of [...candidates].sort((a, b) => a - b)) {
    const pending = terms.filter((i) => !out.has(i));
    if (!pending.length) break;
    if (c.words) {
      const own = lineTokens(k);
      if (!own.length) continue;
      // a phrase that starts on line k may end on a later line: the tokens after k's, as many as the longest needs
      const longest = Math.max(...pending.map((i) => c.tokens[i].length));
      const window = [...own];
      for (let m = k + 1; m < lines && window.length < own.length + longest - 1; m++) window.push(...lineTokens(m));
      for (const i of pending) {
        const p = phraseAt(window.slice(0, own.length + c.tokens[i].length - 1), c.tokens[i]);
        if (p >= 0) out.set(i, window[p].at);
      }
    } else {
      // --substring: line k's reading, then the next lines' as long as a term starting on line k could reach them (the
      // lines' readings are joined by one space, as the whole text's are)
      const own = lineReading(k);
      const longest = Math.max(...pending.map((i) => c.tokens[i][0].length));
      let m = k, reach = own;
      while (m + 1 < lines && reach < own + 1 + longest) { m++; const n = lineReading(m); if (n) reach += (reach ? 1 : 0) + n; }
      const st = substringText(text.slice(start(k), end(m)));
      for (const i of pending) {
        const j = st.text.indexOf(c.tokens[i][0]);
        if (j >= 0 && j < own) out.set(i, start(k) + st.rawAt(j));
      }
    }
  }
  return out;
}

// ---- 8. A record's fields, by kind ------------------------------------------------

type PathLink = { key: string | number; up: PathLink } | null;
const step = (up: PathLink, key: string | number): PathLink => ({ key, up });
/** The key path of a field, from the record: names passing the label rule (else (withheld)), and indices. */
function pathOf(p: PathLink): (string | number)[] {
  const out: (string | number)[] = [];
  for (let x = p; x; x = x.up) out.push(typeof x.key === 'number' ? x.key : label(x.key, WITHHELD));
  return out.reverse();
}
interface Field { kind: SearchKind; text: string; path: PathLink }
interface RecordNotes { images: number; redacted: number; spilled: boolean }

/** Every string under a value, depth first in key order; an object whose type is `image` is counted and not read.
 *  A field's path names the keys of the first `levels` levels under the value (a tool's parameters, an attachment's
 *  own keys), where an array is a level too, so the items of a tool input written as an array have no names; a key
 *  below them is data a tool or the model wrote, and its path names it (withheld). Array indices are always named. */
function walkStrings(v: unknown, path: PathLink, kind: SearchKind, out: Field[], notes: RecordNotes, levels: number): void {
  const stack: [unknown, PathLink, number][] = [[v, path, levels]];
  while (stack.length) {
    const [x, p, n] = stack.pop()!;
    if (typeof x === 'string') { if (x) out.push({ kind, text: x, path: p }); continue; }
    if (typeof x !== 'object' || x === null) continue;
    if (Array.isArray(x)) { for (let i = x.length - 1; i >= 0; i--) stack.push([x[i], step(p, i), n - 1]); continue; }
    if ((x as any).type === 'image') { notes.images++; continue; }
    const keys = Object.keys(x);
    for (let i = keys.length - 1; i >= 0; i--) stack.push([(x as any)[keys[i]], step(p, n > 0 ? keys[i] : WITHHELD), n - 1]);
  }
}

/** Text blocks (and bare strings) of a content array, or a content string, under `path`. Image blocks are counted. */
function contentTexts(content: unknown, path: PathLink, kind: SearchKind, out: Field[], notes: RecordNotes, textKey = 'text'): void {
  if (typeof content === 'string') { if (content) out.push({ kind, text: content, path }); return; }
  if (!Array.isArray(content)) return;
  content.forEach((b: any, i) => {
    if (typeof b === 'string') { if (b) out.push({ kind, text: b, path: step(path, i) }); return; }
    if (!isObj(b)) return;
    if (b.type === 'image') notes.images++;
    else if (b.type === 'text' && typeof b[textKey] === 'string' && b[textKey]) out.push({ kind, text: b[textKey], path: step(step(path, i), textKey) });
  });
}

/** The text of a tool_result block's content, as the spill test reads it: a string, or its text blocks joined. */
const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join(NL) : '');

function fieldsOf(rec: any, out: Field[], notes: RecordNotes): void {
  if (rec.type === 'user' || rec.type === 'assistant') {
    const msg = rec.message, content = isObj(msg) ? msg.content : undefined;
    const base = step(step(null, 'message'), 'content');
    let kind: SearchKind;
    if (rec.type === 'user') kind = isToolResultRecord(rec) ? 'result' : isInputTurn(rec) ? 'input' : inputChannel(rec) === 'harness:compact-summary' ? 'summary' : 'meta';
    else kind = rec.isApiErrorMessage === true ? 'system' : 'reply';
    if (!Array.isArray(content)) { contentTexts(content, base, kind, out, notes); return; }
    content.forEach((b: any, i) => {
      if (!isObj(b)) return;
      const at = step(base, i);
      if (b.type === 'text') { if (typeof b.text === 'string' && b.text) out.push({ kind, text: b.text, path: step(at, 'text') }); }
      else if (b.type === 'image') notes.images++;
      else if (b.type === 'tool_result') {
        if (SPILLED.test(resultText(b.content))) notes.spilled = true;
        contentTexts(b.content, step(at, 'content'), 'result', out, notes);
      } else if (rec.type === 'assistant' && b.type === 'thinking') { if (typeof b.thinking === 'string' && b.thinking) out.push({ kind: 'thinking', text: b.thinking, path: step(at, 'thinking') }); }
      else if (rec.type === 'assistant' && b.type === 'redacted_thinking') notes.redacted++;
      else if (rec.type === 'assistant' && b.type === 'tool_use') walkStrings(b.input, step(at, 'input'), 'call', out, notes, 1);
    });
    return;
  }
  if (rec.type === 'system') {
    // the record's own keys are named; the keys below them are not
    for (const k of Object.keys(rec)) if (!ENVELOPE.has(k) && !SYSTEM_NAMES.has(k)) walkStrings(rec[k], step(null, k), 'system', out, notes, 0);
    return;
  }
  if (rec.type === 'attachment') {
    const att = rec.attachment, at = step(null, 'attachment');
    if (isObj(att) && att.type === 'queued_command' && att.commandMode === 'prompt') {
      contentTexts(att.prompt, step(at, 'prompt'), 'input', out, notes);
      for (const k of Object.keys(att)) if (k !== 'prompt') walkStrings(att[k], step(at, k), 'attachment', out, notes, 0);
    } else walkStrings(att, at, 'attachment', out, notes, 1);
  }
}

// ---- 9. A transcript ------------------------------------------------------------------

/** Search one transcript: its text, or the parser's Transcript of it. Turns holding every term of the query, in path
 *  order, with one entry per record and kind holding a term; the file's counts; its latest timestamp. A query with no
 *  terms matches nothing. */
export function searchTranscript(input: string | Transcript, query: SearchQuery, options: SearchOptions = {}): SearchResult {
  const t = typeof input === 'string' ? parseTranscript(input) : input;
  const kinds = new Set<SearchKind>(options.kinds ?? SEARCH_DEFAULT_KINDS);
  const pre = options.prefix ? options.prefix + ':' : '';
  const c = compile(query);
  const nTerms = query.terms.length;

  const path = repairedLivePath(t).path;
  const turns = turnsOf(t, path);
  // a turn's records: its prompt first, then the call and result nodes of its calls, then its path records
  const owner = new Map<TreeNode, number>();
  turns.forEach((turn, k) => owner.set(turn.prompt, k));
  turns.forEach((turn, k) => {
    for (const call of turn.toolCalls) {
      if (!owner.has(call.callNode)) owner.set(call.callNode, k);
      if (call.resultNode && !owner.has(call.resultNode)) owner.set(call.resultNode, k);
    }
  });
  // path records before the first prompt belong to T001; with no input turn, they are counted (each node once)
  const beforeFirstTurn = turns.length ? 0 : new Set(path).size;
  let cur = 0;
  if (turns.length) for (const n of path) {
    const k = owner.get(n);
    if (k !== undefined && turns[k].prompt === n) { cur = k; continue; }
    if (k === undefined) owner.set(n, cur);
  }
  const records: TreeNode[][] = turns.map(() => []);
  for (const [n, k] of owner) records[k].push(n);
  for (const l of records) l.sort((a, b) => a.index - b.index);

  const ns: SearchNotSearched = {
    offPath: t.nodes.size - owner.size - beforeFirstTurn, toolUseResult: 0, wireInputs: 0, redactedThinking: 0,
    sidecars: t.sidecars.length, images: 0, spilled: 0, replays: t.stats.replayedCopies, beforeFirstTurn,
    unreadableLines: t.stats.unparseable, kindsOff: 0,
  };
  const byKind: Partial<Record<SearchKind, number>> = {};
  for (const k of SEARCH_KINDS) if (kinds.has(k)) byKind[k] = 0;
  const gap: Record<string, number> = {};
  for (const s of query.gapScripts) gap[s] = 0;
  const hits: SearchTurnHit[] = [];
  let searched = 0, hitRecords = 0;

  for (let k = 0; k < turns.length; k++) {
    const entries: SearchEntry[] = [];
    const held = new Set<number>();
    let recordsWithEntries = 0;
    for (const n of records[k]) {
      const rec: any = n.record;
      const fields: Field[] = [], notes: RecordNotes = { images: 0, redacted: 0, spilled: false };
      fieldsOf(rec, fields, notes);
      ns.images += notes.images;
      ns.redactedThinking += notes.redacted;
      if (notes.spilled) ns.spilled++;
      if ('toolUseResult' in rec) ns.toolUseResult++;
      if (rec.wireToolInputs !== undefined) ns.wireInputs++;
      let on = false, off = false;
      const byRecordKind = new Map<SearchKind, { path: PathLink; at: number; w: Set<number> }>();
      for (const f of fields) {
        if (!kinds.has(f.kind)) { off = true; continue; }
        on = true;
        if (query.gapScripts.length) {
          const text = f.text.includes(BS) && HAS_ESCAPE.test(f.text) ? decodeEscapes(f.text).text : f.text;
          for (const s of query.gapScripts) gap[s] += countLetters(text, s);
        }
        if (!nTerms) continue;
        const h = searchField(f.text, c);
        if (!h) continue;
        let e = byRecordKind.get(f.kind);
        if (!e) { e = { path: f.path, at: h.at, w: new Set() }; byRecordKind.set(f.kind, e); }
        for (const i of h.found) e.w.add(i);
      }
      if (on || !off) searched++; else ns.kindsOff++;
      if (!byRecordKind.size) continue;
      recordsWithEntries++;
      const a = `${pre}L${t.positions[n.index].line}`;
      for (const kind of SEARCH_KINDS) {
        const e = byRecordKind.get(kind);
        if (!e) continue;
        const w = [...e.w].sort((x, y) => x - y);
        for (const i of w) held.add(i);
        entries.push({ a, kind, field: pathOf(e.path), at: e.at, w });
      }
    }
    if (!nTerms || held.size < nTerms) continue;
    hits.push({ ta: `${pre}T${pad3(k + 1)}`, ch: label(inputChannel(turns[k].prompt.record), 'none'), entries });
    hitRecords += recordsWithEntries;
    for (const kind of new Set(entries.map((e) => e.kind))) byKind[kind] = (byKind[kind] ?? 0) + 1;
  }

  return {
    turns: hits,
    counts: { parsed: t.records.length, turns: turns.length, searched, notSearched: ns, hits: { turns: hits.length, records: hitRecords, byKind }, gapScripts: gap },
    last: t.stats.lastTimestamp,
    fileKind: t.fileKind,
  };
}
