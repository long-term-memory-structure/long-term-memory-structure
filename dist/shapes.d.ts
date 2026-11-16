/** The report's format, named in its first line. */
export declare const SHAPES_FORMAT = "ltms-shapes/0";
/** The format a vocabulary file names in its `format` field. */
export declare const SHAPES_VOCABULARY_FORMAT = "ltms-shapes-vocabulary/0";
/** The longest line read by default; a longer one is counted (tooLong) as its bytes stream past, never held. */
export declare const SHAPES_MAX_LINE: number;
/** The number of files a path must be seen in to be printed, unless --floor says otherwise. */
export declare const SHAPES_FLOOR = 3;
/** The least floor --floor takes, and a report's first line may state; the largest is Number.MAX_SAFE_INTEGER (a floor is
 *  a whole number a double holds exactly, never one it rounds: S374's closure read, U7). */
export declare const SHAPES_MIN_FLOOR = 2;
/** The names (or values) kept per path for the local review list (--unlisted); the occurrences past them are counted. */
export declare const SHAPES_NAMES_PER_PATH = 2048;
/** A usage error: the run cannot start as given (exit 2). Its message is ltms's own, and quotes only what was given. */
export declare class ShapesUsageError extends Error {
    constructor(message: string);
}
/** The vocabulary, as the first line of a report names it. */
export interface ShapesVocabularyEntry {
    /** Its name (the label rule). */
    name: string;
    /** The first 12 hex digits of the sha256 of the file's bytes. */
    sha256: string;
    /** The number of entries in its paths list. */
    paths: number;
    /** The number of entries in its value lists. */
    values: number;
}
/** A vocabulary, read: every name and value a report may print, and where the kinds and versions are. */
export interface ShapesVocabulary {
    /** What a report's first line names. */
    list: ShapesVocabularyEntry[];
    /** The key paths that may be named, --allow's among them. */
    paths: Set<string>;
    /** Per value path, the values that may be printed, --allow's among them. */
    values: Map<string, Set<string>>;
    /** The path of a record's kind, or null (every record is of the kind (all)). */
    kindPath: string | null;
    /** Per kind, the path of its sub-kind. */
    sub: Map<string, string>;
    /** The version paths, in order: the first one a record has gives its version. */
    versions: string[];
}
/** Reads a vocabulary file (ltms-shapes-vocabulary/0). A file that cannot be read throws its own error; one that is not a
 *  vocabulary, that holds a field the format does not name (at its top or in kinds), whose path, name or value breaks
 *  the rules, that names in kinds, versions or values a path that paths does not list, or that names in kinds.sub a kind
 *  that values does not list at the kind path, is a usage error whose message names the entry by its field and index
 *  (paths[3], values[".kind"][2], kinds.sub["event"], versions[0]). */
export declare function loadVocabulary(file: string): ShapesVocabulary;
/** --allow <path> or --allow <path>=<value>: the person names a key path (and with it every path above it) or a value, to
 *  print. Adds them to the vocabulary; returns the allowed list as the first line prints it, sorted, each once. A value
 *  at a kind path may not hold ':' (S374's closure read, U15): it would merge two kinds of record into one line. */
export declare function applyAllow(V: ShapesVocabulary, specs: readonly string[]): string[];
/** A path that could not be read, with its error (the command words the message). */
export interface ShapesFailure {
    /** The path, as given or as met under a directory given. */
    path: string;
    /** What reading it threw. */
    error: unknown;
}
/** The files to read. */
export interface ShapesFiles {
    /** Each file once (by its device and inode), sorted. */
    files: string[];
    /** The paths given that do not exist, and the directories and files under them that could not be read. */
    failed: ShapesFailure[];
    /** The symbolic links met under the directories given: counted, not followed. */
    symlinks: number;
    /** The entries named .jsonl under the directories given that are not regular files (a FIFO, a socket, a device):
     *  counted, not read (S374's closure read, U13). */
    special: number;
    /** The directories met again under a path given: the same device and inode as one entered before in that path's walk
     *  (a bind mount of a directory inside itself shows them), not entered again; each counted once, as search counts
     *  them (S375's known issue k15). */
    again: number;
    /** The entries under the directories given whose names are not valid UTF-8, a directory or a name that ends in
     *  .jsonl: its directory, its name's bytes, and whether it is a directory. Not read (ltms reads paths as text, and
     *  such a name, decoded, can name another entry), each a failure (S374's closure read, S7). */
    notUtf8: {
        dir: string;
        name: Buffer;
        isDir: boolean;
    }[];
}
/** Every file named, and every .jsonl under a directory named (at any depth; symbolic links counted, not followed; an
 *  entry named .jsonl that is not a regular file counted, not read; a name that is not valid UTF-8 kept by its bytes and
 *  not read; a directory met again in a path's walk, by its device and inode, not entered again, and counted). Each
 *  directory is entered once per path given, as search enters it, and its entries are counted the first time it is
 *  listed, so each entry is counted once however many paths given reach it. Sorted, so a run does not depend on the
 *  order the paths were given or listed in. */
export declare function collectFiles(paths: readonly string[]): ShapesFiles;
/** Calls onLine(bytes) for each line of the file, split on byte 0x0A (which never occurs inside a UTF-8 sequence; a last
 *  line without a new line is read), or onLine(null) for a line longer than maxLine bytes, whose bytes are passed over as
 *  they stream past and never held; onLine returns false to read no further. Memory: one chunk, plus at most maxLine
 *  bytes of one line. */
export declare function readLines(file: string, maxLine: number, onLine: (line: Buffer | null) => boolean | void): void;
/** A count: its occurrences, its files, and the last file it was counted in (by its number in the run). */
export type ShapesCount = [n: number, f: number, last: number];
/** What one (kind, path) line has counted. */
export interface ShapesPathCount {
    /** The record kind. */
    kind: string;
    /** The key path: vocabulary steps, one .* step, or a [] step. */
    path: string;
    /** Occurrences. */
    n: number;
    /** Files. */
    f: number;
    /** The last file counted, by its number. */
    last: number;
    /** The versions in force where it occurs. */
    vers: Set<string>;
    /** The version last added to vers. */
    lastVer: string | undefined;
    /** Per group and label (joined by a NUL), its count. */
    sub: Map<string, ShapesCount>;
    /** On a .* line, the distinct names merged there, at most 64, never printed: only how many. */
    names: Set<string> | null;
}
/** What one record kind has counted. */
export interface ShapesKindCount {
    /** Records. */
    n: number;
    /** Files. */
    f: number;
    /** The last file counted, by its number. */
    last: number;
    /** Per version in force, its records. */
    vers: Map<string, ShapesCount>;
}
/** The names (or values) the vocabulary lacks at one path, for the local review list. */
export interface ShapesUnlisted {
    /** Per name (or value), its count; at most 2048, the first met. */
    names: Map<string, ShapesCount>;
    /** The occurrences of the names (or values) past the 2048 kept: counted, not kept (S374's closure read, S5, for the
     *  values). */
    overflow: number;
}
/** What reading the files counted. */
export interface ShapesRun {
    /** Files read to their end. */
    filesRead: number;
    /** Files that could not be read, or whose reading stopped with an error. */
    filesFailed: number;
    /** Files not read, being ltms shapes' own output, not transcripts: their first line is a report's or an --unlisted
     *  list's (S374's closure read, U5). Neither read nor failed. */
    skipped: string[];
    /** Those files, with their errors. */
    failures: {
        file: string;
        error: unknown;
    }[];
    /** Lines that are JSON objects. */
    records: number;
    /** Empty lines, and lines of white space only. */
    blank: number;
    /** Lines that are not JSON. */
    notJson: number;
    /** Lines that are JSON but not an object. */
    notObject: number;
    /** Lines longer than the line cap, never read. */
    tooLong: number;
    /** Per version in force, its records. */
    versions: Map<string, ShapesCount>;
    /** Per record kind, what it counted. */
    kinds: Map<string, ShapesKindCount>;
    /** Per (kind, path), what it counted. */
    lines: Map<string, ShapesPathCount>;
    /** --unlisted only: per .* path, the names merged there. */
    unlisted: Map<string, ShapesUnlisted> | null;
    /** --unlisted only: per value path, the values the vocabulary lacks: at a path that lists values, as the walk meets
     *  them; at the kind path and a sub-kind's path, as the reading of the kind meets them where the walk keeps none (no
     *  list there, or a path it does not reach). */
    unlistedValues: Map<string, ShapesUnlisted> | null;
}
/** How to read. */
export interface ShapesReadOptions {
    /** The line cap, in bytes. */
    maxLine: number;
    /** Keep the names and values the vocabulary lacks, for the local review list. */
    unlisted: boolean;
}
/** Reads the files, one at a time, each line alone, and counts. Per record: the version in force (the value at the first
 *  version path the record has, if it follows the version rule; (withheld) for any other value; else the version before
 *  it in the same file, or (none) before the file's first); its kind; and the walk, along vocabulary paths only: a key
 *  the vocabulary holds is counted at its path and walked, any other is counted at the .* of the object it is in, and
 *  the walk stops there. A file whose reading throws counts as failed; what was read of it before is counted. A file
 *  whose first line is a report's or an --unlisted list's is ltms shapes' own output: nothing of it is read, and it is
 *  listed in skipped. */
export declare function readShapes(V: ShapesVocabulary, files: readonly string[], opts: ShapesReadOptions): ShapesRun;
/** A line of a report, as built and as written: one JSON object whose `k` names its kind. */
export type ShapesLine = Record<string, unknown>;
/** A report, built, and the counts of its path lines (for the command's closing line on stderr). */
export interface ShapesReport {
    /** Its lines, in the order written: the header, the versions, the kinds, the paths, the rare lines, the end. */
    lines: ShapesLine[];
    /** The (kind, path) lines counted. */
    pathLines: number;
    /** Those printed: seen in at least floor files. */
    printed: number;
    /** Those under the floor, counted in the rare lines. */
    belowFloor: number;
}
/** The report of a run. Every count becomes a bucket; a path line seen in fewer than floor files is not printed and is
 *  counted in its kind's rare line; a sub-count over fewer than floor files folds into (rare). The lines are sorted
 *  (versions in numeric order, equal numbers by their text, then kinds, then paths by kind and path, then the rare
 *  lines), and their fields come in a fixed order, so the same files give the same bytes whatever the order of the files
 *  and of the keys in each record. */
export declare function buildReport(V: ShapesVocabulary, S: ShapesRun, floor: number, allowed: readonly string[]): ShapesReport;
/** The language of one report: the vocabulary (with --allow's names), the allowed list its first line must print, and,
 *  at the write, the floor and the number of lines it must state. */
export interface ShapesLanguage {
    /** The vocabulary, --allow applied. */
    V: ShapesVocabulary;
    /** The allowed list, as the first line must print it. */
    allowed: string[];
    /** Every kind a line may name. */
    kindTokens: Set<string>;
    /** At the write: the floor the first line must state; null for --check, which reads it from the report. */
    floor: number | null;
    /** At the write: the number the end line must state; null for --check, which counts the report's lines. */
    lines: number | null;
}
/** The language a report of this vocabulary and allowed list is written in. `expect`, at the write, is the run's floor
 *  and its number of lines. */
export declare function shapesLanguage(V: ShapesVocabulary, allowed: readonly string[], expect?: {
    floor: number;
    lines: number;
}): ShapesLanguage;
/** Is this line in the report's language? null when it is; otherwise why not, as one of this function's own words, never
 *  a part of the line: 'not an object'; 'k' (no line kind of the format); 'fields' (one missing, or one its kind does
 *  not have); the name of the field that failed (S374's closure read, U10); or, on a path line whose fields each pass,
 *  what it says of itself that the builder never writes: 'first without last', 'last without first', 'first after
 *  last', 'n under files' (n's bucket below files', S375's known issue k10). */
export declare function checkLine(o: unknown, Lg: ShapesLanguage): string | null;
/** A problem of a report: the number of its line, and why, as one of the check's own words (checkLine's, or one of the
 *  report as a whole: CHECK_WORDS), never a part of the line. */
export interface ShapesProblem {
    /** The line's number in the report, from 1. */
    line: number;
    /** Why it is not in the language. */
    why: string;
}
/** The words of the report as a whole, beside checkLine's: a line that is 'blank' or 'not JSON'; a line that is in the
 *  language alone but not where it stands
 *  ('first line': line 1 is not a first line; 'second first line'; 'end before the last line'; 'order': out of the
 *  format's order of line kinds, or of its kind's order; 'repeat': the same key as the line of its kind before it;
 *  'under the floor': a path line in fewer files than the floor), one not written as the builder writes it ('form'), and
 *  the end ('cut': the last line is not an end line; 'count': the end line does not count the report's lines). */
export declare const CHECK_WORDS: string[];
/** THE CHECK OF A REPORT WHOLE, the same at the write and at --check (S374's closure read, S3 and U6). `rows` are its
 *  lines' text (null: a line that has none, an object JSON cannot write). Each line alone: JSON, an object, in the
 *  language (checkLine), and written byte for byte as the builder writes it (canonicalText: its fields in the format's
 *  order, each map's keys in the builder's order, each key once, no space, JSON's own spelling of every string and
 *  number). Then each line in its place: line 1 the first line, and no other; the line kinds in the format's order
 *  (shapes, version, kind, path, rare, end); within each kind, the lines strictly in the builder's order, so none
 *  repeats; a path line in at least the floor's files; one end line, the last, that counts the lines. A line that fails
 *  alone is not held to its place. Returns the problems, by line; none when the report is in the language. */
export declare function checkRows(rows: readonly (string | null)[], Lg: ShapesLanguage): ShapesProblem[];
/** What writeReport did. */
export interface ShapesWritten {
    /** Lines written: every line of the report, or none. */
    written: number;
    /** The lines that failed the check (each a bug in ltms); when there is one, nothing is written. */
    refused: number;
    /** Each problem, by its line's number in the report and why (checkRows' words). */
    reasons: ShapesProblem[];
    /** Bytes written. */
    bytes: number;
}
/** THE WRITE GUARD, and the only way a report leaves this module. Each line is turned into the text that will be
 *  written; the report, that text, is checked whole (checkRows: each line parsed back and checked against the language,
 *  and each in its place) before any of it is written; and only that text is written: what is checked is exactly what
 *  goes out (an object whose JSON is not its own fields, through an inherited toJSON say, cannot pass as one line and be
 *  written as another: S374's closure read, S1). A report with any problem is not written at all: no part of a report
 *  out of the language (a line repeated, say) leaves, and which lines failed cannot be read from what does. `write` is
 *  given the text in parts of at most 1,000 lines. */
export declare function writeReport(lines: readonly unknown[], Lg: ShapesLanguage, write: (text: string) => void): ShapesWritten;
/** What --check found in a report file. */
export type ShapesCheck = {
    k: 'not-a-report';
    /** Why: the file is empty; its first line is blank, not JSON, or JSON but not an object; it is an --unlisted list
     *  (its first line's k is unlisted-review); or its first line is no report's first line. */
    why: 'empty' | 'blank' | 'not JSON' | 'not an object' | 'unlisted' | 'not a first line';
} | {
    k: 'bad-allowed';
    /** Each string of the first line's allowed list that --allow refuses: its index in the list, from 0, and the rule it
     *  breaks, in the module's words, which hold no part of it (S375's known issue k1). Nothing else is checked. */
    refused: {
        index: number;
        rule: string;
    }[];
} | {
    k: 'checked';
    /** The report's lines, checked: the file's lines but the blank lines at its end. */
    lines: number;
    /** The file's lines, those blank lines among them. */
    rows: number;
    /** Each problem, by its line's number and why (checkRows' words, and the file's own: 'byte-order mark',
     *  'carriage return', 'blank at the end'), in the order of the lines. */
    problems: ShapesProblem[];
    /** The allowed list of its first line, as read. */
    allowed: string[];
};
/** --check: is this report, every token of it and every line in its place, in its language? The language is the
 *  vocabulary given and the report's own allowed list (its first line), each of whose strings --allow must take: one it
 *  refuses is named (bad-allowed), by its index and the rule it breaks, and nothing else is checked. The report is
 *  checked whole as the writer checks it (checkRows), its floor the one its first line states. It cannot tell whether
 *  ltms wrote it, nor whether its counts are true. What ltms never writes, and an editor or a shell can add (S374's
 *  closure read, U10), is named for what it is: a byte-order mark before line 1, a carriage return at the end of a line
 *  (CR LF), blank lines after the last line; each is a problem, and is taken off for the rest of the check, so that the
 *  lines are checked as they would be without it. */
export declare function checkReport(text: string, V: ShapesVocabulary): ShapesCheck;
/** --unlisted: NOT a report. The names and values the vocabulary lacks, read from the transcripts as written, for the
 *  person's own review before an --allow; every line says "send":false, and --check refuses the list. Exact counts. A
 *  name that cannot be a path step (a file path, say), or a value --allow refuses (not a label; ':' at a kind path),
 *  gets "allow":null: it can never be allowed. */
export declare function reviewLines(S: ShapesRun, V: ShapesVocabulary): ShapesLine[];
/** What an --unlisted list holds, counted from its lines (for the command's closing line): the names and the values
 *  listed, each with the number of paths they are at, and the occurrences counted past the 2048 kept at a path (its
 *  unlisted-more line), for names (at a .* path) and for values (at a value path, which never ends in .*). */
export interface ShapesReviewTotals {
    /** unlisted lines, and the .* paths they are at. */
    names: number;
    namePaths: number;
    /** unlisted-value lines, and the paths they are at. */
    values: number;
    valuePaths: number;
    /** The occurrences of names past the cap, and the .* paths with an unlisted-more line. */
    moreNames: number;
    moreNamePaths: number;
    /** The occurrences of values past the cap, and the value paths with an unlisted-more line. */
    moreValues: number;
    moreValuePaths: number;
}
export declare function reviewTotals(lines: readonly ShapesLine[]): ShapesReviewTotals;
