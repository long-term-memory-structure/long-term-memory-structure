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
// How it reads (S375): never the whole file. Two passes over the same bytes, a chunk at a time (1 MiB): the first finds
// the first line that carries each uuid (a parent may be written after its child) and the versions (the header, written
// first, lists them); the second writes each record as its line passes. So memory holds one chunk, the line that
// crosses it, and the uuids, not the file and every line parsed (that took 3.6 GiB for a file of 1 GB, and a file of
// 2 GiB or more could not be read at all). Both passes read the size the file had when it was opened, so lines appended
// after it are not read; and each pass hashes every byte it reads: two passes that disagree (the file was rewritten, or
// shrank, between them) are reported, and the records written are then not a view of it.
//
// This module opens no file and writes nothing itself: the command (cli.ts) gives it a function that reads a file's
// bytes at a position and one that writes text. It imports node:crypto, so it is not part of the library's entry point
// (which imports nothing from Node).

import { createHash } from 'node:crypto';
import { blocksOf, hasEnvelope, isInputTurn, isToolResultRecord } from './parser.js';

/** The format a records file names in its header. */
export const RECORDS_FORMAT = 'ltms-records/0';
/** Every kind a record may have, in the order the balance line prints them. */
export const RECORD_KINDS = ['input', 'reply', 'thinking', 'tool call', 'tool result', 'system', 'context', 'summary', 'compaction', 'marker', 'other', 'blank', 'malformed'] as const;
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
  /** Its type, when it is a string (by the label rule). */
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
  supplier: { name: 'claude-code'; versions: string[] };
  converter: { name: 'ltms'; version: string };
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
  parents: { resolved: number; root: number; unresolved: number; none: number };
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

const NL = 0x0a;
/** The label rule, as cli.ts, search.ts and shapes.ts hold it (a test holds this copy equal to cli.ts's): a string the
 *  file wrote prints only when it is at most 64 ASCII letters, digits and . _ : + -, else as (withheld). The links are
 *  made from the values as written; only what is printed passes the rule. */
const LABEL = /^[\w.:+-]{1,64}$/;
const shown = (v: string): string => (LABEL.test(v) ? v : '(withheld)');
/** Lenient: a byte sequence that is not UTF-8 becomes U+FFFD in the text parsed; the sha256 is of the bytes. */
const DECODER = new TextDecoder('utf-8');
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** A stamp that names its zone: Z, or an offset. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;
const N3 = /^\d+\.\d+\.\d+$/;
/** Versions N.N.N in numeric order (two spellings of one number, 01.2.3 and 1.2.3, by their text), then any other
 *  strings by their text: a total order, so the header does not depend on the order of the records. */
function cmpVersions(a: string, b: string): number {
  const na = N3.test(a), nb = N3.test(b);
  if (na && nb) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a < b ? -1 : a > b ? 1 : 0; }
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A Claude Code record's kind (the draft's section 13). */
export function kindOf(r: Record<string, any>): { kind: RecordKind; kinds?: RecordKind[] } {
  switch (r.type) {
    case 'assistant': {
      if (r.isApiErrorMessage === true) return { kind: 'system' };
      const ks = blocksOf(r.message).map((b): RecordKind => (b.type === 'text' ? 'reply' : b.type === 'thinking' || b.type === 'redacted_thinking' ? 'thinking' : b.type === 'tool_use' ? 'tool call' : 'other'));
      if (!ks.length) return { kind: 'other' };
      return ks.length > 1 ? { kind: ks[0], kinds: ks } : { kind: ks[0] };
    }
    case 'user':
      if (isToolResultRecord(r)) return { kind: 'tool result' };
      if (r.isCompactSummary === true) return { kind: 'summary' };
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

function timeOf(r: Record<string, any>): RecordTime | undefined {
  const t = str(r.timestamp);
  if (t === undefined) return undefined;
  const out: RecordTime = { as_written: shown(t), kind: 'stamped' };
  if (ZONED.test(t)) { const d = new Date(t); if (!Number.isNaN(d.getTime())) out.utc = d.toISOString(); }
  return out;
}

/** The bytes read at a time. */
export const RECORDS_CHUNK = 1 << 20;

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
export function scanLines(read: ReadAt, size: number, chunkBytes: number, onLine: (bytes: Buffer, line: number, offset: number) => void): RecordsPass {
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, size)));
  const whole = createHash('sha256');
  let pos = 0, line = 0, start = 0, newlines = 0, last = -1;
  let pieces: Buffer[] = [];
  while (pos < size) {
    const n = read(buf.subarray(0, Math.min(buf.length, size - pos)), pos);
    if (!(n > 0)) break; // the source ended before its size: it shrank (the caller compares bytes with size)
    const chunk = buf.subarray(0, n);
    whole.update(chunk);
    for (let i = 0; i < n; i++) if (chunk[i] === NL) newlines++;
    last = chunk[n - 1];
    let from = 0;
    for (let nl = chunk.indexOf(NL, from); nl >= 0; nl = chunk.indexOf(NL, from)) {
      const part = chunk.subarray(from, nl);
      onLine(pieces.length ? Buffer.concat([...pieces, part]) : part, ++line, start);
      pieces = [];
      start = pos + nl + 1;
      from = nl + 1;
    }
    if (from < n) pieces.push(Buffer.from(chunk.subarray(from))); // a copy: buf is read into again
    pos += n;
  }
  if (pieces.length) onLine(Buffer.concat(pieces), ++line, start);
  return { bytes: pos, lines: line, newlines, unterminated: pos > 0 && last !== NL, sha256: whole.digest('hex') };
}

/** A line longer than this Node can hold as a string: it cannot be parsed, so the file cannot be converted. */
export class RecordsLineTooLong extends Error {
  constructor(readonly line: number, readonly bytes: number) {
    super(`line ${line} is ${bytes} bytes, longer than this Node can read as a string`);
    this.name = 'RecordsLineTooLong';
  }
}

/** A line as JSON: an object; 'blank' (white space only); or 'malformed' (not a JSON object). */
function parseLine(bytes: Buffer, line: number): Record<string, any> | 'blank' | 'malformed' {
  let text: string;
  try { text = DECODER.decode(bytes); }
  catch { throw new RecordsLineTooLong(line, bytes.length); }
  if (text.trim() === '') return 'blank';
  let v: unknown;
  try { v = JSON.parse(text); } catch { return 'malformed'; }
  return isObj(v) ? v : 'malformed';
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
export function writeRecords(read: ReadAt, size: number, o: RecordsOptions, write: (text: string) => void, chunkBytes: number = RECORDS_CHUNK): RecordsRun {
  const at = (line: number): string => `${o.prefix}:L${line}`;
  // the first pass: the first line that carries each uuid, and the versions
  const firstLine = new Map<string, number>();
  const versions = new Set<string>();
  const one = scanLines(read, size, chunkBytes, (bytes, line) => {
    const p = parseLine(bytes, line);
    if (typeof p === 'string') return;
    if (hasEnvelope(p) && !firstLine.has(p.uuid)) firstLine.set(p.uuid, line);
    const version = str(p.version);
    if (version !== undefined) versions.add(version);
  });
  const header: RecordsHeader = {
    format: RECORDS_FORMAT, kind: 'header',
    source: { id: o.prefix, path: o.path, bytes: one.bytes, lines: one.newlines, last_line_unterminated: one.unterminated, read_at: o.readAt },
    supplier: { name: 'claude-code', versions: [...new Set([...versions].map(shown))].sort(cmpVersions) },
    converter: { name: 'ltms', version: o.converterVersion },
    content: 'by-address',
  };
  write(JSON.stringify(header) + '\n');
  // the second pass: each record as its line passes
  const byKind = Object.fromEntries(RECORD_KINDS.map((k) => [k, 0])) as Record<RecordKind, number>;
  const parents = { resolved: 0, root: 0, unresolved: 0, none: 0 };
  let dupOf = 0, written = 0, text = '', held = 0;
  const two = scanLines(read, size, chunkBytes, (bytes, line, offset) => {
    const src: RecordSrc = { kind: 'line', line, offset, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const p = parseLine(bytes, line);
    let rec: ViewRecord;
    if (p === 'blank' || p === 'malformed') {
      parents.none++;
      rec = { id: at(line), kind: p, order: line, parent: null, parent_by: 'none', src };
    } else {
      const { kind, kinds } = kindOf(p);
      const supplier: RecordSupplier = {};
      const type = str(p.type);
      if (type !== undefined) supplier.type = shown(type);
      const sub = p.type === 'system' ? str(p.subtype) : p.type === 'attachment' && isObj(p.attachment) ? str(p.attachment.type) : undefined;
      if (sub !== undefined) supplier.subtype = shown(sub);
      let parent: string | null = null, parentBy: 'supplied' | 'none' = 'none', dup: string | undefined;
      if (hasEnvelope(p)) {
        supplier.id = shown(p.uuid);
        const pu = typeof p.parentUuid === 'string' ? p.parentUuid : null;
        supplier.parent = pu === null ? null : shown(pu);
        parentBy = 'supplied';
        if (pu === null) parents.root++;
        else { const pl = firstLine.get(pu); if (pl !== undefined) { parent = at(pl); parents.resolved++; } else parents.unresolved++; }
        const first = firstLine.get(p.uuid);
        if (first !== undefined && first !== line) { dup = at(first); dupOf++; }
      } else parents.none++;
      const version = str(p.version);
      if (version !== undefined) supplier.version = shown(version);
      const group = p.type === 'assistant' ? str(p.requestId) ?? (isObj(p.message) ? str(p.message.id) : undefined) : undefined;
      const time = timeOf(p);
      rec = {
        id: at(line), kind, ...(kinds ? { kinds } : {}), order: line, parent, parent_by: parentBy,
        ...(group !== undefined ? { group: shown(group) } : {}), ...(dup !== undefined ? { dup_of: dup } : {}),
        ...(Object.keys(supplier).length ? { supplier } : {}), ...(time ? { time } : {}), src,
      };
    }
    byKind[rec.kind]++;
    written++;
    text += JSON.stringify(rec) + '\n';
    if (++held === 1000) { write(text); text = ''; held = 0; }
  });
  if (text) write(text);
  const changed = one.bytes < size || two.bytes < size
    ? `the file shrank while it was read (${size} bytes when it was opened; ${Math.min(one.bytes, two.bytes)} read)`
    : one.sha256 !== two.sha256 ? `the file changed between the two reads (its first ${size} bytes differ)` : null;
  return { header, balance: { linesRead: two.newlines + (two.unterminated ? 1 : 0), recordsWritten: written, byKind, dupOf, parents }, changed };
}

/** writeRecords over bytes in memory: the header, the records and the balance (for the tests and the library). */
export function recordsOf(bytes: Uint8Array, o: RecordsOptions, chunkBytes: number = RECORDS_CHUNK): { header: RecordsHeader; records: ViewRecord[]; balance: RecordsBalance; changed: string | null } {
  const src = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: string[] = [];
  const r = writeRecords((buf, pos) => src.copy(buf, 0, pos, Math.min(pos + buf.length, src.length)), src.length, o, (t) => { parts.push(t); }, chunkBytes);
  const records = parts.join('').split('\n').slice(1, -1).map((l) => JSON.parse(l) as ViewRecord);
  return { header: r.header, records, balance: r.balance, changed: r.changed };
}
