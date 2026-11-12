// ============================================================================
//  sieve-cache.ts: the sieves `ltms search` keeps between searches (search.ts, section 10), on disk.
//
//  One file per transcript, named by a hash of its device and inode, in $XDG_CACHE_HOME/ltms/sieves (an absolute
//  XDG_CACHE_HOME; else ~/.cache/ltms/sieves, under an absolute home). A sieve is used only for the file it was built
//  from, unchanged, and only by the runtime that built it: its key is the device, inode, size, modification time and
//  status-change time (in nanoseconds), the ltms version and sieve format that built it, the runtime's reading of text
//  (searchRuntime()) and the files that runtime reads text with (runtimeFiles()); any difference, or any error reading
//  it, and the transcript is read instead. Its bytes on disk are sealed by their sha256, so a sieve damaged there is
//  passed over. It is written only when the file did not change while it was read (the same key before and after, and
//  as many bytes as its size). It holds bits and counts and no text as written, not even the transcript's last
//  timestamp; but its bits tell whether a word or a run of up to 3 code units is in the file, by kind, and short ASCII
//  text can be pieced back from its exact gram bits: it is as private as the transcript. The directories are made mode
//  0700 and the files 0600, and the cache is used only when the ltms and sieves directories are this user's, and no one
//  else can write to them: a sieve someone else wrote could hide a file's hits.
// ============================================================================
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { SEARCH_SIEVE_FORMAT, SEARCH_SIEVE_ASCII_GRAMS, SEARCH_KINDS, searchRuntime } from './search.js';
/** A sieve file: this, the sha256 (64 hex digits) of the bytes after its line, and a new line; then those bytes, the
 *  raw deflate of the head (one line of JSON) and of the bits of the two filters and of the ASCII grams. The seal is
 *  checked before anything is inflated. */
const MAGIC = 'ltms-sieve 2 ';
/** The most a sieve may inflate to: two filters of 2^32 bits and the head. */
const MAX_INFLATED = 2 ** 30 + 2 ** 20;
/** The names of the cache's own files: a sieve, and a temp file (a sieve's name, the writer's pid and time, random hex;
 *  without the hex before S367). Nothing of another name is ever removed (S366 review B7). */
const SIEVE_NAME = /^[0-9a-f]{32}\.sieve$/;
const TEMP_NAME = /^[0-9a-f]{32}\.sieve\.\d+\.\d+(?:\.[0-9a-f]{12})?\.tmp$/;
/** A sieve is removed this long after it was kept (a file still searched gets a new one; one whose file is gone, no
 *  longer answers for it); a temp file this long after it was made (a write takes milliseconds: the search stopped). */
const SIEVE_DAYS = 30, SIEVE_MAX_AGE_MS = SIEVE_DAYS * 86400e3, TEMP_MAX_AGE_MS = 10 * 60e3;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
let filesId = null;
/** The files this runtime reads text with, as a sha256 (32 hex digits): its executable, the ICU libraries it has
 *  loaded (process.report's shared objects, else /proc/self/maps), and NODE_ICU_DATA and ICU_DATA when set, each file
 *  by its path, size, modification time and inode. An upgrade of any of them makes every kept sieve be read again and
 *  rebuilt; searchRuntime() reads what the files do, this which files they are. Computed once. */
export function runtimeFiles() {
    if (filesId !== null)
        return filesId;
    const paths = new Set();
    if (process.execPath)
        paths.add(process.execPath);
    let libs = [];
    try {
        const so = process.report?.getReport?.()?.sharedObjects;
        if (Array.isArray(so))
            libs = so.filter((x) => typeof x === 'string');
    }
    catch { /* no report */ }
    if (!libs.length) {
        try {
            libs = readFileSync('/proc/self/maps', 'utf8').split('\n').map((l) => l.replace(/^(?:\S+\s+){5}/, '')).filter((x) => x.startsWith('/'));
        }
        catch { /* not Linux */ }
    }
    for (const x of libs)
        if (/icu/i.test(basename(x)))
            paths.add(x);
    const env = [];
    for (const k of ['NODE_ICU_DATA', 'ICU_DATA']) {
        const v = process.env[k];
        if (v === undefined)
            continue;
        env.push(`${k}=${v}`);
        for (const x of v.split(process.platform === 'win32' ? ';' : ':'))
            if (x)
                paths.add(x);
    }
    const lines = [...paths].sort().map((x) => {
        try {
            const st = statSync(x, { bigint: true });
            return `${x}\t${st.size}\t${st.mtimeNs}\t${st.ino}`;
        }
        catch {
            return `${x}\t-`;
        }
    });
    filesId = createHash('sha256').update([...lines, ...env].join('\n')).digest('hex').slice(0, 32);
    return filesId;
}
/** The directory, or why there is none: XDG_CACHE_HOME when it is an absolute path, else the home directory's .cache. */
export function sieveCacheDir() {
    const x = process.env.XDG_CACHE_HOME;
    let base;
    if (x && isAbsolute(x))
        base = x;
    else {
        let h = '';
        try {
            h = homedir();
        }
        catch { /* none */ }
        if (!h)
            return { why: 'no home directory is known and XDG_CACHE_HOME is not an absolute path' };
        // a relative home would put the sieves under the current directory, wherever the command runs (S366 review B8)
        if (!isAbsolute(h))
            return { why: `the home directory ${JSON.stringify(h.slice(0, 80))} is not an absolute path, and XDG_CACHE_HOME is not set to one` };
        base = join(h, '.cache');
    }
    return { dir: join(base, 'ltms', 'sieves'), base };
}
/** A key for a file as it stands: its identity and its size and times. */
export function sieveKey(st) {
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}
/** A filter's shape as a head gives it: m a whole number of bytes, at least 64 bits and at most 2^32 (the probes are
 *  taken modulo m from 32 bits), and 1 to 32 probes. Any other (m 0 would read every probe as an empty bit) is refused. */
const filterShape = (f) => !!f && Number.isInteger(f.m) && f.m >= 64 && f.m % 8 === 0 && f.m <= 2 ** 32 && Number.isInteger(f.k) && f.k >= 1 && f.k <= 32;
export class SieveCache {
    dir;
    version;
    uid;
    /** The first error writing a sieve, if any (the search goes on without it). */
    writeError = null;
    /** The files prune() removed. */
    removed = 0;
    constructor(dir, version, uid = typeof process.getuid === 'function' ? process.getuid() : null) {
        this.dir = dir;
        this.version = version;
        this.uid = uid;
    }
    /** Sieves kept more than SIEVE_DAYS ago and temp files older than TEMP_MAX_AGE_MS removed, by their names only. */
    prune(now) {
        let names;
        try {
            names = readdirSync(this.dir);
        }
        catch {
            return;
        }
        for (const n of names) {
            const max = SIEVE_NAME.test(n) ? SIEVE_MAX_AGE_MS : TEMP_NAME.test(n) ? TEMP_MAX_AGE_MS : -1;
            if (max < 0)
                continue;
            try {
                if (now - lstatSync(join(this.dir, n)).mtimeMs > max) {
                    unlinkSync(join(this.dir, n));
                    this.removed++;
                }
            }
            catch { /* gone */ }
        }
    }
    nameOf(st) {
        return join(this.dir, createHash('sha256').update(`${st.dev}:${st.ino}`).digest('hex').slice(0, 32) + '.sieve');
    }
    /** The sieve kept for this file as it stands (st), or null: none, another key, version, format or runtime, damaged,
     *  or unreadable. */
    read(st) {
        // opened without following a link, and used only when it is one regular file with one name, this user's, that no one
        // else can write to (S366 review B3): whoever could put a file there could hide a file's hits
        let file, body, fd = -1;
        try {
            fd = openSync(this.nameOf(st), constants.O_RDONLY | O_NOFOLLOW);
            const s = fstatSync(fd);
            if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o022) || (this.uid !== null && s.uid !== this.uid))
                return null;
            file = readFileSync(fd);
        }
        catch {
            return null;
        }
        finally {
            if (fd >= 0)
                try {
                    closeSync(fd);
                }
                catch { /* closed */ }
        }
        const top = MAGIC.length + 65;
        if (file.length <= top || file.subarray(0, MAGIC.length).toString('latin1') !== MAGIC || file[top - 1] !== 10)
            return null;
        const z = file.subarray(top);
        if (createHash('sha256').update(z).digest('hex') !== file.subarray(MAGIC.length, top - 1).toString('latin1'))
            return null;
        try {
            body = inflateRawSync(z, { maxOutputLength: MAX_INFLATED });
        }
        catch {
            return null;
        }
        try {
            const nl = body.indexOf(10);
            if (nl < 0)
                return null;
            const h = JSON.parse(body.subarray(0, nl).toString('utf8'));
            if (h.key !== sieveKey(st) || h.ltms !== this.version || h.sieve?.format !== SEARCH_SIEVE_FORMAT)
                return null;
            if (h.sieve.runtime !== searchRuntime() || h.files !== runtimeFiles())
                return null;
            if (!filterShape(h.words) || !filterShape(h.grams))
                return null;
            const asciiBytes = (SEARCH_SIEVE_ASCII_GRAMS * SEARCH_KINDS.length) / 8;
            const lens = [h.words.m / 8, asciiBytes, h.grams.m / 8];
            if (nl + 1 + lens[0] + lens[1] + lens[2] !== body.length)
                return null;
            let at = nl + 1;
            const take = (n) => { const b = new Uint8Array(body.buffer, body.byteOffset + at, n); at += n; return b; };
            const words = { m: h.words.m, k: h.words.k, bits: take(lens[0]) };
            const ascii = take(lens[1]);
            const grams = { m: h.grams.m, k: h.grams.k, bits: take(lens[2]) };
            return { sieve: { ...h.sieve, words, ascii, grams }, flags: h.flags };
        }
        catch {
            return null;
        }
    }
    /** Keep a file's sieve, under the key it was read with: a new file renamed over the old one. True when it was
     *  written. It is not fsynced: a sieve cut short by a crash fails its seal and is read as none (S366 review B4). */
    write(st, sieve, flags) {
        const { words, ascii, grams, ...rest } = sieve;
        // last, the transcript's own timestamp string, is not kept: the command never uses it for a file answered from its
        // sieve (only files with hits are ordered by it), and a cache holds no string of the transcript (S366 review B6)
        const head = JSON.stringify({ key: sieveKey(st), ltms: this.version, files: runtimeFiles(), sieve: { ...rest, last: null }, words: { m: words.m, k: words.k }, grams: { m: grams.m, k: grams.k }, flags });
        const z = deflateRawSync(Buffer.concat([Buffer.from(head + '\n', 'utf8'), words.bits, ascii, grams.bits]));
        const sealed = Buffer.concat([Buffer.from(MAGIC + createHash('sha256').update(z).digest('hex') + '\n', 'latin1'), z]);
        // a name no other writer takes (random hex), and removed on failure only when this call made it (S366 review B11)
        const name = this.nameOf(st), tmp = `${name}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
        let fd = -1, made = false;
        try {
            fd = openSync(tmp, 'wx', 0o600);
            made = true;
            for (let off = 0; off < sealed.length;)
                off += writeSync(fd, sealed, off);
            closeSync(fd);
            fd = -1;
            renameSync(tmp, name);
            return true;
        }
        catch (e) {
            if (fd >= 0)
                try {
                    closeSync(fd);
                }
                catch { /* already closed */ }
            if (made)
                try {
                    unlinkSync(tmp);
                }
                catch { /* gone */ }
            this.writeError ??= String(e?.message ?? e);
            return false;
        }
    }
}
/** The cache, made if it is missing, or why it is not used. */
export function openSieveCache(version) {
    // Windows reports a file's mode as 0o666 or 0o444 whoever can write to it: the checks below would mean nothing there
    if (process.platform === 'win32')
        return { why: 'sieves are not kept on Windows, where a file\'s mode does not say who can write to it' };
    const d = sieveCacheDir();
    if ('why' in d)
        return d;
    const ltms = join(d.base, 'ltms');
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    // the base itself, resolved: this user's or root's, and writable by no one else unless it is root's with the sticky bit
    // (/tmp): whoever can write to it could rename ltms/ and put sieves of their own in its place (S366 review B3)
    try {
        mkdirSync(d.base, { recursive: true, mode: 0o700 });
        const real = realpathSync(d.base), b = statSync(real);
        if (uid !== null && b.uid !== uid && b.uid !== 0)
            return { why: `${d.base} belongs to another user (uid ${b.uid})` };
        if ((b.mode & 0o022) && !(b.uid === 0 && b.mode & 0o1000))
            return { why: `others can write to ${d.base} (mode ${(b.mode & 0o7777).toString(8)})` };
    }
    catch (e) {
        return { why: `${d.base} could not be read (${e?.message ?? e})` };
    }
    try {
        mkdirSync(d.dir, { recursive: true, mode: 0o700 });
    }
    catch (e) {
        return { why: `${d.dir} could not be made (${e?.message ?? e})` };
    }
    for (const p of [ltms, d.dir]) {
        let st;
        try {
            st = lstatSync(p);
        }
        catch (e) {
            return { why: `${p} could not be read (${e?.message ?? e})` };
        }
        if (!st.isDirectory())
            return { why: `${p} is not a directory${st.isSymbolicLink() ? ' (a symbolic link)' : ''}` };
        if (uid !== null && st.uid !== uid)
            return { why: `${p} belongs to another user (uid ${st.uid})` };
        if (st.mode & 0o022)
            return { why: `others can write to ${p} (mode ${(st.mode & 0o777).toString(8)})` };
    }
    const cache = new SieveCache(d.dir, version, uid);
    cache.prune(Date.now());
    return cache;
}
