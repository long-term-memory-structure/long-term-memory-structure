/** The format a records file names in its header. */
export declare const RECORDS_FORMAT = "ltms-records/0";
/** Every kind a record may have, in the order the balance line prints them. */
export declare const RECORD_KINDS: readonly ["input", "reply", "thinking", "tool call", "tool result", "system", "context", "summary", "compaction", "marker", "other", "blank", "malformed"];
/** A record's kind. */
export type RecordKind = typeof RECORD_KINDS[number];
/** Where a record's bytes are: one line of the source. */
export interface RecordSrc {
    /** The address's kind: a line (the only kind version 0 defines). */
    kind: 'line';
    /** The line's number, 1-based, counting every line, blank ones too. */
    line: number;
    /** The byte offset of the line's start in the file. */
    offset: number;
    /** The line's length in bytes, without its newline (a carriage return before it counted). */
    bytes: number;
    /** The sha256 of exactly those bytes, in hex. */
    sha256: string;
}
/** What the source says of a record: each value only when the record has its key, as written when it passes the label
 *  rule, else (withheld), as is a value that is not a string. */
export interface RecordSupplier {
    /** Its type. */
    type?: string;
    /** A system record's subtype, or an attachment's type (its attachment's type key). */
    subtype?: string;
    /** Its uuid, on any record that has one, with a parentUuid or without (a sidecar's too). */
    id?: string;
    /** Its parentUuid, or null for a root, on any record that has one, with a uuid or without. */
    parent?: string | null;
    /** The version of the program that wrote it. */
    version?: string;
    /** Its leafUuid (a marker's: the record the session's head points to), whether or not a record in the file carries
     *  it. */
    leaf?: string;
    /** Its logicalParentUuid (a compaction's boundary: the record before it), whether or not a record in the file carries
     *  it. */
    logical_parent?: string;
    /** The tool_use_id of each of its tool_result blocks, in block order (a user record's). */
    calls?: string[];
    /** Its sessionId. */
    session?: string;
}
/** A record's time, as the source stamped it. */
export interface RecordTime {
    /** The stamp, as written. */
    as_written: string;
    /** The same instant in UTC, when the stamp names its zone and parses. */
    utc?: string;
    /** What the time is: the source's own stamp. */
    kind: 'stamped';
}
/** One record of the view: one raw line of the source. */
export interface ViewRecord {
    /** Its address: <prefix>:L<line>, as ltms's line addresses. */
    id: string;
    /** Its kind (the module's header says how each is decided). */
    kind: RecordKind;
    /** Every block's kind, when an assistant record holds several. */
    kinds?: RecordKind[];
    /** Its place in the source, 1-based: its line. */
    order: number;
    /** The address of its parent, or null. */
    parent: string | null;
    /** Where the parent link comes from: the source ("supplied"), or nowhere ("none": a record outside the tree). */
    parent_by: 'supplied' | 'none';
    /** The address of the record its leafUuid names (a marker's: the session's head), or null when not in the file. */
    leaf?: string | null;
    /** The address of the record its logicalParentUuid names (a compaction's boundary), or null when not in the file. */
    logical_parent?: string | null;
    /** For each tool result block, in order, the address of the record that holds its call, or null when not in the file. */
    calls?: (string | null)[];
    /** The response it belongs to (an assistant record's requestId, else its message id). */
    group?: string;
    /** The first record that carries its uuid, when it is a replay. */
    dup_of?: string;
    /** What the source says of it. */
    supplier?: RecordSupplier;
    /** Its time. */
    time?: RecordTime;
    /** Where its bytes are. */
    src: RecordSrc;
}
/** The first line of a records file. */
export interface RecordsHeader {
    format: typeof RECORDS_FORMAT;
    kind: 'header';
    source: {
        /** The address prefix its records' ids carry. */
        id: string;
        /** The file's path, as the command resolved it. */
        path: string;
        /** The file's length in bytes. */
        bytes: number;
        /** Its lines that end in a newline: what `wc -l` counts. */
        lines: number;
        /** True when the file's last line has no newline (it is a record too, counted apart from lines). */
        last_line_unterminated: boolean;
        /** When it was read (UTC). */
        read_at: string;
    };
    supplier: {
        name: 'claude-code';
        versions: string[];
    };
    converter: {
        name: 'ltms';
        version: string;
    };
    /** The records hold no text: it is read from the source through each record's src. */
    content: 'by-address';
}
/** The count that must balance, and what it is made of. */
export interface RecordsBalance {
    /** Lines read: the newline-terminated ones, and a last one without a newline. */
    linesRead: number;
    /** Records written. */
    recordsWritten: number;
    /** Records per kind. */
    byKind: Record<RecordKind, number>;
    /** Records that repeat an earlier record's uuid. */
    dupOf: number;
    /** Parent links: resolved in the file; roots (parentUuid null); named but not in the file; records outside the tree. */
    parents: {
        resolved: number;
        root: number;
        unresolved: number;
        none: number;
    };
    /** The other links (leaf, logical_parent, calls): found in the file, or not. */
    links: {
        found: number;
        missing: number;
    };
}
/** What the command gives recordsOf. */
export interface RecordsOptions {
    /** The address prefix (cli.ts's prefixOf). */
    prefix: string;
    /** The file's path, as the header names it. */
    path: string;
    /** When it was read, as an ISO 8601 time in UTC. */
    readAt: string;
    /** This package's version. */
    converterVersion: string;
}
/** A Claude Code record's kind (the draft's section 13). */
export declare function kindOf(r: Record<string, any>): {
    kind: RecordKind;
    kinds?: RecordKind[];
};
/** The bytes read at a time. */
export declare const RECORDS_CHUNK: number;
/** Reads the source's bytes at a byte position into buf, and returns how many it read (0 at its end). */
export type ReadAt = (buf: Buffer, position: number) => number;
/** One pass over a source. */
export interface RecordsPass {
    /** The bytes read. */
    bytes: number;
    /** The lines the splitter gave: one per newline, and a last one without a newline. */
    lines: number;
    /** The newline bytes, counted chunk by chunk by another route than the splitter's (the balance compares the two). */
    newlines: number;
    /** True when the last byte read is not a newline: the last line has none. */
    unterminated: boolean;
    /** The sha256 of every byte read, in hex: two passes over an unchanged source agree on it. */
    sha256: string;
}
/** Reads `size` bytes of a source, a chunk at a time, and gives each line to onLine: its bytes without the newline (a
 *  carriage return before it kept), valid only during the call, its number (1-based) and the byte offset of its start.
 *  A line longer than a chunk is joined from its pieces; a last line without a newline is a line; the empty rest after
 *  a final newline is not. Splits on byte 0x0A, which never occurs inside a UTF-8 sequence. */
export declare function scanLines(read: ReadAt, size: number, chunkBytes: number, onLine: (bytes: Buffer, line: number, offset: number) => void): RecordsPass;
/** A line longer than this Node can hold as a string: it cannot be parsed, so the file cannot be converted. */
export declare class RecordsLineTooLong extends Error {
    readonly line: number;
    readonly bytes: number;
    constructor(line: number, bytes: number);
}
/** What a records run wrote, and whether its two passes agreed. */
export interface RecordsRun {
    header: RecordsHeader;
    balance: RecordsBalance;
    /** null when both passes read the same bytes; else why not (the records written are then not a view of the file). */
    changed: string | null;
}
/** A transcript as ltms-records/0, written as it is read: the header (after a first pass), then one record per line
 *  (the second pass), in batches of 1000 lines. `size` is the file's length when it was opened. */
export declare function writeRecords(read: ReadAt, size: number, o: RecordsOptions, write: (text: string) => void, chunkBytes?: number): RecordsRun;
/** writeRecords over bytes in memory: the header, the records and the balance (for the tests and the library). */
export declare function recordsOf(bytes: Uint8Array, o: RecordsOptions, chunkBytes?: number): {
    header: RecordsHeader;
    records: ViewRecord[];
    balance: RecordsBalance;
    changed: string | null;
};
