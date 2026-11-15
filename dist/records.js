// The record view (ltms records, 0.3.0): a transcript as `ltms-records/0`, the format of the record protocol's draft
// (version 0). One record per raw line, each with the address of the bytes it came from (its line, the byte offset of
// its start, its length in bytes and the sha256 of exactly those bytes), its kind, and its parent link as the source
// supplies it. No text: the text stays in the source and is read back through the address (the draft's D2: content by
// address). The count balances: every line read gives one record, the lines not understood included (other,
// malformed, blank), so `wc -l` on the source and a count of the records check each other.
//
// The kinds of a Claude Code record (the draft's section 13, decided S374):
//   assistant      by its content block: text gives reply; thinking and redacted_thinking, thinking; tool_use, tool
//                  call. One written for an API error (isApiErrorMessage) is system. A record of several blocks takes
//                  its first block's kind, and lists every block's in kinds.
//   user           a tool result (the parser's isToolResultRecord) is tool result; a compaction's summary
//                  (isCompactSummary) is summary; someone's words (isInputTurn: a channel that opens a turn) are input;
//                  what the harness wrote (meta, command output, an interrupt, a queued copy) is system.
//   attachment     a prompt queued while the model worked (type queued_command, commandMode prompt) is input; any other
//                  is context (what the harness added to the model's context).
//   system         compact_boundary is compaction; any other subtype is system.
//   last-prompt    marker (the session's head pointer).
//   any other type other (its type kept, as every record's is, in supplier.type).
//   A line of white space only is blank; one that is not a JSON object is malformed.
//
// The parent link: a record with the envelope (a uuid and a parentUuid key) has parent_by "supplied": parent is the
// address of the first record in the file that carries its parentUuid, or null (a root, or a parent not in this file:
// supplier.parent then says which). A record without the envelope (Claude Code's sidecars: last-prompt, ai-title and
// the like) is outside the tree: parent null, parent_by "none". A record whose uuid an earlier record carries (a replay)
// names that one in dup_of. Nothing is repaired here: a repair belongs to a view (the live path), not to the records.
//
// This module reads no file and writes nothing: the command (cli.ts) gives it the bytes and prints what it returns. It
// imports node:crypto, so it is not part of the library's entry point (which imports nothing from Node).
import { createHash } from 'node:crypto';
import { blocksOf, hasEnvelope, isInputTurn, isToolResultRecord } from './parser.js';
/** The format a records file names in its header. */
export const RECORDS_FORMAT = 'ltms-records/0';
/** Every kind a record may have, in the order the balance line prints them. */
export const RECORD_KINDS = ['input', 'reply', 'thinking', 'tool call', 'tool result', 'system', 'context', 'summary', 'compaction', 'marker', 'other', 'blank', 'malformed'];
const NL = 0x0a;
/** Lenient: a byte sequence that is not UTF-8 becomes U+FFFD in the text parsed; the sha256 is of the bytes. */
const DECODER = new TextDecoder('utf-8');
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);
/** A stamp that names its zone: Z, or an offset. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;
const N3 = /^\d+\.\d+\.\d+$/;
/** Versions N.N.N in numeric order, then any other strings by their text. */
function cmpVersions(a, b) {
    const na = N3.test(a), nb = N3.test(b);
    if (na && nb) {
        const x = a.split('.').map(Number), y = b.split('.').map(Number);
        for (let i = 0; i < 3; i++)
            if (x[i] !== y[i])
                return x[i] - y[i];
        return 0;
    }
    if (na !== nb)
        return na ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}
/** A Claude Code record's kind (the draft's section 13). */
export function kindOf(r) {
    switch (r.type) {
        case 'assistant': {
            if (r.isApiErrorMessage === true)
                return { kind: 'system' };
            const ks = blocksOf(r.message).map((b) => (b.type === 'text' ? 'reply' : b.type === 'thinking' || b.type === 'redacted_thinking' ? 'thinking' : b.type === 'tool_use' ? 'tool call' : 'other'));
            if (!ks.length)
                return { kind: 'other' };
            return ks.length > 1 ? { kind: ks[0], kinds: ks } : { kind: ks[0] };
        }
        case 'user':
            if (isToolResultRecord(r))
                return { kind: 'tool result' };
            if (r.isCompactSummary === true)
                return { kind: 'summary' };
            return { kind: isInputTurn(r) ? 'input' : 'system' };
        case 'attachment': {
            const a = r.attachment;
            return { kind: isObj(a) && a.type === 'queued_command' && a.commandMode === 'prompt' ? 'input' : 'context' };
        }
        case 'system':
            return { kind: r.subtype === 'compact_boundary' ? 'compaction' : 'system' };
        case 'last-prompt':
            return { kind: 'marker' };
        default:
            return { kind: 'other' };
    }
}
function timeOf(r) {
    const t = str(r.timestamp);
    if (t === undefined)
        return undefined;
    const out = { as_written: t, kind: 'stamped' };
    if (ZONED.test(t)) {
        const d = new Date(t);
        if (!Number.isNaN(d.getTime()))
            out.utc = d.toISOString();
    }
    return out;
}
/** The lines of a file: [start, end) byte spans, split on byte 0x0A, which never occurs inside a UTF-8 sequence. A last
 *  line with no newline is a line; the empty rest after a final newline is not. */
export function lineSpans(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const spans = [];
    let start = 0;
    for (let nl = buf.indexOf(NL, start); nl >= 0; nl = buf.indexOf(NL, start)) {
        spans.push([start, nl]);
        start = nl + 1;
    }
    const unterminated = start < buf.length;
    if (unterminated)
        spans.push([start, buf.length]);
    return { spans, terminated: unterminated ? spans.length - 1 : spans.length, unterminated };
}
/** The lines of a file counted by another route than lineSpans: its newline bytes, and a last line without one. The
 *  balance compares this count with the records written, so a defect in the splitting shows as a count that differs. */
export function countLines(bytes) {
    let newlines = 0;
    for (let i = 0; i < bytes.length; i++)
        if (bytes[i] === NL)
            newlines++;
    return { newlines, unterminated: bytes.length > 0 && bytes[bytes.length - 1] !== NL };
}
/** A transcript's bytes as ltms-records/0: its header, one record per line, and the balance. */
export function recordsOf(bytes, o) {
    const { spans } = lineSpans(bytes);
    const counted = countLines(bytes);
    const at = (line) => `${o.prefix}:L${line}`;
    // first pass: each line parsed alone; the first line that carries each uuid, so a parent may be written after its child
    const parsed = [];
    const firstLine = new Map();
    spans.forEach(([a, b], i) => {
        const text = DECODER.decode(bytes.subarray(a, b));
        if (text.trim() === '') {
            parsed.push('blank');
            return;
        }
        let v;
        try {
            v = JSON.parse(text);
        }
        catch {
            parsed.push('malformed');
            return;
        }
        if (!isObj(v)) {
            parsed.push('malformed');
            return;
        }
        parsed.push(v);
        if (hasEnvelope(v) && !firstLine.has(v.uuid))
            firstLine.set(v.uuid, i + 1);
    });
    // second pass: the records
    const byKind = Object.fromEntries(RECORD_KINDS.map((k) => [k, 0]));
    const parents = { resolved: 0, root: 0, unresolved: 0, none: 0 };
    const versions = new Set();
    let dupOf = 0;
    const records = spans.map(([a, b], i) => {
        const line = i + 1;
        const src = { kind: 'line', line, offset: a, bytes: b - a, sha256: createHash('sha256').update(bytes.subarray(a, b)).digest('hex') };
        const p = parsed[i];
        let rec;
        if (p === 'blank' || p === 'malformed') {
            parents.none++;
            rec = { id: at(line), kind: p, order: line, parent: null, parent_by: 'none', src };
        }
        else {
            const { kind, kinds } = kindOf(p);
            const supplier = {};
            const type = str(p.type);
            if (type !== undefined)
                supplier.type = type;
            const sub = p.type === 'system' ? str(p.subtype) : p.type === 'attachment' && isObj(p.attachment) ? str(p.attachment.type) : undefined;
            if (sub !== undefined)
                supplier.subtype = sub;
            let parent = null, parentBy = 'none', dup;
            if (hasEnvelope(p)) {
                supplier.id = p.uuid;
                const pu = typeof p.parentUuid === 'string' ? p.parentUuid : null;
                supplier.parent = pu;
                parentBy = 'supplied';
                if (pu === null)
                    parents.root++;
                else {
                    const pl = firstLine.get(pu);
                    if (pl !== undefined) {
                        parent = at(pl);
                        parents.resolved++;
                    }
                    else
                        parents.unresolved++;
                }
                const first = firstLine.get(p.uuid);
                if (first !== line) {
                    dup = at(first);
                    dupOf++;
                }
            }
            else
                parents.none++;
            const version = str(p.version);
            if (version !== undefined) {
                supplier.version = version;
                versions.add(version);
            }
            const group = p.type === 'assistant' ? str(p.requestId) ?? (isObj(p.message) ? str(p.message.id) : undefined) : undefined;
            const time = timeOf(p);
            rec = {
                id: at(line), kind, ...(kinds ? { kinds } : {}), order: line, parent, parent_by: parentBy,
                ...(group !== undefined ? { group } : {}), ...(dup !== undefined ? { dup_of: dup } : {}),
                ...(Object.keys(supplier).length ? { supplier } : {}), ...(time ? { time } : {}), src,
            };
        }
        byKind[rec.kind]++;
        return rec;
    });
    const header = {
        format: RECORDS_FORMAT, kind: 'header',
        source: { id: o.prefix, path: o.path, bytes: bytes.length, lines: counted.newlines, last_line_unterminated: counted.unterminated, read_at: o.readAt },
        supplier: { name: 'claude-code', versions: [...versions].sort(cmpVersions) },
        converter: { name: 'ltms', version: o.converterVersion },
        content: 'by-address',
    };
    return { header, records, balance: { linesRead: counted.newlines + (counted.unterminated ? 1 : 0), recordsWritten: records.length, byKind, dupOf, parents } };
}
