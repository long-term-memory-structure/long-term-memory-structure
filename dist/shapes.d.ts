/** The report's format, named in its first line. */
export declare const SHAPES_FORMAT = "ltms-shapes/0";
/** The format a vocabulary file names in its `format` field. */
export declare const SHAPES_VOCABULARY_FORMAT = "ltms-shapes-vocabulary/0";
/** The longest line read by default; a longer one is counted (tooLong) as its bytes stream past, never held. */
export declare const SHAPES_MAX_LINE: number;
/** The number of files a path must be seen in to be printed, unless --floor says otherwise. */
export declare const SHAPES_FLOOR = 3;
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
 *  the rules, or that names in kinds, versions or values a path that paths does not list, is a usage error whose
 *  message names the entry by its field and index (paths[3], values[".type"][2], kinds.sub["system"], versions[0]). */
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
}
/** Every file named, and every .jsonl under a directory named (at any depth; symbolic links counted, not followed; a
 *  directory met twice, by its device and inode, read once). Sorted, so a run does not depend on the order the paths were
 *  given or listed in. */
export declare function collectFiles(paths: readonly string[]): ShapesFiles;
/** Calls onLine(bytes) for each line of the file, split on byte 0x0A (which never occurs inside a UTF-8 sequence; a last
 *  line without a new line is read), or onLine(null) for a line longer than maxLine bytes, whose bytes are passed over as
 *  they stream past and never held. Memory: one chunk, plus at most maxLine bytes of one line. */
export declare function readLines(file: string, maxLine: number, onLine: (line: Buffer | null) => void): void;
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
    /** Per name, its count; at most 2048 names. */
    names: Map<string, ShapesCount>;
    /** The occurrences of the names past the 2048 kept. */
    overflow: number;
}
/** What reading the files counted. */
export interface ShapesRun {
    /** Files read to their end. */
    filesRead: number;
    /** Files that could not be read, or whose reading stopped with an error. */
    filesFailed: number;
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
    /** --unlisted only: per value path, the values the vocabulary lacks. */
    unlistedValues: Map<string, Map<string, ShapesCount>> | null;
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
 *  the walk stops there. A file whose reading throws counts as failed; what was read of it before is counted. */
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
/** Is this line in the report's language? null when it is; otherwise why not, as one of this function's own words (the
 *  field or the line kind that failed), never a part of the line. */
export declare function checkLine(o: unknown, Lg: ShapesLanguage): string | null;
/** What writeReport did. */
export interface ShapesWritten {
    /** Lines written. */
    written: number;
    /** Lines refused at the write (each a bug in ltms): not written. */
    refused: number;
    /** For each refused line, its number in the report and why (checkLine's word). */
    reasons: {
        line: number;
        why: string;
    }[];
    /** Bytes written. */
    bytes: number;
}
/** THE WRITE GUARD, and the only way a report leaves this module: each line is turned into the text that will be
 *  written, that text is parsed back and checked against the language, and only that text is written: what is checked is
 *  exactly what goes out (an object whose JSON is not its own fields, through an inherited toJSON say, cannot pass as one
 *  line and be written as another: S374's closure read, S1). A line that fails is not written. `write` is given the text
 *  in parts of at most 1,000 lines. */
export declare function writeReport(lines: readonly unknown[], Lg: ShapesLanguage, write: (text: string) => void): ShapesWritten;
/** What --check found in a report file. */
export type ShapesCheck = {
    k: 'not-a-report';
} | {
    k: 'bad-allowed';
} | {
    k: 'checked';
    /** The lines read. */
    lines: number;
    /** Each line outside the language, by its number and checkLine's word; the cut or edited end, as 'end'. */
    problems: {
        line: number;
        why: string;
    }[];
    /** The allowed list of its first line, as read. */
    allowed: string[];
};
/** --check: is every token of this report in its language? The language is the vocabulary given and the report's own
 *  allowed list (its first line); every line is checked as the writer checks it, and the last line must be an end line
 *  that counts the report's lines. */
export declare function checkReport(text: string, V: ShapesVocabulary): ShapesCheck;
/** --unlisted: NOT a report. The names and values the vocabulary lacks, read from the transcripts as written, for the
 *  person's own review before an --allow; every line says "send":false, and --check refuses the list. Exact counts. A
 *  name that cannot be a path step (a file path, say), or a value --allow refuses (not a label; ':' at a kind path),
 *  gets "allow":null: it can never be allowed. */
export declare function reviewLines(S: ShapesRun, V: ShapesVocabulary): ShapesLine[];
