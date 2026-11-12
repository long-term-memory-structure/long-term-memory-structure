// pin.ts: copies of Claude Code's transcripts that its cleanup does not sweep, and a log they can be checked against.
//
// Claude Code deletes a session's transcript, and the session directory beside it, once the file has not been
// modified for cleanupPeriodDays (30 by default), and deletes the files under a session's tool-results/ by their own
// age even while the transcript lives. pinPaths copies the files of the sweep's own shape, from under the projects
// directory (the root), into a directory of the caller's choosing (to), and appends one JSON line per change to
// <to>/PINS.log. checkPin reads every version the log records back from the copy that holds it.
//
// The layout of a pin:
//   <to>/<rel>          the newest bytes of each file, with its source's mtime (rel is the path under the root, '/')
//   <to>/<rel-kept>     an older version, kept by a hard link when a file was rewritten:
//                       <stem>.superseded-<sha12>.jsonl for a .jsonl, <name>.superseded-<sha12> for another file
//   <to>/PINS.log       JSON lines, not named .jsonl, so nothing reads it as a transcript
//   <to>/.ltms-pin.lock the lock, while a pin runs
//
// Node only (node:fs, node:crypto, node:path, node:os). The package's "." entry, the parser, imports nothing from Node.

import {
  closeSync, constants as fsConstants, fstatSync, fsyncSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import type { BigIntStats, Dirent, Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, hostname } from 'node:os';

// ---- the types ---------------------------------------------------------------------------------------------------

/** What a line of PINS.log says happened to a file: `new`, its first copy; `grown`, the old copy is a byte prefix of
 *  the new one; `rewritten`, anything else, the old copy kept first; `recovered`, a line written so that the log says
 *  what the pin holds (after a pin that stopped between a rename and its line, a file the log did not name, a copy
 *  missing from the pin and written again from its source, or a log line cut short). */
export type PinHow = 'new' | 'grown' | 'rewritten' | 'recovered';

/** One version of a file: its length in bytes, and the sha256 of those bytes (64 lower-case hex characters). */
export interface PinVersion { bytes: number; sha256: string }

/** What a pin's lock file holds: the process that holds it, the host it runs on, and when it took the lock (ISO); and,
 *  where the platform gives them (Linux: /proc), the host's boot id and the process's PID namespace, which tell a lock
 *  left before the last boot, and a pin that runs in another PID namespace (S368). A lock written by ltms 0.2.0 or older
 *  has neither. */
export interface PinLockHolder { pid: number; host: string; started: string; boot?: string; pidns?: string }

/** One line of PINS.log. Which fields a line has depends on `how`: `root` (the first line), `takeover`, a file's line
 *  (`new`, `grown`, `rewritten`, `recovered`), or a `recovered` line that names a line cut short (`torn`). */
export interface PinLogLine {
  /** when the line was written (ISO) */
  t: string;
  how: 'root' | 'takeover' | PinHow;
  /** a file's line: its path under the root, '/'-separated */
  rel?: string;
  /** a file's line: the length of the version it records */
  bytes?: number;
  /** a file's line: the sha256 of that version */
  sha256?: string;
  /** a file's line: the version the line follows, or null for `new` and for a recovered file no line named */
  prev?: PinVersion | null;
  /** `rewritten` (and `recovered` after a crash in a rewrite): the rel of the copy that keeps the older versions */
  kept?: string;
  /** a file's line: the source's mtime, as stat gave it just before the read (ISO 8601 to the nanosecond:
   *  `2026-11-08T13:57:08.261123456Z`); for a recovered line that records a file found in the pin, the copy's */
  mtime?: string;
  /** `root`: the real path of the root the rels are measured from */
  root?: string;
  /** `root`: the ltms version that started the log, or null when package.json could not be read */
  ltms?: string | null;
  /** `takeover`: the lock that was taken over, as its file held it */
  lock?: PinLockHolder;
  /** `recovered` for a cut line: the number of the line (1-based) that did not end in a new line, and its length */
  torn?: { line: number; bytes: number };
  /** the sha256 of the bytes of the line before this one (without its new line); null on the first line */
  chain: string | null;
}

/** The steps of one file's write, in order, as onStep sees them: `stat` (before the read), `linked` (an old copy kept),
 *  `temp-written` (the temp file written, fsynced and closed), `renamed` (the temp renamed over the copy, and its
 *  directory fsynced), `logged` (the line appended and fsynced); `rename-retry` before each retry on win32. */
export type PinStep = 'stat' | 'linked' | 'temp-written' | 'renamed' | 'logged' | 'rename-retry';

/** pinPaths's options. Relative paths resolve against the current directory. */
export interface PinOptions {
  /** the pin directory, made with mode 0700 when it does not exist */
  to: string;
  /** the directory rels are measured from; default `<configDir>/projects` */
  root?: string;
  /** Claude Code's config directory; default `claudeConfigDir().path`: `$CLAUDE_CONFIG_DIR`, or `<home>/.claude` when
   *  that is unset or empty */
  configDir?: string;
  /** read and hash every file, even one whose size and mtime equal its last line; and read each copy whose source still
   *  holds the version its last line records, writing it again from that source when it holds other bytes */
  rehash?: boolean;
  /** how long to wait for a lock held by a running pin, in ms; default 30000 */
  lockWaitMs?: number;
  /** the platform whose rules apply; default `process.platform`. darwin and win32 compare paths without case; win32
   *  retries a rename that fails with EPERM, EACCES or EBUSY, and fsyncs no directory */
  platform?: string;
  /** called at each step of each file's write (the tests use it to stop a pin at a chosen step) */
  onStep?: (step: PinStep, rel: string) => void;
}

/** One run's counts. `seen` = new + grown + rewritten + unchanged + notCopied + failed. */
export interface PinCoverage {
  /** the root's real path */
  root: string;
  /** the pin directory's real path */
  to: string;
  files: {
    /** the files of the sweep's shape found under the given paths: the sum of the six below */
    seen: number;
    new: number;
    grown: number;
    rewritten: number;
    /** the copy already held the source's whole-line prefix (a copy written again from its source counts here too) */
    unchanged: number;
    /** .jsonl files with no new line yet (empty, or their first line still being written): nothing whole to copy, so
     *  no copy is written */
    notCopied: number;
    /** the source files that could not be read, kept or written, one failure each */
    failed: number;
  };
  /** every failure of the run, one line each: `files.failed` of them are source files; the rest are the pin directory,
   *  its lock or its log, a given path or a directory under it, or a file of the pin that recovery could not read */
  failures: number;
  /** .jsonl files with bytes after their last new line (or with no new line yet), left for a later pin; they are also
   *  counted in `files` */
  partial: number;
  /** what was found under the given paths and not copied */
  skipped: {
    /** files not of the sweep's shape */
    notSessionShaped: number;
    /** symbolic links met under the given paths, not followed */
    symlinks: number;
    /** `memory/` directories directly under a project directory, not entered */
    memory: number;
    /** `.git` directories, not entered */
    git: number;
  };
  /** the bytes written into copies */
  bytesCopied: number;
  /** pinned files under the given paths whose source is gone: what only the pin keeps */
  keptSourceGone: number;
  /** when PINS.log's last line was written (ISO), or null */
  lastLog: string | null;
  /** how long the run took, in ms */
  ms: number;
}

/** Where a failure happened: `to` (making the pin directory), `lock`, `log` (reading or appending PINS.log), `walk`
 *  (a given path or a directory under it), `read` (a source), `keep` (keeping an old copy), `write` (the temp file,
 *  the rename, the directory), `recover` (a file of the pin, read or removed by recovery). */
export type PinFailureOp = 'to' | 'lock' | 'log' | 'walk' | 'read' | 'keep' | 'write' | 'recover';

/** A file or directory that could not be read or written. */
export interface PinFailure {
  /** the absolute path */
  path: string;
  /** its rel, or null when it has none */
  rel: string | null;
  op: PinFailureOp;
  /** the error code (ENOENT, EACCES, ...); or `kept-copy-differs`: the name an old copy is kept by already holds other
   *  bytes, so the copy is left as it was; or `symlink-in-pin`: a directory between the pin directory and the copy is
   *  a symbolic link, which pin does not write through; or `not-a-regular-file`: PINS.log, the lock, a kept copy's name
   *  or a copy is a symbolic link, a FIFO or anything else but a regular file, which pin neither reads nor writes through
   *  (nor waits on) */
  code: string;
}

/** Why a pin or a check was refused before anything was written. */
export type PinRefusalReason =
  | 'no-to' | 'no-paths' | 'to-inside-config' | 'to-inside-path' | 'to-inside-root' | 'path-inside-to'
  | 'path-outside-root' | 'to-not-a-directory' | 'root-differs' | 'log-unreadable' | 'to-holds-files' | 'not-a-pin';

/** A refusal: nothing was read or written. The message echoes the input (with its real path when that differs). */
export interface PinRefusal {
  k: 'refused';
  reason: PinRefusalReason;
  message: string;
  /** `root-differs`: the root PINS.log's first line records, as pin read it (a caller's next step can name it without
   *  reading the log again) */
  recordedRoot?: string;
}

/** The lock was held by a running pin (or one that cannot be seen to have stopped) for the whole wait. */
export interface PinBusy {
  k: 'busy';
  /** the lock file's path */
  lock: string;
  /** what the lock holds, or null when it cannot be read as a lock */
  holder: PinLockHolder | null;
  /** the holder is on another host, so whether it still runs cannot be seen */
  otherHost: boolean;
  /** the holder is on this host in another PID namespace (a container, a sandbox), so whether it still runs cannot be
   *  seen either (S368) */
  otherNamespace: boolean;
  /** how long the pin waited, in ms */
  waitedMs: number;
  /** the holder, its start time, and the rm command */
  message: string;
}

/** A pin that ran. */
export interface PinDone {
  k: 'pinned';
  coverage: PinCoverage;
  /** one entry per file or directory that failed */
  failures: PinFailure[];
  /** every line this run appended to PINS.log, in order */
  lines: PinLogLine[];
  /** the lock this run took over from a pin that is no longer running, or null */
  takeover: PinLockHolder | null;
  /** temp files of an earlier pin, removed by this one */
  removedTemps: number;
  /** sentences about what recovery did and what the log holds */
  notices: string[];
  /** the signal that stopped the run between two files, or null */
  interrupted: string | null;
}

export type PinResult = PinRefusal | PinBusy | PinDone;

/** checkPin's options. */
export interface PinCheckOptions {
  /** the root to measure the staleness against; default the root PINS.log's first line records */
  root?: string;
  /** how long to wait for a lock held by a running pin before checking, in ms; default 30000 */
  lockWaitMs?: number;
  /** as in PinOptions */
  platform?: string;
}

/** A log line whose version is not what the copy that holds it holds. */
export interface PinMismatch {
  rel: string;
  /** the rel of the copy that holds the line's version, and was read: `rel` itself, or the kept copy a later line for
   *  `rel` names */
  copy: string;
  /** the line's number in PINS.log (1-based) */
  line: number;
  want: PinVersion;
  /** what the copy holds: its first `want.bytes` bytes, or the whole copy when it is shorter or, for the newest version
   *  in it, longer; null when the copy is missing, cannot be read, or is not a regular file */
  got: PinVersion | null;
}

/** A line whose chain is not the sha256 of the line before it. */
export interface PinChainBreak {
  line: number;
  /** the sha256 of the line before (null for the first line) */
  want: string | null;
  /** the line's own chain */
  got: string | null;
}

/** How far the pin is behind its sources. */
export interface PinStaleness {
  /** the root walked */
  root: string;
  /** the root is the one PINS.log records (no root was given) */
  fromLog: boolean;
  /** the files of the sweep's shape under the root */
  sources: number;
  /** of those, the ones with no copy in the pin; a .jsonl with no new line yet, which a pin does not copy, is not counted */
  missing: number;
  /** of those, the ones longer than their copy, except those counted in unfinished */
  longer: number;
  /** of those, the .jsonl files longer than their copy only by a line not yet finished: the copy is a byte prefix of the
   *  file (the sha256 of its first bytes, as many as the copy holds, is the copy's), and the file holds no new line past
   *  the copy's length, so a pin copies nothing of it; not counted in longer */
  unfinished: number;
  /** project directories under the root of which the pin holds nothing */
  projectsNotPinned: number;
  /** of the sources, those larger than a pin reads (PIN_MAX_BYTES, 2 GiB): every pin fails on each, so the pin falls
   *  behind them for good (also counted in missing or longer) */
  tooLarge: number;
  /** directories under the root (or the root itself) that could not be read */
  failed: number;
}

/** A check that ran. */
export interface PinCheckDone {
  k: 'checked';
  /** the pin directory's real path */
  dir: string;
  /** the root PINS.log's first line records, or null when that line is not a root line */
  root: string | null;
  /** the lines in PINS.log that end in a new line */
  lines: number;
  /** the names PINS.log has: its link count, from the file read. Above 1 (a hard link), a pin refuses it
   *  (`log-unreadable`), and a notice says so */
  logNames: number;
  /** the file lines checked */
  versions: number;
  /** the copies read, each once */
  files: number;
  mismatches: PinMismatch[];
  chainBreaks: PinChainBreak[];
  /** lines that are not log lines, a line cut short at the end included; a cut line that a recovered line names is not
   *  counted */
  unreadableLines: number[];
  /** files of the pin's shape that no line names */
  unlogged: string[];
  /** temp files left by a pin that stopped */
  temps: number;
  /** when the last line was written (ISO), or null */
  lastLog: string | null;
  /** null when no root is given and PINS.log records none */
  staleness: PinStaleness | null;
  /** what the lock file holds, when there is one: a pin is running, or one stopped without removing it */
  lock: PinLockHolder | null;
  notices: string[];
  ms: number;
}

export type PinCheckResult = PinRefusal | PinBusy | PinCheckDone;

// ---- names, shapes and small helpers ---------------------------------------------------------------------------

const LOG = 'PINS.log';
const LOCK = '.ltms-pin.lock';
/** A temp file of ours: `.<name>.ltms-tmp-<pid>`, in the directory of the file it becomes. */
const TEMP = /^\..+\.ltms-tmp-\d+$/;
/** The lock's own temp file, which a pin waiting for the lock keeps: left alone while its pid runs on this host. */
const LOCK_TEMP = /^\.\.ltms-pin\.lock\.ltms-tmp-(\d+)$/;
const tempName = (name: string): string => `.${name}.ltms-tmp-${process.pid}`;
/** The parts of a session directory that the sweep deletes with its transcript (mcp-tasks/: the docs' list). */
const SESSION_PARTS = new Set(['subagents', 'tool-results', 'workflows', 'mcp-tasks']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude Code's own set-aside copy of a transcript: <name>.jsonl.superseded-<ms>. */
const SET_ASIDE = /\.jsonl\.superseded-/;
/** The name an old copy is kept by. */
const KEPT = /\.superseded-[0-9a-f]{12}(?:\.jsonl)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;
/** On win32, a rename that fails with one of these is retried RENAME_TRIES times, RENAME_PAUSE_MS apart (about 2 s). */
const RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_TRIES = 20;
const RENAME_PAUSE_MS = 100;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const NL = Buffer.from('\n');

const now = (): string => new Date().toISOString();
const p2 = (n: bigint): string => String(n).padStart(2, '0');
/** The civil date (year, month, day) of a count of days since 1970-01-01, in the proleptic Gregorian calendar, in BigInt
 *  (H. Hinnant's civil_from_days), so that a file time past the range of a JavaScript Date has one too. */
function civil(days: bigint): [bigint, bigint, bigint] {
  const z = days + 719_468n;
  const era = (z >= 0n ? z : z - 146_096n) / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  return [yoe + era * 400n + (m <= 2n ? 1n : 0n), m, doy - (153n * mp + 2n) / 5n + 1n];
}
/** A file time, in ns since the epoch, as ISO 8601 to the nanosecond: what the fast path compares. A millisecond holds
 *  many writes (measured: 2,000 writes of one file, each followed by a stat, took 23 ms and got 2,000 distinct mtimes).
 *  The years 0000-9999 as a Date writes them (every line before S368 holds that form); any other year, which a file
 *  system can store (btrfs keeps an mtime of 9e12 s), in ISO 8601's expanded form, a sign and six digits or more
 *  (`+287014-...`): S368, the adversarial reading's A9 (a Date out of range threw, and stopped every pin at that file). */
function isoNs(ns: bigint): string {
  let s = ns / 1_000_000_000n, f = ns % 1_000_000_000n;
  if (f < 0n) { s -= 1n; f += 1_000_000_000n; }
  const frac = String(f).padStart(9, '0');
  if (s >= -62_167_219_200n && s <= 253_402_300_799n) return `${new Date(Number(s) * 1000).toISOString().slice(0, 19)}.${frac}Z`;
  let days = s / 86_400n, sec = s % 86_400n;
  if (sec < 0n) { days -= 1n; sec += 86_400n; }
  const [y, mo, d] = civil(days);
  const year = `${y < 0n ? '-' : '+'}${String(y < 0n ? -y : y).padStart(6, '0')}`;
  return `${year}-${p2(mo)}-${p2(d)}T${p2(sec / 3600n)}:${p2((sec % 3600n) / 60n)}:${p2(sec % 60n)}.${frac}Z`;
}
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const codeOf = (e: unknown): string => {
  const c = (e as NodeJS.ErrnoException | null)?.code;
  return typeof c === 'string' ? c : e instanceof Error ? e.name : 'Error';
};
/** An error the file system raised (it carries an errno code and a syscall), or a file of the pin that is not a regular
 *  file (NotRegularFile), as against a bug, or an error thrown by onStep: those are not failures of one file, and are
 *  thrown on. */
const isFsError = (e: unknown): boolean => e instanceof NotRegularFile
  || (e instanceof Error && typeof (e as NodeJS.ErrnoException).code === 'string' && typeof (e as NodeJS.ErrnoException).syscall === 'string');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const yieldToSignals = (): Promise<void> => new Promise((r) => setImmediate(r));

let versionRead: string | null | undefined;
function ltmsVersion(): string | null {
  if (versionRead === undefined) {
    try {
      const v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
      versionRead = typeof v === 'string' ? v : null;
    } catch { versionRead = null; }
  }
  return versionRead;
}

function writeAll(fd: number, b: Uint8Array): void {
  for (let off = 0; off < b.length;) off += writeSync(fd, b, off, b.length - off);
}

/** The largest file pin reads: Node's Buffer indexOf and lastIndexOf take a 32-bit offset (measured, node 24: on a 2.4 GB
 *  buffer, lastIndexOf found its last new line at -1,883,242,454), and fs.writeSync refuses a length over 2^31 - 1. A
 *  larger file is a failure, ERR_FS_FILE_TOO_LARGE, before anything is read (as 0.2.0 failed on it), and --check counts
 *  it (PinStaleness.tooLarge). S368: a first repair read such a file in parts, and wrote a copy cut at a wrapped offset. */
const PIN_MAX_BYTES = 2 ** 31 - 1;
/** An open file's bytes, read to its end (it may have grown since its size was taken). */
function readFd(fd: number, size: number): Buffer {
  let buf = Buffer.allocUnsafe(Math.max(size, 0)), n = 0;
  for (;;) {
    if (n === buf.length) {
      const more = Buffer.allocUnsafe(65536);
      const r = readSync(fd, more, 0, more.length, n);
      if (r === 0) return buf;
      const bigger = Buffer.allocUnsafe(Math.max(buf.length * 2, n + r));
      buf.copy(bigger, 0, 0, n);
      more.copy(bigger, n, 0, r);
      buf = bigger;
      n += r;
      continue;
    }
    const r = readSync(fd, buf, n, buf.length - n, n);
    if (r === 0) return buf.subarray(0, n);
    n += r;
  }
}
/** A file's bytes, read once, to its end. */
function readWhole(path: string, size: number): Buffer {
  const fd = openSync(path, 'r');
  try { return readFd(fd, size); } finally { closeSync(fd); }
}

/** What a path that is not a regular file is, as lstat saw it. */
function kindOf(st: Stats): string {
  return st.isSymbolicLink() ? 'a symbolic link' : st.isDirectory() ? 'a directory' : st.isFIFO() ? 'a FIFO'
    : st.isSocket() ? 'a socket' : 'a device';
}

/** A path that openRegular would not open: a symbolic link, or anything else but a regular file (a FIFO, a socket, a
 *  device, a directory). Its code is a failure's: `not-a-regular-file`. */
class NotRegularFile extends Error {
  readonly code = 'not-a-regular-file';
  constructor(readonly path: string, readonly kind: string) { super(`'${path}' is ${kind}, not a regular file`); }
  get link(): boolean { return this.kind === 'a symbolic link'; }
}

/** Where the platform defines them (not on win32): an open that fails on a symbolic link, and one that does not wait (a
 *  FIFO opened to read waits for a writer, and opened to write, for a reader). Neither changes how a regular file reads. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

/** Opens path only when it is a regular file, so a symbolic link is never read or written through and a FIFO never waited
 *  on: lstat first (NotRegularFile, saying what it is); then the open itself refuses a link (O_NOFOLLOW: ELOOP) and does
 *  not wait (O_NONBLOCK), where the platform defines them, and fstat checks what was opened, so that a file put in its
 *  place between the two is refused too. A missing path throws ENOENT, as an open does, unless flags hold O_CREAT. The
 *  pin's own files (PINS.log, the lock, a kept copy, a copy the check reads) and the sources the check reads are opened
 *  this way. */
function openRegular(path: string, flags: number, mode?: number): number {
  let st: Stats | null = null;
  try { st = lstatSync(path); } catch (e) { if (!(flags & fsConstants.O_CREAT) || codeOf(e) !== 'ENOENT') throw e; }
  if (st !== null && !st.isFile()) throw new NotRegularFile(path, kindOf(st));
  const fd = openSync(path, flags | O_NOFOLLOW | O_NONBLOCK, mode);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new NotRegularFile(path, kindOf(opened));
  } catch (e) { closeSync(fd); throw e; }
  return fd;
}
/** A regular file's bytes, read whole, by openRegular's rules. */
function readRegular(path: string): Buffer {
  const fd = openRegular(path, fsConstants.O_RDONLY);
  try { return readFd(fd, fstatSync(fd).size); } finally { closeSync(fd); }
}
/** PINS.log read as readRegular reads it, with the link count and the inode of the very file read (fstat): another name,
 *  a hard link, is one that neither lstat nor O_NOFOLLOW sees. */
function readLog(path: string): { bytes: Buffer; names: number; ino: bigint } {
  const fd = openRegular(path, fsConstants.O_RDONLY);
  try {
    const s = fstatSync(fd, { bigint: true });
    return { names: Number(s.nlink), ino: s.ino, bytes: readFd(fd, Number(s.size)) };
  } finally { closeSync(fd); }
}

/** fsync a directory, so that a rename in it survives a power loss. Not on win32, where a directory cannot be opened. */
function fsyncDir(dir: string, platform: string): void {
  if (platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); }
  catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(codeOf(e))) throw e; }   // a file system that cannot fsync one
  finally { closeSync(fd); }
}

// ---- paths -------------------------------------------------------------------------------------------------------

/** Claude Code's config directory, as Claude Code reads it: `$CLAUDE_CONFIG_DIR`, or `<home>/.claude` when that is unset
 *  or empty. Read at each call. The one place this rule is written: pinPaths' default, `ltms pin` and `ltms search` use
 *  it. */
export function claudeConfigDir(): {
  /** the directory, as the variable gives it, or `<home>/.claude` (os.homedir()) */
  path: string;
  /** `true` when $CLAUDE_CONFIG_DIR gave it */
  fromEnv: boolean;
} {
  const set = process.env.CLAUDE_CONFIG_DIR;
  return set ? { path: set, fromEnv: true } : { path: join(homedir(), '.claude'), fromEnv: false };
}

/** The real path of p; when p does not exist yet, the real path of its nearest existing ancestor, with the rest of p. */
function realOrNearest(p: string): string {
  const tail: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try { return join(realpathSync.native(cur), ...tail); }
    catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      tail.unshift(basename(cur));
      cur = up;
    }
  }
}
const folded = (p: string, platform: string): string => (platform === 'darwin' || platform === 'win32' ? p.toLowerCase() : p);
/** a is b, or is inside b: path.relative(b, a) is '', or neither leaves b (a first segment '..') nor is absolute. */
function inside(a: string, b: string, platform: string): boolean {
  const r = relative(folded(b, platform), folded(a, platform));
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}
/** A path as it was given, and its real path when that is not just the given one made absolute. */
const shown = (given: string, real: string): string => (resolve(given) === real ? `'${given}'` : `'${given}' (real path '${real}')`);
/** A path as one word of a command a notice gives, by cli.ts's rule for the commands it gives (its `quoted`): in single
 *  quotes, with every ' and every backslash written outside them, as backslash-quote and backslash-backslash, so the
 *  command runs as printed in sh, bash, zsh and fish whatever the path holds. */
const quoted = (s: string): string => `'${s.replace(/['\\]/g, (c) => `'\\${c}'`)}'`;
/** A rel read from PINS.log is used only when it cannot lead out of the pin. */
function safeRel(r: unknown, platform: string): r is string {
  return typeof r === 'string' && r.length > 0 && !r.includes('\0') && !isAbsolute(r)
    && !(platform === 'win32' && /[\\:]/.test(r)) && r.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
const under = (root: string, rel: string): string => join(root, ...rel.split('/'));
/** The rel an old copy of rel is kept by: <stem>.superseded-<sha12>.jsonl for a .jsonl, else <rel>.superseded-<sha12>. */
const keptRel = (rel: string, sha: string): string =>
  (rel.endsWith('.jsonl') ? `${rel.slice(0, -'.jsonl'.length)}.superseded-${sha.slice(0, 12)}.jsonl` : `${rel}.superseded-${sha.slice(0, 12)}`);

/** The sweep's own shape, for rels under a root: <project>/<name>.jsonl, <project>/<name>.jsonl.superseded-*, and every
 *  file under <project>/<dir>/{subagents,tool-results,workflows,mcp-tasks}/ of a session directory: one whose name is a
 *  UUID, or whose name plus .jsonl names a file beside it. */
function shapeOf(root: string): (rel: string) => boolean {
  const sessionDir = new Map<string, boolean>();
  const isSessionDir = (project: string, name: string): boolean => {
    const key = `${project}/${name}`;
    let v = sessionDir.get(key);
    if (v === undefined) {
      v = UUID.test(name);
      if (!v) { try { v = lstatSync(join(root, project, `${name}.jsonl`)).isFile(); } catch { v = false; } }
      sessionDir.set(key, v);
    }
    return v;
  };
  return (rel) => {
    const s = rel.split('/');
    if (s.length === 2) return s[1].endsWith('.jsonl') || SET_ASIDE.test(s[1]);
    return s.length >= 4 && SESSION_PARTS.has(s[2]) && isSessionDir(s[0], s[1]);
  };
}

/** Whether rel, a path under root ('/'-separated), is of the sweep's own shape, which pinPaths copies:
 *  `<project>/<name>.jsonl`, `<project>/<name>.jsonl.superseded-*`, or a file under `<project>/<dir>/{subagents,
 *  tool-results,workflows,mcp-tasks}/` of a session directory, one whose name is a UUID or whose name plus `.jsonl` is a
 *  regular file beside it under root (lstat). Nothing else is looked at: not whether the file rel names is there. The
 *  rule is written once: pinPaths and checkPin select by it, and `ltms pin --check` asks it before it gives the
 *  `--rehash` command. */
export function isSweepShaped(root: string, rel: string): boolean { return shapeOf(root)(rel); }

/** The directories the walk does not enter, by their name and their depth under the root (a project directory is at
 *  depth 1): `.git`, at any depth, and `memory` directly under a project directory. The rule is written once: walk()
 *  asks it of each directory it meets, and projectPinReaches of each directory on the way to a file. */
function walkSkips(name: string, depth: number): 'git' | 'memory' | null {
  return name === '.git' ? 'git' : depth === 2 && name === 'memory' ? 'memory' : null;
}

/** Whether a pin of the project directory of `rel` (a path under the root, '/'-separated, whose first segment is its
 *  project directory) walks to the file at `rel`: the walk enters no `.git` directory, at any depth, and no `memory/`
 *  directly under a project directory, so a file under one of those is pinned only when it is given by its own path.
 *  Only the names on the way are read, nothing on disk: whether the file is there, of the sweep's shape
 *  (isSweepShaped), or reached through a symbolic link (which the walk does not follow) is not looked at. The walk's
 *  rule is written once: `ltms pin --check` asks it to name, in the `--rehash` command it gives, a copy's project
 *  directory, or the file itself. */
export function projectPinReaches(rel: string): boolean {
  return rel.split('/').slice(0, -1).every((name, i) => walkSkips(name, i + 1) === null);
}

interface Given { given: string; resolved: string; real: string }
interface Walk {
  /** rel -> the source's absolute path */
  files: Map<string, string>;
  skipped: PinCoverage['skipped'];
  failures: PinFailure[];
  /** the project directories entered */
  projects: Set<string>;
  /** the rels the given paths cover (a given <sid>.jsonl covers its <sid>/ too); '' is the whole root */
  covered: string[];
  /** the rels at and under which the walk could not see what is there, each with its failure (op walk): a directory it
   *  could not list, an entry or a given path it could not lstat, and a given <sid>.jsonl's <sid>/, which it then did
   *  not enter; '' is the whole root */
  unread: string[];
}

/** The files of the sweep's shape under the given paths. Symbolic links met on the way, memory/ directly under a
 *  project, and .git are counted, never followed; every path is counted once, however many given paths reach it. */
function walk(givens: Given[], root: string): Walk {
  const w: Walk = { files: new Map(), skipped: { notSessionShaped: 0, symlinks: 0, memory: 0, git: 0 }, failures: [], projects: new Set(), covered: [], unread: [] };
  const shaped = shapeOf(root);
  const seen = new Set<string>();
  const relOf = (abs: string): string => relative(root, abs).split(sep).join('/');
  const once = (abs: string): boolean => (seen.has(abs) ? false : (seen.add(abs), true));
  /** A path the walk could not read: a failure of the run, and the rels it did not see there (rel, or those given). */
  const failed = (path: string, rel: string, err: unknown, unread: string[] = [rel]): void => {
    w.failures.push({ path, rel, op: 'walk', code: codeOf(err) });
    w.unread.push(...unread);
  };
  const file = (abs: string): void => {
    if (!once(abs)) return;
    const rel = relOf(abs);
    if (shaped(rel)) w.files.set(rel, abs); else w.skipped.notSessionShaped++;
  };
  const enter = (start: string): void => {
    const stack = [start];
    while (stack.length) {
      const d = stack.pop()!;
      if (!once(d)) continue;
      const rel = relOf(d), depth = rel === '' ? 0 : rel.split('/').length;
      const skip = walkSkips(basename(d), depth);
      if (skip !== null) { w.skipped[skip]++; continue; }
      if (depth === 1) w.projects.add(rel);
      let entries: Dirent[];
      try { entries = readdirSync(d, { withFileTypes: true }); }
      catch (e) { failed(d, rel, e); continue; }
      for (const e of entries) {
        const abs = join(d, e.name);
        let kind: Dirent | Stats = e;
        if (!(e.isFile() || e.isDirectory() || e.isSymbolicLink() || e.isFIFO() || e.isSocket() || e.isBlockDevice() || e.isCharacterDevice())) {
          try { kind = lstatSync(abs); }   // a file system that does not give the entry's type
          catch (err) { failed(abs, relOf(abs), err); continue; }
        }
        if (kind.isSymbolicLink()) { if (once(abs)) w.skipped.symlinks++; }
        else if (kind.isDirectory()) stack.push(abs);
        else if (kind.isFile()) file(abs);
        else if (once(abs)) w.skipped.notSessionShaped++;   // a socket, a FIFO, a device: never opened
      }
    }
  };
  for (const g of givens) {
    const rel = relOf(g.real), s = rel.split('/');
    const sessionOf = s.length === 2 && s[1].endsWith('.jsonl') ? join(dirname(g.real), s[1].slice(0, -'.jsonl'.length)) : null;
    w.covered.push(rel);
    if (sessionOf !== null) w.covered.push(relOf(sessionOf));
    let st: Stats;
    try { st = lstatSync(g.real); }
    catch (e) { failed(g.resolved, rel, e, sessionOf === null ? [rel] : [rel, relOf(sessionOf)]); continue; }
    if (st.isDirectory()) { enter(g.real); continue; }
    if (!st.isFile()) { if (once(g.real)) w.skipped.notSessionShaped++; continue; }
    file(g.real);
    if (sessionOf !== null) {   // a given <sid>.jsonl: its <sid>/ the same way
      let ds: Stats | undefined;
      try { ds = lstatSync(sessionOf); } catch { /* no session directory */ }
      if (ds?.isSymbolicLink()) { if (once(sessionOf)) w.skipped.symlinks++; }
      else if (ds?.isDirectory()) enter(sessionOf);
    }
  }
  return w;
}

interface PinScan {
  /** every file in the pin but PINS.log, the lock and temp files: rel -> its size and mtime (ISO, to the ns) */
  files: Map<string, { size: number; mtime: string }>;
  /** files of the pin's own shape (the sweep's, measured from the pin) */
  shaped: (rel: string) => boolean;
  temps: string[];
  /** the directories of the pin that could not be listed: rel ('' for the pin directory) -> the error's code. What is in
   *  one cannot be seen, so a pin writes nothing at or under it (S368, the adversarial reading's A5: a rewrite was renamed
   *  over a copy the scan had not seen, with nothing kept) */
  unlisted: Map<string, string>;
}
function scanPin(to: string): PinScan {
  const scan: PinScan = { files: new Map(), shaped: shapeOf(to), temps: [], unlisted: new Map() };
  const stack = [to];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); }
    catch (e) { if (codeOf(e) !== 'ENOENT') scan.unlisted.set(relative(to, d).split(sep).join('/'), codeOf(e)); continue; }
    for (const e of entries) {
      const abs = join(d, e.name);
      // every directory, .git too: the copy of a file pinned by its own path under a source's .git/ is under one, and a
      // copy the scan does not see reads as missing (written over at a rewrite, its old version not kept)
      if (e.isDirectory()) { stack.push(abs); continue; }
      if (!e.isFile()) continue;
      if (TEMP.test(e.name)) {
        const waiting = d === to ? LOCK_TEMP.exec(e.name) : null;
        if (waiting === null || !running(Number(waiting[1]))) scan.temps.push(abs);
        continue;
      }
      if (d === to && (e.name === LOG || e.name === LOCK)) continue;
      try { const s = lstatSync(abs, { bigint: true }); scan.files.set(relative(to, abs).split(sep).join('/'), { size: Number(s.size), mtime: isoNs(s.mtimeNs) }); }
      catch { /* gone since the listing */ }
    }
  }
  return scan;
}

// ---- the log -----------------------------------------------------------------------------------------------------

interface FileState { bytes: number; sha256: string; mtime: string | null }
interface LogState {
  path: string;
  /** the lines that end in a new line */
  lines: number;
  /** each such line's bytes, and what it parsed to (null: not a log line) */
  raw: Buffer[];
  parsed: Array<PinLogLine | null>;
  /** line 1, when it is a root line */
  root: PinLogLine | null;
  /** the last version each rel's lines record */
  byRel: Map<string, FileState>;
  /** every rel a line names, as its rel or as its kept copy */
  named: Set<string>;
  /** the rels lines name as a kept copy (`kept`): names a source's copy is never written at */
  keptRels: Set<string>;
  lastT: string | null;
  /** bytes after the last new line: a line cut short */
  torn: Buffer | null;
  /** lines that are not log lines (a cut line that a recovered line names is taken out) */
  unreadable: number[];
  /** the log's length in bytes as this run knows it (read, and appended since), and the inode it read: a pin stops when
   *  PINS.log is not that file at that length any more (another process wrote to it, or put another file at its name) */
  end: number;
  ino: bigint | null;
}
const FILE_HOWS = new Set(['new', 'grown', 'rewritten', 'recovered']);
const isVersion = (v: unknown): v is PinVersion =>
  isObject(v) && Number.isSafeInteger(v.bytes) && (v.bytes as number) >= 0 && typeof v.sha256 === 'string' && SHA256.test(v.sha256);
const isHolder = (v: unknown): v is PinLockHolder =>
  isObject(v) && Number.isSafeInteger(v.pid) && (v.pid as number) > 0 && typeof v.host === 'string' && typeof v.started === 'string';
/** A file's line: one that records a version of a rel. */
const isFileLine = (l: PinLogLine, platform: string): boolean =>
  FILE_HOWS.has(l.how) && safeRel(l.rel, platform) && isVersion(l) && (l.prev === undefined || l.prev === null || isVersion(l.prev))
  && (l.kept === undefined || safeRel(l.kept, platform));

/** What one line of PINS.log is, or null when it is not a log line. */
function parseLine(b: Buffer, n: number, platform: string): PinLogLine | null {
  let o: unknown;
  try { o = JSON.parse(b.toString('utf8')); } catch { return null; }
  if (!isObject(o) || typeof o.t !== 'string' || typeof o.how !== 'string' || !(o.chain === null || typeof o.chain === 'string')) return null;
  const l = o as unknown as PinLogLine;
  if (l.how === 'root') return n === 1 && typeof l.root === 'string' ? l : null;
  if (l.how === 'takeover') return isHolder(l.lock) ? l : null;
  if (l.how === 'recovered' && l.rel === undefined) return isObject(l.torn) && Number.isSafeInteger(l.torn.line) && Number.isSafeInteger(l.torn.bytes) ? l : null;
  return isFileLine(l, platform) ? l : null;
}

/** Takes one whole line into the state. */
function take(st: LogState, b: Buffer, platform: string): PinLogLine | null {
  st.lines++;
  st.raw.push(b);
  const l = parseLine(b, st.lines, platform);
  st.parsed.push(l);
  if (l === null) { st.unreadable.push(st.lines); return null; }
  if (l.how === 'root') st.root = l;
  if (l.rel !== undefined && FILE_HOWS.has(l.how)) {
    st.byRel.set(l.rel, { bytes: l.bytes!, sha256: l.sha256!, mtime: typeof l.mtime === 'string' ? l.mtime : null });
    st.named.add(l.rel);
    if (l.kept !== undefined) { st.named.add(l.kept); st.keptRels.add(l.kept); }
  }
  if (l.torn !== undefined) st.unreadable = st.unreadable.filter((k) => k !== l.torn!.line);
  st.lastT = l.t;
  return l;
}

function parseLog(path: string, buf: Buffer, platform: string, ino: bigint | null = null): LogState {
  const st: LogState = { path, lines: 0, raw: [], parsed: [], root: null, byRel: new Map(), named: new Set(), keptRels: new Set(), lastT: null, torn: null, unreadable: [], end: buf.length, ino };
  let start = 0;
  for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, start)) {
    take(st, buf.subarray(start, nl), platform);
    start = nl + 1;
  }
  if (start < buf.length) st.torn = buf.subarray(start);
  return st;
}

/** A write to PINS.log that failed: the pin stops there, since nothing more it did could be recorded. */
class LogWriteError extends Error {
  constructor(readonly reason: unknown) { super('PINS.log could not be written'); }
}

class Log {
  private fd: number | null = null;
  /** guard: called before each write, it throws when this pin may no longer write (LockLost) */
  constructor(readonly st: LogState, private readonly written: PinLogLine[], private readonly platform: string, private readonly guard: () => void = () => {}) {}
  /** The log, opened to append, only as a regular file: never through a symbolic link put at its name (openRegular). */
  private open(): number {
    if (this.fd === null) this.fd = openRegular(this.st.path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, FILE_MODE);
    return this.fd;
  }
  /** Appends one line, chained to the line before it, and fsyncs it. */
  append(fields: Omit<PinLogLine, 'chain'>): PinLogLine {
    this.guard();
    const line = { ...fields, chain: this.st.raw.length ? sha256(this.st.raw[this.st.raw.length - 1]) : null } as PinLogLine;
    const b = Buffer.from(JSON.stringify(line), 'utf8');
    try { const fd = this.open(); writeAll(fd, Buffer.concat([b, NL])); fsyncSync(fd); }
    catch (e) { throw new LogWriteError(e); }
    this.st.end += b.length + 1;
    take(this.st, b, this.platform);
    this.written.push(line);
    return line;
  }
  /** A log that does not end in a new line: the cut line is closed as it is, and a recovered line names it. */
  closeTorn(): void {
    const torn = this.st.torn;
    if (torn === null) return;
    this.guard();
    try { const fd = this.open(); writeAll(fd, NL); fsyncSync(fd); }
    catch (e) { throw new LogWriteError(e); }
    this.st.end += 1;
    this.st.torn = null;
    take(this.st, torn, this.platform);
    this.append({ t: now(), how: 'recovered', torn: { line: this.st.lines, bytes: torn.length } });
  }
  close(): void { if (this.fd !== null) { closeSync(this.fd); this.fd = null; } }
}

/** A new PINS.log holding its root line, made whole before it gets its name (written to a temp file, fsynced, then
 *  linked), so its first line is never cut short. */
function createLog(to: string, root: string, written: PinLogLine[], platform: string): LogState {
  const path = join(to, LOG), tmp = join(to, tempName(LOG));
  const line: PinLogLine = { t: now(), how: 'root', root, ltms: ltmsVersion(), chain: null };
  const b = Buffer.from(JSON.stringify(line), 'utf8');
  const fd = openSync(tmp, 'wx', FILE_MODE);
  try { writeAll(fd, Buffer.concat([b, NL])); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, path); } finally { unlinkSync(tmp); }
  fsyncDir(to, platform);
  written.push(line);
  // the bytes just written: nothing is read back at that name; the inode is the one linked
  return parseLog(path, Buffer.concat([b, NL]), platform, lstatSync(path, { bigint: true }).ino);
}

// ---- the lock ----------------------------------------------------------------------------------------------------

/** The locks this process holds, so that a lock naming this pid that this process did not take is known to be left by
 *  an earlier process that had the same pid. */
const heldHere = new Set<string>();
interface Held { path: string; body: string; released: boolean }

function holderIn(raw: string): PinLockHolder | null {
  try {
    const o: unknown = JSON.parse(raw);
    if (!isHolder(o)) return null;
    const h: PinLockHolder = { pid: o.pid, host: o.host, started: o.started };
    const fields = o as unknown as Record<string, unknown>;
    for (const k of ['boot', 'pidns'] as const) { const v = fields[k]; if (typeof v === 'string') h[k] = v; }
    return h;
  } catch { return null; }
}
/** process.kill(pid, 0): ESRCH means no such process; anything else (EPERM: another user's) means it runs. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return codeOf(e) !== 'ESRCH'; }
}
/** This host's boot id and this process's PID namespace, where /proc gives them (Linux), read once; else null. */
let selfRead: { boot: string | null; pidns: string | null } | undefined;
function self(): { boot: string | null; pidns: string | null } {
  if (selfRead === undefined) {
    let boot: string | null = null, pidns: string | null = null;
    try { boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { /* not Linux, or no /proc */ }
    try { pidns = readlinkSync('/proc/self/ns/pid'); } catch { /* not Linux, or no /proc */ }
    selfRead = { boot, pidns };
  }
  return selfRead;
}

/** What a lock tells of its holder: `dead` (taken over), or why it counts as running: `running` (its process runs on this
 *  host), `other-host`, `other-namespace` (on this host, in another PID namespace: its pid names nothing here), or
 *  `unreadable` (not a pin's lock). Dead: on this host, left before its last boot (another boot id), or its pid runs no
 *  process, or this process's own pid when this process did not take it. A running pid counts as the lock's holder, as
 *  in 0.2.0: a start time would tell a reused pid, but a time namespace shifts the start time a process sees, and a
 *  live pin was taken over (S368, the re-check's A3). A lock with no boot id or namespace is read by its pid alone. */
type LockSeen = 'dead' | 'running' | 'other-host' | 'other-namespace' | 'unreadable';
function lockSeen(path: string, holder: PinLockHolder | null): LockSeen {
  if (holder === null) return 'unreadable';
  if (holder.host !== hostname()) return 'other-host';
  const me = self();
  if (holder.boot !== undefined && me.boot !== null && holder.boot !== me.boot) return 'dead';
  if (holder.pidns !== undefined && me.pidns !== null && holder.pidns !== me.pidns) return 'other-namespace';
  if (holder.pid === process.pid) return heldHere.has(path) ? 'running' : 'dead';
  return running(holder.pid) ? 'running' : 'dead';
}

function busy(path: string, holder: PinLockHolder | null, seen: LockSeen, waitedMs: number): PinBusy {
  const waited = `${(waitedMs / 1000).toFixed(1)} s`;
  const who = holder === null
    ? `could not be read as a pin's lock (a pid, a host and a start time), so which process holds it cannot be told; it was still there after ${waited}`
    : seen === 'other-host'
      ? `is held by pid ${holder.pid} on another host, ${holder.host}, since ${holder.started}; whether that process still runs cannot be seen from this host, so it counts as running, and it still held the lock after ${waited}`
      : seen === 'other-namespace'
        ? `is held by pid ${holder.pid} in another PID namespace on this host (a container or a sandbox: ${holder.pidns}), since ${holder.started}; whether that process still runs cannot be seen from here, so it counts as running, and it still held the lock after ${waited}`
        : `is held by pid ${holder.pid} on this host, since ${holder.started}; a process with that pid is running, and it still held the lock after ${waited}`;
  return { k: 'busy', lock: path, holder, otherHost: seen === 'other-host', otherNamespace: seen === 'other-namespace', waitedMs,
    message: `the lock '${path}' ${who}. If no pin is running, remove the lock: rm ${quoted(path)}` };
}

/** The lock this pin took no longer holds what it wrote into it (removed, or another pin's), or PINS.log is no longer the
 *  file this pin read at the length it knows (another process wrote to it): the pin stops before its next write (S368,
 *  the adversarial reading's C2, A2 and B1: two pins at once, each deciding from what it read at its start). */
class LockLost extends Error {
  constructor(readonly what: 'lock' | 'log', readonly path: string) { super(what === 'lock' ? 'the lock is not this pin\'s any more' : 'PINS.log changed under this pin'); }
}

type Acquired = { k: 'held'; held: Held; takeover: PinLockHolder | null } | PinBusy | { k: 'failed'; failure: PinFailure }
  | { k: 'stopped' };
/** Set by the signal listeners of a run, and read between two steps of it. */
interface Stop { signal: NodeJS.Signals | null }

/** Takes <to>/.ltms-pin.lock: its content (pid, host, started) is written and fsynced in a temp file first, and the
 *  temp file is then linked to the lock's name, which fails when the lock exists, so a lock is never seen empty. A
 *  lock whose pid no longer runs on this host is taken over; any other is waited for, up to waitMs, unless a signal
 *  stops the wait (`stopped`). */
async function acquire(to: string, waitMs: number, stop: Stop): Promise<Acquired> {
  const path = join(to, LOCK), tmp = join(to, tempName(LOCK));
  const me = self();
  const body = JSON.stringify({ pid: process.pid, host: hostname(), started: now(),
    ...(me.boot === null ? {} : { boot: me.boot }), ...(me.pidns === null ? {} : { pidns: me.pidns }) });
  const t0 = Date.now();
  let takeover: PinLockHolder | null = null;
  const failed = (e: unknown): Acquired => ({ k: 'failed', failure: { path, rel: null, op: 'lock', code: codeOf(e) } });
  const writeTemp = (): void => {
    // whatever is at the temp file's name (left by an earlier process with this pid, or planted there) is removed, never
    // opened: 'wx' makes a new file, does not follow a symbolic link, and fails when the name was taken again meanwhile
    try { unlinkSync(tmp); } catch (e) { if (codeOf(e) !== 'ENOENT') throw e; }
    const fd = openSync(tmp, 'wx', FILE_MODE);
    try { writeAll(fd, Buffer.from(body)); fsyncSync(fd); } finally { closeSync(fd); }
  };
  try {
    try { writeTemp(); } catch (e) { return failed(e); }
    for (;;) {
      try {
        linkSync(tmp, path);
        heldHere.add(path);
        return { k: 'held', held: { path, body, released: false }, takeover };
      } catch (e) {
        if (codeOf(e) === 'ENOENT') { try { writeTemp(); continue; } catch (e2) { return failed(e2); } }   // our temp file was removed
        if (codeOf(e) !== 'EEXIST') return failed(e);
      }
      // the lock is read only as a regular file: a FIFO there would hold the pin, past every signal, waiting for a
      // writer, and a symbolic link would be read through (a failure, op lock, not-a-regular-file)
      let raw: string;
      try { raw = readRegular(path).toString('utf8'); } catch (e) { if (codeOf(e) === 'ENOENT') continue; return failed(e); }
      const holder = holderIn(raw);
      // a lock naming this pid that this process did not take was left by an earlier process with the same pid
      const seen = lockSeen(path, holder);
      if (seen === 'dead') {
        let again: string | null = null;
        try { again = readRegular(path).toString('utf8'); } catch { /* removed meanwhile, or no longer a regular file */ }
        if (again === raw) {
          // two pins that find the same dead lock at once can both remove it, the second one the first one's new lock:
          // the one whose lock is not at the name any more stops before its next write (LockLost)
          try { unlinkSync(path); } catch (e) { if (codeOf(e) !== 'ENOENT') return failed(e); }
          takeover = holder;
        }
        continue;
      }
      const waited = Date.now() - t0;
      if (waited >= waitMs) return busy(path, holder, seen, waited);
      await sleep(Math.min(LOCK_POLL_MS, waitMs - waited));
      if (stop.signal !== null) return { k: 'stopped' };
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* not made, or linked and removed */ }
  }
}

/** Whether the lock at path names a pin that may be running (lockSeen: anything but `dead`). */
const lockLive = (path: string, holder: PinLockHolder | null): boolean => lockSeen(path, holder) !== 'dead';

/** Throws LockLost unless the lock still holds what this pin wrote into it and PINS.log is the file this pin read, at the
 *  length it knows: called before each write that could replace or remove a file of the pin, and before each line. */
function guard(h: Held, st: LogState): void {
  let now: string | null = null;
  try { now = readRegular(h.path).toString('utf8'); } catch { /* removed, or no longer a regular file */ }
  if (now !== h.body) throw new LockLost('lock', h.path);
  // PINS.log removed, or another regular file or this one at another length; what is not a regular file at its name is
  // left to the append, which opens only a regular file (a failure, op log, with the code of the refusal)
  let s: BigIntStats | null = null;
  try { s = lstatSync(st.path, { bigint: true }); } catch { /* removed */ }
  if (s === null || (s.isFile() && (Number(s.size) !== st.end || (st.ino !== null && s.ino !== st.ino)))) throw new LockLost('log', st.path);
}

/** Removes the lock, only while it still holds what this pin wrote into it: something else put at its name (read only as
 *  a regular file, since this runs at exit too) is left. */
function release(h: Held): void {
  if (h.released) return;
  h.released = true;
  heldHere.delete(h.path);
  try { if (readRegular(h.path).toString('utf8') === h.body) unlinkSync(h.path); } catch { /* gone already, or not a lock */ }
}

// ---- pinPaths ----------------------------------------------------------------------------------------------------

function refuse(reason: PinRefusalReason, message: string): PinRefusal { return { k: 'refused', reason, message }; }

interface Prepared { k: 'ok'; to: string; root: string; givens: Given[] }

/** The refusals, each checked on real paths, before anything is read or written. */
function prepare(paths: readonly string[], o: PinOptions | undefined, platform: string): PinRefusal | Prepared {
  if (typeof o?.to !== 'string' || o.to === '') return refuse('no-to', 'no pin directory given: name the directory to write the copies into (--to <dir>).');
  if (!Array.isArray(paths) || paths.length === 0) return refuse('no-paths', 'no paths given to pin.');
  const configGiven = o.configDir ?? claudeConfigDir().path;
  const rootGiven = o.root ?? join(configGiven, 'projects');
  const config = realOrNearest(configGiven), root = realOrNearest(rootGiven), to = realOrNearest(o.to);
  const givens: Given[] = paths.map((g) => ({ given: String(g), resolved: resolve(String(g)), real: realOrNearest(String(g)) }));
  const pinDir = `the pin directory ${shown(o.to, to)}`;
  if (inside(to, config, platform)) return refuse('to-inside-config', `${pinDir} is inside Claude Code's config directory ${shown(configGiven, config)}, which its cleanup manages.`);
  for (const g of givens) if (inside(to, g.real, platform)) return refuse('to-inside-path', `${pinDir} is inside ${shown(g.given, g.real)}, a path given to pin.`);
  if (inside(to, root, platform)) return refuse('to-inside-root', `${pinDir} is inside the root ${shown(rootGiven, root)}, whose files it would pin.`);
  for (const g of givens) if (inside(g.real, to, platform)) return refuse('path-inside-to', `${shown(g.given, g.real)} is inside ${pinDir}.`);
  for (const g of givens) if (!inside(g.real, root, platform)) return refuse('path-outside-root', `${shown(g.given, g.real)} is outside the root ${shown(rootGiven, root)}, which every path in a pin is measured from.`);
  let toStat: Stats | null = null;
  try { toStat = lstatSync(to); } catch { /* not made yet; or under a file, and making it fails next, as a failure */ }
  if (toStat !== null && !toStat.isDirectory()) {
    const kind = toStat.isFile() ? 'a file' : toStat.isSymbolicLink() ? 'a symbolic link that leads to nothing' : 'a socket, a FIFO or a device';
    return refuse('to-not-a-directory', `${pinDir} exists and is not a directory (${kind}), so pin cannot write its copies into it.`);
  }
  const logPath = join(to, LOG);
  let buf: Buffer | null = null, names = 1;
  try { ({ bytes: buf, names } = readLog(logPath)); }   // with the link count of the very file read
  catch (e) {   // no log yet: ENOENT, or ENOTDIR when to cannot be a directory (making it fails next, as a failure)
    if (e instanceof NotRegularFile) {
      return refuse('log-unreadable', e.link
        ? `'${logPath}' is a symbolic link: pin neither reads nor appends to its log through a link, which could lead out of the pin directory.`
        : `'${logPath}' is not a regular file (it is ${e.kind}): pin reads and appends to its log only as a regular file.`);
    }
    if (codeOf(e) !== 'ENOENT' && codeOf(e) !== 'ENOTDIR') return refuse('log-unreadable', `'${logPath}' cannot be read (${codeOf(e)}).`);
  }
  if (buf !== null) {
    // another name (a hard link, which lstat and O_NOFOLLOW do not see) would be the same file: whoever can read it reads
    // every line appended from then on
    if (names > 1) return refuse('log-unreadable', `'${logPath}' has ${names} names (hard links to one file): pin does not append to a log that has another name, since whoever can read that name, which can lie outside the pin directory, could read every line appended later.`);
    const nl = buf.indexOf(0x0a);
    const first = nl < 0 ? null : parseLine(buf.subarray(0, nl), 1, platform);
    if (first === null || first.how !== 'root') {
      const what = buf.length === 0 ? 'is empty' : nl < 0 ? 'holds no whole line' : 'opens with another line';
      return refuse('log-unreadable', `'${logPath}' ${what}, not the line that records the root its copies are measured from, so pin cannot tell which root that is.`);
    }
    // the root it records, or the directory that path leads to now: Claude Code's config directory moved to another
    // disk with a symbolic link left at its path is the same root (S368, the adversarial reading's B4: every pin was
    // refused, and the command the refusal gave was refused too)
    if (relative(folded(first.root!, platform), folded(root, platform)) !== ''
      && relative(folded(realOrNearest(first.root!), platform), folded(root, platform)) !== '') {
      return { ...refuse('root-differs', `'${logPath}' records the root '${first.root}', and this pin's root is ${shown(rootGiven, root)}: every rel in the pin is measured from the root it records.`), recordedRoot: first.root! };
    }
  } else if (toStat !== null) {
    // no log: a directory that holds anything but a pin's own lock and temp files (a pin stopped before it made its log
    // leaves those) is not a pin, and what it holds is not pin's to adopt or write among
    let names: string[] = [];
    try { names = readdirSync(to).filter((n) => n !== LOCK && !TEMP.test(n)).sort(); } catch { /* read again by the run, as a failure */ }
    if (names.length) {
      const held = names.length === 1 ? `'${names[0]}'` : `${names.length} entries ('${names[0]}' first, by name)`;
      return refuse('to-holds-files', `${pinDir} already holds ${held}, and no PINS.log: it is not a pin, and pin does not write among files it did not make.`);
    }
  }
  return { k: 'ok', to, root, givens };
}

interface Env {
  to: string;
  platform: string;
  rehash: boolean;
  onStep: PinOptions['onStep'];
  log: Log;
  /** the rels whose copy is in the pin now */
  present: Set<string>;
  failures: PinFailure[];
  /** each directory of a copy looked at, and the symbolic link on the way to it from the pin directory, or null */
  linkTo: Map<string, string | null>;
  /** throws LockLost unless this pin may still write (guard) */
  guard: () => void;
  /** the directories of the pin the scan could not list (PinScan.unlisted) */
  unlisted: Map<string, string>;
  /** the rels keepAside kept bytes at, in order */
  keptAside: string[];
}

/** The first directory at or above rel's copy that the scan could not list, with the error's code; or null. */
function unlistedOver(e: Env, rel: string): { path: string; code: string } | null {
  if (e.unlisted.size === 0) return null;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/'), code = e.unlisted.get(d);
    if (code !== undefined) return { path: d === '' ? e.to : under(e.to, d), code };
  }
  return null;
}

/** The kept copy of version v of rel (keptRel), when the pin holds one that holds v exactly; else null. A recovered line
 *  that records what a copy holds instead of v names it, so that a check reads v there. */
function heldKept(e: Env, rel: string, v: FileState): string | null {
  const k = keptRel(rel, v.sha256);
  try { const b = readRegular(under(e.to, k)); return b.length === v.bytes && sha256(b) === v.sha256 ? k : null; }
  catch (err) { if (!isFsError(err)) throw err; return null; }
}

/** Keeps bytes b, which the copy at rel holds and which no line records as rel's version, before anything is written over
 *  them: linked to the kept name of their own bytes (keptRel; never over another file), a file of the pin of its own,
 *  with a recovered line that records it (prev null) unless a line names it already. Null, with a failure, when that
 *  name holds other bytes or the link fails: then nothing may be written over the copy (S368: --rehash wrote a copy
 *  again from its source, and lost what it held, the adversarial reading's A1). */
function keepAside(e: Env, rel: string, b: Buffer): string | null {
  const sha = sha256(b), k = keptRel(rel, sha), kAbs = under(e.to, k);
  const fail = (code: unknown): null => {
    if (typeof code !== 'string' && !isFsError(code)) throw code;
    e.failures.push({ path: kAbs, rel: k, op: 'keep', code: typeof code === 'string' ? code : codeOf(code) });
    return null;
  };
  if (!safeRel(k, e.platform)) return fail('name-not-allowed');
  e.guard();
  try { linkSync(under(e.to, rel), kAbs); }
  catch (err) {
    if (codeOf(err) !== 'EEXIST') return fail(err);
    let there: Buffer;
    try { there = readRegular(kAbs); } catch (err2) { return fail(err2); }
    if (sha256(there) !== sha) return fail('kept-copy-differs');
  }
  try { fsyncDir(dirname(kAbs), e.platform); } catch (err) { return fail(err); }
  if (!e.log.st.named.has(k)) {
    let mtime: string | null = null;
    try { mtime = isoNs(lstatSync(kAbs, { bigint: true }).mtimeNs); } catch { /* linked a moment ago */ }
    e.log.append({ t: now(), rel: k, how: 'recovered', bytes: b.length, sha256: sha, prev: null, ...(mtime === null ? {} : { mtime }) });
  }
  e.present.add(k);
  if (!e.keptAside.includes(k)) e.keptAside.push(k);
  return k;
}
/** One file's outcome. `again`: its copy was written again from its source, which still holds the version its last line
 *  records, because the copy was missing, or (with rehash) held other bytes. `lost`: its copy was missing and its
 *  source has changed since, so the version its last line records is in the pin no more. */
type Outcome = { how: 'new' | 'grown' | 'rewritten' | 'unchanged' | 'notCopied' | 'failed'; partial: boolean; bytes: number;
  again: 'missing' | 'damaged' | null; lost: boolean };

/** The first directory between the pin directory and dir (dir included) that is a symbolic link, or null. A directory
 *  not made yet ends the search: from there on, mkdirSync makes real directories. */
function linkOnTheWay(to: string, dir: string, seen: Map<string, string | null>): string | null {
  const known = seen.get(dir);
  if (known !== undefined) return known;
  let found: string | null = null;
  let cur = to;
  for (const part of relative(to, dir).split(sep).filter((p) => p !== '')) {
    cur = join(cur, part);
    let st: Stats;
    try { st = lstatSync(cur); } catch { break; }
    if (st.isSymbolicLink()) { found = cur; break; }
  }
  seen.set(dir, found);
  return found;
}

/** Whether the file at path is exactly buf's first n bytes, read in chunks of 1 MiB, never whole, as a regular file: a
 *  grown copy is checked so, beside the source already held (S368, the re-check's A2: reading the copy whole doubled
 *  the memory a pin needs, and under a limit killed pins that 0.2.0 finished). False when it cannot be read. */
function equalsPrefix(path: string, buf: Buffer, n: number): boolean {
  let fd: number;
  try { fd = openRegular(path, fsConstants.O_RDONLY); } catch { return false; }
  try {
    if (fstatSync(fd).size !== n || n > buf.length) return false;
    const chunk = Buffer.allocUnsafe(Math.min(1 << 20, Math.max(n, 1)));
    for (let pos = 0; pos < n;) {
      const r = readSync(fd, chunk, 0, Math.min(chunk.length, n - pos), pos);
      if (r === 0 || !chunk.subarray(0, r).equals(buf.subarray(pos, pos + r))) return false;
      pos += r;
    }
    return true;
  } catch { return false; } finally { closeSync(fd); }
}

/** Whether the copy at path holds exactly version v; a copy that cannot be read, or is not a regular file, does not. */
function holds(path: string, v: FileState): boolean {
  try { const b = readRegular(path); return b.length === v.bytes && sha256(b) === v.sha256; } catch { return false; }
}

/** One file: stat, read once, cut, hash, decide, keep the old copy, write, rename, log. */
function pinOne(rel: string, src: string, e: Env): Outcome {
  const last = e.log.st.byRel.get(rel);
  const dst = under(e.to, rel);
  const present = e.present.has(rel);
  const fail = (op: PinFailureOp, path: string, err: unknown): Outcome => {
    e.failures.push({ path, rel, op, code: typeof err === 'string' ? err : codeOf(err) });
    return { how: 'failed', partial: false, bytes: 0, again: null, lost: false };
  };
  const unchanged = (partial: boolean): Outcome => ({ how: 'unchanged', partial, bytes: 0, again: null, lost: false });

  // a rel whose line could not be read back under this platform's rules (on win32, one holding ':' or '\') is never
  // written: its copy would stand with no line, and the next pin would write over it as new (S368, A8)
  if (!safeRel(rel, e.platform)) return fail('write', src, 'name-not-allowed');
  // a name a line gives a kept copy is never a source's copy: written there, the version kept by it would be gone (S368, A4)
  if (last === undefined && e.log.st.keptRels.has(rel)) return fail('write', dst, 'kept-name');
  // a directory of the pin that could not be listed: what is in it cannot be seen, so nothing is written into it (S368, A5)
  const blind = unlistedOver(e, rel);
  if (blind !== null) return fail('write', blind.path, blind.code);

  let st: BigIntStats;
  try { st = lstatSync(src, { bigint: true }); } catch (err) { return fail('read', src, err); }
  if (!st.isFile()) return fail('read', src, 'not-a-file');
  e.onStep?.('stat', rel);
  const size = Number(st.size), mtime = isoNs(st.mtimeNs);
  if (size > PIN_MAX_BYTES) return fail('read', src, 'ERR_FS_FILE_TOO_LARGE');
  // the fast path: the size and the mtime (to the ns) its last line records, and the copy in place
  if (!e.rehash && last !== undefined && present && size === last.bytes && mtime === last.mtime) return unchanged(false);
  // a copy is never written through a symbolic link inside the pin: it would land outside the pin, where the pin's own
  // scan does not see it (the scan does not follow links), and be written again on every run
  if (linkOnTheWay(e.to, dirname(dst), e.linkTo) !== null) return fail('write', dst, 'symlink-in-pin');

  let buf: Buffer;
  try { buf = readWhole(src, size); }
  catch (err) {
    if (err instanceof RangeError) return fail('read', src, 'ERR_FS_FILE_TOO_LARGE');
    if (!isFsError(err)) throw err;
    return fail('read', src, err);
  }
  // a .jsonl is cut at its last new line; one with none yet (or empty) has nothing whole to pin, and is not copied
  const jsonl = rel.endsWith('.jsonl');
  const cut = jsonl ? buf.lastIndexOf(0x0a) + 1 : buf.length;
  const partial = jsonl && cut < buf.length;
  if (jsonl && cut === 0) {
    // nothing whole to copy. A copy that recovery left to this run (rehash: its version, then bytes no pin wrote) is cut
    // back to that version, so that those bytes never stand as one
    if (e.rehash && present && last !== undefined) {
      let held: Buffer | null = null;
      try { held = readRegular(dst); } catch (err) { if (!isFsError(err)) throw err; }   // read by recovery a moment ago
      if (held !== null && startsWith(held, last) && damageAfter(held, last, rel)) {
        e.guard();
        try { cutBack(dst, held, last, e.platform); } catch (err) { if (!isFsError(err)) throw err; return fail('write', dst, err); }
      }
    }
    return { how: 'notCopied', partial, bytes: 0, again: null, lost: false };
  }
  // the sha256 of the prefix the old copy claims and of the bytes up to the cut, in one pass
  const h = createHash('sha256');
  let prefix: string | null = null;
  if (last !== undefined && last.bytes <= cut) {
    h.update(buf.subarray(0, last.bytes));
    prefix = h.copy().digest('hex');
    h.update(buf.subarray(last.bytes, cut));
  } else h.update(buf.subarray(0, cut));
  const sha = h.digest('hex');
  const body = buf.subarray(0, cut);

  let how: PinHow;
  let prev: PinVersion | null = last === undefined ? null : { bytes: last.bytes, sha256: last.sha256 };
  let again: Outcome['again'] = null;
  if (last === undefined) how = 'new';
  else if (cut === last.bytes && sha === last.sha256) {
    // the source holds the version its last line records: the copy is that version, unless it is missing or, read
    // with rehash, holds other bytes (a copy changed in place at the same size is seen by nothing else); then it is
    // written again from the source
    if (present && !(e.rehash && !holds(dst, last))) return unchanged(partial);
    how = 'recovered';
    again = present ? 'damaged' : 'missing';
  } else if (cut > last.bytes && prefix === last.sha256) how = 'grown';
  else how = 'rewritten';
  // what the copy holds now, read before anything is written over it: the run believes it holds the version its last
  // line records (a copy the scan saw), or that there is none (a new file, a copy missing from the pin). A copy that is
  // not what the run believes is recorded by a recovered line and decided against again (a rewrite then keeps it); with
  // --rehash, a damaged copy written again from its source is kept aside first. So no pin writes over a file it has not
  // read, nor over bytes it has not kept or found held (S368: before, only a rewrite read the copy, and a pin that decided
  // from a stale state, a killed pin's unlogged rename, or a copy the scan had not seen was written over: the adversarial
  // reading's A1, A2, B1, C2, A5). What is not a regular file at the copy's name holds no version: it is written over as
  // before, unless it is the copy the scan saw and a rewrite must keep (a failure, op keep, not-a-regular-file)
  let disk: BigIntStats | null = null;
  try { disk = lstatSync(dst, { bigint: true }); }
  catch (err) { if (codeOf(err) !== 'ENOENT') { if (!isFsError(err)) throw err; return fail('write', dst, err); } }
  if (disk !== null && !disk.isFile()) {
    if (how === 'rewritten' && present) return fail('keep', dst, 'not-a-regular-file');
    disk = null;
  }
  if (how === 'rewritten' && present && disk === null) return fail('keep', dst, 'ENOENT');
  const believed: FileState | null = present && last !== undefined ? last : null;
  let old: Buffer | null = null;
  // a grown copy that is the version its last line records, the bytes the source starts with: compared in chunks, not
  // read whole (equalsPrefix); any other copy is read whole, as a rewrite read it in 0.2.0
  const grownAsLine = disk !== null && how === 'grown' && believed !== null && Number(disk.size) === believed.bytes
    && prefix === believed.sha256 && equalsPrefix(dst, buf, believed.bytes);
  if (disk !== null && !grownAsLine) {
    try { old = readRegular(dst); } catch (err) { if (!isFsError(err)) throw err; return fail('keep', dst, err); }
  }
  // a copy missing from the pin cannot be kept: when its source has been rewritten since, its version is lost
  const lost = how === 'rewritten' && disk === null;

  // a rewrite keeps the old copy first, by a link named by the sha12 of its bytes on disk
  let kept: string | undefined;
  if (old !== null) {
    // a grown file's copy is the version its last line records when it is the bytes the source starts with: the decision
    // hashed that prefix, so a compare proves it, and the copy need not be hashed (measured: a grown 100 MB transcript)
    const asPrefix = how === 'grown' && believed !== null && old.length === believed.bytes && prefix === believed.sha256 && buf.subarray(0, old.length).equals(old);
    let oldSha = asPrefix ? believed!.sha256 : sha256(old);
    if (e.rehash && believed !== null && startsWith(old, believed) && damageAfter(old, believed, rel)) {
      // its version, then bytes no pin wrote (recovery left it to this run): cut back to that version first, which the
      // rewrite then keeps; the rules for a rewrite apply to the source's bytes, never to that damage
      e.guard();
      try { cutBack(dst, old, believed, e.platform); } catch (err) { if (!isFsError(err)) throw err; return fail('write', dst, err); }
      old = old.subarray(0, believed.bytes);
      oldSha = believed.sha256;
    }
    if (believed === null || old.length !== believed.bytes || oldSha !== believed.sha256) {
      if (e.rehash && believed !== null && (again === 'damaged' || how === 'grown')) {
        // with --rehash, recovery left this copy to the run (its source holds the version its last line records, at its
        // start): the run writes it from the source, and what the copy holds instead is kept aside first, a file of its
        // own (it can be a version a killed pin renamed in); except a .jsonl's bytes that do not end in a new line, which
        // no pin writes (it copies whole lines): damage, never a version
        const cutInLine = rel.endsWith('.jsonl') && old.length > 0 && old[old.length - 1] !== 0x0a;
        if (!cutInLine && keepAside(e, rel, old) === null) return { how: 'failed', partial: false, bytes: 0, again: null, lost: false };
      } else {
        // the copy does not hold what the run believes: a recovered line records what it holds (naming the kept copy of
        // the version its last line records, when one holds it), and the decision is made again against that
        let copyMtime: string | null = null;
        try { copyMtime = isoNs(lstatSync(dst, { bigint: true }).mtimeNs); } catch { /* read a moment ago */ }
        const lastKept = last === undefined ? null : heldKept(e, rel, last);
        e.log.append({ t: now(), rel, how: 'recovered', bytes: old.length, sha256: oldSha, prev: last === undefined ? null : { bytes: last.bytes, sha256: last.sha256 },
          ...(lastKept === null ? {} : { kept: lastKept }), ...(copyMtime === null ? {} : { mtime: copyMtime }) });
        e.present.add(rel);
        prev = { bytes: old.length, sha256: oldSha };
        if (old.length === cut && oldSha === sha) return unchanged(partial);
        how = old.length < cut && buf.subarray(0, old.length).equals(old) ? 'grown' : 'rewritten';
        again = null;
      }
    }
    if (how === 'rewritten') {
      const k = keptRel(rel, oldSha), kAbs = under(e.to, k);
      e.guard();
      try { linkSync(dst, kAbs); }
      catch (err) {
        if (codeOf(err) !== 'EEXIST') { if (!isFsError(err)) throw err; return fail('keep', kAbs, err); }
        // kept already: it must hold these bytes, as a regular file (a link there is never read through, and a FIFO
        // never waited on: a failure, not-a-regular-file)
        let held: Buffer;
        try { held = readRegular(kAbs); } catch (err2) { if (!isFsError(err2)) throw err2; return fail('keep', kAbs, err2); }
        if (sha256(held) !== oldSha) return fail('keep', kAbs, 'kept-copy-differs');
      }
      kept = k;
      e.present.add(k);
      e.onStep?.('linked', rel);
    }
  }

  // the write: a temp file from the very bytes hashed, with the source's mtime, fsynced; renamed over the copy; the
  // directory fsynced
  const dir = dirname(dst), tmp = join(dir, tempName(basename(dst)));
  let tmpMade = false;
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const fd = openSync(tmp, 'wx', FILE_MODE & Number(st.mode));   // 0600, or the source's mode when it is stricter
    tmpMade = true;
    try {
      writeAll(fd, body);
      futimesSync(fd, Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9);   // seconds as a double: within a µs
      fsyncSync(fd);
    } finally { closeSync(fd); }
    e.onStep?.('temp-written', rel);
    e.guard();
    renameOver(tmp, dst, e.platform, () => e.onStep?.('rename-retry', rel));
    tmpMade = false;
    fsyncDir(dir, e.platform);
  } catch (err) {
    if (tmpMade) { try { unlinkSync(tmp); } catch { /* the next pin removes it */ } }
    if (!isFsError(err)) throw err;
    return fail('write', dst, err);
  }
  e.present.add(rel);
  e.onStep?.('renamed', rel);
  e.log.append({ t: now(), rel, how, bytes: cut, sha256: sha, prev: how === 'new' ? null : prev, ...(kept === undefined ? {} : { kept }), mtime });
  e.onStep?.('logged', rel);
  return how === 'recovered' ? { how: 'unchanged', partial, bytes: cut, again, lost } : { how, partial, bytes: cut, again: null, lost };
}

/** Whether bytes b start with version v: the sha256 of their first v.bytes bytes is v's. */
const startsWith = (b: Buffer, v: FileState): boolean => b.length >= v.bytes && sha256(b.subarray(0, v.bytes)) === v.sha256;

/** Whether a copy b of rel, which starts with version v (startsWith), holds after it only bytes that no pin wrote: rel
 *  is a .jsonl, which a pin copies only up to a new line, and no new line follows v in b. Those bytes are damage, never
 *  a version: a pin stopped between the rename of a grown copy and its line leaves whole lines after v. */
const damageAfter = (b: Buffer, v: FileState, rel: string): boolean =>
  rel.endsWith('.jsonl') && b.length > v.bytes && b.indexOf(0x0a, v.bytes) < 0;

/** Renames tmp over dst. On win32, a rename that fails with EPERM, EACCES or EBUSY is retried RENAME_TRIES times,
 *  RENAME_PAUSE_MS apart, onRetry called before each retry. */
function renameOver(tmp: string, dst: string, platform: string, onRetry?: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, dst); return; }
    catch (err) {
      if (platform !== 'win32' || !RENAME_RETRY.has(codeOf(err)) || attempt >= RENAME_TRIES) throw err;
      onRetry?.();
      sleepSync(RENAME_PAUSE_MS);
    }
  }
}

/** Seconds since the epoch, as a double, of a time isoNs wrote (`2026-11-08T13:57:08.261123456Z`), within a µs; null
 *  when it is not one. */
function secondsOf(iso: string): number | null {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3})(\d{6})Z$/.exec(iso);
  const ms = m === null ? NaN : Date.parse(`${m[1]}Z`);
  return Number.isNaN(ms) ? null : ms / 1000 + Number(m![2]) / 1e9;
}

/** Writes the copy at dst again holding only version v, from b, the copy's own bytes, which start with v (hashed: see
 *  startsWith), as pinOne writes a copy: a temp file, fsynced, renamed over the copy, its directory fsynced; with the
 *  copy's own mode (0600, or stricter), and the mtime v's line records (its source's, when v was pinned), or, when that
 *  line has none that can be read, the copy's own. No line is written: the copy then holds what its last line records. */
function cutBack(dst: string, b: Buffer, v: FileState, platform: string): void {
  const st = lstatSync(dst, { bigint: true });
  const dir = dirname(dst), tmp = join(dir, tempName(basename(dst)));
  const mtime = (v.mtime === null ? null : secondsOf(v.mtime)) ?? Number(st.mtimeNs) / 1e9;
  const fd = openSync(tmp, 'wx', FILE_MODE & Number(st.mode));
  try {
    try {
      writeAll(fd, b.subarray(0, v.bytes));
      futimesSync(fd, Number(st.atimeNs) / 1e9, mtime);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameOver(tmp, dst, platform);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the next pin removes it */ }
    throw err;
  }
  fsyncDir(dir, platform);
}

/** Whether the source at path holds version v at its start as a pin copies it: the sha256 of its first v.bytes bytes is
 *  v's, and, for a .jsonl, those bytes end at or before its last new line (whole lines). pinOne then finds it unchanged
 *  against v, or grown from it. `unreadable` when it cannot be read or is not a regular file (readRegular: never
 *  waited on). */
function sourceHolds(path: string, rel: string, v: FileState): boolean | 'unreadable' {
  let b: Buffer;
  try { b = readRegular(path); } catch { return 'unreadable'; }
  const cut = rel.endsWith('.jsonl') ? b.lastIndexOf(0x0a) + 1 : b.length;
  return v.bytes <= cut && startsWith(b, v);
}

/** With rehash: whether recovery leaves to this run, with no recovered line, a copy b that does not hold version v, the
 *  one its last line records (no kept copy waits beside it, and src is its source, which this run pins). A recovered
 *  line would make b's bytes a version, against which the source would read as rewritten, and the run would keep those
 *  bytes, damage and all, as the old copy. Left to the run: a copy whose source cannot be read (the run fails on that
 *  file, and the copy stays as it is until a run can read the source: recovery cannot check it against its source); a
 *  copy that no longer holds v at its start, whose source still does (the run writes it again from the source); and a
 *  copy whose bytes after v no pin wrote (damageAfter: the run pins the source against v, and keeps v, never those
 *  bytes). Any other is recorded: what it holds after v can be a version that only the pin holds (a pin stopped between
 *  the rename of a grown copy and its line leaves whole lines there), and one that holds v no more, beside a source that
 *  holds v no more either, is the README's limit: a rewrite keeps it as it is. */
function leftToTheRun(b: Buffer, v: FileState, rel: string, src: string): boolean {
  const atStart = startsWith(b, v);
  if (atStart && damageAfter(b, v, rel)) return true;
  const holds = sourceHolds(src, rel, v);
  return holds === 'unreadable' || (!atStart && holds);
}

/** Whether rel is one of rels, or under one ('' is the whole root). */
const atOrUnder = (rel: string, rels: readonly string[]): boolean => rels.some((d) => d === '' || rel === d || rel.startsWith(`${d}/`));

/** Recovery, under the lock, before pinning: a copy that does not hold what its last line records, and a file of the
 *  pin's shape that no line names, each get a recovered line saying what it holds. A copy is read when its size is not
 *  the one its last line records, or when a kept copy of that version waits beside it unnamed (a rewrite stopped after
 *  its link: the rename may have happened, with a new version of the same size); a copy that changed is then named
 *  with that kept copy, which holds the version its last line records.
 *  With rehash, a copy beside which no kept copy waits, whose source is one of `sources` (the files this run pins),
 *  gets no line when leftToTheRun says so: its source cannot be read, or the run writes the copy again from it, or the
 *  copy's bytes after its version are damage that no pin wrote. One whose source is not among them gets none when it
 *  is at or under one of `unread`, where the walk could not see what is there: its source cannot be read either, so
 *  nothing can check the copy against it, and the run fails on that path (its walk failure); the copy is left as it
 *  is until a run can read it. */
function recover(e: Env, scan: PinScan, sources: ReadonlyMap<string, string>, unread: readonly string[]): number {
  let n = 0;
  const st = e.log.st;
  const read = (rel: string): Buffer | null => {
    try { return readRegular(under(e.to, rel)); }
    catch (err) { if (!isFsError(err)) throw err; e.failures.push({ path: under(e.to, rel), rel, op: 'recover', code: codeOf(err) }); return null; }
  };
  for (const [rel, last] of [...st.byRel].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const f = scan.files.get(rel);
    if (f === undefined) continue;
    const k = keptRel(rel, last.sha256), keptWaits = scan.files.has(k) && !st.named.has(k);
    if (f.size === last.bytes && !keptWaits) continue;
    const b = read(rel);
    if (b === null) continue;
    const bSha = sha256(b);
    if (b.length === last.bytes && bSha === last.sha256) continue;   // as its line says: the rename did not happen
    const src = sources.get(rel);
    // pinned from src by this run; or, its source out of the walk's sight, left as it is
    if (e.rehash && !keptWaits && (src === undefined ? atOrUnder(rel, unread) : leftToTheRun(b, last, rel, src))) continue;
    // the kept copy of the version its last line records, waiting or named by an earlier line, when it holds that version
    let kept: string | undefined;
    if (scan.files.has(k)) { const kb = read(k); if (kb !== null && kb.length === last.bytes && sha256(kb) === last.sha256) kept = k; }
    e.log.append({ t: now(), rel, how: 'recovered', bytes: b.length, sha256: bSha, prev: { bytes: last.bytes, sha256: last.sha256 }, ...(kept === undefined ? {} : { kept }), mtime: f.mtime });
    n++;
  }
  for (const rel of [...scan.files.keys()].sort()) {
    // a rel whose line could not be read back under this platform's rules gets none (S368, A8)
    if (st.named.has(rel) || !scan.shaped(rel) || !safeRel(rel, e.platform)) continue;
    const b = read(rel);
    if (b === null) continue;
    e.log.append({ t: now(), rel, how: 'recovered', bytes: b.length, sha256: sha256(b), prev: null, mtime: scan.files.get(rel)!.mtime });
    n++;
  }
  return n;
}

/** The temp files a pin that did not finish left, settled once PINS.log is read (S367; the adversarial reading of
 *  "nothing ltms does destroys a record"). A file named like a temp that a line names is a pinned file, not a temp: a
 *  source of the sweep's shape can bear such a name. A temp is removed only when what it holds is held already: a byte
 *  prefix of its target's copy, of a kept copy of its target, or of its target's source (which this run pins). Any other
 *  can be the only copy of a version, its source rewritten or gone since: it is kept, linked to the kept name of its own
 *  bytes (never over another file), and recorded by a recovered line, as a file of the pin no line named. */
function settleTemps(e: Env, scan: PinScan, root: string): { removed: number; kept: string[] } {
  const st = e.log.st, out = { removed: 0, kept: [] as string[] };
  const fail = (path: string, rel: string | null, op: PinFailure['op'], err: unknown): void => {
    if (typeof err !== 'string' && !isFsError(err)) throw err;
    e.failures.push({ path, rel, op, code: typeof err === 'string' ? err : codeOf(err) });
  };
  for (const abs of scan.temps) {
    const rel = relative(e.to, abs).split(sep).join('/');
    // a waiting pin's lock temp file, its pid no longer running (scanPin): the lock's, never a copy (a file directly
    // under the root is never of the sweep's shape), so removed as before
    if (dirname(abs) === e.to && LOCK_TEMP.test(basename(abs))) {
      e.guard();
      try { unlinkSync(abs); out.removed++; } catch (err) { fail(abs, null, 'recover', err); }
      continue;
    }
    if (st.named.has(rel)) {
      try { const s = lstatSync(abs, { bigint: true }); scan.files.set(rel, { size: Number(s.size), mtime: isoNs(s.mtimeNs) }); e.present.add(rel); }
      catch { /* gone since the scan */ }
      continue;
    }
    let t: Buffer;
    try { t = readRegular(abs); } catch (err) { fail(abs, null, 'recover', err); continue; }
    const m = /^\.(.+)\.ltms-tmp-\d+$/.exec(basename(abs)), slash = rel.lastIndexOf('/');
    const target = m === null ? null : `${slash < 0 ? '' : rel.slice(0, slash + 1)}${m[1]}`;
    const holdsT = (path: string): boolean => {
      let b: Buffer;
      try { b = readRegular(path); } catch (err) { if (!isFsError(err)) throw err; return false; }
      return b.length >= t.length && b.subarray(0, t.length).equals(t);
    };
    // held when a file of the pin holds its bytes: its target's copy, or a kept copy of it. Its source holding them is
    // not enough (S368, the re-check's B1): a pin of another project leaves that source unpinned, and once it is
    // rewritten the version is in no file. Except a .jsonl temp whose bytes do not end in a new line: a write cut short,
    // which holds no version (a pin copies whole lines), removed when its source holds them too
    let held = t.length === 0;
    const cutShort = target !== null && target.endsWith('.jsonl') && t[t.length - 1] !== 0x0a;
    if (!held && target !== null) {
      const where = cutShort ? [under(e.to, target), under(root, target)] : [under(e.to, target)];
      for (const l of st.parsed) if (l !== null && l.rel === target && typeof l.kept === 'string') where.push(under(e.to, l.kept));
      held = where.some(holdsT);
    }
    if (held) {
      e.guard();
      try { unlinkSync(abs); out.removed++; } catch (err) { fail(abs, null, 'recover', err); }
      continue;
    }
    const sha = sha256(t), k = keptRel(target ?? rel, sha), kAbs = under(e.to, k);
    // a kept name whose line could not be read back under this platform's rules: the temp is left as it is (S368, A8)
    if (!safeRel(k, e.platform)) { fail(abs, null, 'keep', 'name-not-allowed'); continue; }
    e.guard();
    try { linkSync(abs, kAbs); }
    catch (err) {
      if (codeOf(err) !== 'EEXIST') { fail(kAbs, k, 'keep', err); continue; }
      let there: Buffer;
      try { there = readRegular(kAbs); } catch (err2) { fail(kAbs, k, 'keep', err2); continue; }
      if (sha256(there) !== sha) { fail(kAbs, k, 'keep', 'kept-copy-differs'); continue; }
    }
    try { fsyncDir(dirname(kAbs), e.platform); unlinkSync(abs); } catch (err) { fail(abs, null, 'recover', err); }
    let mtime: string | null = null;
    try { mtime = isoNs(lstatSync(kAbs, { bigint: true }).mtimeNs); } catch { /* linked a moment ago */ }
    if (!st.named.has(k)) e.log.append({ t: now(), rel: k, how: 'recovered', bytes: t.length, sha256: sha, prev: null, ...(mtime === null ? {} : { mtime }) });
    if (mtime !== null) scan.files.set(k, { size: t.length, mtime });
    e.present.add(k);
    out.kept.push(k);
  }
  return out;
}

/** The pinned files under the given paths whose source is gone (lstat gives ENOENT or ENOTDIR). */
function keptSourceGone(st: LogState, w: Walk, present: Set<string>, root: string): number {
  let n = 0;
  for (const rel of st.byRel.keys()) {
    if (KEPT.test(rel) || w.files.has(rel) || !present.has(rel)) continue;
    if (!w.covered.some((c) => c === '' || rel === c || rel.startsWith(`${c}/`))) continue;
    try { lstatSync(under(root, rel)); } catch (err) { if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') n++; }
  }
  return n;
}

/** Copies the files of the sweep's shape under the given paths into options.to, and appends what changed to
 *  <to>/PINS.log. Resolves to a refusal (nothing written), `busy` (the lock stayed held for the whole wait), or the
 *  run's coverage. Errors of one file are failures in the result; an error thrown by onStep, or a bug, is thrown on,
 *  after the lock is removed. From before it takes the lock until after it has removed it, a SIGINT, SIGTERM or SIGHUP
 *  stops it (between two files, or the wait for the lock); it then removes the lock and, when nothing else listens for
 *  that signal, raises it again. */
export async function pinPaths(paths: readonly string[], options: PinOptions): Promise<PinResult> {
  const t0 = Date.now();
  const platform = options?.platform ?? process.platform;
  const p = prepare(paths, options, platform);
  if (p.k === 'refused') return p;
  const { to, root, givens } = p;
  const failures: PinFailure[] = [], lines: PinLogLine[] = [], notices: string[] = [];
  const files = { seen: 0, new: 0, grown: 0, rewritten: 0, unchanged: 0, notCopied: 0, failed: 0 };
  const skipped = { notSessionShaped: 0, symlinks: 0, memory: 0, git: 0 };
  let partial = 0, bytesCopied = 0, kept = 0, removedTemps = 0;
  let takeover: PinLockHolder | null = null;
  const stop: Stop = { signal: null };   // set by a signal listener, read between files and during the lock's wait
  const done = (): PinDone => {
    files.seen = files.new + files.grown + files.rewritten + files.unchanged + files.notCopied + files.failed;
    return { k: 'pinned', coverage: { root, to, files, failures: failures.length, partial, skipped, bytesCopied, keptSourceGone: kept, lastLog: lastLog(), ms: Date.now() - t0 },
      failures, lines, takeover, removedTemps, notices, interrupted: stop.signal };
  };
  let state: LogState | null = null;
  const lastLog = (): string | null => state?.lastT ?? null;

  try { mkdirSync(to, { recursive: true, mode: DIR_MODE }); }
  catch (err) { failures.push({ path: to, rel: null, op: 'to', code: codeOf(err) }); return done(); }
  if (platform !== 'win32') {
    let mode = 0;
    try { mode = lstatSync(to).mode & 0o777; } catch { /* made a moment ago: the lock, next, reports what is wrong */ }
    // what others can do there depends on the mode: it is said as such, never that pin's files are safe from them (whoever
    // can write into the directory can put a file of their own at PINS.log's name)
    if (mode & 0o077) notices.push(`the pin directory '${to}' is open to other users (mode ${mode.toString(8).padStart(4, '0')}): those its mode lets read it can list the names in it, and those it lets write into it can replace pin's files with their own. To close it: chmod 700 ${quoted(to)}`);
  }
  const lockWait = typeof options.lockWaitMs === 'number' && options.lockWaitMs >= 0 ? options.lockWaitMs : LOCK_WAIT_MS;
  // the signal listeners come before the lock and go after it: a signal that finds no listener ends the process at
  // once, so while the lock exists, one must always be there (measured: 17 of 200 SIGTERMs sent as soon as the lock
  // appeared ended the process before the listeners came, and left the lock)
  let held: Held | null = null;
  const onSignal = (sig: NodeJS.Signals): void => { stop.signal ??= sig; };
  const onExit = (): void => { if (held !== null) release(held); };
  for (const s of SIGNALS) process.on(s, onSignal);
  process.on('exit', onExit);
  try {
    const got = await acquire(to, lockWait, stop);
    if (got.k === 'busy') return got;
    if (got.k === 'failed') { failures.push(got.failure); return done(); }
    if (got.k === 'stopped') {
      notices.push(`stopped by ${stop.signal} while waiting for the lock '${join(to, LOCK)}'; nothing was pinned.`);
      return done();
    }
    held = got.held;
    takeover = got.takeover;
    const scan = scanPin(to);
    // a pin directory that can be written but not listed: no copy in it can be seen, so none is written (S368, A5)
    const blindTo = scan.unlisted.get('');
    if (blindTo !== undefined) {
      failures.push({ path: to, rel: null, op: 'to', code: blindTo });
      notices.push(`the pin directory '${to}' could not be listed (${blindTo}), so what it holds cannot be seen, and nothing was written into it. See its mode and owner: ls -ld ${quoted(to)}`);
      return done();
    }
    const logPath = join(to, LOG);
    try {
      // read again under the lock, as a regular file: a link or a FIFO put at its name since the refusals were checked
      // is a failure, op log, not-a-regular-file
      let read: { bytes: Buffer; ino: bigint } | null = null;
      try { read = readLog(logPath); } catch (err) { if (codeOf(err) !== 'ENOENT') throw err; }
      state = read === null ? createLog(to, root, lines, platform) : parseLog(logPath, read.bytes, platform, read.ino);
    } catch (err) {
      if (!isFsError(err)) throw err;
      failures.push({ path: logPath, rel: null, op: 'log', code: codeOf(err) });
      return done();
    }
    const heldNow = held, stateNow = state;
    const check = (): void => guard(heldNow, stateNow);
    const log = new Log(state, lines, platform, check);
    const e: Env = { to, platform, rehash: options.rehash === true, onStep: options.onStep, log, present: new Set(scan.files.keys()), failures, linkTo: new Map(),
      guard: check, unlisted: scan.unlisted, keptAside: [] };
    try {
      if (state.torn !== null) {
        log.closeTorn();
        notices.push(`'${logPath}' did not end in a new line: line ${state.lines - 1} was cut short; it is closed as it was, and the recovered line after it names it.`);
      }
      if (takeover !== null) {
        log.append({ t: now(), how: 'takeover', lock: takeover });
        notices.push(`took over the lock '${join(to, LOCK)}': pid ${takeover.pid} took it at ${takeover.started} and is no longer running on this host; PINS.log has a takeover line.`);
      }
      // the temp files a pin that did not finish left, settled only now that PINS.log is read (settleTemps, S367)
      const temps = settleTemps(e, scan, root);
      removedTemps = temps.removed;
      if (removedTemps) notices.push(`removed ${removedTemps} temp ${plural(removedTemps, 'file', 'files')} left in '${to}' by a pin that did not finish, each holding what a copy or its source holds.`);
      if (temps.kept.length) notices.push(`${temps.kept.length} temp ${plural(temps.kept.length, 'file', 'files')} left in '${to}' by a pin that did not finish held what no copy and no source holds any more: kept as ${temps.kept.map((k) => `'${k}'`).join(', ')}, with a recovered line each.`);
      const unread = state.unreadable.length;
      if (unread) notices.push(`'${logPath}' has ${unread} ${plural(unread, 'line', 'lines')} that ${plural(unread, 'is not a log line', 'are not log lines')} (first: line ${state.unreadable[0]}); ${plural(unread, 'it is', 'they are')} passed over here, and a check of the pin reports ${plural(unread, 'it', 'them')}.`);
      // the walk before recovery, which leaves to this run (with rehash) a damaged copy that it writes again, and as it
      // is one under a path the walk could not read; its failures still follow recovery's
      const w = walk(givens, root);
      const recovered = recover(e, scan, w.files, w.unread);
      if (recovered) notices.push(`${recovered} ${plural(recovered, 'file', 'files')} in '${to}' held other bytes than ${plural(recovered, 'its', 'their')} last line in PINS.log records, or ${plural(recovered, 'was', 'were')} named by no line: a recovered line now records what each one holds.`);
      failures.push(...w.failures);
      Object.assign(skipped, w.skipped);
      let restored = 0, repaired = 0, lost = 0, k = 0;
      const rels = [...w.files.keys()].sort();
      for (const rel of rels) {
        await yieldToSignals();
        if (stop.signal !== null) break;
        const o = pinOne(rel, w.files.get(rel)!, e);
        files[o.how]++;
        if (o.partial) partial++;
        if (o.again === 'missing') restored++;
        if (o.again === 'damaged') repaired++;
        if (o.lost) lost++;
        bytesCopied += o.bytes;
        k++;
      }
      const aside = e.keptAside.length;
      if (aside) notices.push(`${aside} ${plural(aside, 'copy', 'copies')} in '${to}' held bytes that no line in PINS.log records as ${plural(aside, 'its version', 'their versions')}: they are kept as ${e.keptAside.map((k) => `'${k}'`).join(', ')}, with a recovered line each, and the ${plural(aside, 'copy was', 'copies were')} then written again from ${plural(aside, 'its source', 'their sources')} (--rehash).`);
      if (restored) notices.push(`${restored} ${plural(restored, 'copy was', 'copies were')} missing from '${to}' and written again from ${plural(restored, 'its source', 'their sources')}, with a recovered line each.`);
      if (repaired) notices.push(`${repaired} ${plural(repaired, 'copy', 'copies')} in '${to}' held other bytes than ${plural(repaired, 'its', 'their')} last line in PINS.log records, and ${plural(repaired, 'was', 'were')} written again from ${plural(repaired, 'its source', 'their sources')}, which still ${plural(repaired, 'holds', 'hold')} that version (--rehash), with a recovered line each.`);
      if (lost) notices.push(`${lost} ${plural(lost, 'copy was', 'copies were')} missing from '${to}' while ${plural(lost, 'its source', 'their sources')} had been rewritten: the ${plural(lost, 'version its', 'versions their')} last line in PINS.log ${plural(lost, 'records is', 'record are')} lost, and a check of the pin reports ${plural(lost, 'it', 'them')} at ${plural(lost, 'that line', 'those lines')}.`);
      if (stop.signal !== null) notices.push(`stopped by ${stop.signal} after ${k} of ${rels.length} files; each file pinned so far is whole and has its line.`);
      kept = keptSourceGone(state, w, e.present, root);
    } catch (err) {
      if (err instanceof LockLost) {
        // S368: two pins at once (a lock removed by hand, a dead lock taken over twice, an old pin that took over a live
        // lock): this one stops before its next write, and the other one's lock is left
        failures.push({ path: err.path, rel: null, op: err.what, code: err.what === 'lock' ? 'lock-lost' : 'log-changed' });
        notices.push(err.what === 'lock'
          ? `the lock '${err.path}' no longer holds what this pin wrote into it (it was removed, or another pin took it), so this pin stopped before its next write; each file it pinned before is whole and has its line.`
          : `'${err.path}' changed under this pin (another process wrote to it, or put another file at its name), so this pin stopped before its next write; each file it pinned before is whole and has its line.`);
      } else {
        if (!(err instanceof LogWriteError)) throw err;
        failures.push({ path: logPath, rel: null, op: 'log', code: codeOf(err.reason) });
        notices.push(`'${logPath}' could not be written (${codeOf(err.reason)}), so the pin stopped there; the next pin records what this one left without a line.`);
      }
    } finally { log.close(); }
    return done();
  } finally {
    // the lock goes before the listeners: a signal from here on finds either a listener or no lock
    if (held !== null) release(held);
    for (const s of SIGNALS) process.removeListener(s, onSignal);
    process.removeListener('exit', onExit);
    if (stop.signal !== null && process.listenerCount(stop.signal) === 0) process.kill(process.pid, stop.signal);
  }
}

// ---- checkPin ----------------------------------------------------------------------------------------------------

/** One pass over a file: the sha256 of its first n bytes at each n asked for (Hash.copy() at each), and of the whole.
 *  null when it cannot be read, or is not a regular file (openRegular: a FIFO is never waited on). */
function digestsAt(path: string, lengths: number[]): { size: number; whole: string; at: Map<number, string> } | null {
  let fd: number;
  try { fd = openRegular(path, fsConstants.O_RDONLY); } catch { return null; }
  try {
    const marks = [...new Set(lengths)].sort((a, b) => a - b);
    const h = createHash('sha256'), at = new Map<number, string>(), chunk = Buffer.allocUnsafe(1 << 20);
    let pos = 0, m = 0;
    for (; m < marks.length && marks[m] === 0; m++) at.set(0, h.copy().digest('hex'));
    for (;;) {
      const n = readSync(fd, chunk, 0, m < marks.length ? Math.min(chunk.length, marks[m] - pos) : chunk.length, pos);
      if (n === 0) break;
      h.update(chunk.subarray(0, n));
      pos += n;
      for (; m < marks.length && marks[m] === pos; m++) at.set(pos, h.copy().digest('hex'));
    }
    return { size: pos, whole: h.digest('hex'), at };
  } catch { return null; } finally { closeSync(fd); }
}

/** Whether the file at `copy` is a byte prefix of the file at `src`: the sha256 of src's first bytes, as many as the copy
 *  holds, is the copy's whole sha256 (digestsAt, one pass over each). False when either cannot be read. */
function isPrefix(copy: string, src: string): boolean {
  const c = digestsAt(copy, []);
  if (c === null) return false;
  const s = digestsAt(src, [c.size]);
  return s !== null && s.at.get(c.size) === c.whole;
}

/** Whether a file holds a new line at or after byte `from`, read in chunks up to the first one: a .jsonl without one past
 *  its copy's length has nothing whole that a pin would copy (nor, from 0, does one without any). A file that cannot be
 *  read counts as holding one. */
function holdsNewLine(path: string, from = 0): boolean {
  let fd: number;
  try { fd = openRegular(path, fsConstants.O_RDONLY); } catch { return true; }
  try {
    const chunk = Buffer.allocUnsafe(65536);
    for (let pos = from; ;) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) return false;
      if (chunk.subarray(0, n).includes(0x0a)) return true;
      pos += n;
    }
  } catch { return true; } finally { closeSync(fd); }
}

/** Checks a pin against its own log, and its sources against the pin: every file line against the copy that holds its
 *  version (the current file, or the kept copy the first later line for that rel names), one pass per copy; the chain
 *  of the lines; and the staleness (sources under the root missing from the pin, or longer than their copy). A lock held
 *  by a running pin is waited for first, as a pin waits for it: a file that pin is writing would read as damage.
 *  Writes nothing. */
export async function checkPin(dir: string, options: PinCheckOptions = {}): Promise<PinCheckResult> {
  const t0 = Date.now();
  const platform = options?.platform ?? process.platform;
  const d = realOrNearest(dir);
  const lockWait = typeof options?.lockWaitMs === 'number' && options.lockWaitMs >= 0 ? options.lockWaitMs : LOCK_WAIT_MS;
  for (const lockPath = join(d, LOCK); ;) {
    // no lock, or none that can be read as one (not a regular file: never waited on, and a notice below): nothing runs
    let raw: string;
    try { raw = readRegular(lockPath).toString('utf8'); } catch { break; }
    const holder = holderIn(raw);
    const seen = lockSeen(lockPath, holder);
    if (seen === 'dead') break;   // a pin that stopped without removing it: reported below
    const waited = Date.now() - t0;
    if (waited >= lockWait) return busy(lockPath, holder, seen, waited);
    await sleep(Math.min(LOCK_POLL_MS, lockWait - waited));
  }
  let log: { bytes: Buffer; names: number };
  try { log = readLog(join(d, LOG)); }
  catch (e) {
    const why = codeOf(e) === 'ENOENT' ? 'holds no PINS.log'
      : e instanceof NotRegularFile ? `has a PINS.log that ${e.link ? 'is a symbolic link' : `is not a regular file (it is ${e.kind})`}`
        : `has a PINS.log that cannot be read (${codeOf(e)})`;
    return refuse('not-a-pin', `${shown(dir, d)} ${why}, so it is not a pin this check can read.`);
  }
  const st = parseLog(join(d, LOG), log.bytes, platform);
  const notices: string[] = [];
  // a pin refuses a log that has another name (prepare), so none runs here until it is the only one: this notice says so
  // once, and no other says what a next pin would do
  const pinRuns = log.names <= 1;
  if (!pinRuns) notices.push(`'${join(d, LOG)}' has ${log.names} names (hard links to one file): a pin refuses a log that has another name, so every pin into '${d}' is refused until only one name is left. Find its other names: find / -samefile ${quoted(join(d, LOG))} 2>/dev/null`);
  if (st.root === null) notices.push(`line 1 of '${join(d, LOG)}' is not the line that records the root, so which root the copies are measured from is not known${options?.root === undefined ? '; give the root to measure the staleness' : ''}.`);

  const chainBreaks: PinChainBreak[] = [];
  st.parsed.forEach((l, i) => {
    if (l === null) return;
    const want = i === 0 ? null : sha256(st.raw[i - 1]);
    if (l.chain !== want) chainBreaks.push({ line: i + 1, want, got: l.chain });
  });

  // each file line, against the copy that holds its version
  const fileLines: Array<{ line: number; l: PinLogLine }> = [];
  st.parsed.forEach((l, i) => { if (l !== null && l.rel !== undefined && FILE_HOWS.has(l.how)) fileLines.push({ line: i + 1, l }); });
  const holder: string[] = new Array(fileLines.length);
  const laterKept = new Map<string, string>();
  for (let j = fileLines.length - 1; j >= 0; j--) {
    const { l } = fileLines[j];
    holder[j] = laterKept.get(l.rel!) ?? l.rel!;
    if (l.kept !== undefined) laterKept.set(l.rel!, l.kept);
  }
  const groups = new Map<string, Array<{ line: number; rel: string; want: PinVersion }>>();
  fileLines.forEach(({ line, l }, j) => {
    const g = groups.get(holder[j]) ?? [];
    g.push({ line, rel: l.rel!, want: { bytes: l.bytes!, sha256: l.sha256! } });
    groups.set(holder[j], g);
  });
  const mismatches: PinMismatch[] = [];
  let files = 0;
  for (const [h, vs] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    await yieldToSignals();
    const got = digestsAt(under(d, h), vs.map((v) => v.want.bytes));
    if (got !== null) files++;
    const newest = vs[vs.length - 1];   // the latest line held by this copy: the copy must be exactly that version
    for (const v of vs) {
      let g: PinVersion | null;
      if (got === null) g = null;
      else if (v.want.bytes > got.size) g = { bytes: got.size, sha256: got.whole };
      else if (got.at.get(v.want.bytes) !== v.want.sha256) g = { bytes: v.want.bytes, sha256: got.at.get(v.want.bytes)! };
      else if (v === newest && got.size !== v.want.bytes) g = { bytes: got.size, sha256: got.whole };
      else continue;
      mismatches.push({ rel: v.rel, copy: h, line: v.line, want: v.want, got: g });
    }
  }
  mismatches.sort((a, b) => a.line - b.line);

  const scan = scanPin(d);
  const unlogged = [...scan.files.keys()].filter((r) => !st.named.has(r) && scan.shaped(r)).sort();
  const unreadableLines = st.torn === null ? st.unreadable : [...st.unreadable, st.lines + 1];
  if (st.torn !== null) notices.push(`'${join(d, LOG)}' does not end in a new line: line ${st.lines + 1} is cut short${pinRuns ? '; the next pin closes it with a recovered line' : ''}.`);

  let lock: PinLockHolder | null = null;
  try {
    const raw = readRegular(join(d, LOCK)).toString('utf8');
    lock = holderIn(raw);
    if (lock === null) notices.push(`'${join(d, LOCK)}' exists, and does not hold a pin's lock (a pid, a host and a start time).`);
    // the wait at the start leaves one window: a pin that took the lock after it
    else if (lockLive(join(d, LOCK), lock)) notices.push(`a pin took the lock '${join(d, LOCK)}' while this check ran (pid ${lock.pid} on ${lock.host}, since ${lock.started}): a copy it was writing can read as damage here; check again when it is done.`);
  } catch (e) {   // no lock; or one that is not a regular file, which every pin fails at
    if (e instanceof NotRegularFile) notices.push(`'${join(d, LOCK)}' ${e.link ? 'is a symbolic link' : `is not a regular file (it is ${e.kind})`}, so it is not read as a pin's lock${pinRuns ? '; a pin fails at it (not-a-regular-file) until it is gone' : ''}. See what it is: ls -l ${quoted(join(d, LOCK))}`);
  }

  let staleness: PinStaleness | null = null;
  const rootGiven = options?.root ?? st.root?.root;
  if (rootGiven !== undefined) {
    const root = realOrNearest(rootGiven);
    const w = walk([{ given: rootGiven, resolved: resolve(rootGiven), real: root }], root);
    let missing = 0, longer = 0, unfinished = 0, tooLarge = 0;
    for (const [rel, abs] of w.files) {
      try { if (lstatSync(abs).size > PIN_MAX_BYTES) tooLarge++; } catch { /* gone since the walk */ }
      const copy = scan.files.get(rel);
      // a .jsonl with no new line yet is not copied by a pin (notCopied), so it is not missing from the pin
      if (copy === undefined) { if (!rel.endsWith('.jsonl') || holdsNewLine(abs)) missing++; continue; }
      let size: number;
      try { size = lstatSync(abs).size; } catch { continue; }   // gone since the walk
      if (size <= copy.size) continue;
      // a .jsonl is copied up to its last new line: one whose copy is a byte prefix of it, with no new line past the
      // copy's length, is longer only by a line not yet finished, which a pin does not copy, so the pin is not behind it.
      // One rewritten under such a line is not: its copy is no prefix of it, and the next pin rewrites it
      if (rel.endsWith('.jsonl') && !holdsNewLine(abs, copy.size) && isPrefix(under(d, rel), abs)) unfinished++; else longer++;
    }
    const pinnedProjects = new Set([...st.named].map((r) => r.split('/')[0]));
    const projectsNotPinned = [...w.projects].filter((pr) => !pinnedProjects.has(pr)).length;
    staleness = { root, fromLog: options?.root === undefined, sources: w.files.size, missing, longer, unfinished, projectsNotPinned, failed: w.failures.length, tooLarge };
  }

  return { k: 'checked', dir: d, root: st.root?.root ?? null, lines: st.lines, logNames: log.names, versions: fileLines.length, files, mismatches,
    chainBreaks, unreadableLines, unlogged, temps: scan.temps.filter((a) => !st.named.has(relative(d, a).split(sep).join('/'))).length, lastLog: st.lastT, staleness, lock, notices, ms: Date.now() - t0 };
}
