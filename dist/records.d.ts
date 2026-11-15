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
/** What the source says of a record, as it wrote it. */
export interface RecordSupplier {
    /** Its type, when it is a string. */
    type?: string;
    /** A system record's subtype, or an attachment's type, when it is a string. */
    subtype?: string;
    /** Its uuid (records with the envelope). */
    id?: string;
    /** Its parentUuid, or null (records with the envelope). */
    parent?: string | null;
    /** The version of the program that wrote it, when it is a string. */
    version?: string;
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
/** The lines of a file: [start, end) byte spans, split on byte 0x0A, which never occurs inside a UTF-8 sequence. A last
 *  line with no newline is a line; the empty rest after a final newline is not. */
export declare function lineSpans(bytes: Uint8Array): {
    spans: [number, number][];
    terminated: number;
    unterminated: boolean;
};
/** The lines of a file counted by another route than lineSpans: its newline bytes, and a last line without one. The
 *  balance compares this count with the records written, so a defect in the splitting shows as a count that differs. */
export declare function countLines(bytes: Uint8Array): {
    newlines: number;
    unterminated: boolean;
};
/** A transcript's bytes as ltms-records/0: its header, one record per line, and the balance. */
export declare function recordsOf(bytes: Uint8Array, o: RecordsOptions): {
    header: RecordsHeader;
    records: ViewRecord[];
    balance: RecordsBalance;
};
