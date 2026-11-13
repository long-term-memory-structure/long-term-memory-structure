/** What a line of PINS.log says happened to a file: `new`, its first copy; `grown`, the old copy is a byte prefix of
 *  the new one; `rewritten`, anything else, the old copy kept first; `recovered`, a line written so that the log says
 *  what the pin holds (after a pin that stopped between a rename and its line, a file the log did not name, a copy
 *  missing from the pin and written again from its source, or a log line cut short). */
export type PinHow = 'new' | 'grown' | 'rewritten' | 'recovered';
/** One version of a file: its length in bytes, and the sha256 of those bytes (64 lower-case hex characters). */
export interface PinVersion {
    bytes: number;
    sha256: string;
}
/** What a pin's lock file holds: the process that holds it, the host it runs on, and when it took the lock (ISO); and,
 *  where the platform gives them (Linux: /proc), the host's boot id and the process's PID namespace, which tell a lock
 *  left before the last boot, and a pin that runs in another PID namespace (S368). A lock written by ltms 0.2.0 or older
 *  has neither. */
export interface PinLockHolder {
    pid: number;
    host: string;
    started: string;
    boot?: string;
    pidns?: string;
}
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
    torn?: {
        line: number;
        bytes: number;
    };
    /** the sha256 of the bytes of the line before this one (without its new line); null on the first line */
    chain: string | null;
}
/** The steps of one file's write, in order, as onStep sees them: `stat` (before the read), `read` (the source read,
 *  hashed and written to the copy's temp file as it was read; the copy not read yet), `linked` (an old copy kept),
 *  `temp-written` (the temp given its mtime, fsynced and closed), `renamed` (the temp renamed over the copy, and its
 *  directory fsynced), `logged` (the line appended and fsynced); `rename-retry` before each retry on win32. */
export type PinStep = 'stat' | 'read' | 'linked' | 'temp-written' | 'renamed' | 'logged' | 'rename-retry';
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
    /** the size of each read and write of a file's bytes, in bytes (a whole number from 1 to 2^26, 64 MiB; default 1 MiB):
     *  a pin holds at most this much of a file at once, so the memory it needs for a file's bytes does not grow with the
     *  file's size (the tests use small sizes, so that each read crosses many) */
    chunkBytes?: number;
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
export type PinRefusalReason = 'no-to' | 'no-paths' | 'to-inside-config' | 'to-inside-path' | 'to-inside-root' | 'path-inside-to' | 'path-outside-root' | 'to-not-a-directory' | 'root-differs' | 'log-unreadable' | 'to-holds-files' | 'not-a-pin';
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
    /** of the sources, those larger than a pin can address (PIN_MAX_BYTES, 2^53 - 1 bytes: a position in a file is a
     *  JavaScript number): every pin fails on each, so the pin falls behind them for good (also counted in missing or
     *  longer). Until 0.2.1 the limit was 2 GiB, since a pin read each file whole */
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
/** Claude Code's config directory, as Claude Code reads it: `$CLAUDE_CONFIG_DIR`, or `<home>/.claude` when that is unset
 *  or empty. Read at each call. The one place this rule is written: pinPaths' default, `ltms pin` and `ltms search` use
 *  it. */
export declare function claudeConfigDir(): {
    /** the directory, as the variable gives it, or `<home>/.claude` (os.homedir()) */
    path: string;
    /** `true` when $CLAUDE_CONFIG_DIR gave it */
    fromEnv: boolean;
};
/** Whether rel, a path under root ('/'-separated), is of the sweep's own shape, which pinPaths copies:
 *  `<project>/<name>.jsonl`, `<project>/<name>.jsonl.superseded-*`, or a file under `<project>/<dir>/{subagents,
 *  tool-results,workflows,mcp-tasks}/` of a session directory, one whose name is a UUID or whose name plus `.jsonl` is a
 *  regular file beside it under root (lstat). Nothing else is looked at: not whether the file rel names is there. The
 *  rule is written once: pinPaths and checkPin select by it, and `ltms pin --check` asks it before it gives the
 *  `--rehash` command. */
export declare function isSweepShaped(root: string, rel: string): boolean;
/** Whether a pin of the project directory of `rel` (a path under the root, '/'-separated, whose first segment is its
 *  project directory) walks to the file at `rel`: the walk enters no `.git` directory, at any depth, and no `memory/`
 *  directly under a project directory, so a file under one of those is pinned only when it is given by its own path.
 *  Only the names on the way are read, nothing on disk: whether the file is there, of the sweep's shape
 *  (isSweepShaped), or reached through a symbolic link (which the walk does not follow) is not looked at. The walk's
 *  rule is written once: `ltms pin --check` asks it to name, in the `--rehash` command it gives, a copy's project
 *  directory, or the file itself. */
export declare function projectPinReaches(rel: string): boolean;
/** Copies the files of the sweep's shape under the given paths into options.to, and appends what changed to
 *  <to>/PINS.log. Resolves to a refusal (nothing written), `busy` (the lock stayed held for the whole wait), or the
 *  run's coverage. Errors of one file are failures in the result; an error thrown by onStep, or a bug, is thrown on,
 *  after the lock is removed. From before it takes the lock until after it has removed it, a SIGINT, SIGTERM or SIGHUP
 *  stops it (between two files, or the wait for the lock); it then removes the lock and, when nothing else listens for
 *  that signal, raises it again. */
export declare function pinPaths(paths: readonly string[], options: PinOptions): Promise<PinResult>;
/** Checks a pin against its own log, and its sources against the pin: every file line against the copy that holds its
 *  version (the current file, or the kept copy the first later line for that rel names), one pass per copy; the chain
 *  of the lines; and the staleness (sources under the root missing from the pin, or longer than their copy). A lock held
 *  by a running pin is waited for first, as a pin waits for it: a file that pin is writing would read as damage.
 *  Writes nothing. */
export declare function checkPin(dir: string, options?: PinCheckOptions): Promise<PinCheckResult>;
