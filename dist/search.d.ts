import type { FileKind, Transcript } from './parser.js';
/** A kind of text, as the README's table names them. */
export type SearchKind = 'input' | 'summary' | 'reply' | 'thinking' | 'call' | 'result' | 'system' | 'meta' | 'attachment';
/** Every kind, in the table's order: the order of one record's entries in a hit, and of `hits.byKind`. */
export declare const SEARCH_KINDS: readonly SearchKind[];
/** The kinds searched when none are named: every kind but meta and attachment, which hold the harness's own text. */
export declare const SEARCH_DEFAULT_KINDS: readonly SearchKind[];
/** `words`: a term matches a field holding its tokens. `substring`: a term matches a field holding it as a substring. */
export type SearchMode = 'words' | 'substring';
/** `icu`: spaceless runs are split into dictionary words. `no-dictionary`: they stay whole. */
export type SearchSegmenter = 'icu' | 'no-dictionary';
/** The scripts with a known gap, and which gap: words with attached clitics, or no spaces between words. */
export declare const SEARCH_GAP_SCRIPTS: Readonly<Record<string, 'clitics' | 'spaceless'>>;
/** A token, and the UTF-16 offset of its first character in the string it was read from. */
export interface SearchToken {
    token: string;
    at: number;
}
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
/** Whether this runtime can run the search (Unicode property escapes, Intl, String.prototype.normalize), and whether
 *  its Intl.Segmenter splits spaceless scripts into dictionary words: a known Thai and a known Chinese string, built
 *  from code points, must split into their known words for `icu`. Computed once. */
export declare function checkSearchSupport(): SearchSupport;
/** The text as --substring reads it: each run of letters, marks, digits and format characters normalized (NFKD, lower
 *  case, final sigma to sigma, marks, format characters and U+0640 removed, U+200B a break, NFC), the runs of letters
 *  and digits joined by one space, so every run of anything else has become one space and none is at either end. */
export declare function normalizeForSearch(text: string): string;
/** Words mode's tokens of a string, each with the UTF-16 offset of its first character in it (steps 1 to 4 above).
 *  The same function reads the query and the text. */
export declare function tokenizeForSearch(text: string, options?: {
    segmenter?: SearchSegmenter;
}): SearchToken[];
/** The query, read: words separated by white space, ANDed. A `"` or a U+201C where a word starts opens a phrase, which
 *  ends at the matching `"` or U+201D, or runs to the end of the query (`unbalanced`); a quote inside a word is part of
 *  the word. Each term is read by the same function as the text: in words mode, its tokens (several make it a
 *  phrase); in substring mode, normalizeForSearch of it. A term that reads as nothing is dropped. */
export declare function parseSearchQuery(query: string, options?: SearchQueryOptions): SearchQuery;
/** Search one transcript: its text, or the parser's Transcript of it. Turns holding every term of the query, in path
 *  order, with one entry per record and kind holding a term; the file's counts; its latest timestamp. A query with no
 *  terms matches nothing. */
export declare function searchTranscript(input: string | Transcript, query: SearchQuery, options?: SearchOptions): SearchResult;
/** The sieve's format. Any change to what it holds, or to how the search reads text (the tokens, --substring's
 *  reading, which fields are of which kind, the gap scripts' letters), must change it: a sieve of another format is
 *  never used. */
export declare const SEARCH_SIEVE_FORMAT = 1;
/** A Bloom filter: `m` bits (a multiple of 8), `k` probes per entry. */
export interface SearchBloom {
    m: number;
    k: number;
    bits: Uint8Array;
}
/** What a search can know about one transcript without reading it again (sieveTranscript). */
export interface SearchSieve {
    format: number;
    /** The segmenter the words were read with: a sieve answers a words-mode query only when it was read with the same. */
    segmenter: SearchSegmenter;
    fileKind: FileKind;
    last: string | null;
    parsed: number;
    turns: number;
    /** The not-searched counts that do not depend on the kinds searched; kindsOff is 0 here (see masks). */
    notSearched: SearchNotSearched;
    /** The turn records, by the set of kinds their text is of (bit i is SEARCH_KINDS[i]; 0: no text): [set, records]. */
    masks: [number, number][];
    /** For each script of SEARCH_GAP_SCRIPTS, its letters in the text of each kind, in SEARCH_KINDS order. */
    gapLetters: Record<string, number[]>;
    words: SearchBloom;
    /** SEARCH_SIEVE_ASCII_GRAMS bits per kind, in SEARCH_KINDS order. */
    ascii: Uint8Array;
    grams: SearchBloom;
}
/** The bits one kind takes in `ascii`: SIEVE_ASCII_GRAMS_RAW rounded up to whole bytes. */
export declare const SEARCH_SIEVE_ASCII_GRAMS: number;
/** The sieve of one transcript (its text, or the parser's Transcript of it), its words read with `segmenter`. */
export declare function sieveTranscript(input: string | Transcript, segmenter: SearchSegmenter): SearchSieve;
/** False only when no turn of the sieve's file can hold every term of the query in the kinds searched: some term's
 *  tokens (words mode) or grams (--substring) are not all in any one kind searched. True when the sieve cannot tell:
 *  then the file must be read. A sieve of another format, or a words-mode query read with another segmenter, always
 *  answers true. */
export declare function sieveMayHold(s: SearchSieve, query: SearchQuery, kinds?: readonly SearchKind[]): boolean;
/** The SearchResult a search returns for the sieve's file when sieveMayHold is false: no turn, and the file's counts
 *  for these kinds and this query's gap scripts. */
export declare function sieveResult(s: SearchSieve, query: SearchQuery, kinds?: readonly SearchKind[]): SearchResult;
