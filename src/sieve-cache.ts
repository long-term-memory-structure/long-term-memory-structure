// ============================================================================
//  sieve-cache.ts: the sieves `ltms search` keeps between searches (search.ts, section 10), on disk.
//
//  One file per transcript, named by a hash of its device and inode, in $XDG_CACHE_HOME/ltms/sieves (an absolute
//  XDG_CACHE_HOME; else ~/.cache/ltms/sieves). A sieve is used only for the file it was built from, unchanged: its
//  key is the device, inode, size, modification time and status-change time (in nanoseconds), and the ltms version
//  and sieve format that built it; any difference, or any error reading it, and the transcript is read instead. It is
//  written only when the file did not change while it was read (the same key before and after, and as many bytes as
//  its size). It holds bits and counts, no text. The directories are made mode 0700 and the files 0600, and the cache
//  is used only when the ltms and sieves directories are this user's, and no one else can write to them: a sieve
//  someone else wrote could hide a file's hits.
// ============================================================================

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { SEARCH_SIEVE_FORMAT, SEARCH_SIEVE_ASCII_GRAMS, SEARCH_KINDS } from './search.js';
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

const MAGIC = 'ltms-sieve 1\n';

/** The directory, or why there is none: XDG_CACHE_HOME when it is an absolute path, else the home directory's .cache. */
export function sieveCacheDir(): { dir: string; base: string } | { why: string } {
  const x = process.env.XDG_CACHE_HOME;
  let base: string;
  if (x && isAbsolute(x)) base = x;
  else {
    let h = '';
    try { h = homedir(); } catch { /* none */ }
    if (!h) return { why: 'no home directory is known and XDG_CACHE_HOME is not an absolute path' };
    base = join(h, '.cache');
  }
  return { dir: join(base, 'ltms', 'sieves'), base };
}

/** A key for a file as it stands: its identity and its size and times. */
export function sieveKey(st: BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

export class SieveCache {
  readonly dir: string;
  private readonly version: string;
  /** The first error writing a sieve, if any (the search goes on without it). */
  writeError: string | null = null;
  constructor(dir: string, version: string) { this.dir = dir; this.version = version; }

  private nameOf(st: BigIntStats): string {
    return join(this.dir, createHash('sha256').update(`${st.dev}:${st.ino}`).digest('hex').slice(0, 32) + '.sieve');
  }

  /** The sieve kept for this file as it stands (st), or null: none, another key, version or format, or unreadable. */
  read(st: BigIntStats): CachedSieve | null {
    let raw: Buffer;
    try { raw = inflateRawSync(readFileSync(this.nameOf(st))); } catch { return null; }
    try {
      if (raw.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) return null;
      const nl = raw.indexOf(10, MAGIC.length);
      if (nl < 0) return null;
      const h = JSON.parse(raw.subarray(MAGIC.length, nl).toString('utf8'));
      if (h.key !== sieveKey(st) || h.ltms !== this.version || h.sieve?.format !== SEARCH_SIEVE_FORMAT) return null;
      const asciiBytes = (SEARCH_SIEVE_ASCII_GRAMS * SEARCH_KINDS.length) / 8;
      const lens = [h.words.m / 8, asciiBytes, h.grams.m / 8];
      if (nl + 1 + lens[0] + lens[1] + lens[2] !== raw.length) return null;
      let at = nl + 1;
      const take = (n: number): Uint8Array => { const b = new Uint8Array(raw.buffer, raw.byteOffset + at, n); at += n; return b; };
      const words: SearchBloom = { m: h.words.m, k: h.words.k, bits: take(lens[0]) };
      const ascii = take(lens[1]);
      const grams: SearchBloom = { m: h.grams.m, k: h.grams.k, bits: take(lens[2]) };
      return { sieve: { ...h.sieve, words, ascii, grams }, flags: h.flags };
    } catch { return null; }
  }

  /** Keep a file's sieve, under the key it was read with: a new file renamed over the old one. */
  write(st: BigIntStats, sieve: SearchSieve, flags: SieveFlags): void {
    const { words, ascii, grams, ...rest } = sieve;
    const head = JSON.stringify({ key: sieveKey(st), ltms: this.version, sieve: rest, words: { m: words.m, k: words.k }, grams: { m: grams.m, k: grams.k }, flags });
    const body = deflateRawSync(Buffer.concat([Buffer.from(MAGIC + head + '\n', 'utf8'), words.bits, ascii, grams.bits]));
    const name = this.nameOf(st), tmp = `${name}.${process.pid}.${Date.now()}.tmp`;
    let fd = -1;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      for (let off = 0; off < body.length;) off += writeSync(fd, body, off);
      fsyncSync(fd);
      closeSync(fd); fd = -1;
      renameSync(tmp, name);
    } catch (e) {
      if (fd >= 0) try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(tmp); } catch { /* not made */ }
      this.writeError ??= String((e as Error)?.message ?? e);
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
