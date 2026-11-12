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
/** Every kind, in the table's order: the order of one record's entries in a hit, and of `hits.byKind`. */
export const SEARCH_KINDS = Object.freeze(['input', 'summary', 'reply', 'thinking', 'call', 'result', 'system', 'meta', 'attachment']);
/** The kinds searched when none are named: every kind but meta and attachment, which hold the harness's own text. */
export const SEARCH_DEFAULT_KINDS = Object.freeze(['input', 'summary', 'reply', 'thinking', 'call', 'result', 'system']);
/** The scripts with a known gap, and which gap: words with attached clitics, or no spaces between words. */
export const SEARCH_GAP_SCRIPTS = Object.freeze({
    Hebrew: 'clitics', Arabic: 'clitics', Hangul: 'clitics',
    Han: 'spaceless', Hiragana: 'spaceless', Katakana: 'spaceless', Thai: 'spaceless', Lao: 'spaceless', Khmer: 'spaceless', Myanmar: 'spaceless',
});
// ---- 2. Constants, built from code points -------------------------------------
const cp = (...c) => String.fromCodePoint(...c);
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
const SHORT_ESCAPE = {
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
const label = (v, fallback) => (!v ? fallback : typeof v === 'string' && LABEL.test(v) ? v : WITHHELD);
const pad3 = (n) => String(n).padStart(3, '0');
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
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
let unicode = null;
function rx() {
    if (unicode)
        return unicode;
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
let support = null;
/** Whether this runtime can run the search (Unicode property escapes, Intl, String.prototype.normalize), and whether
 *  its Intl.Segmenter splits spaceless scripts into dictionary words: a known Thai and a known Chinese string, built
 *  from code points, must split into their known words for `icu`. Computed once. */
export function checkSearchSupport() {
    if (support)
        return support;
    let missing = null;
    try {
        new RegExp('\\p{L}', 'u');
    }
    catch {
        missing = 'unicode property escapes';
    }
    if (!missing && typeof Intl !== 'object')
        missing = 'Intl';
    if (!missing) {
        try {
            if (cp(0xfb01).normalize('NFKD') !== 'fi')
                missing = 'String.prototype.normalize';
        }
        catch {
            missing = 'String.prototype.normalize';
        }
    }
    support = missing ? { ok: false, segmenter: null, missing } : { ok: true, segmenter: segmenterSplits() ? 'icu' : 'no-dictionary', missing: null };
    return support;
}
function segmenterSplits() {
    try {
        const S = Intl.Segmenter;
        if (typeof S !== 'function')
            return false;
        const seg = new S(undefined, { granularity: 'word' });
        const lengths = (s) => [...seg.segment(s)].map((x) => x.segment.length).join(',');
        return lengths(THAI_CHECK) === '4,3' && lengths(CHINESE_CHECK) === '2,2';
    }
    catch {
        return false;
    }
}
let wordSegmenter = null;
function segmenters() {
    if (typeof Intl !== 'object' || typeof Intl.Segmenter !== 'function')
        throw new Error('Intl.Segmenter is not available on this runtime: read the text with segmenter no-dictionary');
    wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
    return { word: wordSegmenter };
}
// ---- 4. Scripts ------------------------------------------------------------------
/** A letter that joins either side: Common, Inherited, or a script this runtime does not name. */
const JOIN = -1;
let scriptRegexes = null;
const scriptCache = new Map();
const oneScriptCache = new Map();
/** The index in SCRIPT_NAMES of a LETTER's Script value, or JOIN. */
function scriptOf(c) {
    if (c < 0x80)
        return 0; // an ASCII letter is Latin
    const known = scriptCache.get(c);
    if (known !== undefined)
        return known;
    const ch = String.fromCodePoint(c);
    let s = JOIN;
    if (!rx().joins.test(ch)) {
        // a name this runtime's regexes do not know (a script newer than its Unicode) is passed over
        scriptRegexes ??= SCRIPT_NAMES.map((n) => { try {
            return new RegExp(`^\\p{Script=${n}}`, 'u');
        }
        catch {
            return null;
        } });
        for (let i = 0; i < scriptRegexes.length; i++)
            if (scriptRegexes[i]?.test(ch)) {
                s = i;
                break;
            }
    }
    scriptCache.set(c, s);
    return s;
}
/** A string whose letters are all of script s, or Common, or Inherited. */
function oneScript(s) {
    let r = oneScriptCache.get(s);
    if (!r) {
        r = new RegExp(`^(?:[\\p{Script=${SCRIPT_NAMES[s]}}\\p{Script=Common}\\p{Script=Inherited}]|\\P{L})*$`, 'u');
        oneScriptCache.set(s, r);
    }
    return r;
}
const NO_CUTS = [];
/** Where a run of letters and digits is cut: between two adjacent letters, neither joining, whose scripts differ. */
function scriptCuts(x) {
    if (!NON_ASCII.test(x))
        return NO_CUTS;
    const r = rx();
    let first = JOIN;
    for (let i = 0; i < x.length && first === JOIN;) {
        const c = x.codePointAt(i), n = c > 0xffff ? 2 : 1;
        if (r.letter.test(x.slice(i, i + n)))
            first = scriptOf(c);
        i += n;
    }
    if (first === JOIN || oneScript(first).test(x))
        return NO_CUTS;
    const cuts = [];
    let prevLetter = false, prevScript = JOIN;
    for (let i = 0; i < x.length;) {
        const c = x.codePointAt(i), n = c > 0xffff ? 2 : 1;
        const isLetter = r.letter.test(x.slice(i, i + n));
        const s = isLetter ? scriptOf(c) : JOIN;
        if (isLetter && prevLetter && s !== JOIN && prevScript !== JOIN && s !== prevScript)
            cuts.push(i);
        prevLetter = isLetter;
        prevScript = s;
        i += n;
    }
    return cuts;
}
function foldPiece(s, base) {
    if (!NON_ASCII.test(s))
        return { x: s.toLowerCase(), off: null };
    const r = rx();
    if (s.normalize('NFKD') === s) {
        const lower = s.toLowerCase();
        if (lower.length === s.length) { // one code unit for one: only U+0130 grows under toLowerCase
            const y = lower.replaceAll(FINAL_SIGMA, SIGMA).replaceAll(ZWSP, ' ');
            if (!r.stripOne.test(y))
                return { x: y, off: null };
            let x = '';
            const off = [];
            for (let i = 0; i < y.length;) {
                const c = y.codePointAt(i), n = c > 0xffff ? 2 : 1, ch = y.slice(i, i + n);
                if (!r.stripOne.test(ch)) {
                    x += ch;
                    for (let k = 0; k < n; k++)
                        off.push(base + i + k);
                }
                i += n;
            }
            return { x, off };
        }
    }
    let x = '';
    const off = [];
    for (let i = 0; i < s.length;) {
        const c = s.codePointAt(i), n = c > 0xffff ? 2 : 1;
        const d = s.slice(i, i + n).normalize('NFKD').toLowerCase().replaceAll(FINAL_SIGMA, SIGMA).replaceAll(ZWSP, ' ').replace(r.strip, '');
        x += d;
        for (let k = 0; k < d.length; k++)
            off.push(base + i);
        i += n;
    }
    return { x, off };
}
/** A spaceless run split into the Segmenter's words, as [start, end) offsets in the raw run. The Segmenter reads the
 *  NFC text. When the run is not NFC already, that text is built piece by piece, a piece starting at each character
 *  that is not a mark and that NFC joins to nothing before it, so each boundary maps back to its place in the run (a
 *  grapheme cluster is too coarse: ICU can put a word boundary inside one, between a leading jamo and a syllable). */
function segmentRun(run) {
    const { word } = segmenters();
    const out = [];
    if (run.normalize('NFC') === run) {
        for (const s of word.segment(run))
            out.push([s.index, s.index + s.segment.length]);
        return out;
    }
    const r = rx();
    let text = '', start = 0;
    const rawAt = [];
    const cut = (end) => {
        const n = run.slice(start, end).normalize('NFC');
        text += n;
        for (let k = 0; k < n.length; k++)
            rawAt.push(start);
        start = end;
    };
    for (let i = 0; i < run.length;) {
        const n = run.codePointAt(i) > 0xffff ? 2 : 1, ch = run.slice(i, i + n);
        if (i > start && !r.mark.test(ch)) {
            const before = run.slice(start, i);
            if ((before + ch).normalize('NFC') === before.normalize('NFC') + ch.normalize('NFC'))
                cut(i);
        }
        i += n;
    }
    cut(run.length);
    rawAt.push(run.length);
    for (const s of word.segment(text)) {
        const a = rawAt[s.index], b = rawAt[s.index + s.segment.length];
        if (b > a)
            out.push([a, b]);
    }
    return out;
}
const rawOf = (p, k) => (p.off ? p.off[p.xi + k] : p.base + p.xi + k);
/** Steps 1 to 4 over a raw string, calling `emit` for each piece in order. `segment` applies step 2, `cut` step 4's
 *  script cuts (words mode); --substring reads with neither. */
function eachPiece(s, segment, cut, emit) {
    const r = rx();
    // this call's own copies of the two global regexes, so no other reader shares their lastIndex
    const run = new RegExp(r.run.source, 'gu'), ln = new RegExp(r.ln.source, 'gu');
    const fold = (raw, base) => {
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
        if (!NON_ASCII.test(m[0]))
            emit({ text: m[0].toLowerCase(), x: m[0], xi: 0, xlen: m[0].length, off: null, base: m.index });
        else if (segment && r.spaceless.test(m[0]))
            for (const [a, b] of segmentRun(m[0]))
                fold(m[0].slice(a, b), m.index + a);
        else
            fold(m[0], m.index);
    }
}
/** Words mode's tokens of a raw string, each with the UTF-16 offset of its first character in it. */
function tokensOf(s, segment) {
    const out = [];
    if (!NON_ASCII.test(s)) { // ASCII: the runs are [A-Za-z0-9]+, and folding is lower case
        ASCII_TOKEN.lastIndex = 0;
        for (let m = ASCII_TOKEN.exec(s); m; m = ASCII_TOKEN.exec(s))
            out.push({ token: m[0].toLowerCase(), at: m.index });
        return out;
    }
    eachPiece(s, segment, true, (p) => out.push({ token: p.text, at: rawOf(p, 0) }));
    return out;
}
/** --substring's reading of a raw string: its pieces joined by one space, and the raw offset of any offset in it. */
function substringText(s) {
    const pieces = [], starts = [];
    let text = '';
    eachPiece(s, false, false, (p) => {
        if (pieces.length)
            text += ' ';
        starts.push(text.length);
        pieces.push(p);
        text += p.text;
    });
    const rawAt = (j) => {
        let lo = 0, hi = pieces.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= j)
                lo = mid;
            else
                hi = mid - 1;
        }
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
function decodeEscapes(s) {
    const off = [];
    let text = '', last = 0;
    ESCAPE.lastIndex = 0;
    for (let m = ESCAPE.exec(s); m; m = ESCAPE.exec(s)) {
        for (let i = last; i < m.index; i++)
            off.push(i);
        text += s.slice(last, m.index) + (m[1] !== undefined ? SHORT_ESCAPE[m[1]] : String.fromCharCode(parseInt(m[2], 16)));
        off.push(m.index);
        last = m.index + m[0].length;
    }
    for (let i = last; i < s.length; i++)
        off.push(i);
    return { text: text + s.slice(last), off };
}
/** The whole string folded at once (NFKD, lower case, sigma, the strip): every token's NFKD form is a substring of it,
 *  so a term whose tokens are not all in it cannot match (the exact test below then never runs). */
function foldWhole(s) {
    if (!NON_ASCII.test(s))
        return s.toLowerCase();
    return s.normalize('NFKD').toLowerCase().replaceAll(FINAL_SIGMA, SIGMA).replace(rx().strip, '');
}
// ---- 6. The exported functions over strings -----------------------------------
const segmentOf = (segmenter) => (segmenter ?? checkSearchSupport().segmenter ?? 'no-dictionary') === 'icu';
/** The text as --substring reads it: each run of letters, marks, digits and format characters normalized (NFKD, lower
 *  case, final sigma to sigma, marks, format characters and U+0640 removed, U+200B a break, NFC), the runs of letters
 *  and digits joined by one space, so every run of anything else has become one space and none is at either end. */
export function normalizeForSearch(text) {
    return substringText(text).text;
}
/** Words mode's tokens of a string, each with the UTF-16 offset of its first character in it (steps 1 to 4 above).
 *  The same function reads the query and the text. */
export function tokenizeForSearch(text, options = {}) {
    return tokensOf(text, segmentOf(options.segmenter));
}
/** The query, read: words separated by white space, ANDed. A `"` or a U+201C where a word starts opens a phrase, which
 *  ends at the matching `"` or U+201D, or runs to the end of the query (`unbalanced`); a quote inside a word is part of
 *  the word. Each term is read by the same function as the text: in words mode, its tokens (several make it a
 *  phrase); in substring mode, normalizeForSearch of it. A term that reads as nothing is dropped. */
export function parseSearchQuery(query, options = {}) {
    const mode = options.mode ?? 'words';
    const segmenter = options.segmenter ?? checkSearchSupport().segmenter ?? 'no-dictionary';
    const raw = [];
    let unbalanced = false;
    for (let i = 0; i < query.length;) {
        if (/\s/.test(query[i])) {
            i++;
            continue;
        }
        const q = query[i];
        if (q === '"' || q === OPEN_CURLY) {
            const close = q === '"' ? '"' : CLOSE_CURLY, end = query.indexOf(close, i + 1);
            if (end < 0) {
                unbalanced = true;
                raw.push({ text: query.slice(i + 1), quoted: true });
                break;
            }
            raw.push({ text: query.slice(i + 1, end), quoted: true });
            i = end + 1;
            continue;
        }
        let j = i;
        while (j < query.length && !/\s/.test(query[j]))
            j++;
        raw.push({ text: query.slice(i, j), quoted: false });
        i = j;
    }
    const terms = [], dropped = [];
    for (const { text, quoted } of raw) {
        const tokens = mode === 'words' ? tokensOf(text, segmenter === 'icu').map((t) => t.token) : [normalizeForSearch(text)].filter((s) => s !== '');
        if (!tokens.length) {
            dropped.push(text);
            continue;
        }
        const phrase = quoted || tokens.length > 1 || (mode === 'substring' && tokens[0].includes(' '));
        terms.push({ text, quoted, tokens, phrase, gapScripts: gapScriptsOf(text) });
    }
    const held = new Set(terms.flatMap((t) => t.gapScripts));
    return { terms, dropped, unbalanced, mode, segmenter, gapScripts: Object.keys(SEARCH_GAP_SCRIPTS).filter((s) => held.has(s)) };
}
const gapLetterRegexes = new Map();
function gapLetters(script) {
    let r = gapLetterRegexes.get(script);
    if (!r) {
        r = new RegExp(`(?=\\p{L})\\p{Script=${script}}`, 'gu');
        gapLetterRegexes.set(script, r);
    }
    return r;
}
function gapScriptsOf(text) {
    if (!NON_ASCII.test(text))
        return [];
    return Object.keys(SEARCH_GAP_SCRIPTS).filter((s) => { const r = gapLetters(s); r.lastIndex = 0; return r.test(text); });
}
function countLetters(text, script) {
    if (!NON_ASCII.test(text))
        return 0;
    const r = gapLetters(script);
    r.lastIndex = 0;
    let n = 0;
    while (r.exec(text))
        n++;
    return n;
}
/** In an ASCII field the tokens are exactly its runs of [A-Za-z0-9], lower-cased, and --substring's reading is those
 *  runs joined by one space. So an ASCII term is found by one case-insensitive regex, its parts joined by a run of
 *  anything else (which also makes every inner part a whole run), and its first match is the term's first match.
 *  Words mode adds the outer edges: the first token begins a run and the last ends one; in --substring the first part
 *  may begin inside a run and the last may end inside one. */
function asciiRegex(parts, words) {
    if (!parts.every((x) => /^[a-z0-9]+$/.test(x)))
        return null;
    const body = parts.join('[^A-Za-z0-9]+');
    return new RegExp(words ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, 'i');
}
function compile(q) {
    const words = q.mode === 'words';
    const tokens = q.terms.map((t) => t.tokens);
    const parts = tokens.map((ts) => (words ? ts : ts[0].split(' ')).filter((x) => x));
    const needles = parts.map((ps) => [...new Set(ps.map((x) => x.normalize('NFKD')))]);
    return { words, segment: q.segmenter === 'icu', tokens, needles, ascii: parts.map((ps) => asciiRegex(ps, words)) };
}
/** The first index in `toks` where `term`'s tokens stand adjacent and in order, or -1. */
function phraseAt(toks, term) {
    outer: for (let i = 0; i + term.length <= toks.length; i++) {
        for (let k = 0; k < term.length; k++)
            if (toks[i + k].token !== term[k])
                continue outer;
        return i;
    }
    return -1;
}
/** Which terms one field holds, in either of its forms, and the raw offset of its earliest match; null when none. */
function searchField(v, c) {
    const forms = [{ text: v, off: null }];
    if (v.includes(BS) && HAS_ESCAPE.test(v)) {
        const d = decodeEscapes(v);
        forms.push({ text: d.text, off: d.off });
    }
    const found = new Set();
    let at = Infinity;
    for (const f of forms) {
        if (!NON_ASCII.test(f.text)) { // an ASCII form: one regex per term, no tokens read
            for (let i = 0; i < c.ascii.length; i++) {
                const r = c.ascii[i];
                const j = r ? f.text.search(r) : -1;
                if (j < 0)
                    continue;
                found.add(i);
                const raw = f.off ? f.off[j] : j;
                if (raw < at)
                    at = raw;
            }
            continue;
        }
        const folded = foldWhole(f.text);
        const possible = [];
        for (let i = 0; i < c.needles.length; i++)
            if (c.needles[i].every((nd) => folded.includes(nd)))
                possible.push(i);
        if (!possible.length)
            continue;
        for (const [i, local] of firstMatches(f.text, folded, possible, c)) {
            found.add(i);
            const raw = f.off ? f.off[local] : local;
            if (raw < at)
                at = raw;
        }
    }
    return found.size ? { found: [...found], at } : null;
}
const NL = String.fromCharCode(10);
/** The offset of every new line in s, in order. */
function newlines(s) {
    const out = [];
    for (let i = s.indexOf(NL); i >= 0; i = s.indexOf(NL, i + 1))
        out.push(i);
    return out;
}
/** How many of the ascending numbers in `sorted` are below p. */
function countBelow(sorted, p) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < p)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
/** The offset of the first match of each term that the text (not ASCII) holds, read by lines. A run of letters never
 *  crosses a new line, and the text folded whole keeps each of its new lines, in order (nothing folds to one or from
 *  one). So a term's first match starts on a line whose folded text holds the NFKD form of its first token (in
 *  --substring, its first part), and only those lines are read, with the lines after one that a phrase reaches. The
 *  lines are read in order, so the first match found for a term is its first in the text. */
function firstMatches(text, folded, terms, c) {
    const out = new Map();
    const nlText = newlines(text), nlFolded = newlines(folded);
    if (nlFolded.length !== nlText.length) { // never measured; read the whole text as one line rather than guess
        nlText.length = 0;
        nlFolded.length = 0;
    }
    const lines = nlText.length + 1;
    const start = (k) => (k === 0 ? 0 : nlText[k - 1] + 1);
    const end = (k) => (k < nlText.length ? nlText[k] : text.length);
    const candidates = new Set();
    for (const i of terms) {
        const head = (c.words ? c.tokens[i][0] : c.tokens[i][0].split(' ')[0]).normalize('NFKD');
        for (let p = folded.indexOf(head); p >= 0;) {
            const k = countBelow(nlFolded, p);
            candidates.add(k);
            if (k >= nlFolded.length)
                break;
            p = folded.indexOf(head, nlFolded[k] + 1); // the next line: one hit per line is enough to read it
        }
    }
    const readingByLine = new Map();
    const lineReading = (k) => {
        let n = readingByLine.get(k);
        if (n === undefined) {
            n = substringText(text.slice(start(k), end(k))).text.length;
            readingByLine.set(k, n);
        }
        return n;
    };
    const tokensByLine = new Map();
    const lineTokens = (k) => {
        let t = tokensByLine.get(k);
        if (!t) {
            const base = start(k);
            t = tokensOf(text.slice(base, end(k)), c.segment).map((x) => ({ token: x.token, at: x.at + base }));
            tokensByLine.set(k, t);
        }
        return t;
    };
    for (const k of [...candidates].sort((a, b) => a - b)) {
        const pending = terms.filter((i) => !out.has(i));
        if (!pending.length)
            break;
        if (c.words) {
            const own = lineTokens(k);
            if (!own.length)
                continue;
            // a phrase that starts on line k may end on a later line: the tokens after k's, as many as the longest needs
            const longest = Math.max(...pending.map((i) => c.tokens[i].length));
            const window = [...own];
            for (let m = k + 1; m < lines && window.length < own.length + longest - 1; m++)
                window.push(...lineTokens(m));
            for (const i of pending) {
                const p = phraseAt(window.slice(0, own.length + c.tokens[i].length - 1), c.tokens[i]);
                if (p >= 0)
                    out.set(i, window[p].at);
            }
        }
        else {
            // --substring: line k's reading, then the next lines' as long as a term starting on line k could reach them (the
            // lines' readings are joined by one space, as the whole text's are)
            const own = lineReading(k);
            const longest = Math.max(...pending.map((i) => c.tokens[i][0].length));
            let m = k, reach = own;
            while (m + 1 < lines && reach < own + 1 + longest) {
                m++;
                const n = lineReading(m);
                if (n)
                    reach += (reach ? 1 : 0) + n;
            }
            const st = substringText(text.slice(start(k), end(m)));
            for (const i of pending) {
                const j = st.text.indexOf(c.tokens[i][0]);
                if (j >= 0 && j < own)
                    out.set(i, start(k) + st.rawAt(j));
            }
        }
    }
    return out;
}
const step = (up, key) => ({ key, up });
/** The key path of a field, from the record: names passing the label rule (else (withheld)), and indices. */
function pathOf(p) {
    const out = [];
    for (let x = p; x; x = x.up)
        out.push(typeof x.key === 'number' ? x.key : label(x.key, WITHHELD));
    return out.reverse();
}
/** Every string under a value, depth first in key order; an object whose type is `image` is counted and not read.
 *  A field's path names the keys of the first `levels` levels under the value (a tool's parameters, an attachment's
 *  own keys), where an array is a level too, so the items of a tool input written as an array have no names; a key
 *  below them is data a tool or the model wrote, and its path names it (withheld). Array indices are always named. */
function walkStrings(v, path, kind, out, notes, levels) {
    const stack = [[v, path, levels]];
    while (stack.length) {
        const [x, p, n] = stack.pop();
        if (typeof x === 'string') {
            if (x)
                out.push({ kind, text: x, path: p });
            continue;
        }
        if (typeof x !== 'object' || x === null)
            continue;
        if (Array.isArray(x)) {
            for (let i = x.length - 1; i >= 0; i--)
                stack.push([x[i], step(p, i), n - 1]);
            continue;
        }
        if (x.type === 'image') {
            notes.images++;
            continue;
        }
        const keys = Object.keys(x);
        for (let i = keys.length - 1; i >= 0; i--)
            stack.push([x[keys[i]], step(p, n > 0 ? keys[i] : WITHHELD), n - 1]);
    }
}
/** Text blocks (and bare strings) of a content array, or a content string, under `path`. Image blocks are counted. */
function contentTexts(content, path, kind, out, notes, textKey = 'text') {
    if (typeof content === 'string') {
        if (content)
            out.push({ kind, text: content, path });
        return;
    }
    if (!Array.isArray(content))
        return;
    content.forEach((b, i) => {
        if (typeof b === 'string') {
            if (b)
                out.push({ kind, text: b, path: step(path, i) });
            return;
        }
        if (!isObj(b))
            return;
        if (b.type === 'image')
            notes.images++;
        else if (b.type === 'text' && typeof b[textKey] === 'string' && b[textKey])
            out.push({ kind, text: b[textKey], path: step(step(path, i), textKey) });
    });
}
/** The text of a tool_result block's content, as the spill test reads it: a string, or its text blocks joined. */
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join(NL) : '');
function fieldsOf(rec, out, notes) {
    if (rec.type === 'user' || rec.type === 'assistant') {
        const msg = rec.message, content = isObj(msg) ? msg.content : undefined;
        const base = step(step(null, 'message'), 'content');
        let kind;
        if (rec.type === 'user')
            kind = isToolResultRecord(rec) ? 'result' : isInputTurn(rec) ? 'input' : inputChannel(rec) === 'harness:compact-summary' ? 'summary' : 'meta';
        else
            kind = rec.isApiErrorMessage === true ? 'system' : 'reply';
        if (!Array.isArray(content)) {
            contentTexts(content, base, kind, out, notes);
            return;
        }
        content.forEach((b, i) => {
            if (!isObj(b))
                return;
            const at = step(base, i);
            if (b.type === 'text') {
                if (typeof b.text === 'string' && b.text)
                    out.push({ kind, text: b.text, path: step(at, 'text') });
            }
            else if (b.type === 'image')
                notes.images++;
            else if (b.type === 'tool_result') {
                if (SPILLED.test(resultText(b.content)))
                    notes.spilled = true;
                contentTexts(b.content, step(at, 'content'), 'result', out, notes);
            }
            else if (rec.type === 'assistant' && b.type === 'thinking') {
                if (typeof b.thinking === 'string' && b.thinking)
                    out.push({ kind: 'thinking', text: b.thinking, path: step(at, 'thinking') });
            }
            else if (rec.type === 'assistant' && b.type === 'redacted_thinking')
                notes.redacted++;
            else if (rec.type === 'assistant' && b.type === 'tool_use')
                walkStrings(b.input, step(at, 'input'), 'call', out, notes, 1);
        });
        return;
    }
    if (rec.type === 'system') {
        // the record's own keys are named; the keys below them are not
        for (const k of Object.keys(rec))
            if (!ENVELOPE.has(k) && !SYSTEM_NAMES.has(k))
                walkStrings(rec[k], step(null, k), 'system', out, notes, 0);
        return;
    }
    if (rec.type === 'attachment') {
        const att = rec.attachment, at = step(null, 'attachment');
        if (isObj(att) && att.type === 'queued_command' && att.commandMode === 'prompt') {
            contentTexts(att.prompt, step(at, 'prompt'), 'input', out, notes);
            for (const k of Object.keys(att))
                if (k !== 'prompt')
                    walkStrings(att[k], step(at, k), 'attachment', out, notes, 0);
        }
        else
            walkStrings(att, at, 'attachment', out, notes, 1);
    }
}
// ---- 9. A transcript ------------------------------------------------------------------
/** A file's turns, each turn's records (its prompt first, then the call and result nodes of its calls, then its path
 *  records, sorted by line), and the counts of what is not searched that do not depend on the records' text (the
 *  record walk adds the others). searchTranscript and sieveTranscript both read a file through this one function. */
function turnRecordsOf(t) {
    const path = repairedLivePath(t).path;
    const turns = turnsOf(t, path);
    // a turn's records: its prompt first, then the call and result nodes of its calls, then its path records
    const owner = new Map();
    turns.forEach((turn, k) => owner.set(turn.prompt, k));
    turns.forEach((turn, k) => {
        for (const call of turn.toolCalls) {
            if (!owner.has(call.callNode))
                owner.set(call.callNode, k);
            if (call.resultNode && !owner.has(call.resultNode))
                owner.set(call.resultNode, k);
        }
    });
    // path records before the first prompt belong to T001; with no input turn, they are counted (each node once)
    const beforeFirstTurn = turns.length ? 0 : new Set(path).size;
    let cur = 0;
    if (turns.length)
        for (const n of path) {
            const k = owner.get(n);
            if (k !== undefined && turns[k].prompt === n) {
                cur = k;
                continue;
            }
            if (k === undefined)
                owner.set(n, cur);
        }
    const records = turns.map(() => []);
    for (const [n, k] of owner)
        records[k].push(n);
    for (const l of records)
        l.sort((a, b) => a.index - b.index);
    const ns = {
        offPath: t.nodes.size - owner.size - beforeFirstTurn, toolUseResult: 0, wireInputs: 0, redactedThinking: 0,
        sidecars: t.sidecars.length, images: 0, spilled: 0, replays: t.stats.replayedCopies, beforeFirstTurn,
        unreadableLines: t.stats.unparseable, kindsOff: 0,
    };
    return { turns, records, ns };
}
/** Search one transcript: its text, or the parser's Transcript of it. Turns holding every term of the query, in path
 *  order, with one entry per record and kind holding a term; the file's counts; its latest timestamp. A query with no
 *  terms matches nothing. */
export function searchTranscript(input, query, options = {}) {
    const t = typeof input === 'string' ? parseTranscript(input) : input;
    const kinds = new Set(options.kinds ?? SEARCH_DEFAULT_KINDS);
    const pre = options.prefix ? options.prefix + ':' : '';
    const c = compile(query);
    const nTerms = query.terms.length;
    const { turns, records, ns } = turnRecordsOf(t);
    const byKind = {};
    for (const k of SEARCH_KINDS)
        if (kinds.has(k))
            byKind[k] = 0;
    const gap = {};
    for (const s of query.gapScripts)
        gap[s] = 0;
    const hits = [];
    let searched = 0, hitRecords = 0;
    for (let k = 0; k < turns.length; k++) {
        const entries = [];
        const held = new Set();
        let recordsWithEntries = 0;
        for (const n of records[k]) {
            const rec = n.record;
            const fields = [], notes = { images: 0, redacted: 0, spilled: false };
            fieldsOf(rec, fields, notes);
            ns.images += notes.images;
            ns.redactedThinking += notes.redacted;
            if (notes.spilled)
                ns.spilled++;
            if ('toolUseResult' in rec)
                ns.toolUseResult++;
            if (rec.wireToolInputs !== undefined)
                ns.wireInputs++;
            let on = false, off = false;
            const byRecordKind = new Map();
            for (const f of fields) {
                if (!kinds.has(f.kind)) {
                    off = true;
                    continue;
                }
                on = true;
                if (query.gapScripts.length) {
                    const text = f.text.includes(BS) && HAS_ESCAPE.test(f.text) ? decodeEscapes(f.text).text : f.text;
                    for (const s of query.gapScripts)
                        gap[s] += countLetters(text, s);
                }
                if (!nTerms)
                    continue;
                const h = searchField(f.text, c);
                if (!h)
                    continue;
                let e = byRecordKind.get(f.kind);
                if (!e) {
                    e = { path: f.path, at: h.at, w: new Set() };
                    byRecordKind.set(f.kind, e);
                }
                for (const i of h.found)
                    e.w.add(i);
            }
            if (on || !off)
                searched++;
            else
                ns.kindsOff++;
            if (!byRecordKind.size)
                continue;
            recordsWithEntries++;
            const a = `${pre}L${t.positions[n.index].line}`;
            for (const kind of SEARCH_KINDS) {
                const e = byRecordKind.get(kind);
                if (!e)
                    continue;
                const w = [...e.w].sort((x, y) => x - y);
                for (const i of w)
                    held.add(i);
                entries.push({ a, kind, field: pathOf(e.path), at: e.at, w });
            }
        }
        if (!nTerms || held.size < nTerms)
            continue;
        hits.push({ ta: `${pre}T${pad3(k + 1)}`, ch: label(inputChannel(turns[k].prompt.record), 'none'), entries });
        hitRecords += recordsWithEntries;
        for (const kind of new Set(entries.map((e) => e.kind)))
            byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    return {
        turns: hits,
        counts: { parsed: t.records.length, turns: turns.length, searched, notSearched: ns, hits: { turns: hits.length, records: hitRecords, byKind }, gapScripts: gap },
        last: t.stats.lastTimestamp,
        fileKind: t.fileKind,
    };
}
// ---- 10. The sieve: what a search can know about a file without reading it again -------------
// A sieve holds, for one transcript, the counts a search adds up for it whatever the query (by the kinds searched),
// and what can be asked of its text without the text: which tokens it holds (words mode), and which 1- to
// 3-code-unit grams --substring's reading of it holds, each tagged with the kind of the text it came from. It holds
// no text: bits and counts. Neither test has false negatives: when the sieve says some term's tokens (or grams) are
// not all in any one kind searched, no field of that kind holds the term, so no turn holds every term, and the file's
// counts are the sieve's. When it says they may be, the file is read and searched as without a sieve. So a search with
// sieves prints what one without them prints.
//   words   a Bloom filter over (kind, token), the tokens tokensOf reads from each form of each field.
//   ascii   for each kind, one bit per possible gram of the 37 symbols --substring's reading of ASCII text is made of
//           (a-z, 0-9 and the space): exact, no false positives.
//   grams   a Bloom filter over (kind, gram) for every other gram (one holding a code unit outside those 37).
// Each entry of the two Bloom filters is also kept once with the tag ANY (any kind), which is asked first.
/** The sieve's format. Any change to what it holds, or to how the search reads text (the tokens, --substring's
 *  reading, which fields are of which kind, the gap scripts' letters), must change it: a sieve of another format is
 *  never used. */
export const SEARCH_SIEVE_FORMAT = 1;
const BLOOM_K = 7, BLOOM_BITS_PER_ENTRY = 10; // about 0.8 % false positives: a false positive only costs a read
/** The tag of an entry kept for every kind at once, beside its kind's own: checked first, so a term absent from the file
 *  is ruled out at one filter's rate of false positives, not at that rate times the kinds searched. */
const ANY = 9;
/** The 37 symbols of --substring's reading of ASCII text, and their grams: 37 + 37^2 + 37^3 bits, per kind. */
const SYMBOLS = 37, SIEVE_ASCII_GRAMS_RAW = SYMBOLS + SYMBOLS * SYMBOLS + SYMBOLS * SYMBOLS * SYMBOLS;
/** The bits one kind takes in `ascii`: SIEVE_ASCII_GRAMS_RAW rounded up to whole bytes. */
export const SEARCH_SIEVE_ASCII_GRAMS = Math.ceil(SIEVE_ASCII_GRAMS_RAW / 8) * 8;
/** A code unit's symbol: the space 0, 0-9 1 to 10, a-z 11 to 36; -1 for any other. */
const symbolOf = (c) => (c === 32 ? 0 : c >= 48 && c <= 57 ? c - 47 : c >= 97 && c <= 122 ? c - 86 : -1);
const asciiGram1 = (a) => a;
const asciiGram2 = (a, b) => SYMBOLS + a * SYMBOLS + b;
const asciiGram3 = (a, b, c) => SYMBOLS + SYMBOLS * SYMBOLS + (a * SYMBOLS + b) * SYMBOLS + c;
// 32-bit hashes, streamed so a token can be hashed while it is scanned. An entry is the kind's index, then a
// separator, then its code units: FNV-1a, finished by a mixer. The Bloom filter's probes come from the hash and a
// second mix of it (double hashing).
const FNV = 0x811c9dc5;
const fnv = (h, c) => Math.imul(h ^ c, 0x01000193);
function fmix(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}
/** The hash of a words-mode entry: the kind, ':', the token. */
function wordHash(kind, token) {
    let h = fnv(fnv(FNV, 48 + kind), 58);
    for (let i = 0; i < token.length; i++)
        h = fnv(h, token.charCodeAt(i));
    return fmix(h);
}
/** The hash of a gram entry: the kind, the gram's length, its code units (b and c only as n reaches them). */
function gramHash(kind, n, a, b, c) {
    let h = fnv(fnv(fnv(FNV, 48 + kind), 48 + n), a);
    if (n > 1)
        h = fnv(h, b);
    if (n > 2)
        h = fnv(h, c);
    return fmix(h);
}
/** A set of 32-bit hashes (open addressing in a typed array; 0 is stored as 1, which can only add a false positive). */
class HashSet32 {
    table = new Uint32Array(1 << 10);
    size = 0;
    add(h) {
        if (h === 0)
            h = 1;
        let t = this.table, mask = t.length - 1, i = h & mask;
        while (t[i] !== 0) {
            if (t[i] === h)
                return;
            i = (i + 1) & mask;
        }
        t[i] = h;
        if (++this.size * 2 > t.length) {
            const old = t;
            t = this.table = new Uint32Array(old.length * 2);
            mask = t.length - 1;
            for (const x of old)
                if (x !== 0) {
                    let j = x & mask;
                    while (t[j] !== 0)
                        j = (j + 1) & mask;
                    t[j] = x;
                }
        }
    }
}
function probes(h) { if (h === 0)
    h = 1; return [h, (fmix(h ^ 0x9e3779b9) | 1) >>> 0]; }
function bloomOf(set) {
    const m = Math.max(64, Math.ceil((set.size * BLOOM_BITS_PER_ENTRY) / 8) * 8);
    const bits = new Uint8Array(m / 8);
    for (const h of set.table) {
        if (h === 0)
            continue;
        const [a, b] = probes(h);
        for (let i = 0; i < BLOOM_K; i++) {
            const j = ((a + Math.imul(i, b)) >>> 0) % m;
            bits[j >> 3] |= 1 << (j & 7);
        }
    }
    return { m, k: BLOOM_K, bits };
}
function bloomHas(f, h) {
    const [a, b] = probes(h);
    for (let i = 0; i < f.k; i++) {
        const j = ((a + Math.imul(i, b)) >>> 0) % f.m;
        if (!(f.bits[j >> 3] & (1 << (j & 7))))
            return false;
    }
    return true;
}
const setBit = (bits, j) => { bits[j >> 3] |= 1 << (j & 7); };
const hasBit = (bits, j) => (bits[j >> 3] & (1 << (j & 7))) !== 0;
/** The gap scripts' letters, by code point: the index in SEARCH_GAP_SCRIPTS's keys, or -1 (computed once per code
 *  point, with the same regexes countLetters uses). */
const gapIndexCache = new Map();
function gapIndexOf(c, scripts) {
    let g = gapIndexCache.get(c);
    if (g === undefined) {
        const ch = String.fromCodePoint(c);
        g = -1;
        for (let s = 0; s < scripts.length; s++) {
            const r = gapLetters(scripts[s]);
            r.lastIndex = 0;
            if (r.test(ch)) {
                g = s;
                break;
            }
        }
        gapIndexCache.set(c, g);
    }
    return g;
}
/** The sieve of one transcript (its text, or the parser's Transcript of it), its words read with `segmenter`. */
export function sieveTranscript(input, segmenter) {
    const t = typeof input === 'string' ? parseTranscript(input) : input;
    const { turns, records, ns } = turnRecordsOf(t);
    const segment = segmenter === 'icu';
    const scripts = Object.keys(SEARCH_GAP_SCRIPTS);
    const letters = scripts.map(() => SEARCH_KINDS.map(() => 0));
    const masks = new Map();
    const words = new HashSet32(), grams = new HashSet32();
    const ascii = new Uint8Array((SEARCH_SIEVE_ASCII_GRAMS * SEARCH_KINDS.length) / 8);
    // One form's reading, streamed: its code units in order, each with the grams it ends (a gram never crosses a field's
    // form). Its pieces are joined by one space, as substringText joins them: `space` is owed before the next piece.
    let kind = 0, base = 0, count = 0, u1 = 0, u2 = 0, s1 = -1, s2 = -1, any = false;
    const startForm = (k) => { kind = k; base = k * SEARCH_SIEVE_ASCII_GRAMS; count = 0; any = false; };
    const push = (u) => {
        const s0 = symbolOf(u);
        if (s0 >= 0)
            setBit(ascii, base + asciiGram1(s0));
        else {
            grams.add(gramHash(kind, 1, u, 0, 0));
            grams.add(gramHash(ANY, 1, u, 0, 0));
        }
        if (count >= 1) {
            if (s0 >= 0 && s1 >= 0)
                setBit(ascii, base + asciiGram2(s1, s0));
            else {
                grams.add(gramHash(kind, 2, u1, u, 0));
                grams.add(gramHash(ANY, 2, u1, u, 0));
            }
        }
        if (count >= 2) {
            if (s0 >= 0 && s1 >= 0 && s2 >= 0)
                setBit(ascii, base + asciiGram3(s2, s1, s0));
            else {
                grams.add(gramHash(kind, 3, u2, u1, u));
                grams.add(gramHash(ANY, 3, u2, u1, u));
            }
        }
        u2 = u1;
        u1 = u;
        s2 = s1;
        s1 = s0;
        count++;
    };
    /** An ASCII stretch [a, b) of x (no code unit above 127): tokensOf's ASCII path (runs of A-Z, a-z and 0-9,
     *  lower-cased) into `words`, hashed as scanned, and those runs into the reading. */
    const asciiStretch = (x, a, b) => {
        let h = 0, ha = 0, inRun = false;
        for (let i = a; i <= b; i++) {
            let c = i < b ? x.charCodeAt(i) : 32;
            if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90)) {
                if (c <= 90 && c >= 65)
                    c += 32;
                if (!inRun) {
                    h = fnv(fnv(FNV, 48 + kind), 58);
                    ha = fnv(fnv(FNV, 48 + ANY), 58);
                    inRun = true;
                    if (any)
                        push(32);
                    any = true;
                }
                h = fnv(h, c);
                ha = fnv(ha, c);
                push(c);
            }
            else if (inRun) {
                words.add(fmix(h));
                words.add(fmix(ha));
                inRun = false;
            }
        }
    };
    /** Any other line: its tokens by tokensOf, its reading by substringText (a run of letters never crosses a new
     *  line, so a line's tokens and reading are the field's on that line). */
    const otherLine = (line) => {
        for (const tk of tokensOf(line, segment)) {
            words.add(wordHash(kind, tk.token));
            words.add(wordHash(ANY, tk.token));
        }
        const r = substringText(line).text;
        if (!r)
            return;
        if (any)
            push(32);
        any = true;
        for (let i = 0; i < r.length; i++)
            push(r.charCodeAt(i));
    };
    const form = (k, x) => {
        startForm(k);
        if (!NON_ASCII.test(x)) {
            asciiStretch(x, 0, x.length);
            return;
        }
        for (let a = 0; a <= x.length;) {
            let b = x.indexOf(NL, a);
            if (b < 0)
                b = x.length;
            let plain = true;
            for (let i = a; i < b; i++)
                if (x.charCodeAt(i) > 127) {
                    plain = false;
                    break;
                }
            if (plain)
                asciiStretch(x, a, b);
            else
                otherLine(x.slice(a, b));
            a = b + 1;
        }
    };
    for (const list of records)
        for (const n of list) {
            const rec = n.record;
            const fields = [], notes = { images: 0, redacted: 0, spilled: false };
            fieldsOf(rec, fields, notes);
            ns.images += notes.images;
            ns.redactedThinking += notes.redacted;
            if (notes.spilled)
                ns.spilled++;
            if ('toolUseResult' in rec)
                ns.toolUseResult++;
            if (rec.wireToolInputs !== undefined)
                ns.wireInputs++;
            let mask = 0;
            for (const f of fields) {
                const k = SEARCH_KINDS.indexOf(f.kind);
                mask |= 1 << k;
                // the forms searchField reads: the text as written, and with its JSON escapes decoded when it holds one
                const forms = [f.text];
                if (f.text.includes(BS) && HAS_ESCAPE.test(f.text))
                    forms.push(decodeEscapes(f.text).text);
                // searchTranscript counts a gap script's letters in the last form: one pass, by code point
                const lettersIn = forms[forms.length - 1];
                if (NON_ASCII.test(lettersIn)) {
                    for (let i = 0; i < lettersIn.length;) {
                        const c = lettersIn.codePointAt(i);
                        i += c > 0xffff ? 2 : 1;
                        if (c < 0x80)
                            continue;
                        const g = gapIndexOf(c, scripts);
                        if (g >= 0)
                            letters[g][k]++;
                    }
                }
                for (const x of forms)
                    form(k, x);
            }
            masks.set(mask, (masks.get(mask) ?? 0) + 1);
        }
    const gapLettersOut = {};
    scripts.forEach((s, i) => { gapLettersOut[s] = letters[i]; });
    return {
        format: SEARCH_SIEVE_FORMAT, segmenter, fileKind: t.fileKind, last: t.stats.lastTimestamp,
        parsed: t.records.length, turns: turns.length, notSearched: ns,
        masks: [...masks].sort((x, y) => x[0] - y[0]), gapLetters: gapLettersOut,
        words: bloomOf(words), ascii, grams: bloomOf(grams),
    };
}
/** Whether the sieve may hold a gram of `x` at i, of length n, in kind k (or, k ANY, in any of `ks`). */
function gramMay(s, k, x, i, n, ks) {
    const a = symbolOf(x.charCodeAt(i)), b = n > 1 ? symbolOf(x.charCodeAt(i + 1)) : 0, c = n > 2 ? symbolOf(x.charCodeAt(i + 2)) : 0;
    if (a >= 0 && b >= 0 && c >= 0) {
        const g = n === 1 ? asciiGram1(a) : n === 2 ? asciiGram2(a, b) : asciiGram3(a, b, c);
        return k === ANY ? ks.some((kk) => hasBit(s.ascii, kk * SEARCH_SIEVE_ASCII_GRAMS + g)) : hasBit(s.ascii, k * SEARCH_SIEVE_ASCII_GRAMS + g);
    }
    return bloomHas(s.grams, gramHash(k, n, x.charCodeAt(i), n > 1 ? x.charCodeAt(i + 1) : 0, n > 2 ? x.charCodeAt(i + 2) : 0));
}
/** Whether the sieve may hold every token (words mode) or gram (--substring) of a term in kind k (or ANY). */
function termMay(s, mode, term, k, ks) {
    if (mode === 'words')
        return term.tokens.every((tk) => bloomHas(s.words, wordHash(k, tk)));
    const x = term.tokens[0], n = Math.min(3, x.length);
    for (let i = 0; i + n <= x.length; i++)
        if (!gramMay(s, k, x, i, n, ks))
            return false;
    return true;
}
/** False only when no turn of the sieve's file can hold every term of the query in the kinds searched: some term's
 *  tokens (words mode) or grams (--substring) are not all in any one kind searched. True when the sieve cannot tell:
 *  then the file must be read. A sieve of another format, or a words-mode query read with another segmenter, always
 *  answers true. */
export function sieveMayHold(s, query, kinds = SEARCH_DEFAULT_KINDS) {
    if (s.format !== SEARCH_SIEVE_FORMAT || (query.mode === 'words' && s.segmenter !== query.segmenter))
        return true;
    if (!query.terms.length)
        return false;
    const ks = SEARCH_KINDS.map((k, i) => (kinds.includes(k) ? i : -1)).filter((i) => i >= 0);
    for (const term of query.terms) {
        // any kind first: a term absent from the file is ruled out here, at one filter's rate of false positives
        if (!termMay(s, query.mode, term, ANY, ks))
            return false;
        if (!ks.some((k) => termMay(s, query.mode, term, k, ks)))
            return false;
    }
    return true;
}
/** The SearchResult a search returns for the sieve's file when sieveMayHold is false: no turn, and the file's counts
 *  for these kinds and this query's gap scripts. */
export function sieveResult(s, query, kinds = SEARCH_DEFAULT_KINDS) {
    let on = 0;
    SEARCH_KINDS.forEach((k, i) => { if (kinds.includes(k))
        on |= 1 << i; });
    let searched = 0, kindsOff = 0;
    for (const [mask, n] of s.masks) {
        if (mask === 0 || (mask & on))
            searched += n;
        else
            kindsOff += n;
    }
    const byKind = {};
    for (const k of SEARCH_KINDS)
        if (kinds.includes(k))
            byKind[k] = 0;
    const gap = {};
    for (const x of query.gapScripts)
        gap[x] = SEARCH_KINDS.reduce((sum, k, i) => sum + (kinds.includes(k) ? s.gapLetters[x][i] : 0), 0);
    return {
        turns: [],
        counts: { parsed: s.parsed, turns: s.turns, searched, notSearched: { ...s.notSearched, kindsOff }, hits: { turns: 0, records: 0, byKind }, gapScripts: gap },
        last: s.last,
        fileKind: s.fileKind,
    };
}
