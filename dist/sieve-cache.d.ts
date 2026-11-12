import type { BigIntStats } from 'node:fs';
import type { SearchSieve } from './search.js';
/** What the CLI needs of a file beyond its search counts, kept with its sieve. */
export interface SieveFlags {
    /** Lines that could not be read (the parser's problems). */
    problems: boolean;
    /** Records on a parentUuid cycle. */
    cycle: boolean;
    /** Responses read from parent links (the parser's requestKeyGuessed). */
    guessed: boolean;
}
export interface CachedSieve {
    sieve: SearchSieve;
    flags: SieveFlags;
}
/** The files this runtime reads text with, as a sha256 (32 hex digits): its executable, the ICU libraries it has
 *  loaded (process.report's shared objects, else /proc/self/maps), and NODE_ICU_DATA and ICU_DATA when set, each file
 *  by its path, size, modification time and inode. An upgrade of any of them makes every kept sieve be read again and
 *  rebuilt; searchRuntime() reads what the files do, this which files they are. Computed once. */
export declare function runtimeFiles(): string;
/** The directory, or why there is none: XDG_CACHE_HOME when it is an absolute path, else the home directory's .cache. */
export declare function sieveCacheDir(): {
    dir: string;
    base: string;
} | {
    why: string;
};
/** A key for a file as it stands: its identity and its size and times. */
export declare function sieveKey(st: BigIntStats): string;
export declare class SieveCache {
    readonly dir: string;
    private readonly version;
    /** The first error writing a sieve, if any (the search goes on without it). */
    writeError: string | null;
    constructor(dir: string, version: string);
    private nameOf;
    /** The sieve kept for this file as it stands (st), or null: none, another key, version, format or runtime, damaged,
     *  or unreadable. */
    read(st: BigIntStats): CachedSieve | null;
    /** Keep a file's sieve, under the key it was read with: a new file renamed over the old one. True when it was
     *  written. It is not fsynced: a sieve cut short by a crash fails its seal and is read as none (S366 review B4). */
    write(st: BigIntStats, sieve: SearchSieve, flags: SieveFlags): boolean;
}
/** The cache, made if it is missing, or why it is not used. */
export declare function openSieveCache(version: string): SieveCache | {
    why: string;
};
