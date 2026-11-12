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

import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { SEARCH_SIEVE_FORMAT, SEARCH_SIEVE_ASCII_GRAMS, SEARCH_KINDS, searchRuntime } from './search.js';
import type { SearchBloom, SearchSieve } from './search.js';

/** What the CLI needs of a file beyond its search counts, kept with its sieve. */
export interface SieveFlags {
  /** Lines that could not be read (the parser's problems). */
  problems: boolean;
  /** Records on a parentUuid cycle. */
  cycle: boolean;
  /** Responses read from parent links (the parser's requestKeyGuessed). */
  guessed: boolean;
}
export interface CachedSieve { sieve: SearchSieve; flags: SieveFlags }

/** A sieve file: this, the sha256 (64 hex digits) of the bytes after its line, and a new line; then those bytes, the
 *  raw deflate of the head (one line of JSON) and of the bits of the two filters and of the ASCII grams. The seal is
 *  checked before anything is inflated. */
const MAGIC = 'ltms-sieve 2 ';
/** The most a sieve may inflate to: two filters of 2^32 bits and the head. */
const MAX_INFLATED = 2 ** 30 + 2 ** 20;

let filesId: string | null = null;
/** The files this runtime reads text with, as a sha256 (32 hex digits): its executable, the ICU libraries it has
 *  loaded (process.report's shared objects, else /proc/self/maps), and NODE_ICU_DATA and ICU_DATA when set, each file
 *  by its path, size, modification time and inode. An upgrade of any of them makes every kept sieve be read again and
 *  rebuilt; searchRuntime() reads what the files do, this which files they are. Computed once. */
export function runtimeFiles(): string {
  if (filesId !== null) return filesId;
  const paths = new Set<string>();
  if (process.execPath) paths.add(process.execPath);
  let libs: string[] = [];
  try {
    const so = (process as any).report?.getReport?.()?.sharedObjects;
    if (Array.isArray(so)) libs = so.filter((x: unknown): x is string => typeof x === 'string');
  } catch { /* no report */ }
  if (!libs.length) {
    try { libs = readFileSync('/proc/self/maps', 'utf8').split('\n').map((l) => l.replace(/^(?:\S+\s+){5}/, '')).filter((x) => x.startsWith('/')); } catch { /* not Linux */ }
  }
  for (const x of libs) if (/icu/i.test(basename(x))) paths.add(x);
  const env: string[] = [];
  for (const k of ['NODE_ICU_DATA', 'ICU_DATA']) {
    const v = process.env[k];
    if (v === undefined) continue;
    env.push(`${k}=${v}`);
    for (const x of v.split(process.platform === 'win32' ? ';' : ':')) if (x) paths.add(x);
  }
  const lines = [...paths].sort().map((x) => {
    try { const st = statSync(x, { bigint: true }); return `${x}\t${st.size}\t${st.mtimeNs}\t${st.ino}`; } catch { return `${x}\t-`; }
  });
  filesId = createHash('sha256').update([...lines, ...env].join('\n')).digest('hex').slice(0, 32);
  return filesId;
}

/** The directory, or why there is none: XDG_CACHE_HOME when it is an absolute path, else the home directory's .cache. */
export function sieveCacheDir(): { dir: string; base: string } | { why: string } {
  const x = process.env.XDG_CACHE_HOME;
  let base: string;
  if (x && isAbsolute(x)) base = x;
  else {
    let h = '';
    try { h = homedir(); } catch { /* none */ }
    if (!h) return { why: 'no home directory is known and XDG_CACHE_HOME is not an absolute path' };
    // a relative home would put the sieves under the current directory, wherever the command runs (S366 review B8)
    if (!isAbsolute(h)) return { why: `the home directory ${JSON.stringify(h.slice(0, 80))} is not an absolute path, and XDG_CACHE_HOME is not set to one` };
    base = join(h, '.cache');
  }
  return { dir: join(base, 'ltms', 'sieves'), base };
}

/** A key for a file as it stands: its identity and its size and times. */
export function sieveKey(st: BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/** A filter's shape as a head gives it: m a whole number of bytes, at least 64 bits and at most 2^32 (the probes are
 *  taken modulo m from 32 bits), and 1 to 32 probes. Any other (m 0 would read every probe as an empty bit) is refused. */
const filterShape = (f: any): boolean =>
  !!f && Number.isInteger(f.m) && f.m >= 64 && f.m % 8 === 0 && f.m <= 2 ** 32 && Number.isInteger(f.k) && f.k >= 1 && f.k <= 32;

export class SieveCache {
  readonly dir: string;
  private readonly version: string;
  /** The first error writing a sieve, if any (the search goes on without it). */
  writeError: string | null = null;
  constructor(dir: string, version: string) { this.dir = dir; this.version = version; }

  private nameOf(st: BigIntStats): string {
    return join(this.dir, createHash('sha256').update(`${st.dev}:${st.ino}`).digest('hex').slice(0, 32) + '.sieve');
  }

  /** The sieve kept for this file as it stands (st), or null: none, another key, version, format or runtime, damaged,
   *  or unreadable. */
  read(st: BigIntStats): CachedSieve | null {
    let file: Buffer, body: Buffer;
    try { file = readFileSync(this.nameOf(st)); } catch { return null; }
    const top = MAGIC.length + 65;
    if (file.length <= top || file.subarray(0, MAGIC.length).toString('latin1') !== MAGIC || file[top - 1] !== 10) return null;
    const z = file.subarray(top);
    if (createHash('sha256').update(z).digest('hex') !== file.subarray(MAGIC.length, top - 1).toString('latin1')) return null;
    try { body = inflateRawSync(z, { maxOutputLength: MAX_INFLATED }); } catch { return null; }
    try {
      const nl = body.indexOf(10);
      if (nl < 0) return null;
      const h = JSON.parse(body.subarray(0, nl).toString('utf8'));
      if (h.key !== sieveKey(st) || h.ltms !== this.version || h.sieve?.format !== SEARCH_SIEVE_FORMAT) return null;
      if (h.sieve.runtime !== searchRuntime() || h.files !== runtimeFiles()) return null;
      if (!filterShape(h.words) || !filterShape(h.grams)) return null;
      const asciiBytes = (SEARCH_SIEVE_ASCII_GRAMS * SEARCH_KINDS.length) / 8;
      const lens = [h.words.m / 8, asciiBytes, h.grams.m / 8];
      if (nl + 1 + lens[0] + lens[1] + lens[2] !== body.length) return null;
      let at = nl + 1;
      const take = (n: number): Uint8Array => { const b = new Uint8Array(body.buffer, body.byteOffset + at, n); at += n; return b; };
      const words: SearchBloom = { m: h.words.m, k: h.words.k, bits: take(lens[0]) };
      const ascii = take(lens[1]);
      const grams: SearchBloom = { m: h.grams.m, k: h.grams.k, bits: take(lens[2]) };
      return { sieve: { ...h.sieve, words, ascii, grams }, flags: h.flags };
    } catch { return null; }
  }

  /** Keep a file's sieve, under the key it was read with: a new file renamed over the old one. True when it was
   *  written. It is not fsynced: a sieve cut short by a crash fails its seal and is read as none (S366 review B4). */
  write(st: BigIntStats, sieve: SearchSieve, flags: SieveFlags): boolean {
    const { words, ascii, grams, ...rest } = sieve;
    // last, the transcript's own timestamp string, is not kept: the command never uses it for a file answered from its
    // sieve (only files with hits are ordered by it), and a cache holds no string of the transcript (S366 review B6)
    const head = JSON.stringify({ key: sieveKey(st), ltms: this.version, files: runtimeFiles(), sieve: { ...rest, last: null }, words: { m: words.m, k: words.k }, grams: { m: grams.m, k: grams.k }, flags });
    const z = deflateRawSync(Buffer.concat([Buffer.from(head + '\n', 'utf8'), words.bits, ascii, grams.bits]));
    const sealed = Buffer.concat([Buffer.from(MAGIC + createHash('sha256').update(z).digest('hex') + '\n', 'latin1'), z]);
    const name = this.nameOf(st), tmp = `${name}.${process.pid}.${Date.now()}.tmp`;
    let fd = -1;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      for (let off = 0; off < sealed.length;) off += writeSync(fd, sealed, off);
      closeSync(fd); fd = -1;
      renameSync(tmp, name);
      return true;
    } catch (e) {
      if (fd >= 0) try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(tmp); } catch { /* not made */ }
      this.writeError ??= String((e as Error)?.message ?? e);
      return false;
    }
  }
}

/** The cache, made if it is missing, or why it is not used. */
export function openSieveCache(version: string): SieveCache | { why: string } {
  const d = sieveCacheDir();
  if ('why' in d) return d;
  const ltms = join(d.base, 'ltms');
  try { mkdirSync(d.dir, { recursive: true, mode: 0o700 }); } catch (e) { return { why: `${d.dir} could not be made (${(e as Error)?.message ?? e})` }; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const p of [ltms, d.dir]) {
    let st;
    try { st = lstatSync(p); } catch (e) { return { why: `${p} could not be read (${(e as Error)?.message ?? e})` }; }
    if (!st.isDirectory()) return { why: `${p} is not a directory${st.isSymbolicLink() ? ' (a symbolic link)' : ''}` };
    if (uid !== null && st.uid !== uid) return { why: `${p} belongs to another user (uid ${st.uid})` };
    if (st.mode & 0o022) return { why: `others can write to ${p} (mode ${(st.mode & 0o777).toString(8)})` };
  }
  return new SieveCache(d.dir, version);
}
