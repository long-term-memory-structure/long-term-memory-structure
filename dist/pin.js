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
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, ftruncateSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync, } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
// ---- names, shapes and small helpers ---------------------------------------------------------------------------
const LOG = 'PINS.log';
const LOCK = '.ltms-pin.lock';
/** A temp file of ours: `.<name>.ltms-tmp-<pid>`, in the directory of the file it becomes. */
const TEMP = /^\..+\.ltms-tmp-\d+$/;
/** The lock's own temp file, which a pin waiting for the lock keeps: left alone while its pid runs on this host. */
const LOCK_TEMP = /^\.\.ltms-pin\.lock\.ltms-tmp-(\d+)$/;
/** A temp file's name for the copy named name: pinOne's own (n 0), or the cut back's (n 1), which can exist at once. */
const tempName = (name, n = 0) => `.${name}.ltms-tmp-${process.pid}${n === 0 ? '' : n}`;
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
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const NL = Buffer.from('\n');
const now = () => new Date().toISOString();
const p2 = (n) => String(n).padStart(2, '0');
/** The civil date (year, month, day) of a count of days since 1970-01-01, in the proleptic Gregorian calendar, in BigInt
 *  (H. Hinnant's civil_from_days), so that a file time past the range of a JavaScript Date has one too. */
function civil(days) {
    const z = days + 719468n;
    const era = (z >= 0n ? z : z - 146096n) / 146097n;
    const doe = z - era * 146097n;
    const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
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
function isoNs(ns) {
    let s = ns / 1000000000n, f = ns % 1000000000n;
    if (f < 0n) {
        s -= 1n;
        f += 1000000000n;
    }
    const frac = String(f).padStart(9, '0');
    if (s >= -62167219200n && s <= 253402300799n)
        return `${new Date(Number(s) * 1000).toISOString().slice(0, 19)}.${frac}Z`;
    let days = s / 86400n, sec = s % 86400n;
    if (sec < 0n) {
        days -= 1n;
        sec += 86400n;
    }
    const [y, mo, d] = civil(days);
    const year = `${y < 0n ? '-' : '+'}${String(y < 0n ? -y : y).padStart(6, '0')}`;
    return `${year}-${p2(mo)}-${p2(d)}T${p2(sec / 3600n)}:${p2((sec % 3600n) / 60n)}:${p2(sec % 60n)}.${frac}Z`;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const plural = (n, one, many) => (n === 1 ? one : many);
const codeOf = (e) => {
    const c = e?.code;
    return typeof c === 'string' ? c : e instanceof Error ? e.name : 'Error';
};
/** An error the file system raised (it carries an errno code and a syscall), or a file of the pin that is not a regular
 *  file (NotRegularFile) or that changed under the pin (CopyChanged), as against a bug, or an error thrown by onStep:
 *  those are not failures of one file, and are thrown on. */
const isFsError = (e) => e instanceof NotRegularFile || e instanceof CopyChanged
    || (e instanceof Error && typeof e.code === 'string' && typeof e.syscall === 'string');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const yieldToSignals = () => new Promise((r) => setImmediate(r));
let versionRead;
function ltmsVersion() {
    if (versionRead === undefined) {
        try {
            const v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
            versionRead = typeof v === 'string' ? v : null;
        }
        catch {
            versionRead = null;
        }
    }
    return versionRead;
}
function writeAll(fd, b) {
    for (let off = 0; off < b.length;)
        off += writeSync(fd, b, off, b.length - off);
}
/** Writes all of b at position at of the open file fd. */
function writeAt(fd, b, at) {
    for (let off = 0; off < b.length;)
        off += writeSync(fd, b, off, b.length - off, at + off);
}
/** The largest file a pin addresses: a position in a file is a JavaScript number, exact up to 2^53 - 1. A larger file is a
 *  failure, ERR_FS_FILE_TOO_LARGE, before anything is read, and --check counts it (PinStaleness.tooLarge). Until 0.2.1 a
 *  pin read each file whole, into one Buffer, and the limit was 2^31 - 1: Node's Buffer indexOf and lastIndexOf take a
 *  32-bit offset (measured, node 24: on a 2.4 GB buffer, lastIndexOf found its last new line at -1,883,242,454), and
 *  fs.writeSync refuses a longer length. S369: no file is held whole; each is read and written in chunks (pass). */
const PIN_MAX_BYTES = Number.MAX_SAFE_INTEGER;
/** The size of each read and write of a file's bytes, unless PinOptions.chunkBytes gives another. */
const CHUNK_BYTES = 1 << 20;
const chunkOf = (o) => {
    const c = o?.chunkBytes;
    return typeof c === 'number' && Number.isSafeInteger(c) && c >= 1 && c <= 2 ** 26 ? c : CHUNK_BYTES;
};
const EMPTY_SHA256 = sha256(new Uint8Array(0));
/** One pass over the open file fd from its start, read through buf (buf.length bytes at a time, never more held), to
 *  its end or to `limit` bytes: what Pass says. The hash is taken in pieces, split at each mark and after the last new
 *  line of each chunk, a copy of its state kept at each (Hash.copy). `sink` gets each chunk as it is read, with the
 *  position of its first byte, before the next read reuses buf. Passes never nest, so one buf serves a whole run (Env.chunk). Throws as readSync throws, and
 *  as sink throws. */
function pass(fd, buf, o = {}) {
    const marks = [...new Set(o.marks ?? [])].filter((m) => Number.isSafeInteger(m) && m >= 0).sort((a, b) => a - b);
    const limit = o.limit ?? Infinity;
    const h = createHash('sha256'), at = new Map();
    let pos = 0, m = 0, cut = 0, cutH = null, nlAfter = false, lastByte = -1;
    for (; m < marks.length && marks[m] === 0; m++)
        at.set(0, EMPTY_SHA256);
    while (pos < limit) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, limit - pos), pos);
        if (n === 0)
            break;
        const b = buf.subarray(0, n);
        o.sink?.(b, pos);
        const points = []; // [offset in b, true for a mark / false for the cut]
        for (; m < marks.length && marks[m] <= pos + n; m++)
            points.push([marks[m] - pos, true]);
        const nl = b.lastIndexOf(0x0a);
        if (nl >= 0)
            points.push([nl + 1, false]);
        points.sort((x, y) => x[0] - y[0]);
        let from = 0;
        for (const [to, isMark] of points) {
            if (to > from) {
                h.update(b.subarray(from, to));
                from = to;
            }
            if (isMark)
                at.set(pos + to, h.copy().digest('hex'));
            else {
                cutH = h.copy();
                cut = pos + to;
            }
        }
        if (from < n)
            h.update(b.subarray(from, n));
        if (o.nlFrom !== undefined && !nlAfter && pos + n > o.nlFrom && b.indexOf(0x0a, Math.max(0, o.nlFrom - pos)) >= 0)
            nlAfter = true;
        lastByte = b[n - 1];
        pos += n;
    }
    return { bytes: pos, sha256: h.digest('hex'), at, cut, cutSha256: cutH === null ? EMPTY_SHA256 : cutH.digest('hex'), nlAfter, lastByte };
}
/** A pass over a regular file, opened by openRegular's rules (never through a symbolic link, never waiting on a FIFO).
 *  Throws as openRegular and pass throw. */
function passRegular(path, chunk, o) {
    const fd = openRegular(path, fsConstants.O_RDONLY);
    try {
        return pass(fd, chunk, o);
    }
    finally {
        closeSync(fd);
    }
}
/** Removes the directories mkdirSync made for a copy's temp (made: the first of them, as mkdirSync returns it), deepest
 *  first, each only while it is empty: a decision that writes nothing leaves the pin's directories as it found them. */
function unmake(dir, made) {
    if (made === undefined)
        return;
    for (let d = dir;; d = dirname(d)) {
        try {
            rmdirSync(d);
        }
        catch {
            return;
        }
        if (d === made || dirname(d) === d)
            return;
    }
}
/** An open file's bytes, read to its end (it may have grown since its size was taken). Only for the pin's small files of
 *  its own: the lock, and PINS.log. */
function readFd(fd, size) {
    let buf = Buffer.allocUnsafe(Math.max(size, 0)), n = 0;
    for (;;) {
        if (n === buf.length) {
            const more = Buffer.allocUnsafe(65536);
            const r = readSync(fd, more, 0, more.length, n);
            if (r === 0)
                return buf;
            const bigger = Buffer.allocUnsafe(Math.max(buf.length * 2, n + r));
            buf.copy(bigger, 0, 0, n);
            more.copy(bigger, n, 0, r);
            buf = bigger;
            n += r;
            continue;
        }
        const r = readSync(fd, buf, n, buf.length - n, n);
        if (r === 0)
            return buf.subarray(0, n);
        n += r;
    }
}
/** What a path that is not a regular file is, as lstat saw it. */
function kindOf(st) {
    return st.isSymbolicLink() ? 'a symbolic link' : st.isDirectory() ? 'a directory' : st.isFIFO() ? 'a FIFO'
        : st.isSocket() ? 'a socket' : 'a device';
}
/** A path that openRegular would not open: a symbolic link, or anything else but a regular file (a FIFO, a socket, a
 *  device, a directory). Its code is a failure's: `not-a-regular-file`. */
class NotRegularFile extends Error {
    path;
    kind;
    code = 'not-a-regular-file';
    constructor(path, kind) {
        super(`'${path}' is ${kind}, not a regular file`);
        this.path = path;
        this.kind = kind;
    }
    get link() { return this.kind === 'a symbolic link'; }
}
/** A copy that no longer held, when it was read again to be written, the bytes a pass over it had found a moment before
 *  (something else wrote to it meanwhile): nothing is written. Its code is a failure's: `copy-changed`. */
class CopyChanged extends Error {
    path;
    code = 'copy-changed';
    constructor(path) {
        super(`'${path}' changed while the pin read it`);
        this.path = path;
    }
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
function openRegular(path, flags, mode) {
    let st = null;
    try {
        st = lstatSync(path);
    }
    catch (e) {
        if (!(flags & fsConstants.O_CREAT) || codeOf(e) !== 'ENOENT')
            throw e;
    }
    if (st !== null && !st.isFile())
        throw new NotRegularFile(path, kindOf(st));
    const fd = openSync(path, flags | O_NOFOLLOW | O_NONBLOCK, mode);
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile())
            throw new NotRegularFile(path, kindOf(opened));
    }
    catch (e) {
        closeSync(fd);
        throw e;
    }
    return fd;
}
/** A regular file's bytes, read whole, by openRegular's rules. */
function readRegular(path) {
    const fd = openRegular(path, fsConstants.O_RDONLY);
    try {
        return readFd(fd, fstatSync(fd).size);
    }
    finally {
        closeSync(fd);
    }
}
/** PINS.log read as readRegular reads it, with the link count and the inode of the very file read (fstat): another name,
 *  a hard link, is one that neither lstat nor O_NOFOLLOW sees. */
function readLog(path) {
    const fd = openRegular(path, fsConstants.O_RDONLY);
    try {
        const s = fstatSync(fd, { bigint: true });
        return { names: Number(s.nlink), ino: s.ino, bytes: readFd(fd, Number(s.size)) };
    }
    finally {
        closeSync(fd);
    }
}
/** fsync a directory, so that a rename in it survives a power loss. Not on win32, where a directory cannot be opened. */
function fsyncDir(dir, platform) {
    if (platform === 'win32')
        return;
    const fd = openSync(dir, 'r');
    try {
        fsyncSync(fd);
    }
    catch (e) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(codeOf(e)))
            throw e;
    } // a file system that cannot fsync one
    finally {
        closeSync(fd);
    }
}
// ---- paths -------------------------------------------------------------------------------------------------------
/** Claude Code's config directory, as Claude Code reads it: `$CLAUDE_CONFIG_DIR`, or `<home>/.claude` when that is unset
 *  or empty. Read at each call. The one place this rule is written: pinPaths' default, `ltms pin` and `ltms search` use
 *  it. */
export function claudeConfigDir() {
    const set = process.env.CLAUDE_CONFIG_DIR;
    return set ? { path: set, fromEnv: true } : { path: join(homedir(), '.claude'), fromEnv: false };
}
/** The real path of p; when p does not exist yet, the real path of its nearest existing ancestor, with the rest of p. */
function realOrNearest(p) {
    const tail = [];
    let cur = resolve(p);
    for (;;) {
        try {
            return join(realpathSync.native(cur), ...tail);
        }
        catch {
            const up = dirname(cur);
            if (up === cur)
                return resolve(p);
            tail.unshift(basename(cur));
            cur = up;
        }
    }
}
const folded = (p, platform) => (platform === 'darwin' || platform === 'win32' ? p.toLowerCase() : p);
/** a is b, or is inside b: path.relative(b, a) is '', or neither leaves b (a first segment '..') nor is absolute. */
function inside(a, b, platform) {
    const r = relative(folded(b, platform), folded(a, platform));
    return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}
/** A path as it was given, and its real path when that is not just the given one made absolute. */
const shown = (given, real) => (resolve(given) === real ? `'${given}'` : `'${given}' (real path '${real}')`);
/** A path as one word of a command a notice gives, by cli.ts's rule for the commands it gives (its `quoted`): in single
 *  quotes, with every ' and every backslash written outside them, as backslash-quote and backslash-backslash, so the
 *  command runs as printed in sh, bash, zsh and fish whatever the path holds. */
const quoted = (s) => `'${s.replace(/['\\]/g, (c) => `'\\${c}'`)}'`;
/** A rel read from PINS.log is used only when it cannot lead out of the pin. */
function safeRel(r, platform) {
    return typeof r === 'string' && r.length > 0 && !r.includes('\0') && !isAbsolute(r)
        && !(platform === 'win32' && /[\\:]/.test(r)) && r.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
const under = (root, rel) => join(root, ...rel.split('/'));
/** The rel an old copy of rel is kept by: <stem>.superseded-<sha12>.jsonl for a .jsonl, else <rel>.superseded-<sha12>. */
const keptRel = (rel, sha) => (rel.endsWith('.jsonl') ? `${rel.slice(0, -'.jsonl'.length)}.superseded-${sha.slice(0, 12)}.jsonl` : `${rel}.superseded-${sha.slice(0, 12)}`);
/** The sweep's own shape, for rels under a root: <project>/<name>.jsonl, <project>/<name>.jsonl.superseded-*, and every
 *  file under <project>/<dir>/{subagents,tool-results,workflows,mcp-tasks}/ of a session directory: one whose name is a
 *  UUID, or whose name plus .jsonl names a file beside it. */
function shapeOf(root) {
    const sessionDir = new Map();
    const isSessionDir = (project, name) => {
        const key = `${project}/${name}`;
        let v = sessionDir.get(key);
        if (v === undefined) {
            v = UUID.test(name);
            if (!v) {
                try {
                    v = lstatSync(join(root, project, `${name}.jsonl`)).isFile();
                }
                catch {
                    v = false;
                }
            }
            sessionDir.set(key, v);
        }
        return v;
    };
    return (rel) => {
        const s = rel.split('/');
        if (s.length === 2)
            return s[1].endsWith('.jsonl') || SET_ASIDE.test(s[1]);
        return s.length >= 4 && SESSION_PARTS.has(s[2]) && isSessionDir(s[0], s[1]);
    };
}
/** Whether rel, a path under root ('/'-separated), is of the sweep's own shape, which pinPaths copies:
 *  `<project>/<name>.jsonl`, `<project>/<name>.jsonl.superseded-*`, or a file under `<project>/<dir>/{subagents,
 *  tool-results,workflows,mcp-tasks}/` of a session directory, one whose name is a UUID or whose name plus `.jsonl` is a
 *  regular file beside it under root (lstat). Nothing else is looked at: not whether the file rel names is there. The
 *  rule is written once: pinPaths and checkPin select by it, and `ltms pin --check` asks it before it gives the
 *  `--rehash` command. */
export function isSweepShaped(root, rel) { return shapeOf(root)(rel); }
/** The directories the walk does not enter, by their name and their depth under the root (a project directory is at
 *  depth 1): `.git`, at any depth, and `memory` directly under a project directory. The rule is written once: walk()
 *  asks it of each directory it meets, and projectPinReaches of each directory on the way to a file. */
function walkSkips(name, depth) {
    return name === '.git' ? 'git' : depth === 2 && name === 'memory' ? 'memory' : null;
}
/** Whether a pin of the project directory of `rel` (a path under the root, '/'-separated, whose first segment is its
 *  project directory) walks to the file at `rel`: the walk enters no `.git` directory, at any depth, and no `memory/`
 *  directly under a project directory, so a file under one of those is pinned only when it is given by its own path.
 *  Only the names on the way are read, nothing on disk: whether the file is there, of the sweep's shape
 *  (isSweepShaped), or reached through a symbolic link (which the walk does not follow) is not looked at. The walk's
 *  rule is written once: `ltms pin --check` asks it to name, in the `--rehash` command it gives, a copy's project
 *  directory, or the file itself. */
export function projectPinReaches(rel) {
    return rel.split('/').slice(0, -1).every((name, i) => walkSkips(name, i + 1) === null);
}
/** The files of the sweep's shape under the given paths. Symbolic links met on the way, memory/ directly under a
 *  project, and .git are counted, never followed; every path is counted once, however many given paths reach it. */
function walk(givens, root) {
    const w = { files: new Map(), skipped: { notSessionShaped: 0, symlinks: 0, memory: 0, git: 0 }, failures: [], projects: new Set(), covered: [], unread: [] };
    const shaped = shapeOf(root);
    const seen = new Set();
    const relOf = (abs) => relative(root, abs).split(sep).join('/');
    const once = (abs) => (seen.has(abs) ? false : (seen.add(abs), true));
    /** A path the walk could not read: a failure of the run, and the rels it did not see there (rel, or those given). */
    const failed = (path, rel, err, unread = [rel]) => {
        w.failures.push({ path, rel, op: 'walk', code: codeOf(err) });
        w.unread.push(...unread);
    };
    const file = (abs) => {
        if (!once(abs))
            return;
        const rel = relOf(abs);
        if (shaped(rel))
            w.files.set(rel, abs);
        else
            w.skipped.notSessionShaped++;
    };
    const enter = (start) => {
        const stack = [start];
        while (stack.length) {
            const d = stack.pop();
            if (!once(d))
                continue;
            const rel = relOf(d), depth = rel === '' ? 0 : rel.split('/').length;
            const skip = walkSkips(basename(d), depth);
            if (skip !== null) {
                w.skipped[skip]++;
                continue;
            }
            if (depth === 1)
                w.projects.add(rel);
            let entries;
            try {
                entries = readdirSync(d, { withFileTypes: true });
            }
            catch (e) {
                failed(d, rel, e);
                continue;
            }
            for (const e of entries) {
                const abs = join(d, e.name);
                let kind = e;
                if (!(e.isFile() || e.isDirectory() || e.isSymbolicLink() || e.isFIFO() || e.isSocket() || e.isBlockDevice() || e.isCharacterDevice())) {
                    try {
                        kind = lstatSync(abs);
                    } // a file system that does not give the entry's type
                    catch (err) {
                        failed(abs, relOf(abs), err);
                        continue;
                    }
                }
                if (kind.isSymbolicLink()) {
                    if (once(abs))
                        w.skipped.symlinks++;
                }
                else if (kind.isDirectory())
                    stack.push(abs);
                else if (kind.isFile())
                    file(abs);
                else if (once(abs))
                    w.skipped.notSessionShaped++; // a socket, a FIFO, a device: never opened
            }
        }
    };
    for (const g of givens) {
        const rel = relOf(g.real), s = rel.split('/');
        const sessionOf = s.length === 2 && s[1].endsWith('.jsonl') ? join(dirname(g.real), s[1].slice(0, -'.jsonl'.length)) : null;
        w.covered.push(rel);
        if (sessionOf !== null)
            w.covered.push(relOf(sessionOf));
        let st;
        try {
            st = lstatSync(g.real);
        }
        catch (e) {
            failed(g.resolved, rel, e, sessionOf === null ? [rel] : [rel, relOf(sessionOf)]);
            continue;
        }
        if (st.isDirectory()) {
            enter(g.real);
            continue;
        }
        if (!st.isFile()) {
            if (once(g.real))
                w.skipped.notSessionShaped++;
            continue;
        }
        file(g.real);
        if (sessionOf !== null) { // a given <sid>.jsonl: its <sid>/ the same way
            let ds;
            try {
                ds = lstatSync(sessionOf);
            }
            catch { /* no session directory */ }
            if (ds?.isSymbolicLink()) {
                if (once(sessionOf))
                    w.skipped.symlinks++;
            }
            else if (ds?.isDirectory())
                enter(sessionOf);
        }
    }
    return w;
}
function scanPin(to) {
    const scan = { files: new Map(), shaped: shapeOf(to), temps: [], unlisted: new Map() };
    const stack = [to];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        }
        catch (e) {
            if (codeOf(e) !== 'ENOENT')
                scan.unlisted.set(relative(to, d).split(sep).join('/'), codeOf(e));
            continue;
        }
        for (const e of entries) {
            const abs = join(d, e.name);
            // every directory, .git too: the copy of a file pinned by its own path under a source's .git/ is under one, and a
            // copy the scan does not see reads as missing (written over at a rewrite, its old version not kept)
            if (e.isDirectory()) {
                stack.push(abs);
                continue;
            }
            if (!e.isFile())
                continue;
            if (TEMP.test(e.name)) {
                const waiting = d === to ? LOCK_TEMP.exec(e.name) : null;
                if (waiting === null || !running(Number(waiting[1])))
                    scan.temps.push(abs);
                continue;
            }
            if (d === to && (e.name === LOG || e.name === LOCK))
                continue;
            try {
                const s = lstatSync(abs, { bigint: true });
                scan.files.set(relative(to, abs).split(sep).join('/'), { size: Number(s.size), mtime: isoNs(s.mtimeNs) });
            }
            catch { /* gone since the listing */ }
        }
    }
    return scan;
}
const FILE_HOWS = new Set(['new', 'grown', 'rewritten', 'recovered']);
const isVersion = (v) => isObject(v) && Number.isSafeInteger(v.bytes) && v.bytes >= 0 && typeof v.sha256 === 'string' && SHA256.test(v.sha256);
const isHolder = (v) => isObject(v) && Number.isSafeInteger(v.pid) && v.pid > 0 && typeof v.host === 'string' && typeof v.started === 'string';
/** A file's line: one that records a version of a rel. */
const isFileLine = (l, platform) => FILE_HOWS.has(l.how) && safeRel(l.rel, platform) && isVersion(l) && (l.prev === undefined || l.prev === null || isVersion(l.prev))
    && (l.kept === undefined || safeRel(l.kept, platform));
/** What one line of PINS.log is, or null when it is not a log line. */
function parseLine(b, n, platform) {
    let o;
    try {
        o = JSON.parse(b.toString('utf8'));
    }
    catch {
        return null;
    }
    if (!isObject(o) || typeof o.t !== 'string' || typeof o.how !== 'string' || !(o.chain === null || typeof o.chain === 'string'))
        return null;
    const l = o;
    if (l.how === 'root')
        return n === 1 && typeof l.root === 'string' ? l : null;
    if (l.how === 'takeover')
        return isHolder(l.lock) ? l : null;
    if (l.how === 'recovered' && l.rel === undefined)
        return isObject(l.torn) && Number.isSafeInteger(l.torn.line) && Number.isSafeInteger(l.torn.bytes) ? l : null;
    return isFileLine(l, platform) ? l : null;
}
/** Takes one whole line into the state. */
function take(st, b, platform) {
    st.lines++;
    st.raw.push(b);
    const l = parseLine(b, st.lines, platform);
    st.parsed.push(l);
    if (l === null) {
        st.unreadable.push(st.lines);
        return null;
    }
    if (l.how === 'root')
        st.root = l;
    if (l.rel !== undefined && FILE_HOWS.has(l.how)) {
        st.byRel.set(l.rel, { bytes: l.bytes, sha256: l.sha256, mtime: typeof l.mtime === 'string' ? l.mtime : null });
        st.named.add(l.rel);
        if (l.kept !== undefined) {
            st.named.add(l.kept);
            st.keptRels.add(l.kept);
        }
    }
    if (l.torn !== undefined)
        st.unreadable = st.unreadable.filter((k) => k !== l.torn.line);
    st.lastT = l.t;
    return l;
}
function parseLog(path, buf, platform, ino = null) {
    const st = { path, lines: 0, raw: [], parsed: [], root: null, byRel: new Map(), named: new Set(), keptRels: new Set(), lastT: null, torn: null, unreadable: [], end: buf.length, ino };
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, start)) {
        take(st, buf.subarray(start, nl), platform);
        start = nl + 1;
    }
    if (start < buf.length)
        st.torn = buf.subarray(start);
    return st;
}
/** A write to PINS.log that failed: the pin stops there, since nothing more it did could be recorded. */
class LogWriteError extends Error {
    reason;
    constructor(reason) {
        super('PINS.log could not be written');
        this.reason = reason;
    }
}
class Log {
    st;
    written;
    platform;
    guard;
    fd = null;
    /** guard: called before each write, it throws when this pin may no longer write (LockLost) */
    constructor(st, written, platform, guard = () => { }) {
        this.st = st;
        this.written = written;
        this.platform = platform;
        this.guard = guard;
    }
    /** The log, opened to append, only as a regular file: never through a symbolic link put at its name (openRegular). */
    open() {
        if (this.fd === null)
            this.fd = openRegular(this.st.path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, FILE_MODE);
        return this.fd;
    }
    /** Appends one line, chained to the line before it, and fsyncs it. */
    append(fields) {
        this.guard();
        const line = { ...fields, chain: this.st.raw.length ? sha256(this.st.raw[this.st.raw.length - 1]) : null };
        const b = Buffer.from(JSON.stringify(line), 'utf8');
        try {
            const fd = this.open();
            writeAll(fd, Buffer.concat([b, NL]));
            fsyncSync(fd);
        }
        catch (e) {
            throw new LogWriteError(e);
        }
        this.st.end += b.length + 1;
        take(this.st, b, this.platform);
        this.written.push(line);
        return line;
    }
    /** A log that does not end in a new line: the cut line is closed as it is, and a recovered line names it. */
    closeTorn() {
        const torn = this.st.torn;
        if (torn === null)
            return;
        this.guard();
        try {
            const fd = this.open();
            writeAll(fd, NL);
            fsyncSync(fd);
        }
        catch (e) {
            throw new LogWriteError(e);
        }
        this.st.end += 1;
        this.st.torn = null;
        take(this.st, torn, this.platform);
        this.append({ t: now(), how: 'recovered', torn: { line: this.st.lines, bytes: torn.length } });
    }
    close() { if (this.fd !== null) {
        closeSync(this.fd);
        this.fd = null;
    } }
}
/** A new PINS.log holding its root line, made whole before it gets its name (written to a temp file, fsynced, then
 *  linked), so its first line is never cut short. */
function createLog(to, root, written, platform) {
    const path = join(to, LOG), tmp = join(to, tempName(LOG));
    const line = { t: now(), how: 'root', root, ltms: ltmsVersion(), chain: null };
    const b = Buffer.from(JSON.stringify(line), 'utf8');
    const fd = openSync(tmp, 'wx', FILE_MODE);
    try {
        writeAll(fd, Buffer.concat([b, NL]));
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        linkSync(tmp, path);
    }
    finally {
        unlinkSync(tmp);
    }
    fsyncDir(to, platform);
    written.push(line);
    // the bytes just written: nothing is read back at that name; the inode is the one linked
    return parseLog(path, Buffer.concat([b, NL]), platform, lstatSync(path, { bigint: true }).ino);
}
// ---- the lock ----------------------------------------------------------------------------------------------------
/** The locks this process holds, so that a lock naming this pid that this process did not take is known to be left by
 *  an earlier process that had the same pid. */
const heldHere = new Set();
function holderIn(raw) {
    try {
        const o = JSON.parse(raw);
        if (!isHolder(o))
            return null;
        const h = { pid: o.pid, host: o.host, started: o.started };
        const fields = o;
        for (const k of ['boot', 'pidns']) {
            const v = fields[k];
            if (typeof v === 'string')
                h[k] = v;
        }
        return h;
    }
    catch {
        return null;
    }
}
/** process.kill(pid, 0): ESRCH means no such process; anything else (EPERM: another user's) means it runs. */
function running(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return codeOf(e) !== 'ESRCH';
    }
}
/** This host's boot id and this process's PID namespace, where /proc gives them (Linux), read once; else null. */
let selfRead;
function self() {
    if (selfRead === undefined) {
        let boot = null, pidns = null;
        try {
            boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
        }
        catch { /* not Linux, or no /proc */ }
        try {
            pidns = readlinkSync('/proc/self/ns/pid');
        }
        catch { /* not Linux, or no /proc */ }
        selfRead = { boot, pidns };
    }
    return selfRead;
}
function lockSeen(path, holder) {
    if (holder === null)
        return 'unreadable';
    if (holder.host !== hostname())
        return 'other-host';
    const me = self();
    if (holder.boot !== undefined && me.boot !== null && holder.boot !== me.boot)
        return 'dead';
    if (holder.pidns !== undefined && me.pidns !== null && holder.pidns !== me.pidns)
        return 'other-namespace';
    if (holder.pid === process.pid)
        return heldHere.has(path) ? 'running' : 'dead';
    return running(holder.pid) ? 'running' : 'dead';
}
function busy(path, holder, seen, waitedMs) {
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
    what;
    path;
    constructor(what, path) {
        super(what === 'lock' ? 'the lock is not this pin\'s any more' : 'PINS.log changed under this pin');
        this.what = what;
        this.path = path;
    }
}
/** Takes <to>/.ltms-pin.lock: its content (pid, host, started) is written and fsynced in a temp file first, and the
 *  temp file is then linked to the lock's name, which fails when the lock exists, so a lock is never seen empty. A
 *  lock whose pid no longer runs on this host is taken over; any other is waited for, up to waitMs, unless a signal
 *  stops the wait (`stopped`). */
async function acquire(to, waitMs, stop) {
    const path = join(to, LOCK), tmp = join(to, tempName(LOCK));
    const me = self();
    const body = JSON.stringify({ pid: process.pid, host: hostname(), started: now(),
        ...(me.boot === null ? {} : { boot: me.boot }), ...(me.pidns === null ? {} : { pidns: me.pidns }) });
    const t0 = Date.now();
    let takeover = null;
    const failed = (e) => ({ k: 'failed', failure: { path, rel: null, op: 'lock', code: codeOf(e) } });
    const writeTemp = () => {
        // whatever is at the temp file's name (left by an earlier process with this pid, or planted there) is removed, never
        // opened: 'wx' makes a new file, does not follow a symbolic link, and fails when the name was taken again meanwhile
        try {
            unlinkSync(tmp);
        }
        catch (e) {
            if (codeOf(e) !== 'ENOENT')
                throw e;
        }
        const fd = openSync(tmp, 'wx', FILE_MODE);
        try {
            writeAll(fd, Buffer.from(body));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    };
    try {
        try {
            writeTemp();
        }
        catch (e) {
            return failed(e);
        }
        for (;;) {
            try {
                linkSync(tmp, path);
                heldHere.add(path);
                return { k: 'held', held: { path, body, released: false }, takeover };
            }
            catch (e) {
                if (codeOf(e) === 'ENOENT') {
                    try {
                        writeTemp();
                        continue;
                    }
                    catch (e2) {
                        return failed(e2);
                    }
                } // our temp file was removed
                if (codeOf(e) !== 'EEXIST')
                    return failed(e);
            }
            // the lock is read only as a regular file: a FIFO there would hold the pin, past every signal, waiting for a
            // writer, and a symbolic link would be read through (a failure, op lock, not-a-regular-file)
            let raw;
            try {
                raw = readRegular(path).toString('utf8');
            }
            catch (e) {
                if (codeOf(e) === 'ENOENT')
                    continue;
                return failed(e);
            }
            const holder = holderIn(raw);
            // a lock naming this pid that this process did not take was left by an earlier process with the same pid
            const seen = lockSeen(path, holder);
            if (seen === 'dead') {
                let again = null;
                try {
                    again = readRegular(path).toString('utf8');
                }
                catch { /* removed meanwhile, or no longer a regular file */ }
                if (again === raw) {
                    // two pins that find the same dead lock at once can both remove it, the second one the first one's new lock:
                    // the one whose lock is not at the name any more stops before its next write (LockLost)
                    try {
                        unlinkSync(path);
                    }
                    catch (e) {
                        if (codeOf(e) !== 'ENOENT')
                            return failed(e);
                    }
                    takeover = holder;
                }
                continue;
            }
            const waited = Date.now() - t0;
            if (waited >= waitMs)
                return busy(path, holder, seen, waited);
            await sleep(Math.min(LOCK_POLL_MS, waitMs - waited));
            if (stop.signal !== null)
                return { k: 'stopped' };
        }
    }
    finally {
        try {
            unlinkSync(tmp);
        }
        catch { /* not made, or linked and removed */ }
    }
}
/** Whether the lock at path names a pin that may be running (lockSeen: anything but `dead`). */
const lockLive = (path, holder) => lockSeen(path, holder) !== 'dead';
/** Throws LockLost unless the lock still holds what this pin wrote into it and PINS.log is the file this pin read, at the
 *  length it knows: called before each write that could replace or remove a file of the pin, and before each line. */
function guard(h, st) {
    let now = null;
    try {
        now = readRegular(h.path).toString('utf8');
    }
    catch { /* removed, or no longer a regular file */ }
    if (now !== h.body)
        throw new LockLost('lock', h.path);
    // PINS.log removed, or another regular file or this one at another length; what is not a regular file at its name is
    // left to the append, which opens only a regular file (a failure, op log, with the code of the refusal)
    let s = null;
    try {
        s = lstatSync(st.path, { bigint: true });
    }
    catch { /* removed */ }
    if (s === null || (s.isFile() && (Number(s.size) !== st.end || (st.ino !== null && s.ino !== st.ino))))
        throw new LockLost('log', st.path);
}
/** Removes the lock, only while it still holds what this pin wrote into it: something else put at its name (read only as
 *  a regular file, since this runs at exit too) is left. */
function release(h) {
    if (h.released)
        return;
    h.released = true;
    heldHere.delete(h.path);
    try {
        if (readRegular(h.path).toString('utf8') === h.body)
            unlinkSync(h.path);
    }
    catch { /* gone already, or not a lock */ }
}
// ---- pinPaths ----------------------------------------------------------------------------------------------------
function refuse(reason, message) { return { k: 'refused', reason, message }; }
/** The refusals, each checked on real paths, before anything is read or written. */
function prepare(paths, o, platform) {
    if (typeof o?.to !== 'string' || o.to === '')
        return refuse('no-to', 'no pin directory given: name the directory to write the copies into (--to <dir>).');
    if (!Array.isArray(paths) || paths.length === 0)
        return refuse('no-paths', 'no paths given to pin.');
    const configGiven = o.configDir ?? claudeConfigDir().path;
    const rootGiven = o.root ?? join(configGiven, 'projects');
    const config = realOrNearest(configGiven), root = realOrNearest(rootGiven), to = realOrNearest(o.to);
    const givens = paths.map((g) => ({ given: String(g), resolved: resolve(String(g)), real: realOrNearest(String(g)) }));
    const pinDir = `the pin directory ${shown(o.to, to)}`;
    if (inside(to, config, platform))
        return refuse('to-inside-config', `${pinDir} is inside Claude Code's config directory ${shown(configGiven, config)}, which its cleanup manages.`);
    for (const g of givens)
        if (inside(to, g.real, platform))
            return refuse('to-inside-path', `${pinDir} is inside ${shown(g.given, g.real)}, a path given to pin.`);
    if (inside(to, root, platform))
        return refuse('to-inside-root', `${pinDir} is inside the root ${shown(rootGiven, root)}, whose files it would pin.`);
    for (const g of givens)
        if (inside(g.real, to, platform))
            return refuse('path-inside-to', `${shown(g.given, g.real)} is inside ${pinDir}.`);
    for (const g of givens)
        if (!inside(g.real, root, platform))
            return refuse('path-outside-root', `${shown(g.given, g.real)} is outside the root ${shown(rootGiven, root)}, which every path in a pin is measured from.`);
    let toStat = null;
    try {
        toStat = lstatSync(to);
    }
    catch { /* not made yet; or under a file, and making it fails next, as a failure */ }
    if (toStat !== null && !toStat.isDirectory()) {
        const kind = toStat.isFile() ? 'a file' : toStat.isSymbolicLink() ? 'a symbolic link that leads to nothing' : 'a socket, a FIFO or a device';
        return refuse('to-not-a-directory', `${pinDir} exists and is not a directory (${kind}), so pin cannot write its copies into it.`);
    }
    const logPath = join(to, LOG);
    let buf = null, names = 1;
    try {
        ({ bytes: buf, names } = readLog(logPath));
    } // with the link count of the very file read
    catch (e) { // no log yet: ENOENT, or ENOTDIR when to cannot be a directory (making it fails next, as a failure)
        if (e instanceof NotRegularFile) {
            return refuse('log-unreadable', e.link
                ? `'${logPath}' is a symbolic link: pin neither reads nor appends to its log through a link, which could lead out of the pin directory.`
                : `'${logPath}' is not a regular file (it is ${e.kind}): pin reads and appends to its log only as a regular file.`);
        }
        if (codeOf(e) !== 'ENOENT' && codeOf(e) !== 'ENOTDIR')
            return refuse('log-unreadable', `'${logPath}' cannot be read (${codeOf(e)}).`);
    }
    if (buf !== null) {
        // another name (a hard link, which lstat and O_NOFOLLOW do not see) would be the same file: whoever can read it reads
        // every line appended from then on
        if (names > 1)
            return refuse('log-unreadable', `'${logPath}' has ${names} names (hard links to one file): pin does not append to a log that has another name, since whoever can read that name, which can lie outside the pin directory, could read every line appended later.`);
        const nl = buf.indexOf(0x0a);
        const first = nl < 0 ? null : parseLine(buf.subarray(0, nl), 1, platform);
        if (first === null || first.how !== 'root') {
            const what = buf.length === 0 ? 'is empty' : nl < 0 ? 'holds no whole line' : 'opens with another line';
            return refuse('log-unreadable', `'${logPath}' ${what}, not the line that records the root its copies are measured from, so pin cannot tell which root that is.`);
        }
        // the root it records, or the directory that path leads to now: Claude Code's config directory moved to another
        // disk with a symbolic link left at its path is the same root (S368, the adversarial reading's B4: every pin was
        // refused, and the command the refusal gave was refused too)
        if (relative(folded(first.root, platform), folded(root, platform)) !== ''
            && relative(folded(realOrNearest(first.root), platform), folded(root, platform)) !== '') {
            return { ...refuse('root-differs', `'${logPath}' records the root '${first.root}', and this pin's root is ${shown(rootGiven, root)}: every rel in the pin is measured from the root it records.`), recordedRoot: first.root };
        }
    }
    else if (toStat !== null) {
        // no log: a directory that holds anything but a pin's own lock and temp files (a pin stopped before it made its log
        // leaves those) is not a pin, and what it holds is not pin's to adopt or write among
        let names = [];
        try {
            names = readdirSync(to).filter((n) => n !== LOCK && !TEMP.test(n)).sort();
        }
        catch { /* read again by the run, as a failure */ }
        if (names.length) {
            const held = names.length === 1 ? `'${names[0]}'` : `${names.length} entries ('${names[0]}' first, by name)`;
            return refuse('to-holds-files', `${pinDir} already holds ${held}, and no PINS.log: it is not a pin, and pin does not write among files it did not make.`);
        }
    }
    return { k: 'ok', to, root, givens };
}
/** The first directory at or above rel's copy that the scan could not list, with the error's code; or null. */
function unlistedOver(e, rel) {
    if (e.unlisted.size === 0)
        return null;
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/'), code = e.unlisted.get(d);
        if (code !== undefined)
            return { path: d === '' ? e.to : under(e.to, d), code };
    }
    return null;
}
/** The kept copy of version v of rel (keptRel), when the pin holds one that holds v exactly; else null. A recovered line
 *  that records what a copy holds instead of v names it, so that a check reads v there. */
function heldKept(e, rel, v) {
    const k = keptRel(rel, v.sha256);
    try {
        const p = passRegular(under(e.to, k), e.chunk);
        return p.bytes === v.bytes && p.sha256 === v.sha256 ? k : null;
    }
    catch (err) {
        if (!isFsError(err))
            throw err;
        return null;
    }
}
/** Keeps the bytes the copy at rel holds (`bytes` of them, whose sha256 is `sha`: a pass over it), which no line records
 *  as rel's version, before anything is written over them: linked to the kept name of their own bytes (keptRel; never
 *  over another file), a file of the pin of its own, with a recovered line that records it (prev null) unless a line
 *  names it already. Null, with a failure, when that name holds other bytes or the link fails: then nothing may be
 *  written over the copy (S368: --rehash wrote a copy again from its source, and lost what it held, the adversarial
 *  reading's A1). */
function keepAside(e, rel, bytes, sha) {
    const k = keptRel(rel, sha), kAbs = under(e.to, k);
    const fail = (code) => {
        if (typeof code !== 'string' && !isFsError(code))
            throw code;
        e.failures.push({ path: kAbs, rel: k, op: 'keep', code: typeof code === 'string' ? code : codeOf(code) });
        return null;
    };
    if (!safeRel(k, e.platform))
        return fail('name-not-allowed');
    e.guard();
    try {
        linkSync(under(e.to, rel), kAbs);
    }
    catch (err) {
        if (codeOf(err) !== 'EEXIST')
            return fail(err);
        let there;
        try {
            there = passRegular(kAbs, e.chunk);
        }
        catch (err2) {
            return fail(err2);
        }
        if (there.sha256 !== sha)
            return fail('kept-copy-differs');
    }
    try {
        fsyncDir(dirname(kAbs), e.platform);
    }
    catch (err) {
        return fail(err);
    }
    if (!e.log.st.named.has(k)) {
        let mtime = null;
        try {
            mtime = isoNs(lstatSync(kAbs, { bigint: true }).mtimeNs);
        }
        catch { /* linked a moment ago */ }
        e.log.append({ t: now(), rel: k, how: 'recovered', bytes, sha256: sha, prev: null, ...(mtime === null ? {} : { mtime }) });
    }
    e.present.add(k);
    if (!e.keptAside.includes(k))
        e.keptAside.push(k);
    return k;
}
/** The first directory between the pin directory and dir (dir included) that is a symbolic link, or null. A directory
 *  not made yet ends the search: from there on, mkdirSync makes real directories. */
function linkOnTheWay(to, dir, seen) {
    const known = seen.get(dir);
    if (known !== undefined)
        return known;
    let found = null;
    let cur = to;
    for (const part of relative(to, dir).split(sep).filter((p) => p !== '')) {
        cur = join(cur, part);
        let st;
        try {
            st = lstatSync(cur);
        }
        catch {
            break;
        }
        if (st.isSymbolicLink()) {
            found = cur;
            break;
        }
    }
    seen.set(dir, found);
    return found;
}
/** Whether the copy at path holds exactly version v (one pass); a copy that cannot be read, or is not a regular file,
 *  does not. */
function holds(path, v, chunk) {
    try {
        const p = passRegular(path, chunk);
        return p.bytes === v.bytes && p.sha256 === v.sha256;
    }
    catch {
        return false;
    }
}
/** One file: stat; one pass over the source, each chunk hashed and written to the copy's temp as it is read (the cut,
 *  the hash, the prefix hashes the decision needs); decide; one pass over the copy; keep the old copy; rename the temp
 *  over it; log. No file is held whole: each is read and written in chunks of Env.chunk's size, so the memory a pin
 *  needs for a file's bytes does not grow with its size (S369: until 0.2.1 the source and the copy were read whole, a
 *  source of 2 GiB or more could not be pinned, and one larger than the memory a pin could use ended every pin at it). */
function pinOne(rel, src, e) {
    const last = e.log.st.byRel.get(rel);
    const dst = under(e.to, rel);
    const present = e.present.has(rel);
    const fail = (op, path, err) => {
        e.failures.push({ path, rel, op, code: typeof err === 'string' ? err : codeOf(err) });
        return { how: 'failed', partial: false, bytes: 0, again: null, lost: false };
    };
    const unchanged = (partial) => ({ how: 'unchanged', partial, bytes: 0, again: null, lost: false });
    // a rel whose line could not be read back under this platform's rules (on win32, one holding ':' or '\') is never
    // written: its copy would stand with no line, and the next pin would write over it as new (S368, A8)
    if (!safeRel(rel, e.platform))
        return fail('write', src, 'name-not-allowed');
    // a name a line gives a kept copy is never a source's copy: written there, the version kept by it would be gone (S368, A4)
    if (last === undefined && e.log.st.keptRels.has(rel))
        return fail('write', dst, 'kept-name');
    // a directory of the pin that could not be listed: what is in it cannot be seen, so nothing is written into it (S368, A5)
    const blind = unlistedOver(e, rel);
    if (blind !== null)
        return fail('write', blind.path, blind.code);
    let st;
    try {
        st = lstatSync(src, { bigint: true });
    }
    catch (err) {
        return fail('read', src, err);
    }
    if (!st.isFile())
        return fail('read', src, 'not-a-file');
    e.onStep?.('stat', rel);
    const size = Number(st.size), mtime = isoNs(st.mtimeNs);
    if (size > PIN_MAX_BYTES)
        return fail('read', src, 'ERR_FS_FILE_TOO_LARGE');
    // the fast path: the size and the mtime (to the ns) its last line records, and the copy in place
    if (!e.rehash && last !== undefined && present && size === last.bytes && mtime === last.mtime)
        return unchanged(false);
    // a copy is never written through a symbolic link inside the pin: it would land outside the pin, where the pin's own
    // scan does not see it (the scan does not follow links), and be written again on every run
    if (linkOnTheWay(e.to, dirname(dst), e.linkTo) !== null)
        return fail('write', dst, 'symlink-in-pin');
    // the copy's size now: a mark of the pass over the source, so that whether the copy is a byte prefix of the source is a
    // compare of two sha256s below (a copy whose size changes before it is read is then taken for no prefix: a rewrite,
    // which keeps it)
    let pre = null;
    try {
        const d = lstatSync(dst);
        if (d.isFile())
            pre = d.size;
    }
    catch { /* none: looked at again below */ }
    // The source is opened once, and every read of it in this run goes through that one descriptor, so a rename over it,
    // or its deletion, cannot change what this pin reads or writes (S369: a first version opened it again to write the
    // copy, and lost what a source held when it was deleted or replaced between the reads, and never pinned a file
    // replaced more often than that: the re-check's A1, B2, C2). When a write is likely (a new file, or one whose size is
    // not the size its last line records), each chunk is also written to the copy's temp as it is read, so the copy is
    // made of the very bytes the decision hashed; otherwise (a file touched, or read with --rehash) the source is only read,
    // and the temp is written by a second read through the same descriptor when the decision is to write, its bytes
    // checked against the first read's (the closure check's V3: writing every file read into a temp failed ENOSPC on a
    // full disk where 0.2.1 found the file unchanged). A source written in place while it is read (its ctime moved) is
    // read again up to the cut and compared, so a copy torn between two versions is never kept: one read more, then a
    // failure, source-changed (the closure check's V1). The temp is cut back to the cut, and removed again, with any
    // directory made for it, when nothing is renamed in. It is a write into the pin: a pin whose lock is lost stops before
    // it (and again before the rename, below: a copy can take long)
    let sfd;
    try {
        sfd = openSync(src, 'r');
    }
    catch (err) {
        if (!isFsError(err))
            throw err;
        return fail('read', src, err);
    }
    const dir = dirname(dst), tmp = join(dir, tempName(basename(dst)));
    let made, fd = null, open = false, renamed = false;
    /** Makes the copy's temp, after the guard; throws as mkdirSync and openSync throw. */
    const makeTemp = () => {
        e.guard();
        made = mkdirSync(dir, { recursive: true, mode: DIR_MODE });
        fd = openSync(tmp, 'wx', FILE_MODE & Number(st.mode)); // 0600, or the source's mode when it is stricter
        open = true;
        return fd;
    };
    try {
        const sinking = last === undefined || size !== last.bytes;
        if (sinking) {
            try {
                makeTemp();
            }
            catch (err) {
                if (!isFsError(err))
                    throw err;
                return fail('write', dst, err);
            }
        }
        const jsonl = rel.endsWith('.jsonl');
        const marks = [...(last === undefined ? [] : [last.bytes]), ...(pre === null ? [] : [pre])];
        let p = null;
        for (let attempt = 0; attempt < 2 && p === null; attempt++) {
            let q, moved;
            try {
                if (fd !== null && attempt > 0)
                    ftruncateSync(fd, 0);
                const t = fd;
                const c0 = fstatSync(sfd, { bigint: true }).ctimeNs;
                q = pass(sfd, e.chunk, { marks, ...(t === null ? {} : { sink: (b, at) => writeAt(t, b, at) }) });
                moved = fstatSync(sfd, { bigint: true }).ctimeNs !== c0;
                if (moved) {
                    // written while it was read: the bytes up to the cut, read again, must hash as they did, or the read is torn
                    const n = jsonl ? q.cut : q.bytes, again = pass(sfd, e.chunk, { limit: n });
                    if (again.bytes === n && again.sha256 === (jsonl ? q.cutSha256 : q.sha256))
                        moved = false;
                }
            }
            catch (err) {
                if (!isFsError(err))
                    throw err;
                // the source's read fails the read; the temp's write or cut (ENOSPC, EIO) fails the copy's write
                const sc = err.syscall;
                return sc === 'write' || sc === 'ftruncate' ? fail('write', dst, err) : fail('read', src, err);
            }
            if (!moved)
                p = q;
        }
        if (p === null)
            return fail('read', src, 'source-changed');
        e.onStep?.('read', rel);
        // a .jsonl is cut at its last new line; one with none yet (or empty) has nothing whole to pin, and is not copied
        const cut = jsonl ? p.cut : p.bytes;
        const partial = jsonl && cut < p.bytes;
        if (jsonl && cut === 0) {
            // nothing whole to copy. A copy that recovery left to this run (rehash: its version, then bytes no pin wrote) is cut
            // back to that version, so that those bytes never stand as one
            if (e.rehash && present && last !== undefined) {
                let held = null;
                try {
                    held = passRegular(dst, e.chunk, { marks: [last.bytes], nlFrom: last.bytes });
                }
                catch (err) {
                    if (!isFsError(err))
                        throw err;
                } // read by recovery a moment ago
                if (held !== null && startsWith(held, last) && damageAfter(held, last, rel)) {
                    e.guard();
                    try {
                        cutBack(dst, last, held, e.platform, e.chunk);
                    }
                    catch (err) {
                        if (!isFsError(err))
                            throw err;
                        return fail('write', dst, err);
                    }
                }
            }
            return { how: 'notCopied', partial, bytes: 0, again: null, lost: false };
        }
        if (fd !== null && cut < p.bytes) { // the temp holds the bytes up to the cut, and no more
            try {
                ftruncateSync(fd, cut);
            }
            catch (err) {
                if (!isFsError(err))
                    throw err;
                return fail('write', dst, err);
            }
        }
        // the sha256 of the bytes up to the cut, and of the prefix the old copy claims, from the one pass
        const sha = jsonl ? p.cutSha256 : p.sha256;
        const prefix = last !== undefined && last.bytes <= cut ? p.at.get(last.bytes) ?? null : null;
        let how;
        let prev = last === undefined ? null : { bytes: last.bytes, sha256: last.sha256 };
        let again = null;
        if (last === undefined)
            how = 'new';
        else if (cut === last.bytes && sha === last.sha256) {
            // the source holds the version its last line records: the copy is that version, unless it is missing or, read
            // with rehash, holds other bytes (a copy changed in place at the same size is seen by nothing else); then it is
            // written again from the source
            if (present && !(e.rehash && !holds(dst, last, e.chunk)))
                return unchanged(partial);
            how = 'recovered';
            again = present ? 'damaged' : 'missing';
        }
        else if (cut > last.bytes && prefix === last.sha256)
            how = 'grown';
        else
            how = 'rewritten';
        // what the copy holds now, read before anything is written over it: the run believes it holds the version its last
        // line records (a copy the scan saw), or that there is none (a new file, a copy missing from the pin). A copy that is
        // not what the run believes is recorded by a recovered line and decided against again (a rewrite then keeps it); with
        // --rehash, a damaged copy written again from its source is kept aside first. So no pin writes over a file it has not
        // read, nor over bytes it has not kept or found held (S368: before, only a rewrite read the copy, and a pin that decided
        // from a stale state, a killed pin's unlogged rename, or a copy the scan had not seen was written over: the adversarial
        // reading's A1, A2, B1, C2, A5). What is not a regular file at the copy's name holds no version: it is written over as
        // before, unless it is the copy the scan saw and a rewrite must keep (a failure, op keep, not-a-regular-file)
        let disk = null;
        try {
            disk = lstatSync(dst, { bigint: true });
        }
        catch (err) {
            if (codeOf(err) !== 'ENOENT') {
                if (!isFsError(err))
                    throw err;
                return fail('write', dst, err);
            }
        }
        if (disk !== null && !disk.isFile()) {
            if (how === 'rewritten' && present)
                return fail('keep', dst, 'not-a-regular-file');
            disk = null;
        }
        if (how === 'rewritten' && present && disk === null)
            return fail('keep', dst, 'ENOENT');
        const believed = present && last !== undefined ? last : null;
        // what the copy holds, in one pass (never read whole): its length and sha256, whether it starts with the version the
        // run believes it holds, what follows that version in it, and its last byte
        let old = null;
        if (disk !== null) {
            try {
                old = passRegular(dst, e.chunk, believed === null ? {} : { marks: [believed.bytes], nlFrom: believed.bytes });
            }
            catch (err) {
                if (!isFsError(err))
                    throw err;
                return fail('keep', dst, err);
            }
        }
        // a copy missing from the pin cannot be kept: when its source has been rewritten since, its version is lost
        const lost = how === 'rewritten' && disk === null;
        // a rewrite keeps the old copy first, by a link named by the sha12 of its bytes on disk
        let kept;
        if (old !== null) {
            let oldBytes = old.bytes, oldSha = old.sha256;
            if (e.rehash && believed !== null && startsWith(old, believed) && damageAfter(old, believed, rel)) {
                // its version, then bytes no pin wrote (recovery left it to this run): cut back to that version first, which the
                // rewrite then keeps; the rules for a rewrite apply to the source's bytes, never to that damage
                e.guard();
                try {
                    cutBack(dst, believed, old, e.platform, e.chunk);
                }
                catch (err) {
                    if (!isFsError(err))
                        throw err;
                    return fail('write', dst, err);
                }
                oldBytes = believed.bytes;
                oldSha = believed.sha256;
            }
            if (believed === null || oldBytes !== believed.bytes || oldSha !== believed.sha256) {
                if (e.rehash && believed !== null && (again === 'damaged' || how === 'grown')) {
                    // with --rehash, recovery left this copy to the run (its source holds the version its last line records, at its
                    // start): the run writes it from the source, and what the copy holds instead is kept aside first, a file of its
                    // own (it can be a version a killed pin renamed in); except a .jsonl's bytes that do not end in a new line, which
                    // no pin writes (it copies whole lines): damage, never a version
                    const cutInLine = rel.endsWith('.jsonl') && oldBytes > 0 && old.lastByte !== 0x0a;
                    if (!cutInLine && keepAside(e, rel, oldBytes, oldSha) === null)
                        return { how: 'failed', partial: false, bytes: 0, again: null, lost: false };
                }
                else {
                    // the copy does not hold what the run believes: a recovered line records what it holds (naming the kept copy of
                    // the version its last line records, when one holds it), and the decision is made again against that
                    let copyMtime = null;
                    try {
                        copyMtime = isoNs(lstatSync(dst, { bigint: true }).mtimeNs);
                    }
                    catch { /* read a moment ago */ }
                    const lastKept = last === undefined ? null : heldKept(e, rel, last);
                    e.log.append({ t: now(), rel, how: 'recovered', bytes: oldBytes, sha256: oldSha, prev: last === undefined ? null : { bytes: last.bytes, sha256: last.sha256 },
                        ...(lastKept === null ? {} : { kept: lastKept }), ...(copyMtime === null ? {} : { mtime: copyMtime }) });
                    e.present.add(rel);
                    prev = { bytes: oldBytes, sha256: oldSha };
                    if (oldBytes === cut && oldSha === sha)
                        return unchanged(partial);
                    // grown when the copy is a byte prefix of the bytes up to the cut: the pass over the source hashed its first
                    // oldBytes bytes (the mark at the copy's size; a copy whose size changed since reads as no prefix, a rewrite)
                    how = oldBytes < cut && p.at.get(oldBytes) === oldSha ? 'grown' : 'rewritten';
                    again = null;
                }
            }
            if (how === 'rewritten') {
                const k = keptRel(rel, oldSha), kAbs = under(e.to, k);
                e.guard();
                try {
                    linkSync(dst, kAbs);
                }
                catch (err) {
                    if (codeOf(err) !== 'EEXIST') {
                        if (!isFsError(err))
                            throw err;
                        return fail('keep', kAbs, err);
                    }
                    // kept already: it must hold these bytes, as a regular file (a link there is never read through, and a FIFO
                    // never waited on: a failure, not-a-regular-file)
                    let held;
                    try {
                        held = passRegular(kAbs, e.chunk);
                    }
                    catch (err2) {
                        if (!isFsError(err2))
                            throw err2;
                        return fail('keep', kAbs, err2);
                    }
                    if (held.sha256 !== oldSha)
                        return fail('keep', kAbs, 'kept-copy-differs');
                }
                kept = k;
                e.present.add(k);
                e.onStep?.('linked', rel);
            }
        }
        // the write. A source only read so far (no temp yet) is read again through the same descriptor into a new temp, up
        // to the cut, and those bytes must hash as the decision's did: when they do not, it was written in place between the
        // two reads, and nothing is written (a failure, source-changed; the next pin pins it as it is then). Then the temp,
        // holding the bytes up to the cut, is given the source's mtime and fsynced; renamed over the copy; the directory
        // fsynced. The descriptor is let go before its close is asked for: a close that fails has still released it
        let w;
        if (fd === null) {
            try {
                w = makeTemp();
            }
            catch (err) {
                if (!isFsError(err))
                    throw err;
                return fail('write', dst, err);
            }
            let again;
            try {
                again = pass(sfd, e.chunk, { limit: cut, sink: (b, at) => writeAt(w, b, at) });
            }
            catch (err) {
                if (!isFsError(err))
                    throw err;
                return err.syscall === 'write' ? fail('write', dst, err) : fail('read', src, err);
            }
            if (again.bytes !== cut || again.sha256 !== sha)
                return fail('read', src, 'source-changed');
        }
        else
            w = fd;
        try {
            futimesSync(w, Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9); // seconds as a double: within a µs
            fsyncSync(w);
            open = false;
            closeSync(w);
            e.onStep?.('temp-written', rel);
            e.guard();
            renameOver(tmp, dst, e.platform, () => e.onStep?.('rename-retry', rel));
            renamed = true;
            fsyncDir(dir, e.platform);
        }
        catch (err) {
            if (!isFsError(err))
                throw err;
            return fail('write', dst, err);
        }
        e.present.add(rel);
        e.onStep?.('renamed', rel);
        e.log.append({ t: now(), rel, how, bytes: cut, sha256: sha, prev: how === 'new' ? null : prev, ...(kept === undefined ? {} : { kept }), mtime });
        e.onStep?.('logged', rel);
        return how === 'recovered' ? { how: 'unchanged', partial, bytes: cut, again, lost } : { how, partial, bytes: cut, again: null, lost };
    }
    finally {
        // the source let go; nothing renamed in: the temp goes, and the directories made for it while they are empty (an
        // error thrown on, a stop, a decision that writes nothing). A pin killed before this leaves the temp, which the next
        // one settles. A failed close here has still released its descriptor, and is not thrown on (the closure check's V4)
        try {
            closeSync(sfd);
        }
        catch { /* released */ }
        if (open && fd !== null) {
            open = false;
            try {
                closeSync(fd);
            }
            catch { /* released */ }
        }
        if (fd !== null && !renamed) {
            try {
                unlinkSync(tmp);
            }
            catch { /* the next pin settles it */ }
            unmake(dir, made);
        }
    }
}
/** Whether the bytes of a pass start with version v: the sha256 of their first v.bytes bytes is v's (the pass's mark at
 *  v.bytes). */
const startsWith = (b, v) => b.bytes >= v.bytes && b.at.get(v.bytes) === v.sha256;
/** Whether a copy b of rel (a pass with nlFrom v.bytes), which starts with version v (startsWith), holds after it only
 *  bytes that no pin wrote: rel is a .jsonl, which a pin copies only up to a new line, and no new line follows v in b.
 *  Those bytes are damage, never a version: a pin stopped between the rename of a grown copy and its line leaves whole
 *  lines after v. */
const damageAfter = (b, v, rel) => rel.endsWith('.jsonl') && b.bytes > v.bytes && !b.nlAfter;
/** Renames tmp over dst. On win32, a rename that fails with EPERM, EACCES or EBUSY is retried RENAME_TRIES times,
 *  RENAME_PAUSE_MS apart, onRetry called before each retry. */
function renameOver(tmp, dst, platform, onRetry) {
    for (let attempt = 0;; attempt++) {
        try {
            renameSync(tmp, dst);
            return;
        }
        catch (err) {
            if (platform !== 'win32' || !RENAME_RETRY.has(codeOf(err)) || attempt >= RENAME_TRIES)
                throw err;
            onRetry?.();
            sleepSync(RENAME_PAUSE_MS);
        }
    }
}
/** Seconds since the epoch, as a double, of a time isoNs wrote (`2026-11-08T13:57:08.261123456Z`), within a µs; null
 *  when it is not one. */
function secondsOf(iso) {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3})(\d{6})Z$/.exec(iso);
    const ms = m === null ? NaN : Date.parse(`${m[1]}Z`);
    return Number.isNaN(ms) ? null : ms / 1000 + Number(m[2]) / 1e9;
}
/** Writes the copy at dst again holding only version v, its own first v.bytes bytes, which a pass over it found to start
 *  with v (startsWith; `seen`, that pass's length and sha256), as pinOne writes a copy: a temp file of its own name
 *  (tempName's n 1: pinOne's temp exists at once), fsynced, renamed over the copy, its directory fsynced; with the copy's
 *  own mode (0600, or stricter), and the mtime v's line records (its source's, when v was pinned), or, when that line
 *  has none that can be read, the copy's own. The copy is read whole again, in chunks, the first v.bytes bytes written to
 *  the temp: when it is no longer exactly what the pass found (its version, and after it the same bytes no pin wrote),
 *  something else wrote to it meanwhile, and nothing is written over it (CopyChanged; S369, the re-check's A7: a first
 *  check compared only the version's bytes, and cut away whole lines appended after them). No line is written: the
 *  copy then holds what its last line records. */
function cutBack(dst, v, seen, platform, chunk) {
    const st = lstatSync(dst, { bigint: true });
    const dir = dirname(dst), tmp = join(dir, tempName(basename(dst), 1));
    const mtime = (v.mtime === null ? null : secondsOf(v.mtime)) ?? Number(st.mtimeNs) / 1e9;
    const fd = openSync(tmp, 'wx', FILE_MODE & Number(st.mode));
    try {
        try {
            const cfd = openRegular(dst, fsConstants.O_RDONLY);
            let q;
            try {
                q = pass(cfd, chunk, { marks: [v.bytes], sink: (b, at) => { if (at < v.bytes)
                        writeAll(fd, b.subarray(0, Math.min(b.length, v.bytes - at))); } });
            }
            finally {
                closeSync(cfd);
            }
            if (q.bytes !== seen.bytes || q.sha256 !== seen.sha256 || q.at.get(v.bytes) !== v.sha256)
                throw new CopyChanged(dst);
            futimesSync(fd, Number(st.atimeNs) / 1e9, mtime);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameOver(tmp, dst, platform);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch { /* the next pin removes it */ }
        throw err;
    }
    fsyncDir(dir, platform);
}
/** Whether the source at path holds version v at its start as a pin copies it: the sha256 of its first v.bytes bytes is
 *  v's, and, for a .jsonl, those bytes end at or before its last new line (whole lines). pinOne then finds it unchanged
 *  against v, or grown from it (one pass, in chunks). `unreadable` when it cannot be read or is not a regular file
 *  (passRegular: never waited on). */
function sourceHolds(path, rel, v, chunk) {
    let b;
    try {
        b = passRegular(path, chunk, { marks: [v.bytes] });
    }
    catch {
        return 'unreadable';
    }
    const cut = rel.endsWith('.jsonl') ? b.cut : b.bytes;
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
function leftToTheRun(b, v, rel, src, chunk) {
    const atStart = startsWith(b, v);
    if (atStart && damageAfter(b, v, rel))
        return true;
    const holds = sourceHolds(src, rel, v, chunk);
    return holds === 'unreadable' || (!atStart && holds);
}
/** Whether rel is one of rels, or under one ('' is the whole root). */
const atOrUnder = (rel, rels) => rels.some((d) => d === '' || rel === d || rel.startsWith(`${d}/`));
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
function recover(e, scan, sources, unread) {
    let n = 0;
    const st = e.log.st;
    // one pass over a file of the pin; with v, the marks that say whether it starts with v and what follows v in it
    const read = (rel, v) => {
        try {
            return passRegular(under(e.to, rel), e.chunk, v === null ? {} : { marks: [v.bytes], nlFrom: v.bytes });
        }
        catch (err) {
            if (!isFsError(err))
                throw err;
            e.failures.push({ path: under(e.to, rel), rel, op: 'recover', code: codeOf(err) });
            return null;
        }
    };
    for (const [rel, last] of [...st.byRel].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const f = scan.files.get(rel);
        if (f === undefined)
            continue;
        const k = keptRel(rel, last.sha256), keptWaits = scan.files.has(k) && !st.named.has(k);
        if (f.size === last.bytes && !keptWaits)
            continue;
        const b = read(rel, last);
        if (b === null)
            continue;
        if (b.bytes === last.bytes && b.sha256 === last.sha256)
            continue; // as its line says: the rename did not happen
        const src = sources.get(rel);
        // pinned from src by this run; or, its source out of the walk's sight, left as it is
        if (e.rehash && !keptWaits && (src === undefined ? atOrUnder(rel, unread) : leftToTheRun(b, last, rel, src, e.chunk)))
            continue;
        // the kept copy of the version its last line records, waiting or named by an earlier line, when it holds that version
        let kept;
        if (scan.files.has(k)) {
            const kb = read(k, null);
            if (kb !== null && kb.bytes === last.bytes && kb.sha256 === last.sha256)
                kept = k;
        }
        e.log.append({ t: now(), rel, how: 'recovered', bytes: b.bytes, sha256: b.sha256, prev: { bytes: last.bytes, sha256: last.sha256 }, ...(kept === undefined ? {} : { kept }), mtime: f.mtime });
        n++;
    }
    for (const rel of [...scan.files.keys()].sort()) {
        // a rel whose line could not be read back under this platform's rules gets none (S368, A8)
        if (st.named.has(rel) || !scan.shaped(rel) || !safeRel(rel, e.platform))
            continue;
        const b = read(rel, null);
        if (b === null)
            continue;
        e.log.append({ t: now(), rel, how: 'recovered', bytes: b.bytes, sha256: b.sha256, prev: null, mtime: scan.files.get(rel).mtime });
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
function settleTemps(e, scan, root) {
    const st = e.log.st, out = { removed: 0, kept: [] };
    const fail = (path, rel, op, err) => {
        if (typeof err !== 'string' && !isFsError(err))
            throw err;
        e.failures.push({ path, rel, op, code: typeof err === 'string' ? err : codeOf(err) });
    };
    for (const abs of scan.temps) {
        const rel = relative(e.to, abs).split(sep).join('/');
        // a waiting pin's lock temp file, its pid no longer running (scanPin): the lock's, never a copy (a file directly
        // under the root is never of the sweep's shape), so removed as before
        if (dirname(abs) === e.to && LOCK_TEMP.test(basename(abs))) {
            e.guard();
            try {
                unlinkSync(abs);
                out.removed++;
            }
            catch (err) {
                fail(abs, null, 'recover', err);
            }
            continue;
        }
        if (st.named.has(rel)) {
            try {
                const s = lstatSync(abs, { bigint: true });
                scan.files.set(rel, { size: Number(s.size), mtime: isoNs(s.mtimeNs) });
                e.present.add(rel);
            }
            catch { /* gone since the scan */ }
            continue;
        }
        let t;
        try {
            t = passRegular(abs, e.chunk);
        }
        catch (err) {
            fail(abs, null, 'recover', err);
            continue;
        }
        const m = /^\.(.+)\.ltms-tmp-\d+$/.exec(basename(abs)), slash = rel.lastIndexOf('/');
        const target = m === null ? null : `${slash < 0 ? '' : rel.slice(0, slash + 1)}${m[1]}`;
        // whether the file at path starts with the temp's bytes: its first t.bytes bytes, read (no more), hash to the temp's
        const holdsT = (path) => {
            let b;
            try {
                b = passRegular(path, e.chunk, { limit: t.bytes });
            }
            catch (err) {
                if (!isFsError(err))
                    throw err;
                return false;
            }
            return b.bytes === t.bytes && b.sha256 === t.sha256;
        };
        // held when a file of the pin holds its bytes: its target's copy, or a kept copy of it. Its source holding them is
        // not enough (S368, the re-check's B1): a pin of another project leaves that source unpinned, and once it is
        // rewritten the version is in no file. Except a .jsonl temp whose bytes do not end in a new line: a write cut short,
        // which holds no version (a pin copies whole lines), removed when its source holds them too
        let held = t.bytes === 0;
        const cutShort = target !== null && target.endsWith('.jsonl') && t.lastByte !== 0x0a;
        if (!held && target !== null) {
            const where = cutShort ? [under(e.to, target), under(root, target)] : [under(e.to, target)];
            for (const l of st.parsed)
                if (l !== null && l.rel === target && typeof l.kept === 'string')
                    where.push(under(e.to, l.kept));
            held = where.some(holdsT);
        }
        if (held) {
            e.guard();
            try {
                unlinkSync(abs);
                out.removed++;
            }
            catch (err) {
                fail(abs, null, 'recover', err);
            }
            continue;
        }
        const sha = t.sha256, k = keptRel(target ?? rel, sha), kAbs = under(e.to, k);
        // a kept name whose line could not be read back under this platform's rules: the temp is left as it is (S368, A8)
        if (!safeRel(k, e.platform)) {
            fail(abs, null, 'keep', 'name-not-allowed');
            continue;
        }
        e.guard();
        try {
            linkSync(abs, kAbs);
        }
        catch (err) {
            if (codeOf(err) !== 'EEXIST') {
                fail(kAbs, k, 'keep', err);
                continue;
            }
            let there;
            try {
                there = passRegular(kAbs, e.chunk);
            }
            catch (err2) {
                fail(kAbs, k, 'keep', err2);
                continue;
            }
            if (there.sha256 !== sha) {
                fail(kAbs, k, 'keep', 'kept-copy-differs');
                continue;
            }
        }
        try {
            fsyncDir(dirname(kAbs), e.platform);
            unlinkSync(abs);
        }
        catch (err) {
            fail(abs, null, 'recover', err);
        }
        let mtime = null;
        try {
            mtime = isoNs(lstatSync(kAbs, { bigint: true }).mtimeNs);
        }
        catch { /* linked a moment ago */ }
        if (!st.named.has(k))
            e.log.append({ t: now(), rel: k, how: 'recovered', bytes: t.bytes, sha256: sha, prev: null, ...(mtime === null ? {} : { mtime }) });
        if (mtime !== null)
            scan.files.set(k, { size: t.bytes, mtime });
        e.present.add(k);
        out.kept.push(k);
    }
    return out;
}
/** The pinned files under the given paths whose source is gone (lstat gives ENOENT or ENOTDIR). */
function keptSourceGone(st, w, present, root) {
    let n = 0;
    for (const rel of st.byRel.keys()) {
        if (KEPT.test(rel) || w.files.has(rel) || !present.has(rel))
            continue;
        if (!w.covered.some((c) => c === '' || rel === c || rel.startsWith(`${c}/`)))
            continue;
        try {
            lstatSync(under(root, rel));
        }
        catch (err) {
            if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR')
                n++;
        }
    }
    return n;
}
/** Copies the files of the sweep's shape under the given paths into options.to, and appends what changed to
 *  <to>/PINS.log. Resolves to a refusal (nothing written), `busy` (the lock stayed held for the whole wait), or the
 *  run's coverage. Errors of one file are failures in the result; an error thrown by onStep, or a bug, is thrown on,
 *  after the lock is removed. From before it takes the lock until after it has removed it, a SIGINT, SIGTERM or SIGHUP
 *  stops it (between two files, or the wait for the lock); it then removes the lock and, when nothing else listens for
 *  that signal, raises it again. */
export async function pinPaths(paths, options) {
    const t0 = Date.now();
    const platform = options?.platform ?? process.platform;
    const p = prepare(paths, options, platform);
    if (p.k === 'refused')
        return p;
    const { to, root, givens } = p;
    const failures = [], lines = [], notices = [];
    const files = { seen: 0, new: 0, grown: 0, rewritten: 0, unchanged: 0, notCopied: 0, failed: 0 };
    const skipped = { notSessionShaped: 0, symlinks: 0, memory: 0, git: 0 };
    let partial = 0, bytesCopied = 0, kept = 0, removedTemps = 0;
    let takeover = null;
    const stop = { signal: null }; // set by a signal listener, read between files and during the lock's wait
    const done = () => {
        files.seen = files.new + files.grown + files.rewritten + files.unchanged + files.notCopied + files.failed;
        return { k: 'pinned', coverage: { root, to, files, failures: failures.length, partial, skipped, bytesCopied, keptSourceGone: kept, lastLog: lastLog(), ms: Date.now() - t0 },
            failures, lines, takeover, removedTemps, notices, interrupted: stop.signal };
    };
    let state = null;
    const lastLog = () => state?.lastT ?? null;
    try {
        mkdirSync(to, { recursive: true, mode: DIR_MODE });
    }
    catch (err) {
        failures.push({ path: to, rel: null, op: 'to', code: codeOf(err) });
        return done();
    }
    if (platform !== 'win32') {
        let mode = 0;
        try {
            mode = lstatSync(to).mode & 0o777;
        }
        catch { /* made a moment ago: the lock, next, reports what is wrong */ }
        // what others can do there depends on the mode: it is said as such, never that pin's files are safe from them (whoever
        // can write into the directory can put a file of their own at PINS.log's name)
        if (mode & 0o077)
            notices.push(`the pin directory '${to}' is open to other users (mode ${mode.toString(8).padStart(4, '0')}): those its mode lets read it can list the names in it, and those it lets write into it can replace pin's files with their own. To close it: chmod 700 ${quoted(to)}`);
    }
    const lockWait = typeof options.lockWaitMs === 'number' && options.lockWaitMs >= 0 ? options.lockWaitMs : LOCK_WAIT_MS;
    // the signal listeners come before the lock and go after it: a signal that finds no listener ends the process at
    // once, so while the lock exists, one must always be there (measured: 17 of 200 SIGTERMs sent as soon as the lock
    // appeared ended the process before the listeners came, and left the lock)
    let held = null;
    const onSignal = (sig) => { stop.signal ??= sig; };
    const onExit = () => { if (held !== null)
        release(held); };
    for (const s of SIGNALS)
        process.on(s, onSignal);
    process.on('exit', onExit);
    try {
        const got = await acquire(to, lockWait, stop);
        if (got.k === 'busy')
            return got;
        if (got.k === 'failed') {
            failures.push(got.failure);
            return done();
        }
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
            let read = null;
            try {
                read = readLog(logPath);
            }
            catch (err) {
                if (codeOf(err) !== 'ENOENT')
                    throw err;
            }
            state = read === null ? createLog(to, root, lines, platform) : parseLog(logPath, read.bytes, platform, read.ino);
        }
        catch (err) {
            if (!isFsError(err))
                throw err;
            failures.push({ path: logPath, rel: null, op: 'log', code: codeOf(err) });
            return done();
        }
        const heldNow = held, stateNow = state;
        const check = () => guard(heldNow, stateNow);
        const log = new Log(state, lines, platform, check);
        const e = { to, platform, rehash: options.rehash === true, onStep: options.onStep, log, present: new Set(scan.files.keys()), failures, linkTo: new Map(),
            guard: check, unlisted: scan.unlisted, keptAside: [], chunk: Buffer.allocUnsafe(chunkOf(options)) };
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
            if (removedTemps)
                notices.push(`removed ${removedTemps} temp ${plural(removedTemps, 'file', 'files')} left in '${to}' by a pin that did not finish, each holding what a copy or its source holds.`);
            if (temps.kept.length)
                notices.push(`${temps.kept.length} temp ${plural(temps.kept.length, 'file', 'files')} left in '${to}' by a pin that did not finish held what no copy and no source holds any more: kept as ${temps.kept.map((k) => `'${k}'`).join(', ')}, with a recovered line each.`);
            const unread = state.unreadable.length;
            if (unread)
                notices.push(`'${logPath}' has ${unread} ${plural(unread, 'line', 'lines')} that ${plural(unread, 'is not a log line', 'are not log lines')} (first: line ${state.unreadable[0]}); ${plural(unread, 'it is', 'they are')} passed over here, and a check of the pin reports ${plural(unread, 'it', 'them')}.`);
            // the walk before recovery, which leaves to this run (with rehash) a damaged copy that it writes again, and as it
            // is one under a path the walk could not read; its failures still follow recovery's
            const w = walk(givens, root);
            const recovered = recover(e, scan, w.files, w.unread);
            if (recovered)
                notices.push(`${recovered} ${plural(recovered, 'file', 'files')} in '${to}' held other bytes than ${plural(recovered, 'its', 'their')} last line in PINS.log records, or ${plural(recovered, 'was', 'were')} named by no line: a recovered line now records what each one holds.`);
            failures.push(...w.failures);
            Object.assign(skipped, w.skipped);
            let restored = 0, repaired = 0, lost = 0, k = 0;
            const rels = [...w.files.keys()].sort();
            for (const rel of rels) {
                await yieldToSignals();
                if (stop.signal !== null)
                    break;
                const o = pinOne(rel, w.files.get(rel), e);
                files[o.how]++;
                if (o.partial)
                    partial++;
                if (o.again === 'missing')
                    restored++;
                if (o.again === 'damaged')
                    repaired++;
                if (o.lost)
                    lost++;
                bytesCopied += o.bytes;
                k++;
            }
            const aside = e.keptAside.length;
            if (aside)
                notices.push(`${aside} ${plural(aside, 'copy', 'copies')} in '${to}' held bytes that no line in PINS.log records as ${plural(aside, 'its version', 'their versions')}: they are kept as ${e.keptAside.map((k) => `'${k}'`).join(', ')}, with a recovered line each, and the ${plural(aside, 'copy was', 'copies were')} then written again from ${plural(aside, 'its source', 'their sources')} (--rehash).`);
            if (restored)
                notices.push(`${restored} ${plural(restored, 'copy was', 'copies were')} missing from '${to}' and written again from ${plural(restored, 'its source', 'their sources')}, with a recovered line each.`);
            if (repaired)
                notices.push(`${repaired} ${plural(repaired, 'copy', 'copies')} in '${to}' held other bytes than ${plural(repaired, 'its', 'their')} last line in PINS.log records, and ${plural(repaired, 'was', 'were')} written again from ${plural(repaired, 'its source', 'their sources')}, which still ${plural(repaired, 'holds', 'hold')} that version (--rehash), with a recovered line each.`);
            if (lost)
                notices.push(`${lost} ${plural(lost, 'copy was', 'copies were')} missing from '${to}' while ${plural(lost, 'its source', 'their sources')} had been rewritten: the ${plural(lost, 'version its', 'versions their')} last line in PINS.log ${plural(lost, 'records is', 'record are')} lost, and a check of the pin reports ${plural(lost, 'it', 'them')} at ${plural(lost, 'that line', 'those lines')}.`);
            if (stop.signal !== null)
                notices.push(`stopped by ${stop.signal} after ${k} of ${rels.length} files; each file pinned so far is whole and has its line.`);
            kept = keptSourceGone(state, w, e.present, root);
        }
        catch (err) {
            if (err instanceof LockLost) {
                // S368: two pins at once (a lock removed by hand, a dead lock taken over twice, an old pin that took over a live
                // lock): this one stops before its next write, and the other one's lock is left
                failures.push({ path: err.path, rel: null, op: err.what, code: err.what === 'lock' ? 'lock-lost' : 'log-changed' });
                notices.push(err.what === 'lock'
                    ? `the lock '${err.path}' no longer holds what this pin wrote into it (it was removed, or another pin took it), so this pin stopped before its next write; each file it pinned before is whole and has its line.`
                    : `'${err.path}' changed under this pin (another process wrote to it, or put another file at its name), so this pin stopped before its next write; each file it pinned before is whole and has its line.`);
            }
            else {
                if (!(err instanceof LogWriteError))
                    throw err;
                failures.push({ path: logPath, rel: null, op: 'log', code: codeOf(err.reason) });
                notices.push(`'${logPath}' could not be written (${codeOf(err.reason)}), so the pin stopped there; the next pin records what this one left without a line.`);
            }
        }
        finally {
            log.close();
        }
        return done();
    }
    finally {
        // the lock goes before the listeners: a signal from here on finds either a listener or no lock
        if (held !== null)
            release(held);
        for (const s of SIGNALS)
            process.removeListener(s, onSignal);
        process.removeListener('exit', onExit);
        if (stop.signal !== null && process.listenerCount(stop.signal) === 0)
            process.kill(process.pid, stop.signal);
    }
}
// ---- checkPin ----------------------------------------------------------------------------------------------------
/** One pass over a file: the sha256 of its first n bytes at each n asked for (Hash.copy() at each), and of the whole.
 *  null when it cannot be read, or is not a regular file (openRegular: a FIFO is never waited on). */
function digestsAt(path, lengths) {
    let fd;
    try {
        fd = openRegular(path, fsConstants.O_RDONLY);
    }
    catch {
        return null;
    }
    try {
        const marks = [...new Set(lengths)].sort((a, b) => a - b);
        const h = createHash('sha256'), at = new Map(), chunk = Buffer.allocUnsafe(1 << 20);
        let pos = 0, m = 0;
        for (; m < marks.length && marks[m] === 0; m++)
            at.set(0, h.copy().digest('hex'));
        for (;;) {
            const n = readSync(fd, chunk, 0, m < marks.length ? Math.min(chunk.length, marks[m] - pos) : chunk.length, pos);
            if (n === 0)
                break;
            h.update(chunk.subarray(0, n));
            pos += n;
            for (; m < marks.length && marks[m] === pos; m++)
                at.set(pos, h.copy().digest('hex'));
        }
        return { size: pos, whole: h.digest('hex'), at };
    }
    catch {
        return null;
    }
    finally {
        closeSync(fd);
    }
}
/** Whether the file at `copy` is a byte prefix of the file at `src`: the sha256 of src's first bytes, as many as the copy
 *  holds, is the copy's whole sha256 (digestsAt, one pass over each). False when either cannot be read. */
function isPrefix(copy, src) {
    const c = digestsAt(copy, []);
    if (c === null)
        return false;
    const s = digestsAt(src, [c.size]);
    return s !== null && s.at.get(c.size) === c.whole;
}
/** Whether a file holds a new line at or after byte `from`, read in chunks up to the first one: a .jsonl without one past
 *  its copy's length has nothing whole that a pin would copy (nor, from 0, does one without any). A file that cannot be
 *  read counts as holding one. */
function holdsNewLine(path, from = 0) {
    let fd;
    try {
        fd = openRegular(path, fsConstants.O_RDONLY);
    }
    catch {
        return true;
    }
    try {
        const chunk = Buffer.allocUnsafe(65536);
        for (let pos = from;;) {
            const n = readSync(fd, chunk, 0, chunk.length, pos);
            if (n === 0)
                return false;
            if (chunk.subarray(0, n).includes(0x0a))
                return true;
            pos += n;
        }
    }
    catch {
        return true;
    }
    finally {
        closeSync(fd);
    }
}
/** Checks a pin against its own log, and its sources against the pin: every file line against the copy that holds its
 *  version (the current file, or the kept copy the first later line for that rel names), one pass per copy; the chain
 *  of the lines; and the staleness (sources under the root missing from the pin, or longer than their copy). A lock held
 *  by a running pin is waited for first, as a pin waits for it: a file that pin is writing would read as damage.
 *  Writes nothing. */
export async function checkPin(dir, options = {}) {
    const t0 = Date.now();
    const platform = options?.platform ?? process.platform;
    const d = realOrNearest(dir);
    const lockWait = typeof options?.lockWaitMs === 'number' && options.lockWaitMs >= 0 ? options.lockWaitMs : LOCK_WAIT_MS;
    for (const lockPath = join(d, LOCK);;) {
        // no lock, or none that can be read as one (not a regular file: never waited on, and a notice below): nothing runs
        let raw;
        try {
            raw = readRegular(lockPath).toString('utf8');
        }
        catch {
            break;
        }
        const holder = holderIn(raw);
        const seen = lockSeen(lockPath, holder);
        if (seen === 'dead')
            break; // a pin that stopped without removing it: reported below
        const waited = Date.now() - t0;
        if (waited >= lockWait)
            return busy(lockPath, holder, seen, waited);
        await sleep(Math.min(LOCK_POLL_MS, lockWait - waited));
    }
    let log;
    try {
        log = readLog(join(d, LOG));
    }
    catch (e) {
        const why = codeOf(e) === 'ENOENT' ? 'holds no PINS.log'
            : e instanceof NotRegularFile ? `has a PINS.log that ${e.link ? 'is a symbolic link' : `is not a regular file (it is ${e.kind})`}`
                : `has a PINS.log that cannot be read (${codeOf(e)})`;
        return refuse('not-a-pin', `${shown(dir, d)} ${why}, so it is not a pin this check can read.`);
    }
    const st = parseLog(join(d, LOG), log.bytes, platform);
    const notices = [];
    // a pin refuses a log that has another name (prepare), so none runs here until it is the only one: this notice says so
    // once, and no other says what a next pin would do
    const pinRuns = log.names <= 1;
    if (!pinRuns)
        notices.push(`'${join(d, LOG)}' has ${log.names} names (hard links to one file): a pin refuses a log that has another name, so every pin into '${d}' is refused until only one name is left. Find its other names: find / -samefile ${quoted(join(d, LOG))} 2>/dev/null`);
    if (st.root === null)
        notices.push(`line 1 of '${join(d, LOG)}' is not the line that records the root, so which root the copies are measured from is not known${options?.root === undefined ? '; give the root to measure the staleness' : ''}.`);
    const chainBreaks = [];
    st.parsed.forEach((l, i) => {
        if (l === null)
            return;
        const want = i === 0 ? null : sha256(st.raw[i - 1]);
        if (l.chain !== want)
            chainBreaks.push({ line: i + 1, want, got: l.chain });
    });
    // each file line, against the copy that holds its version
    const fileLines = [];
    st.parsed.forEach((l, i) => { if (l !== null && l.rel !== undefined && FILE_HOWS.has(l.how))
        fileLines.push({ line: i + 1, l }); });
    const holder = new Array(fileLines.length);
    const laterKept = new Map();
    for (let j = fileLines.length - 1; j >= 0; j--) {
        const { l } = fileLines[j];
        holder[j] = laterKept.get(l.rel) ?? l.rel;
        if (l.kept !== undefined)
            laterKept.set(l.rel, l.kept);
    }
    const groups = new Map();
    fileLines.forEach(({ line, l }, j) => {
        const g = groups.get(holder[j]) ?? [];
        g.push({ line, rel: l.rel, want: { bytes: l.bytes, sha256: l.sha256 } });
        groups.set(holder[j], g);
    });
    const mismatches = [];
    let files = 0;
    for (const [h, vs] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        await yieldToSignals();
        const got = digestsAt(under(d, h), vs.map((v) => v.want.bytes));
        if (got !== null)
            files++;
        const newest = vs[vs.length - 1]; // the latest line held by this copy: the copy must be exactly that version
        for (const v of vs) {
            let g;
            if (got === null)
                g = null;
            else if (v.want.bytes > got.size)
                g = { bytes: got.size, sha256: got.whole };
            else if (got.at.get(v.want.bytes) !== v.want.sha256)
                g = { bytes: v.want.bytes, sha256: got.at.get(v.want.bytes) };
            else if (v === newest && got.size !== v.want.bytes)
                g = { bytes: got.size, sha256: got.whole };
            else
                continue;
            mismatches.push({ rel: v.rel, copy: h, line: v.line, want: v.want, got: g });
        }
    }
    mismatches.sort((a, b) => a.line - b.line);
    const scan = scanPin(d);
    const unlogged = [...scan.files.keys()].filter((r) => !st.named.has(r) && scan.shaped(r)).sort();
    const unreadableLines = st.torn === null ? st.unreadable : [...st.unreadable, st.lines + 1];
    if (st.torn !== null)
        notices.push(`'${join(d, LOG)}' does not end in a new line: line ${st.lines + 1} is cut short${pinRuns ? '; the next pin closes it with a recovered line' : ''}.`);
    let lock = null;
    try {
        const raw = readRegular(join(d, LOCK)).toString('utf8');
        lock = holderIn(raw);
        if (lock === null)
            notices.push(`'${join(d, LOCK)}' exists, and does not hold a pin's lock (a pid, a host and a start time).`);
        // the wait at the start leaves one window: a pin that took the lock after it
        else if (lockLive(join(d, LOCK), lock))
            notices.push(`a pin took the lock '${join(d, LOCK)}' while this check ran (pid ${lock.pid} on ${lock.host}, since ${lock.started}): a copy it was writing can read as damage here; check again when it is done.`);
    }
    catch (e) { // no lock; or one that is not a regular file, which every pin fails at
        if (e instanceof NotRegularFile)
            notices.push(`'${join(d, LOCK)}' ${e.link ? 'is a symbolic link' : `is not a regular file (it is ${e.kind})`}, so it is not read as a pin's lock${pinRuns ? '; a pin fails at it (not-a-regular-file) until it is gone' : ''}. See what it is: ls -l ${quoted(join(d, LOCK))}`);
    }
    let staleness = null;
    const rootGiven = options?.root ?? st.root?.root;
    if (rootGiven !== undefined) {
        const root = realOrNearest(rootGiven);
        const w = walk([{ given: rootGiven, resolved: resolve(rootGiven), real: root }], root);
        let missing = 0, longer = 0, unfinished = 0, tooLarge = 0;
        for (const [rel, abs] of w.files) {
            try {
                if (lstatSync(abs).size > PIN_MAX_BYTES)
                    tooLarge++;
            }
            catch { /* gone since the walk */ }
            const copy = scan.files.get(rel);
            // a .jsonl with no new line yet is not copied by a pin (notCopied), so it is not missing from the pin
            if (copy === undefined) {
                if (!rel.endsWith('.jsonl') || holdsNewLine(abs))
                    missing++;
                continue;
            }
            let size;
            try {
                size = lstatSync(abs).size;
            }
            catch {
                continue;
            } // gone since the walk
            if (size <= copy.size)
                continue;
            // a .jsonl is copied up to its last new line: one whose copy is a byte prefix of it, with no new line past the
            // copy's length, is longer only by a line not yet finished, which a pin does not copy, so the pin is not behind it.
            // One rewritten under such a line is not: its copy is no prefix of it, and the next pin rewrites it
            if (rel.endsWith('.jsonl') && !holdsNewLine(abs, copy.size) && isPrefix(under(d, rel), abs))
                unfinished++;
            else
                longer++;
        }
        const pinnedProjects = new Set([...st.named].map((r) => r.split('/')[0]));
        const projectsNotPinned = [...w.projects].filter((pr) => !pinnedProjects.has(pr)).length;
        staleness = { root, fromLog: options?.root === undefined, sources: w.files.size, missing, longer, unfinished, projectsNotPinned, failed: w.failures.length, tooLarge };
    }
    return { k: 'checked', dir: d, root: st.root?.root ?? null, lines: st.lines, logNames: log.names, versions: fileLines.length, files, mismatches,
        chainBreaks, unreadableLines, unlogged, temps: scan.temps.filter((a) => !st.named.has(relative(d, a).split(sep).join('/'))).length, lastLog: st.lastT, staleness, lock, notices, ms: Date.now() - t0 };
}
