// The shape report (ltms shapes, 0.3.0): what a set of JSONL transcripts is made of, never what it says. Record kinds,
// key paths, JSON types, classes of strings and numbers, counts and the versions of the program that wrote them.
//
// THE REPORT IS A CLOSED LANGUAGE. Every string in it is one of:
//   (1) a field name or a line kind of the report's own format;
//   (2) a count as a power-of-two bucket ("0", "1", "2-3", "4-7", ...), or a capped one ("64+");
//   (3) a JSON type, or the name of a class of strings or numbers, from the fixed lists below;
//   (4) a key path or a value from the vocabulary (named in the first line by its name and sha256), or one the person
//       named with --allow (listed in the first line);
//   (5) a version by the version rule (VERSION, below: N.N.N, no part of more than one digit starting with 0), read
//       only at a version path the vocabulary names, and printed as written: the one value of a record a report holds
//       (it can be a date, when a program writes its version as one, 2026.11.15).
// No key name, value, length, time, position or order from a transcript reaches a report any other way: writeReport
// checks every line against that language (checkLine) just before it writes it, and writes no line that fails. The guard
// is at the write, so a defect in the reading (a misparse, a wrong count) can make a count wrong but cannot put a
// transcript's token in the report.
//
// This module knows nothing of any supplier: everything that names a program's records is data in the vocabulary file.
// Each line of a transcript is parsed alone, with JSON.parse; nothing here uses the parser of the rest of ltms. It writes
// nothing itself: the command (cli.ts) gives writeReport the function that writes stdout. Ported from the S373 prototype
// (the privacy seat's shapes.mjs), without its --census.

import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** The report's format, named in its first line. */
export const SHAPES_FORMAT = 'ltms-shapes/0';
/** The format a vocabulary file names in its `format` field. */
export const SHAPES_VOCABULARY_FORMAT = 'ltms-shapes-vocabulary/0';
/** The longest line read by default; a longer one is counted (tooLong) as its bytes stream past, never held. */
export const SHAPES_MAX_LINE = 64 * 1024 * 1024;
/** The number of files a path must be seen in to be printed, unless --floor says otherwise. */
export const SHAPES_FLOOR = 3;

/** The core's label rule, a copy of cli.ts's (test/shapes.test.mjs holds the two equal). A value printed in a report
 *  (a vocabulary value, an allowed one) must pass it. */
const LABEL = /^[\w.:+-]{1,64}$/;
/** A key name a vocabulary or --allow may hold: a field name, with no '.' and no '[' (a path's own syntax), so a key that
 *  holds them can never be read as a path. An optional leading $ or @ (as in JSON Schema's $id, JSON-LD's @type). */
const NAME = /^[$@]?[A-Za-z_][A-Za-z0-9_:+-]{0,63}$/;
/** THE VERSION RULE, the only versions printed: three parts joined by '.', of 1 to 4, 1 to 4 and 1 to 6 digits, none of
 *  more than one digit starting with 0, and nothing else (no pre-release or build suffix). Without a leading 0, each
 *  version has one spelling, so two versions never compare equal (S374's closure read, U3). The class version is a
 *  string that follows it too. */
const VERSION = /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,5})$/;
const TYPES = ['array', 'boolean', 'null', 'number', 'object', 'string'];
const STRING_CLASSES = ['empty', 'uuid', 'iso8601-utc', 'iso8601-offset', 'iso8601-local', 'date', 'version', 'digits', 'hex', 'label', 'text'];
const NUMBER_CLASSES = ['int', 'float', 'epoch-s', 'epoch-ms'];
const BOOLEANS = ['false', 'true'];
const RARE = '(rare)', UNLISTED = '(unlisted)', NONE = '(none)', WITHHELD = '(withheld)', NOT_STRING = '(not a string)', ALL = '(all)';
/** Distinct names and array lengths are counted up to this, then print as 64+. */
const CAP = 64;
const CAP_LABELS = ['0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];
/** The names (or values) kept per path for the local review list (--unlisted); the occurrences past them are counted. */
const NAMES_PER_PATH = 2048;
/** Separators inside the accumulators' keys, built: no name, path or label printed can hold them. */
const SEP = String.fromCharCode(0), KSEP = String.fromCharCode(1);

// ---- buckets --------------------------------------------------------------------------------------------------------
/** A count as a power-of-two bucket: 0, 1, 2-3, 4-7, ... Every count a report prints is one. */
function bucket(n: number): string { if (n <= 1) return String(n); let lo = 1; while (lo * 2 <= n) lo *= 2; return `${lo}-${lo * 2 - 1}`; }
/** The same, capped: for a number that only needs to say few or many (distinct names, an array's length). */
const capped = (n: number): string => (n >= CAP ? '64+' : bucket(n));
/** A bucket as bucket() writes it, and nothing else: a string (never another value whose text reads as one). Each number
 *  has at most 16 digits, and below that bound Number() reads a power of two, and the number below its double, exactly. */
function isBucket(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  if (s === '0' || s === '1') return true;
  const m = /^([1-9]\d{0,15})-([1-9]\d{0,15})$/.exec(s);
  if (!m) return false;
  const lo = Number(m[1]), hi = Number(m[2]);
  return lo >= 2 && Number.isInteger(Math.log2(lo)) && hi === lo * 2 - 1;
}

// ---- classes --------------------------------------------------------------------------------------------------------
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;
const ISO_OFF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?[+-]\d{2}:?\d{2}$/;
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;
const HEX = /^[0-9a-fA-F]{8,}$/;
/** A string's class, tested in this order; its text is never kept. */
function stringClass(s: string): string {
  if (s === '') return 'empty';
  if (UUID.test(s)) return 'uuid';
  if (ISO_UTC.test(s)) return 'iso8601-utc';
  if (ISO_OFF.test(s)) return 'iso8601-offset';
  if (ISO_LOCAL.test(s)) return 'iso8601-local';
  if (DATE.test(s)) return 'date';
  if (VERSION.test(s)) return 'version';
  if (DIGITS.test(s)) return 'digits';
  if (HEX.test(s)) return 'hex';
  if (LABEL.test(s)) return 'label';
  return 'text';
}
/** A number's class: whole numbers of seconds or milliseconds between 2000-01-01 and 2100-01-01 are epochs. */
function numberClass(v: number): string {
  if (!Number.isInteger(v)) return 'float';
  if (v >= 946684800 && v < 4102444800) return 'epoch-s';
  if (v >= 946684800000 && v < 4102444800000) return 'epoch-ms';
  return 'int';
}
const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- the vocabulary -------------------------------------------------------------------------------------------------
/** A key path of field names only (the kind path, a sub-kind's path, a version path). */
const PLAIN_PATH = /^(?:\.[$@]?[A-Za-z_][A-Za-z0-9_:+-]{0,63})+$/;
/** A key path of field names and [] steps (an array's elements). */
const VOCAB_PATH = /^(?:\.[$@]?[A-Za-z_][A-Za-z0-9_:+-]{0,63}|\[\])+$/;

/** A usage error: the run cannot start as given (exit 2). Its message is ltms's own, and quotes only what was given. */
export class ShapesUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'ShapesUsageError'; }
}
const usage = (m: string): ShapesUsageError => new ShapesUsageError(m);

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
 *  vocabulary, or whose path or value breaks the rules (a path step that is not a field name, a value that fails the label
 *  rule), is a usage error. */
export function loadVocabulary(file: string): ShapesVocabulary {
  const bytes = readFileSync(file);
  let v: unknown;
  try { v = JSON.parse(bytes.toString('utf8')); } catch { throw usage(`cannot read the vocabulary '${file}' as JSON.`); }
  if (!isObj(v) || v.format !== SHAPES_VOCABULARY_FORMAT) throw usage(`'${file}' is not a vocabulary (its format is not ${SHAPES_VOCABULARY_FORMAT}).`);
  if (typeof v.name !== 'string' || !LABEL.test(v.name)) throw usage(`'${file}': the vocabulary's name must pass the label rule.`);
  const list = (x: unknown, what: string): unknown[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x)) throw usage(`'${file}': ${what} is not a list.`);
    return x;
  };
  const V: ShapesVocabulary = { list: [], paths: new Set(), values: new Map(), kindPath: null, sub: new Map(), versions: [] };
  const paths = list(v.paths, 'paths');
  for (const p of paths) {
    if (typeof p !== 'string' || !VOCAB_PATH.test(p)) throw usage(`'${file}': a path does not follow the path rule; every name must pass the NAME rule.`);
    V.paths.add(p);
  }
  let nValues = 0;
  if (v.values !== undefined && !isObj(v.values)) throw usage(`'${file}': values is not an object of value lists.`);
  for (const [p, vs] of Object.entries(v.values ?? {})) {
    if (!VOCAB_PATH.test(p) || !Array.isArray(vs)) throw usage(`'${file}': a value list is not a path and an array.`);
    let set = V.values.get(p);
    if (!set) V.values.set(p, (set = new Set()));
    for (const x of vs) {
      if (typeof x !== 'string' || !LABEL.test(x)) throw usage(`'${file}': a value does not pass the label rule.`);
      set.add(x); nValues++;
    }
  }
  if (v.kinds !== undefined) {
    const k = v.kinds;
    if (!isObj(k) || typeof k.path !== 'string' || !PLAIN_PATH.test(k.path)) throw usage(`'${file}': kinds.path is not a plain path.`);
    V.kindPath = k.path;
    if (k.sub !== undefined && !isObj(k.sub)) throw usage(`'${file}': kinds.sub is not an object.`);
    for (const [t, sp] of Object.entries(k.sub ?? {})) {
      if (!LABEL.test(t) || typeof sp !== 'string' || !PLAIN_PATH.test(sp)) throw usage(`'${file}': a kinds.sub entry is malformed.`);
      V.sub.set(t, sp);
    }
  }
  for (const p of list(v.versions, 'versions')) {
    if (typeof p !== 'string' || !PLAIN_PATH.test(p)) throw usage(`'${file}': a version path is not a plain path.`);
    if (!V.versions.includes(p)) V.versions.push(p);
  }
  V.list.push({ name: v.name, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 12), paths: paths.length, values: nValues });
  return V;
}

/** --allow <path> or --allow <path>=<value>: the person names a key path (and with it every path above it) or a value, to
 *  print. Adds them to the vocabulary; returns the allowed list as the first line prints it, sorted, each once. */
export function applyAllow(V: ShapesVocabulary, specs: readonly string[]): string[] {
  const allowed: string[] = [];
  for (const s of specs) {
    const i = s.indexOf('=');
    const p = i < 0 ? s : s.slice(0, i), val = i < 0 ? null : s.slice(i + 1);
    if (!VOCAB_PATH.test(p)) throw usage(`--allow '${s}': the path must be written like .message.newField or .list[].name, each name a field name (letters, digits, _ : + -, at most 64; a leading $ or @ allowed).`);
    if (val !== null && !LABEL.test(val)) throw usage(`--allow '${s}': the value must pass the label rule (at most 64 ASCII letters, digits and . _ : + -).`);
    const re = /\.[^.[]+|\[\]/g;
    let m: RegExpExecArray | null, acc = '';
    while ((m = re.exec(p)) !== null) { acc += m[0]; V.paths.add(acc); }
    if (val !== null) { let set = V.values.get(p); if (!set) V.values.set(p, (set = new Set())); set.add(val); }
    allowed.push(s);
  }
  return [...new Set(allowed)].sort();
}
function getPlain(rec: unknown, path: string): unknown {
  let x: unknown = rec;
  for (const seg of path.slice(1).split('.')) { if (!isObj(x) || !Object.hasOwn(x, seg)) return undefined; x = x[seg]; }
  return x;
}

// ---- reading --------------------------------------------------------------------------------------------------------
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
export function collectFiles(paths: readonly string[]): ShapesFiles {
  const files = new Map<string, string>(), dirs = new Set<string>();
  const failed: ShapesFailure[] = [];
  let symlinks = 0;
  const addFile = (p: string, st: Stats): void => { const id = `${st.dev}:${st.ino}`; if (!files.has(id)) files.set(id, p); };
  // a depth-first walk with its own stack, in the order a recursive one takes: each entry in its directory's order, a
  // directory entered where it is met
  const stack: { d: string; entries: Dirent[]; i: number }[] = [];
  const enter = (d: string): void => {
    let st: Stats;
    try { st = lstatSync(d); } catch (e) { failed.push({ path: d, error: e }); return; }
    const id = `${st.dev}:${st.ino}`;
    if (dirs.has(id)) return;
    dirs.add(id);
    let entries: Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (e) { failed.push({ path: d, error: e }); return; }
    stack.push({ d, entries, i: 0 });
  };
  for (const p of paths) {
    let st: Stats;
    try { st = statSync(p); } catch (e) { failed.push({ path: p, error: e }); continue; }
    if (!st.isDirectory()) { addFile(p, st); continue; }
    enter(p);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.entries.length) { stack.pop(); continue; }
      const e = top.entries[top.i++], full = join(top.d, e.name);
      if (e.isSymbolicLink()) symlinks++;
      else if (e.isDirectory()) enter(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) { try { addFile(full, statSync(full)); } catch (x) { failed.push({ path: full, error: x }); } }
    }
  }
  return { files: [...files.values()].sort(), failed, symlinks };
}

/** One read buffer for every file. */
const CHUNK = Buffer.allocUnsafe(1 << 20);
/** Calls onLine(bytes) for each line of the file, split on byte 0x0A (which never occurs inside a UTF-8 sequence; a last
 *  line without a new line is read), or onLine(null) for a line longer than maxLine bytes, whose bytes are passed over as
 *  they stream past and never held. Memory: one chunk, plus at most maxLine bytes of one line. */
export function readLines(file: string, maxLine: number, onLine: (line: Buffer | null) => void): void {
  const fd = openSync(file, 'r');
  try {
    let parts: Buffer[] = [], len = 0, skipping = false;
    for (;;) {
      const got = readSync(fd, CHUNK, 0, CHUNK.length, null);
      if (got === 0) break;
      let start = 0;
      while (start < got) {
        let nl = CHUNK.indexOf(10, start);
        if (nl >= got) nl = -1;
        const end = nl < 0 ? got : nl;
        if (!skipping && len + (end - start) > maxLine) { skipping = true; parts = []; }
        if (!skipping && end > start) parts.push(Buffer.from(CHUNK.subarray(start, end)));
        len += end - start;
        if (nl < 0) break;
        onLine(skipping ? null : parts.length === 1 ? parts[0] : Buffer.concat(parts));
        parts = []; len = 0; skipping = false; start = nl + 1;
      }
    }
    if (len > 0 || skipping) onLine(skipping ? null : parts.length === 1 ? parts[0] : Buffer.concat(parts));
  } finally { closeSync(fd); }
}

// ---- the census of one run ------------------------------------------------------------------------------------------
/** A count: its occurrences, its files, and the last file it was counted in (by its number in the run). */
export type ShapesCount = [n: number, f: number, last: number];
const tally = (c: ShapesCount, fi: number): void => { c[0]++; if (c[2] !== fi) { c[2] = fi; c[1]++; } };
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
  failures: { file: string; error: unknown }[];
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
export function readShapes(V: ShapesVocabulary, files: readonly string[], opts: ShapesReadOptions): ShapesRun {
  const S: ShapesRun = {
    filesRead: 0, filesFailed: 0, failures: [], records: 0, blank: 0, notJson: 0, notObject: 0, tooLong: 0,
    versions: new Map(), kinds: new Map(), lines: new Map(),
    unlisted: opts.unlisted ? new Map() : null, unlistedValues: opts.unlisted ? new Map() : null,
  };
  const unl = S.unlisted, unlVals = S.unlistedValues;
  const lineOf = (kind: string, path: string): ShapesPathCount => {
    const key = kind + KSEP + path;
    let L = S.lines.get(key);
    if (!L) S.lines.set(key, (L = { kind, path, n: 0, f: 0, last: -1, vers: new Set(), lastVer: undefined, sub: new Map(), names: null }));
    return L;
  };
  const bump = (L: ShapesPathCount, group: string, label: string, fi: number): void => {
    const key = group + SEP + label;
    let s = L.sub.get(key);
    if (!s) L.sub.set(key, (s = [0, 0, -1]));
    tally(s, fi);
  };
  const kindOf = (rec: Record<string, unknown>): string => {
    if (!V.kindPath) return ALL;
    const t = getPlain(rec, V.kindPath);
    if (t === undefined) return NONE;
    if (typeof t !== 'string') return NOT_STRING;
    if (!V.values.get(V.kindPath)?.has(t)) return UNLISTED;
    const sp = V.sub.get(t);
    if (!sp) return t;
    // the sub-kind as the kind path gives its own: (none), (not a string), a listed value, or (unlisted) (S374's
    // closure read, U14)
    const s = getPlain(rec, sp);
    if (s === undefined) return `${t}:${NONE}`;
    if (typeof s !== 'string') return `${t}:${NOT_STRING}`;
    return V.values.get(sp)?.has(s) ? `${t}:${s}` : `${t}:${UNLISTED}`;
  };
  const note = (L: ShapesPathCount, v: unknown, fi: number, ver: string, path: string | null): void => {
    L.n++;
    if (L.last !== fi) { L.last = fi; L.f++; }
    if (L.lastVer !== ver) { L.lastVer = ver; L.vers.add(ver); }
    const t = typeOf(v);
    bump(L, 'types', t, fi);
    if (typeof v === 'string') {
      bump(L, 'strings', stringClass(v), fi);
      const vs = path === null ? undefined : V.values.get(path);
      if (vs) {
        const ok = vs.has(v);
        bump(L, 'values', ok ? v : UNLISTED, fi);
        if (!ok && unlVals && path !== null) {   // --unlisted only: the value itself, for the person's own review
          let m = unlVals.get(path);
          if (!m) unlVals.set(path, (m = new Map()));
          let e = m.get(v);
          if (!e) { if (m.size >= NAMES_PER_PATH) return; m.set(v, (e = [0, 0, -1])); }
          tally(e, fi);
        }
      }
    } else if (typeof v === 'number') bump(L, 'numbers', numberClass(v), fi);
    else if (typeof v === 'boolean') bump(L, 'booleans', String(v), fi);
    else if (Array.isArray(v)) bump(L, 'lengths', capped(v.length), fi);
  };
  const noteUnlisted = (kind: string, star: string, name: string, v: unknown, fi: number, ver: string): void => {
    const L = lineOf(kind, star);
    note(L, v, fi, ver, null);
    if (!L.names) L.names = new Set();
    if (L.names.size < CAP) L.names.add(name);
    if (unl) {
      let u = unl.get(star);
      if (!u) unl.set(star, (u = { names: new Map(), overflow: 0 }));
      let e = u.names.get(name);
      if (!e) { if (u.names.size >= NAMES_PER_PATH) { u.overflow++; return; } u.names.set(name, (e = [0, 0, -1])); }
      tally(e, fi);
    }
  };
  // the walk: an explicit stack of (value, path), along vocabulary paths only, so its depth is the vocabulary's, never
  // the record's (JSON.parse takes lines nested a million deep)
  const walk = (root: Record<string, unknown>, kind: string, fi: number, ver: string): void => {
    const vals: unknown[] = [root], at: string[] = [''];
    while (vals.length) {
      const v = vals.pop(), p = at.pop() as string;
      if (Array.isArray(v)) {
        if (!v.length) continue;   // an empty array has no element line: its own line counts its length, 0
        const cp = p + '[]', named = V.paths.has(cp), L = lineOf(kind, cp);
        for (const el of v) {
          note(L, el, fi, ver, named ? cp : null);
          if (named && el !== null && typeof el === 'object') { vals.push(el); at.push(cp); }
        }
      } else {
        const o = v as Record<string, unknown>;
        for (const k of Object.keys(o)) {
          const x = o[k], cp = p + '.' + k;
          if (NAME.test(k) && V.paths.has(cp)) {
            note(lineOf(kind, cp), x, fi, ver, cp);
            if (x !== null && typeof x === 'object') { vals.push(x); at.push(cp); }
          } else noteUnlisted(kind, p + '.*', k, x, fi, ver);
        }
      }
    }
  };

  files.forEach((file, fi) => {
    let ver = NONE;
    try {
      readLines(file, opts.maxLine, (buf) => {
        if (buf === null) { S.tooLong++; return; }
        const s = buf.toString('utf8');
        if (/^\s*$/.test(s)) { S.blank++; return; }
        let rec: unknown;
        try { rec = JSON.parse(s); } catch { S.notJson++; return; }
        if (!isObj(rec)) { S.notObject++; return; }
        S.records++;
        for (const vp of V.versions) {
          const x = getPlain(rec, vp);
          if (x !== undefined) { ver = typeof x === 'string' && VERSION.test(x) ? x : WITHHELD; break; }
        }
        const kind = kindOf(rec);
        let K = S.kinds.get(kind);
        if (!K) S.kinds.set(kind, (K = { n: 0, f: 0, last: -1, vers: new Map() }));
        K.n++;
        if (K.last !== fi) { K.last = fi; K.f++; }
        let kv = K.vers.get(ver);
        if (!kv) K.vers.set(ver, (kv = [0, 0, -1]));
        tally(kv, fi);
        let vv = S.versions.get(ver);
        if (!vv) S.versions.set(ver, (vv = [0, 0, -1]));
        tally(vv, fi);
        walk(rec, kind, fi, ver);
      });
      S.filesRead++;
    } catch (e) { S.filesFailed++; S.failures.push({ file, error: e }); }
  });
  return S;
}

// ---- the report -----------------------------------------------------------------------------------------------------
const vkey = (v: string): number[] => v.split('.').map(Number);
/** Numeric order; equal numbers by their text. The version rule gives each version one spelling, so two never tie; the
 *  text decides if a rule ever lets two spellings of one number through (1.2.3, 01.2.3), so that no order of the files
 *  or of the records, which decides where each was met first, reaches a report (S374's closure read, S4). */
const vcmp = (a: string, b: string): number => { const x = vkey(a), y = vkey(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return cmp(a, b); };
/** Versions in numeric order (equal numbers by their text), then the other tokens ((none), (withheld)) by their text. */
const sortVersions = (vs: Iterable<string>): string[] => [...vs].sort((a, b) => {
  const sa = VERSION.test(a), sb = VERSION.test(b);
  return sa && sb ? vcmp(a, b) : sa ? -1 : sb ? 1 : cmp(a, b);
});

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
export function buildReport(V: ShapesVocabulary, S: ShapesRun, floor: number, allowed: readonly string[]): ShapesReport {
  const F = floor, out: ShapesLine[] = [];
  out.push({
    k: 'shapes', format: SHAPES_FORMAT, vocabulary: V.list, floor: F, allowed: [...allowed],
    files: { read: bucket(S.filesRead), failed: bucket(S.filesFailed) },
    lines: { records: bucket(S.records), blank: bucket(S.blank), notJson: bucket(S.notJson), notObject: bucket(S.notObject), tooLong: bucket(S.tooLong) },
  });
  for (const v of sortVersions(S.versions.keys())) { const [n, f] = S.versions.get(v) as ShapesCount; out.push({ k: 'version', v, records: bucket(n), files: bucket(f) }); }
  for (const kind of [...S.kinds.keys()].sort(cmp)) {
    const K = S.kinds.get(kind) as ShapesKindCount, versions: Record<string, string> = {};
    for (const v of sortVersions(K.vers.keys())) versions[v] = bucket((K.vers.get(v) as ShapesCount)[0]);
    out.push({ k: 'kind', kind, records: bucket(K.n), files: bucket(K.f), versions });
  }
  const rare = new Map<string, [number, number]>();
  let pathLines = 0, printed = 0, belowFloor = 0;
  const lines = [...S.lines.values()].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.path, b.path));
  for (const L of lines) {
    pathLines++;
    if (L.f < F) { belowFloor++; const r = rare.get(L.kind) ?? [0, 0]; r[0]++; r[1] += L.n; rare.set(L.kind, r); continue; }
    printed++;
    const o: ShapesLine = { k: 'path', kind: L.kind, path: L.path, n: bucket(L.n), files: bucket(L.f) };
    const vs = sortVersions([...L.vers].filter((v) => VERSION.test(v)));
    if (vs.length) { o.first = vs[0]; o.last = vs[vs.length - 1]; }
    const groups = new Map<string, Map<string, number>>();
    for (const [key, [n, f]] of L.sub) {
      const i = key.indexOf(SEP), g = key.slice(0, i), label = key.slice(i + 1);
      let m = groups.get(g);
      if (!m) groups.set(g, (m = new Map()));
      if (f >= F) m.set(label, (m.get(label) ?? 0) + n);
      else m.set(RARE, (m.get(RARE) ?? 0) + n);
    }
    for (const g of ['types', 'strings', 'numbers', 'booleans', 'lengths', 'values']) {
      const m = groups.get(g);
      if (!m) continue;
      const order = g === 'lengths' ? CAP_LABELS : null;
      const keys = [...m.keys()].sort((a, b) => Number(a === RARE) - Number(b === RARE) || (order ? order.indexOf(a) - order.indexOf(b) : cmp(a, b)));
      o[g] = Object.fromEntries(keys.map((x) => [x, bucket(m.get(x) as number)]));
    }
    if (L.names) o.names = capped(L.names.size);
    out.push(o);
  }
  for (const kind of [...rare.keys()].sort(cmp)) { const [p, n] = rare.get(kind) as [number, number]; out.push({ k: 'rare', kind, paths: bucket(p), n: bucket(n) }); }
  out.push({ k: 'end', lines: out.length + 1 });
  return { lines: out, pathLines, printed, belowFloor };
}

// ---- the closed language: one check for the writer and for --check ---------------------------------------------------
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
export function shapesLanguage(V: ShapesVocabulary, allowed: readonly string[], expect?: { floor: number; lines: number }): ShapesLanguage {
  // exactly what kindOf can give: a kind that has a sub-kind's path never prints alone
  const kindTokens = new Set([NONE, NOT_STRING, UNLISTED, ALL]);
  if (V.kindPath) for (const t of V.values.get(V.kindPath) ?? []) {
    const sp = V.sub.get(t);
    if (!sp) { kindTokens.add(t); continue; }
    for (const s of [UNLISTED, NONE, NOT_STRING, ...(V.values.get(sp) ?? [])]) kindTokens.add(`${t}:${s}`);
  }
  return { V, allowed: [...allowed], kindTokens, floor: expect?.floor ?? null, lines: expect?.lines ?? null };
}
/** A path a line may print: a vocabulary path, one .* step past one (or the root's .*), or one [] step past one. */
function validPath(Lg: ShapesLanguage, p: unknown): p is string {
  if (typeof p !== 'string') return false;
  const P = Lg.V.paths;
  return P.has(p) || (p.endsWith('.*') && (p === '.*' || P.has(p.slice(0, -2)))) || (p.endsWith('[]') && P.has(p.slice(0, -2)));
}
const keysAre = (obj: unknown, req: readonly string[], opt: readonly string[] = []): obj is Record<string, unknown> =>
  isObj(obj) && Object.keys(obj).every((k) => req.includes(k) || opt.includes(k)) && req.every((k) => Object.hasOwn(obj, k));
const bucketMap = (m: unknown, allowedKey: (k: string) => boolean): boolean => isObj(m) && Object.entries(m).every(([k, v]) => allowedKey(k) && isBucket(v));
const isVersionToken = (v: unknown): boolean => typeof v === 'string' && (VERSION.test(v) || v === NONE || v === WITHHELD);
const isVersion = (v: unknown): boolean => typeof v === 'string' && VERSION.test(v);
const inList = (list: readonly string[]) => (k: string): boolean => k === RARE || list.includes(k);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Is this line in the report's language? null when it is; otherwise why not, as one of this function's own words (the
 *  field or the line kind that failed), never a part of the line. */
export function checkLine(o: unknown, Lg: ShapesLanguage): string | null {
  if (!isObj(o)) return 'not an object';
  switch (o.k) {
    case 'shapes': {
      if (!keysAre(o, ['k', 'format', 'vocabulary', 'floor', 'allowed', 'files', 'lines'])) return 'fields';
      if (o.format !== SHAPES_FORMAT) return 'format';
      if (!Array.isArray(o.vocabulary) || !same(o.vocabulary, Lg.V.list)) return 'vocabulary';
      if (typeof o.floor !== 'number' || !Number.isInteger(o.floor) || o.floor < 1 || (Lg.floor !== null && o.floor !== Lg.floor)) return 'floor';
      if (!Array.isArray(o.allowed) || !same(o.allowed, Lg.allowed)) return 'allowed';
      if (!keysAre(o.files, ['read', 'failed']) || !Object.values(o.files).every(isBucket)) return 'files';
      if (!keysAre(o.lines, ['records', 'blank', 'notJson', 'notObject', 'tooLong']) || !Object.values(o.lines).every(isBucket)) return 'lines';
      return null;
    }
    case 'version':
      if (!keysAre(o, ['k', 'v', 'records', 'files']) || !isVersionToken(o.v) || !isBucket(o.records) || !isBucket(o.files)) return 'version';
      return null;
    case 'kind':
      if (!keysAre(o, ['k', 'kind', 'records', 'files', 'versions']) || typeof o.kind !== 'string' || !Lg.kindTokens.has(o.kind) || !isBucket(o.records) || !isBucket(o.files)) return 'kind';
      if (!bucketMap(o.versions, isVersionToken)) return 'kind.versions';
      return null;
    case 'path': {
      if (!keysAre(o, ['k', 'kind', 'path', 'n', 'files'], ['first', 'last', 'types', 'strings', 'numbers', 'booleans', 'lengths', 'values', 'names'])) return 'path fields';
      if (typeof o.kind !== 'string' || !Lg.kindTokens.has(o.kind) || !validPath(Lg, o.path) || !isBucket(o.n) || !isBucket(o.files)) return 'path';
      const path = o.path as string;
      if (Object.hasOwn(o, 'first') && !isVersion(o.first)) return 'first';
      if (Object.hasOwn(o, 'last') && !isVersion(o.last)) return 'last';
      if (Object.hasOwn(o, 'types') && !bucketMap(o.types, inList(TYPES))) return 'types';
      if (Object.hasOwn(o, 'strings') && !bucketMap(o.strings, inList(STRING_CLASSES))) return 'strings';
      if (Object.hasOwn(o, 'numbers') && !bucketMap(o.numbers, inList(NUMBER_CLASSES))) return 'numbers';
      if (Object.hasOwn(o, 'booleans') && !bucketMap(o.booleans, inList(BOOLEANS))) return 'booleans';
      if (Object.hasOwn(o, 'lengths') && !bucketMap(o.lengths, inList(CAP_LABELS))) return 'lengths';
      if (Object.hasOwn(o, 'values')) {
        const vs = Lg.V.values.get(path);
        if (!vs || !bucketMap(o.values, (k) => k === RARE || k === UNLISTED || vs.has(k))) return 'values';
      }
      if (Object.hasOwn(o, 'names') && (!path.endsWith('.*') || typeof o.names !== 'string' || !CAP_LABELS.includes(o.names))) return 'names';
      return null;
    }
    case 'rare':
      if (!keysAre(o, ['k', 'kind', 'paths', 'n']) || typeof o.kind !== 'string' || !Lg.kindTokens.has(o.kind) || !isBucket(o.paths) || !isBucket(o.n)) return 'rare';
      return null;
    case 'end':
      if (!keysAre(o, ['k', 'lines']) || typeof o.lines !== 'number' || !Number.isInteger(o.lines) || (Lg.lines !== null && o.lines !== Lg.lines)) return 'end';
      return null;
    default: return 'unknown line kind';
  }
}

/** What writeReport did. */
export interface ShapesWritten {
  /** Lines written. */
  written: number;
  /** Lines refused at the write (each a bug in ltms): not written. */
  refused: number;
  /** For each refused line, its number in the report and why (checkLine's word). */
  reasons: { line: number; why: string }[];
  /** Bytes written. */
  bytes: number;
}
/** THE WRITE GUARD, and the only way a report leaves this module: each line is turned into the text that will be
 *  written, that text is parsed back and checked against the language, and only that text is written: what is checked is
 *  exactly what goes out (an object whose JSON is not its own fields, through an inherited toJSON say, cannot pass as one
 *  line and be written as another: S374's closure read, S1). A line that fails is not written. `write` is given the text
 *  in parts of at most 1,000 lines. */
export function writeReport(lines: readonly unknown[], Lg: ShapesLanguage, write: (text: string) => void): ShapesWritten {
  const done: ShapesWritten = { written: 0, refused: 0, reasons: [], bytes: 0 };
  let text = '', held = 0;
  const flush = (): void => { if (text) { done.bytes += Buffer.byteLength(text); write(text); } text = ''; held = 0; };
  lines.forEach((o, i) => {
    let s: string | undefined;
    try { s = JSON.stringify(o); } catch { s = undefined; }
    const why = typeof s === 'string' ? checkLine(JSON.parse(s), Lg) : 'not JSON';
    if (why !== null || typeof s !== 'string') { done.refused++; done.reasons.push({ line: i + 1, why: why ?? 'not JSON' }); return; }
    text += s + '\n';
    done.written++;
    if (++held >= 1000) flush();
  });
  flush();
  return done;
}

/** What --check found in a report file. */
export type ShapesCheck =
  | { k: 'not-a-report' }
  | { k: 'bad-allowed' }
  | {
    k: 'checked';
    /** The lines read. */
    lines: number;
    /** Each line outside the language, by its number and checkLine's word; the cut or edited end, as 'end'. */
    problems: { line: number; why: string }[];
    /** The allowed list of its first line, as read. */
    allowed: string[];
  };
/** --check: is every token of this report in its language? The language is the vocabulary given and the report's own
 *  allowed list (its first line); every line is checked as the writer checks it, and the last line must be an end line
 *  that counts the report's lines. */
export function checkReport(text: string, V: ShapesVocabulary): ShapesCheck {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  let header: unknown;
  try { header = JSON.parse(rows[0]); } catch { header = null; }
  if (!isObj(header) || header.k !== 'shapes' || !Array.isArray(header.allowed)) return { k: 'not-a-report' };
  let allowed: string[];
  try { allowed = applyAllow(V, header.allowed.filter((s): s is string => typeof s === 'string')); }
  catch (e) { if (e instanceof ShapesUsageError) return { k: 'bad-allowed' }; throw e; }
  const Lg = shapesLanguage(V, allowed);
  const problems: { line: number; why: string }[] = [];
  rows.forEach((r, i) => {
    let o: unknown;
    try { o = JSON.parse(r); } catch { o = undefined; }
    const why = checkLine(o, Lg);
    if (why !== null) problems.push({ line: i + 1, why });
  });
  let last: unknown;
  try { last = JSON.parse(rows[rows.length - 1]); } catch { last = null; }
  if (!isObj(last) || last.k !== 'end' || last.lines !== rows.length) problems.push({ line: rows.length, why: 'end' });
  return { k: 'checked', lines: rows.length, problems, allowed };
}

/** --unlisted: NOT a report. The names and values the vocabulary lacks, read from the transcripts as written, for the
 *  person's own review before an --allow; every line says "send":false, and --check refuses the list. Exact counts. A
 *  name that cannot be a path step (a file path, say) gets "allow":null: it can never be allowed. */
export function reviewLines(S: ShapesRun): ShapesLine[] {
  const out: ShapesLine[] = [{ k: 'unlisted-review', send: false, note: 'names the vocabulary does not hold, for your own review: do not send this list. To print one in a report, rerun with --allow <path>.' }];
  const unl = S.unlisted ?? new Map<string, ShapesUnlisted>(), vals = S.unlistedValues ?? new Map<string, Map<string, ShapesCount>>();
  for (const star of [...unl.keys()].sort(cmp)) {
    const u = unl.get(star) as ShapesUnlisted;
    for (const name of [...u.names.keys()].sort(cmp)) {
      const [n, f] = u.names.get(name) as ShapesCount;
      out.push({ k: 'unlisted', send: false, at: star, name, n, files: f, allow: NAME.test(name) ? star.slice(0, -1) + name : null });
    }
    if (u.overflow) out.push({ k: 'unlisted-more', send: false, at: star, n: u.overflow });
  }
  for (const vp of [...vals.keys()].sort(cmp)) {
    const m = vals.get(vp) as Map<string, ShapesCount>;
    for (const value of [...m.keys()].sort(cmp)) {
      const [n, f] = m.get(value) as ShapesCount;
      out.push({ k: 'unlisted-value', send: false, at: vp, value, n, files: f, allow: LABEL.test(value) ? `${vp}=${value}` : null });
    }
  }
  return out;
}
