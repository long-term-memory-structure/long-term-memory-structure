// Tests for the ./pin library (src/pin.ts), run against the built dist/pin.js (build first).
//
// Each test builds its own tree of invented files in a temp directory: a stand-in for Claude Code's config directory
// (<tmp>/claude, whose projects/ directory is the root) and a pin directory beside it (<tmp>/pins). The expected values
// come from how each tree is built (the bytes written here, hashed here with node:crypto), never from the library's own
// output. A crash is simulated in a child process that kills itself at a named step of one file's write (the library's
// onStep hook), so the state left behind is the state a real crash at that step leaves.
//
// LTMS_PIN=<path to a pin.js> runs the same tests against another build (the mutation runs use it).
//
// The last part tests the command, `ltms pin`, by running dist/cli.js in a child process with CLAUDE_CONFIG_DIR set to
// the tree's stand-in config; LTMS_CLI=<path to a cli.js> runs it against another build (with its pin.js beside it).

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, constants as fsConstants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { hostname, tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const PIN = process.env.LTMS_PIN || join(here, '..', 'dist', 'pin.js');
const { pinPaths, checkPin, claudeConfigDir, projectPinReaches } = await import(pathToFileURL(PIN).href);
const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;

// Never the real config directory: a call that leaves configDir out resolves under a temp path that does not exist.
process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), `ltms-pin-test-no-config-${process.pid}`);
process.umask(0o022);
const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const NEEDS_PERMISSIONS = AS_ROOT && 'root is not stopped by file permissions';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const sha12 = (b) => sha(b).slice(0, 12);
const len = (s) => Buffer.byteLength(s);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const modeOf = (p) => statSync(p).mode & 0o777;
/** A file's mtime as ISO 8601 to the nanosecond, built here another way than the library builds it: the ms from a
 *  Date, then the six digits below the ms. */
const mtimeNs = (p) => {
  const ns = statSync(p, { bigint: true }).mtimeNs;
  return `${new Date(Number(ns / 1000000n)).toISOString().slice(0, 23)}${String(ns % 1000000n).padStart(6, '0')}Z`;
};

// Invented transcript lines. A .jsonl is pinned up to its last new line.
const L1 = '{"type":"user","text":"an invented first prompt"}\n';
const L2 = '{"type":"assistant","text":"an invented first reply"}\n';
const L3 = '{"type":"user","text":"an invented second prompt"}\n';
const L4 = '{"type":"user","text":"an invented line written over the others"}\n';
const L5 = '{"type":"assistant","text":"an invented reply after the rewrite"}\n';

const P = '-home-u-alpha', Q = '-home-u-beta';
const SA = '11111111-1111-4111-8111-111111111111';
const SB = '33333333-3333-4333-8333-333333333333';
const SO = '55555555-5555-4555-8555-555555555555';   // a session directory with no transcript beside it

/** What the base tree pins: rel -> content. */
const PINNED = {
  [`${P}/${SA}.jsonl`]: L1 + L2,
  [`${P}/${SA}/subagents/agent-a0000000000000001.jsonl`]: L3,
  [`${P}/${SA}/subagents/agent-a0000000000000001.meta.json`]: '{"agentType":"invented"}',
  [`${P}/${SA}/tool-results/b000000001.txt`]: 'invented tool output\n',
  [`${P}/${SA}/workflows/wf_00000001-001.json`]: '{"invented":true}',
  [`${P}/22222222-2222-4222-8222-222222222222.jsonl.superseded-1731067200000`]: L1,
  [`${P}/sess-named.jsonl`]: L2,
  [`${P}/sess-named/tool-results/x.txt`]: 'x',
  [`${P}/${SO}/tool-results/z.txt`]: 'z',
  [`${Q}/${SB}.jsonl`]: L1 + L2 + L3,
};
const RELS = Object.keys(PINNED).sort();
/** Files under the root that are not of the sweep's shape: counted, not copied. */
const NOT_SHAPED = {
  [`${P}/${SA}/notes.txt`]: 'directly in a session directory',
  [`${P}/not-a-session/tool-results/y.txt`]: 'no transcript beside it, and not a UUID',
  [`${P}/raw/sessions/${SA}.jsonl`]: L1,
  [`${P}/README.txt`]: 'a project file',
  ['stray.txt']: 'directly under the root',
};
const BASE_SKIPPED = { notSessionShaped: 5, symlinks: 1, memory: 1, git: 1 };
const counts = (o) => ({ seen: 0, new: 0, grown: 0, rewritten: 0, unchanged: 0, notCopied: 0, failed: 0, ...o });

function tree() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ltms-pin-')));
  const config = join(tmp, 'claude'), root = join(config, 'projects'), to = join(tmp, 'pins');
  const src = (rel) => join(root, ...rel.split('/'));
  const put = (rel, content) => { const p = src(rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return p; };
  for (const [rel, c] of Object.entries({ ...PINNED, ...NOT_SHAPED })) put(rel, c);
  put(`${P}/memory/MEMORY.md`, 'an invented memory');      // a memory directory: counted, not followed
  put(`${P}/raw/.git/HEAD`, 'ref: refs/heads/main\n');     // a .git directory: counted, not followed
  symlinkSync('sess-named.jsonl', src(`${P}/link.jsonl`)); // a symlink: counted, not followed
  return {
    tmp, config, root, to, src, put,
    pin: (rel) => join(to, ...rel.split('/')),
    opts: (extra = {}) => ({ to, configDir: config, ...extra }),
    clean: () => { openTree(tmp); rmSync(tmp, { recursive: true, force: true }); },
  };
}
/** Gives back the permissions a test took away, so the tree can be removed. */
function openTree(dir) {
  try { chmodSync(dir, 0o700); } catch { /* gone */ }
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) openTree(p); else if (e.isFile()) { try { chmodSync(p, 0o600); } catch { /* gone */ } }
  }
}
/** Every file under dir, as '/'-separated paths relative to it, sorted. */
function filesUnder(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, base)); else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}
function dirsUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { const p = join(dir, e.name); out.push(p, ...dirsUnder(p)); }
  return out;
}
/** Every file's bytes, mode and mtime, and every directory's entries. */
function snapshot(dir) {
  const files = filesUnder(dir).map((f) => { const p = join(dir, f), s = statSync(p); return `${f}\t${sha(readFileSync(p))}\t${s.mode & 0o777}\t${s.mtimeMs}`; });
  const dirs = [dir, ...dirsUnder(dir)].map((d) => `${d}\t${readdirSync(d).sort().join('|')}`);
  return { files, dirs };
}
const logText = (to) => readFileSync(join(to, 'PINS.log'), 'utf8');
const logLines = (to) => logText(to).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const lockOf = (t) => join(t.to, '.ltms-pin.lock');
const plantLock = (t, body) => {
  mkdirSync(t.to, { recursive: true, mode: 0o700 });
  writeFileSync(lockOf(t), typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
};
/** The pid of a process that has exited. */
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
const checkClean = (k) => assert.deepEqual([k.k, k.mismatches, k.chainBreaks, k.unreadableLines, k.unlogged], ['checked', [], [], [], []]);

/** pinPaths in a child process that runs `action` (e.g. kills itself) at one step of one rel's write. */
function childPin(t, paths, step, rel, action, extra = {}) {
  const code = `
    import { pinPaths } from ${JSON.stringify(pathToFileURL(PIN).href)};
    const o = ${JSON.stringify(t.opts(extra))};
    const r = await pinPaths(${JSON.stringify(paths)}, { ...o, onStep(step, rel) {
      if (step === ${JSON.stringify(step)} && rel === ${JSON.stringify(rel)}) { ${action}; }
    } });
    process.stdout.write(JSON.stringify(r));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000 });
  if (r.error) throw r.error;
  return r;
}
const KILL = "process.kill(process.pid, 'SIGKILL')";

// ---- the first pin, the log, the modes ---------------------------------------------------------------------------

test("pin, a first run: every file of the sweep's shape is copied byte for byte, in rel order, and what is passed over is counted", async () => {
  const t = tree();
  try {
    const r = await pinPaths([t.root], t.opts());
    assert.equal(r.k, 'pinned');
    assert.deepEqual(r.coverage.files, counts({ seen: 10, new: 10 }));
    assert.deepEqual(r.coverage.skipped, BASE_SKIPPED);
    assert.equal(r.coverage.partial, 0);
    assert.equal(r.coverage.bytesCopied, RELS.reduce((n, rel) => n + len(PINNED[rel]), 0));
    assert.equal(r.coverage.keptSourceGone, 0);
    assert.deepEqual([r.coverage.root, r.coverage.to], [t.root, t.to]);
    assert.deepEqual([r.failures, r.takeover, r.removedTemps, r.interrupted], [[], null, 0, null]);
    for (const rel of RELS) assert.deepEqual(readFileSync(t.pin(rel)), Buffer.from(PINNED[rel]), rel);
    assert.deepEqual(filesUnder(t.to), ['PINS.log', ...RELS].sort());
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel]), [['root', undefined], ...RELS.map((rel) => ['new', rel])]);
    assert.equal(r.coverage.lastLog, r.lines.at(-1).t);
    assert.ok(Number.isInteger(r.coverage.ms) && r.coverage.ms >= 0);
  } finally { t.clean(); }
});

test("pin, the log: a root line first, then one line per file, each chained to the bytes of the line before it; each copy keeps its source's mtime", async () => {
  const t = tree();
  try {
    const r = await pinPaths([t.root], t.opts());
    const text = logText(t.to);
    assert.ok(text.endsWith('\n'));
    const raw = text.slice(0, -1).split('\n'), lines = raw.map((l) => JSON.parse(l));
    assert.deepEqual(r.lines, lines);
    assert.deepEqual(Object.keys(lines[0]), ['t', 'how', 'root', 'ltms', 'chain']);
    assert.deepEqual([lines[0].how, lines[0].root, lines[0].ltms, lines[0].chain], ['root', t.root, VERSION, null]);
    for (let i = 1; i < raw.length; i++) assert.equal(lines[i].chain, sha(raw[i - 1]), `line ${i + 1}`);
    for (const l of lines) assert.match(l.t, ISO);
    for (const l of lines.slice(1)) {
      const c = PINNED[l.rel], s = statSync(t.src(l.rel)), p = statSync(t.pin(l.rel));
      assert.deepEqual(Object.keys(l), ['t', 'rel', 'how', 'bytes', 'sha256', 'prev', 'mtime', 'chain']);
      assert.deepEqual([l.how, l.bytes, l.sha256, l.prev, l.mtime], ['new', len(c), sha(c), null, mtimeNs(t.src(l.rel))], l.rel);
      assert.ok(Math.abs(p.mtimeMs - s.mtimeMs) < 1, `${l.rel}: the copy's mtime is the source's`);
    }
  } finally { t.clean(); }
});

test("pin, modes under umask 022: copies and the log 0600, or the source's mode when it is stricter; directories 0700; the lock and the temp file 0600", async () => {
  const t = tree();
  try {
    const strict = `${P}/${SA}/tool-results/b000000001.txt`;
    chmodSync(t.src(strict), 0o400);
    const seen = {};
    const r = await pinPaths([t.root], t.opts({ onStep(step, rel) {
      if (step === 'stat' && !seen.lock) seen.lock = { mode: modeOf(lockOf(t)), body: JSON.parse(readFileSync(lockOf(t), 'utf8')) };
      if (step === 'temp-written' && rel === `${Q}/${SB}.jsonl`) seen.temp = modeOf(join(t.to, Q, `.${SB}.jsonl.ltms-tmp-${process.pid}`));
    } }));
    assert.equal(r.coverage.files.new, 10);
    for (const f of filesUnder(t.to)) assert.equal(modeOf(join(t.to, f)), f === strict ? 0o400 : 0o600, f);
    for (const d of [t.to, ...dirsUnder(t.to)]) assert.equal(modeOf(d), 0o700, d);
    assert.deepEqual([seen.lock.mode, seen.temp], [0o600, 0o600]);
    assert.deepEqual(Object.keys(seen.lock.body), ['pid', 'host', 'started']);
    assert.deepEqual([seen.lock.body.pid, seen.lock.body.host], [process.pid, hostname()]);
    assert.match(seen.lock.body.started, ISO);
  } finally { t.clean(); }
});

// ---- the decisions -------------------------------------------------------------------------------------------------

test('pin, a second run over an unchanged tree writes nothing: every file in the pin keeps its bytes, mode and mtime, and no line is added', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const before = snapshot(t.to);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.coverage.files, counts({ seen: 10, unchanged: 10 }));
    assert.deepEqual([r.coverage.bytesCopied, r.lines], [0, []]);
    assert.deepEqual(snapshot(t.to), before);
  } finally { t.clean(); }
});

test('pin, the fast path: a file whose size and mtime equal its last line is not read; --rehash reads it', { skip: NEEDS_PERMISSIONS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`;
    chmodSync(t.src(rel), 0o000);
    const fast = await pinPaths([t.root], t.opts());
    assert.deepEqual([fast.failures, fast.coverage.files], [[], counts({ seen: 10, unchanged: 10 })]);
    const slow = await pinPaths([t.root], t.opts({ rehash: true }));
    assert.deepEqual(slow.failures, [{ path: t.src(rel), rel, op: 'read', code: 'EACCES' }]);
    assert.deepEqual(slow.coverage.files, counts({ seen: 10, unchanged: 9, failed: 1 }));
  } finally { t.clean(); }
});

test('pin, the fast path trusts the size and the mtime: a same-size rewrite with its mtime put back stays unchanged until --rehash; with a new mtime it is rewritten', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, old = L1 + L2 + L3, neu = old.replace('invented', 'INVENTED');
    utimesSync(t.src(rel), 1700000000, 1700000000);   // a whole second: an mtime that can be put back exactly
    await pinPaths([t.root], t.opts());
    assert.equal(len(neu), len(old));
    writeFileSync(t.src(rel), neu); utimesSync(t.src(rel), 1700000000, 1700000000);
    const a = await pinPaths([t.root], t.opts());
    assert.equal(a.coverage.files.unchanged, 10);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), old);
    const b = await pinPaths([t.root], t.opts({ rehash: true }));
    assert.deepEqual(b.coverage.files, counts({ seen: 10, rewritten: 1, unchanged: 9 }));
    assert.equal(readFileSync(t.pin(rel), 'utf8'), neu);
    assert.equal(readFileSync(t.pin(`${Q}/${SB}.superseded-${sha12(old)}.jsonl`), 'utf8'), old);
    const neu2 = neu.replace('first prompt', 'FIRST PROMPT');
    writeFileSync(t.src(rel), neu2); utimesSync(t.src(rel), 1700000005, 1700000005);
    const c = await pinPaths([t.root], t.opts());
    assert.equal(c.coverage.files.rewritten, 1);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), neu2);
  } finally { t.clean(); }
});

test('pin, the fast path compares the mtime to the nanosecond: a same-size rewrite 2 µs later, in the same millisecond, is read and rewritten', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, old = L1 + L2 + L3, neu = old.replace('invented', 'INVENTED');
    utimesSync(t.src(rel), 1700000000.1235, 1700000000.1235);
    const before = mtimeNs(t.src(rel));
    await pinPaths([t.root], t.opts());
    writeFileSync(t.src(rel), neu); utimesSync(t.src(rel), 1700000000.123502, 1700000000.123502);
    const after = mtimeNs(t.src(rel));
    assert.equal(after.slice(0, 23), before.slice(0, 23), `the same millisecond: ${before} ${after}`);
    assert.notEqual(after, before);
    assert.equal(logLines(t.to).find((l) => l.rel === rel).mtime, before);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.coverage.files.rewritten, readFileSync(t.pin(rel), 'utf8')], [1, neu]);
  } finally { t.clean(); }
});

test('pin, grown: whole lines appended to a .jsonl; its line records the version before, and the copy is the new whole-line prefix', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${P}/${SA}.jsonl`;
    appendFileSync(t.src(rel), L3);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.coverage.files, counts({ seen: 10, grown: 1, unchanged: 9 }));
    assert.equal(r.coverage.bytesCopied, len(L1 + L2 + L3));
    assert.equal(r.lines.length, 1);
    const l = r.lines[0];
    assert.deepEqual([l.rel, l.how, l.bytes, l.sha256, l.prev, l.kept], [rel, 'grown', len(L1 + L2 + L3), sha(L1 + L2 + L3), { bytes: len(L1 + L2), sha256: sha(L1 + L2) }, undefined]);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L1 + L2 + L3);
  } finally { t.clean(); }
});

test('pin, rewritten: the old copy is kept by a hard link named by the sha12 of its bytes, for a .jsonl rewritten, a .jsonl cut to fewer lines, and another file', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const a = `${P}/${SA}.jsonl`, b = `${Q}/${SB}.jsonl`, x = `${P}/${SA}/tool-results/b000000001.txt`;
    const want = { [a]: L4 + L5, [b]: L1, [x]: 'other invented output\n' };
    const kept = {
      [a]: `${P}/${SA}.superseded-${sha12(PINNED[a])}.jsonl`,
      [b]: `${Q}/${SB}.superseded-${sha12(PINNED[b])}.jsonl`,
      [x]: `${P}/${SA}/tool-results/b000000001.txt.superseded-${sha12(PINNED[x])}`,
    };
    const inode = Object.fromEntries([a, b, x].map((r) => [r, statSync(t.pin(r)).ino]));
    for (const r of [a, b, x]) writeFileSync(t.src(r), want[r]);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.coverage.files, counts({ seen: 10, rewritten: 3, unchanged: 7 }));
    assert.deepEqual(r.lines.map((l) => l.rel), [a, x, b]);
    for (const l of r.lines) {
      const old = PINNED[l.rel];
      assert.deepEqual([l.how, l.bytes, l.sha256, l.prev, l.kept], ['rewritten', len(want[l.rel]), sha(want[l.rel]), { bytes: len(old), sha256: sha(old) }, kept[l.rel]], l.rel);
      assert.deepEqual(Object.keys(l), ['t', 'rel', 'how', 'bytes', 'sha256', 'prev', 'kept', 'mtime', 'chain']);
      assert.equal(readFileSync(t.pin(l.rel), 'utf8'), want[l.rel]);
      assert.equal(readFileSync(t.pin(kept[l.rel]), 'utf8'), old);
      assert.equal(statSync(t.pin(kept[l.rel])).ino, inode[l.rel], `${l.rel}: kept by link, the old copy's own inode`);
    }
  } finally { t.clean(); }
});

test('pin, rewritten back to a version already kept: the kept name is found holding those bytes; a kept name holding other bytes is a failure, and the copy stays', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, A = L1 + L2 + L3, B = L4, C = L5 + L5;   // three sizes: no step rests on the clock
    await pinPaths([t.root], t.opts());
    writeFileSync(t.src(rel), B); await pinPaths([t.root], t.opts());   // keeps A
    writeFileSync(t.src(rel), A); await pinPaths([t.root], t.opts());   // keeps B
    writeFileSync(t.src(rel), B);
    const r = await pinPaths([t.root], t.opts());                      // keeps A again: the name exists, holding A
    assert.deepEqual(r.failures, []);
    assert.deepEqual([r.lines.length, r.lines[0].how, r.lines[0].kept], [1, 'rewritten', `${Q}/${SB}.superseded-${sha12(A)}.jsonl`]);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), B);
    const keptB = t.pin(`${Q}/${SB}.superseded-${sha12(B)}.jsonl`);
    writeFileSync(keptB, 'planted bytes');
    writeFileSync(t.src(rel), C);
    const f = await pinPaths([t.root], t.opts());
    assert.deepEqual(f.failures, [{ path: keptB, rel, op: 'keep', code: 'kept-copy-differs' }]);
    assert.deepEqual([f.coverage.files, f.lines], [counts({ seen: 10, unchanged: 9, failed: 1 }), []]);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), B);
  } finally { t.clean(); }
});

test('pin, partial: a .jsonl is cut at its last new line, and one with no new line yet is not copied (notCopied); both count as partial; other files are copied whole', async () => {
  const t = tree();
  try {
    const half = `${Q}/${SB}.jsonl`, none = `${Q}/44444444-4444-4444-8444-444444444444.jsonl`, other = `${P}/${SA}/workflows/wf_00000001-001.json`;
    const tail = '{"type":"user","text":"an invented line not yet whole';
    writeFileSync(t.src(half), L1 + tail);
    t.put(none, '{"type":"user"');
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.coverage.files, counts({ seen: 11, new: 10, notCopied: 1 }));
    assert.equal(r.coverage.partial, 2);
    assert.equal(readFileSync(t.pin(half), 'utf8'), L1);
    assert.equal(r.lines.find((l) => l.rel === half).bytes, len(L1));
    assert.equal(existsSync(t.pin(none)), false);
    assert.equal(r.lines.some((l) => l.rel === none), false);
    assert.equal(readFileSync(t.pin(other), 'utf8'), PINNED[other]);   // no new line in it: copied whole
    appendFileSync(t.src(half), '"}\n');
    const g = await pinPaths([t.root], t.opts());
    assert.deepEqual([g.coverage.files.grown, g.coverage.partial], [1, 1]);
    assert.equal(readFileSync(t.pin(half), 'utf8'), L1 + tail + '"}\n');
  } finally { t.clean(); }
});

test('pin, a file growing between the stat and the read: the copy is a whole-line prefix of what was read, its line agrees with it, and its mtime is the one stat saw', async () => {
  const t = tree();
  try {
    const rel = `${P}/${SA}.jsonl`;
    let mtimeAtStat;
    const r = await pinPaths([t.root], t.opts({ onStep(step, s) {
      if (step === 'stat' && s === rel) { mtimeAtStat = mtimeNs(t.src(rel)); appendFileSync(t.src(rel), L3 + '{"type":"assistant","te'); }
    } }));
    const whole = L1 + L2 + L3;
    assert.equal(readFileSync(t.pin(rel), 'utf8'), whole);
    assert.ok(readFileSync(t.src(rel), 'utf8').startsWith(whole));
    const l = r.lines.find((x) => x.rel === rel);
    assert.deepEqual([l.how, l.bytes, l.sha256, l.mtime], ['new', len(whole), sha(whole), mtimeAtStat]);
    assert.equal(r.coverage.partial, 1);
  } finally { t.clean(); }
});

// ---- the selection ------------------------------------------------------------------------------------------------

test('pin, selection: a given <sid>.jsonl pins its <sid>/; a session directory, a project directory or a file pins what is under it; overlapping paths count once', async () => {
  const t = tree();
  try {
    const sa = `${P}/${SA}`, to = (n) => ({ to: `${t.to}-${n}` });
    const relsOf = (r) => r.lines.filter((l) => l.how === 'new').map((l) => l.rel);
    const one = await pinPaths([t.src(`${sa}.jsonl`)], t.opts(to(1)));
    assert.deepEqual(relsOf(one), RELS.filter((r) => r.startsWith(sa)));
    assert.deepEqual(one.coverage.skipped, { notSessionShaped: 1, symlinks: 0, memory: 0, git: 0 });   // notes.txt
    const sub = await pinPaths([t.src(`${sa}/subagents`)], t.opts(to(2)));
    assert.deepEqual(relsOf(sub), RELS.filter((r) => r.startsWith(`${sa}/subagents/`)));
    const proj = await pinPaths([t.src(Q)], t.opts(to(3)));
    assert.deepEqual(relsOf(proj), [`${Q}/${SB}.jsonl`]);
    const all = await pinPaths([t.root, t.src(P), t.src(`${sa}.jsonl`), t.src(`${sa}/subagents`), t.src(`${P}/README.txt`)], t.opts(to(4)));
    assert.deepEqual([all.coverage.files, all.coverage.skipped, relsOf(all)], [counts({ seen: 10, new: 10 }), BASE_SKIPPED, RELS]);
    const mem = await pinPaths([t.src(`${P}/memory`)], t.opts(to(5)));
    assert.deepEqual([mem.coverage.files.seen, mem.coverage.skipped], [0, { notSessionShaped: 0, symlinks: 0, memory: 1, git: 0 }]);
    const readme = await pinPaths([t.src(`${P}/README.txt`)], t.opts(to(6)));
    assert.deepEqual([readme.coverage.files.seen, readme.coverage.skipped.notSessionShaped], [0, 1]);
    // a symlink given by name is followed: the file it names is pinned under its own rel, with its session directory
    const viaLink = await pinPaths([t.src(`${P}/link.jsonl`)], t.opts(to(7)));
    assert.deepEqual(relsOf(viaLink), [`${P}/sess-named.jsonl`, `${P}/sess-named/tool-results/x.txt`]);
    // a session directory's name is a UUID in either case, or <name>.jsonl names a file beside it
    t.put(`${P}/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/subagents/agent-b.jsonl`, L1);
    t.put(`${P}/${SA}/tool-results/memory/m.txt`, 'a memory/ deeper than a project directory is walked');
    symlinkSync(t.src(Q), t.src('-home-u-linked'));   // a symlinked project directory: counted, not followed
    const more = await pinPaths([t.root], t.opts(to(8)));
    for (const r of [`${P}/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/subagents/agent-b.jsonl`, `${P}/${SA}/tool-results/memory/m.txt`]) assert.ok(relsOf(more).includes(r), r);
    assert.deepEqual([more.coverage.files.new, more.coverage.skipped.symlinks, more.coverage.skipped.memory], [12, 2, 1]);
  } finally { t.clean(); }
});

test('pin, paths resolve against the current directory, and rel is measured from the root', async () => {
  const t = tree(), cwd = process.cwd();
  try {
    process.chdir(t.tmp);
    const r = await pinPaths([`claude/projects/${Q}`], { to: 'pins', configDir: 'claude' });
    assert.deepEqual([r.coverage.to, r.coverage.root], [t.to, t.root]);
    assert.deepEqual(r.lines.slice(1).map((l) => l.rel), [`${Q}/${SB}.jsonl`]);
    const r2 = await pinPaths([`claude/projects/${Q}`], { to: 'pins', root: 'claude/projects' });
    assert.equal(r2.coverage.root, t.root);
  } finally { process.chdir(cwd); t.clean(); }
});

test("pin, the default root is <config>/projects: $CLAUDE_CONFIG_DIR, else (also when it is empty) the home directory's .claude", async () => {
  const t = tree(), saved = { c: process.env.CLAUDE_CONFIG_DIR, h: process.env.HOME };
  try {
    process.env.CLAUDE_CONFIG_DIR = t.config;
    assert.equal((await pinPaths([t.src(Q)], { to: t.to })).coverage.root, t.root);
    const home = join(t.tmp, 'home'); mkdirSync(home); symlinkSync(t.config, join(home, '.claude'));
    process.env.HOME = home;
    for (const unset of [undefined, '']) {
      if (unset === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = unset;
      const r = await pinPaths([t.src(Q)], { to: t.to });
      assert.equal(r.k, 'pinned', JSON.stringify(unset)); assert.equal(r.coverage.root, t.root);
      const inside = await pinPaths([t.src(Q)], { to: join(home, '.claude', 'pins') });
      assert.equal(inside.reason, 'to-inside-config');
    }
  } finally {
    process.env.CLAUDE_CONFIG_DIR = saved.c;
    if (saved.h === undefined) delete process.env.HOME; else process.env.HOME = saved.h;
    t.clean();
  }
});

// ---- the refusals ---------------------------------------------------------------------------------------------------

test('pin, refusals: each with its reason and the input echoed, and nothing written', async () => {
  const t = tree();
  try {
    const refused = async (paths, o, reason, ...echo) => {
      const r = await pinPaths(paths, o);
      assert.deepEqual([r.k, r.reason], ['refused', reason], JSON.stringify(r));
      for (const e of echo) assert.ok(r.message.includes(`'${e}'`), `${reason}: the message echoes '${e}': ${r.message}`);
      return r;
    };
    await refused([t.root], { configDir: t.config }, 'no-to');
    await refused([t.root], t.opts({ to: '' }), 'no-to');
    await refused([], t.opts(), 'no-paths');
    const c = await refused([t.root], t.opts({ to: join(t.config, 'pins') }), 'to-inside-config', join(t.config, 'pins'), t.config);
    assert.match(c.message, /which its cleanup manages/);
    await refused([t.root], t.opts({ to: t.config }), 'to-inside-config', t.config);
    const r0 = join(t.tmp, 'r'), p0 = join(r0, 'p');
    mkdirSync(p0, { recursive: true });
    await refused([p0], t.opts({ root: r0, to: join(p0, 'pins') }), 'to-inside-path', join(p0, 'pins'), p0);
    await refused([p0], t.opts({ root: r0, to: p0 }), 'to-inside-path', p0);
    await refused([p0], t.opts({ root: r0, to: r0 }), 'to-inside-root', r0);
    await refused([p0], t.opts({ root: r0, to: join(r0, 'q', 'pins') }), 'to-inside-root', join(r0, 'q', 'pins'), r0);
    await refused([p0], t.opts({ root: r0, to: t.tmp }), 'path-inside-to', p0, t.tmp);
    const out = join(t.tmp, 'elsewhere');
    mkdirSync(out);
    await refused([out], t.opts(), 'path-outside-root', out, t.root);
    await refused([t.root, join(t.tmp, 'missing-outside')], t.opts(), 'path-outside-root', join(t.tmp, 'missing-outside'));
    assert.deepEqual(readdirSync(t.tmp).sort(), ['claude', 'elsewhere', 'r']);
    assert.deepEqual(readdirSync(r0), ['p']);
  } finally { t.clean(); }
});

test('pin, inside is measured on real paths: through a symlink to the config directory, not by a shared name prefix, a child named ..x, and without case on darwin and win32', async () => {
  const t = tree();
  try {
    const link = join(t.tmp, 'cfglink');
    symlinkSync(t.config, link);
    const viaLink = await pinPaths([t.root], t.opts({ to: join(link, 'pins') }));
    assert.equal(viaLink.reason, 'to-inside-config');
    assert.ok(viaLink.message.includes(`'${join(link, 'pins')}'`) && viaLink.message.includes(`'${join(t.config, 'pins')}'`), viaLink.message);
    assert.equal((await pinPaths([t.root], t.opts({ configDir: link, to: join(t.config, 'pins') }))).reason, 'to-inside-config');
    assert.equal((await pinPaths([t.root], t.opts({ to: join(t.config, '..pins') }))).reason, 'to-inside-config');
    const cased = join(t.tmp, 'CLAUDE', 'pins');
    for (const platform of ['darwin', 'win32']) assert.equal((await pinPaths([t.root], t.opts({ to: cased, platform }))).reason, 'to-inside-config', platform);
    if (process.platform === 'linux') {   // the default platform is this one: on linux, case counts
      const r = await pinPaths([t.src(Q)], t.opts({ to: join(t.tmp, 'CLAUDE', 'pins-default') }));
      assert.deepEqual([r.k, r.coverage?.files.new], ['pinned', 1]);
    }
    for (const to of [`${t.config}-pins`, join(t.config, 'projects', '..', '..', 'elsewhere'), cased]) {
      const r = await pinPaths([t.src(Q)], t.opts({ to, platform: 'linux' }));
      assert.deepEqual([r.k, r.coverage?.files.new], ['pinned', 1], to);
    }
  } finally { t.clean(); }
});

test('pin, refused by the log: a root other than the one PINS.log records, and a PINS.log that does not open with its root line', async () => {
  const t = tree();
  try {
    await pinPaths([t.src(Q)], t.opts());
    const r2 = join(t.tmp, 'other-root');
    mkdirSync(join(r2, 'p'), { recursive: true });
    const d = await pinPaths([join(r2, 'p')], t.opts({ root: r2 }));
    assert.equal(d.reason, 'root-differs');
    assert.ok(d.message.includes(`'${t.root}'`) && d.message.includes(`'${r2}'`), d.message);
    assert.equal(d.recordedRoot, t.root);   // as the library read it, so a caller's next step need not read the log again
    for (const [name, body] of [['empty', ''], ['no-root', '{"how":"new","rel":"x"}\n'], ['not-json', 'not json\n']]) {
      const to = join(t.tmp, `bad-log-${name}`);
      mkdirSync(to);
      writeFileSync(join(to, 'PINS.log'), body);
      const u = await pinPaths([t.src(Q)], t.opts({ to }));
      assert.deepEqual([u.reason, u.recordedRoot], ['log-unreadable', undefined], name);
      assert.equal(readFileSync(join(to, 'PINS.log'), 'utf8'), body);
      assert.deepEqual(readdirSync(to), ['PINS.log']);
    }
  } finally { t.clean(); }
});

// ---- failures and keptSourceGone ---------------------------------------------------------------------------------

test('pin, a source or a directory that cannot be read is one failure each; the others are pinned', { skip: NEEDS_PERMISSIONS }, async () => {
  const t = tree();
  try {
    const rel = `${P}/sess-named.jsonl`;
    chmodSync(t.src(rel), 0o000);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.failures, [{ path: t.src(rel), rel, op: 'read', code: 'EACCES' }]);
    assert.deepEqual([r.coverage.files, r.coverage.failures], [counts({ seen: 10, new: 9, failed: 1 }), 1]);
    assert.equal(existsSync(t.pin(rel)), false);
    chmodSync(t.src(rel), 0o600);
    const dir = `${P}/${SA}/tool-results`;
    chmodSync(t.src(dir), 0o000);
    const d = await pinPaths([t.root], t.opts());
    assert.deepEqual(d.failures, [{ path: t.src(dir), rel: dir, op: 'walk', code: 'EACCES' }]);
    // a directory is not a source file: its failure is counted in failures, outside seen
    assert.deepEqual([d.coverage.files, d.coverage.failures], [counts({ seen: 9, new: 1, unchanged: 8 }), 1]);
    assert.equal(d.coverage.keptSourceGone, 0);   // a source that cannot be looked at is not gone
  } finally { t.clean(); }
});

test('pin, keptSourceGone counts the pinned files under the given paths whose source is gone; a given path that is missing is one failure', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const sa = `${P}/${SA}`;
    rmSync(t.src(`${sa}.jsonl`));
    rmSync(t.src(sa), { recursive: true });   // as the sweep deletes a session
    const proj = await pinPaths([t.src(P)], t.opts());
    assert.deepEqual([proj.coverage.keptSourceGone, proj.coverage.files], [5, counts({ seen: 4, unchanged: 4 })]);
    for (const rel of RELS.filter((r) => r.startsWith(sa))) assert.equal(readFileSync(t.pin(rel), 'utf8'), PINNED[rel]);
    const gone = await pinPaths([t.src(`${sa}.jsonl`)], t.opts());
    assert.deepEqual(gone.failures, [{ path: t.src(`${sa}.jsonl`), rel: `${sa}.jsonl`, op: 'walk', code: 'ENOENT' }]);
    assert.deepEqual([gone.coverage.keptSourceGone, gone.coverage.files, gone.coverage.failures], [5, counts({}), 1]);   // a path, not a file seen
    assert.equal((await pinPaths([t.src(Q)], t.opts())).coverage.keptSourceGone, 0);
    assert.equal((await pinPaths([t.root], t.opts())).coverage.keptSourceGone, 5);
  } finally { t.clean(); }
});

// ---- the lock ---------------------------------------------------------------------------------------------------------

test('pin, the lock: held by a live pid on this host, the pin waits, then reports the holder, its start and the rm command, and leaves the lock as it was', async () => {
  const t = tree();
  try {
    const holder = { pid: process.ppid, host: hostname(), started: '2026-11-08T10:00:00.000Z' };
    plantLock(t, holder);
    const t0 = Date.now();
    const r = await pinPaths([t.root], t.opts({ lockWaitMs: 300 }));
    assert.deepEqual([r.k, r.lock, r.holder, r.otherHost], ['busy', lockOf(t), holder, false]);
    assert.ok(r.waitedMs >= 300 && r.waitedMs < 5000 && Date.now() - t0 >= 300, String(r.waitedMs));
    for (const s of [String(holder.pid), holder.started, `rm '${lockOf(t)}'`]) assert.ok(r.message.includes(s), `${s}: ${r.message}`);
    assert.equal(readFileSync(lockOf(t), 'utf8'), JSON.stringify(holder));
    assert.deepEqual(readdirSync(t.to), ['.ltms-pin.lock']);
  } finally { t.clean(); }
});

test('pin, the lock: a holder on another host is treated as live, and so is a lock that cannot be read', async () => {
  const t = tree();
  try {
    const other = { pid: deadPid(), host: 'another-host.invalid', started: '2026-11-08T10:00:00.000Z' };
    plantLock(t, other);
    const r = await pinPaths([t.root], t.opts({ lockWaitMs: 200 }));
    assert.deepEqual([r.k, r.holder, r.otherHost], ['busy', other, true]);
    assert.ok(r.message.includes(other.host) && r.message.includes(`rm '${lockOf(t)}'`), r.message);
    plantLock(t, 'not a lock');
    const u = await pinPaths([t.root], t.opts({ lockWaitMs: 200 }));
    assert.deepEqual([u.k, u.holder, u.otherHost], ['busy', null, false]);
    assert.ok(u.message.includes(`rm '${lockOf(t)}'`), u.message);
    assert.equal(readFileSync(lockOf(t), 'utf8'), 'not a lock');
  } finally { t.clean(); }
});

test('pin, the lock: a lock whose pid is no longer running on this host is taken over, with a notice and a takeover line', async () => {
  const t = tree();
  try {
    const holder = { pid: deadPid(), host: hostname(), started: '2026-11-08T10:00:00.000Z' };
    plantLock(t, holder);
    const r = await pinPaths([t.root], t.opts({ lockWaitMs: 200 }));
    assert.equal(r.k, 'pinned');
    assert.deepEqual(r.takeover, holder);
    assert.deepEqual(r.lines.slice(0, 2).map((l) => l.how), ['root', 'takeover']);
    assert.deepEqual(Object.keys(r.lines[1]), ['t', 'how', 'lock', 'chain']);
    assert.deepEqual(r.lines[1].lock, holder);
    assert.ok(r.notices.some((n) => n.includes(String(holder.pid)) && n.includes('no longer running')), r.notices.join(' | '));
    assert.equal(existsSync(lockOf(t)), false);
    assert.equal(r.coverage.files.new, 10);
  } finally { t.clean(); }
});

test('pin, the lock: a holder that finishes during the wait lets the pin go on', async () => {
  const t = tree();
  try {
    plantLock(t, { pid: process.ppid, host: hostname(), started: '2026-11-08T10:00:00.000Z' });
    setTimeout(() => unlinkSync(lockOf(t)), 300);
    const t0 = Date.now();
    const r = await pinPaths([t.root], t.opts({ lockWaitMs: 10000 }));
    assert.deepEqual([r.k, r.takeover, r.coverage.files.new], ['pinned', null, 10]);
    assert.ok(Date.now() - t0 >= 300);
  } finally { t.clean(); }
});

test('pin, the lock: removed after a normal run, and after an error thrown inside the run, which is not swallowed; the temp file of that write is removed', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`;
    await pinPaths([t.src(Q)], t.opts());
    assert.equal(existsSync(lockOf(t)), false);
    appendFileSync(t.src(rel), L4);
    await assert.rejects(pinPaths([t.src(Q)], t.opts({ onStep(step) { if (step === 'temp-written') throw new Error('planted'); } })), /planted/);
    assert.equal(existsSync(lockOf(t)), false);
    assert.deepEqual(filesUnder(t.to), ['PINS.log', rel].sort());
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L1 + L2 + L3);
    assert.equal(logLines(t.to).length, 2);
  } finally { t.clean(); }
});

test('pin, the lock: removed on SIGINT, SIGTERM and SIGHUP, the pin stopping between two files and the process dying by the signal; and removed on exit', async () => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const t = tree();
    try {
      const c = childPin(t, [t.root], 'logged', RELS[0], `process.kill(process.pid, '${sig}')`);
      assert.equal(c.signal, sig, `${sig}: status ${c.status}, ${c.stderr}`);
      assert.equal(existsSync(lockOf(t)), false, sig);
      assert.deepEqual(logLines(t.to).map((l) => [l.how, l.rel]), [['root', undefined], ['new', RELS[0]]], sig);
      assert.deepEqual(filesUnder(t.to), ['PINS.log', RELS[0]].sort(), sig);
    } finally { t.clean(); }
  }
  const t = tree();
  try {
    const c = childPin(t, [t.root], 'logged', RELS[0], 'process.exit(3)');
    assert.deepEqual([c.status, existsSync(lockOf(t))], [3, false], c.stderr);
  } finally { t.clean(); }
});

// ---- recovery -------------------------------------------------------------------------------------------------------

test('recovery: a crash after the temp file is written; the next pin takes the lock over, removes the temp file and pins the file', async () => {
  const t = tree();
  try {
    const rel = `${P}/${SA}.jsonl`;
    await pinPaths([t.root], t.opts());
    appendFileSync(t.src(rel), L3);
    const c = childPin(t, [t.root], 'temp-written', rel, KILL);
    assert.equal(c.signal, 'SIGKILL', c.stderr);
    const temp = join(t.to, P, `.${SA}.jsonl.ltms-tmp-${c.pid}`);
    assert.equal(readFileSync(temp, 'utf8'), L1 + L2 + L3);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L1 + L2);
    assert.equal(JSON.parse(readFileSync(lockOf(t), 'utf8')).pid, c.pid);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.takeover?.pid, r.removedTemps, existsSync(temp)], [c.pid, 1, false]);
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel]), [['takeover', undefined], ['grown', rel]]);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L1 + L2 + L3);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('recovery: a crash after the rename and before the log line; the next pin adds a recovered line for what the copy holds, naming the kept copy after a rewrite (also one of the same size)', async () => {
  const rel = `${Q}/${SB}.jsonl`, old = L1 + L2 + L3, same = old.replace('invented', 'INVENTED');
  assert.equal(len(same), len(old));
  for (const [kind, change, neu] of [['grown', (p) => appendFileSync(p, L4), old + L4], ['rewritten', (p) => writeFileSync(p, L4), L4],
    ['rewritten, same size', (p) => { writeFileSync(p, same); utimesSync(p, 1700000007, 1700000007); }, same]]) {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      change(t.src(rel));
      const c = childPin(t, [t.root], 'renamed', rel, KILL);
      assert.equal(c.signal, 'SIGKILL', c.stderr);
      assert.equal(readFileSync(t.pin(rel), 'utf8'), neu, kind);
      assert.equal(logLines(t.to).filter((l) => l.rel === rel).length, 1, kind);
      const kept = kind.startsWith('rewritten') ? `${Q}/${SB}.superseded-${sha12(old)}.jsonl` : undefined;
      if (kept) assert.equal(readFileSync(t.pin(kept), 'utf8'), old);
      const r = await pinPaths([t.root], t.opts());
      assert.deepEqual(r.lines.map((l) => l.how), ['takeover', 'recovered'], kind);
      const l = r.lines[1];
      assert.deepEqual([l.rel, l.bytes, l.sha256, l.prev, l.kept], [rel, len(neu), sha(neu), { bytes: len(old), sha256: sha(old) }, kept], kind);
      assert.deepEqual(r.coverage.files, counts({ seen: 10, unchanged: 10 }), kind);
      checkClean(await checkPin(t.to));
    } finally { t.clean(); }
  }
});

test('recovery: a crash between the link and the rename; the kept copy gets its own recovered line, and the next rewrite finds it kept already', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, old = L1 + L2 + L3, kept = `${Q}/${SB}.superseded-${sha12(old)}.jsonl`;
    await pinPaths([t.root], t.opts());
    writeFileSync(t.src(rel), L4);
    const c = childPin(t, [t.root], 'linked', rel, KILL);
    assert.equal(c.signal, 'SIGKILL', c.stderr);
    assert.equal(statSync(t.pin(kept)).ino, statSync(t.pin(rel)).ino);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel]), [['takeover', undefined], ['recovered', kept], ['rewritten', rel]]);
    assert.deepEqual([r.lines[1].bytes, r.lines[1].sha256, r.lines[1].prev], [len(old), sha(old), null]);
    assert.deepEqual([r.lines[2].kept, r.failures, r.removedTemps], [kept, [], 0]);
    assert.equal(readFileSync(t.pin(kept), 'utf8'), old);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L4);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('recovery: a log that does not end in a new line is closed, and a recovered line names the cut line; --check reads it as acknowledged', async () => {
  const t = tree();
  try {
    await pinPaths([t.src(Q)], t.opts());
    const torn = '{"t":"2026-11-08T1';
    appendFileSync(join(t.to, 'PINS.log'), torn);
    assert.deepEqual((await checkPin(t.to)).unreadableLines, [3]);
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), L4);
    const r = await pinPaths([t.src(Q)], t.opts());
    assert.deepEqual(r.lines.map((l) => l.how), ['recovered', 'grown']);
    assert.deepEqual(Object.keys(r.lines[0]), ['t', 'how', 'torn', 'chain']);
    assert.deepEqual([r.lines[0].torn, r.lines[0].chain], [{ line: 3, bytes: len(torn) }, sha(torn)]);
    assert.equal(logText(t.to).split('\n')[2], torn);
    const k = await checkPin(t.to);
    checkClean(k);
    assert.equal(k.lines, 5);
  } finally { t.clean(); }
});

test('recovery: a file of the pin that no line names gets a recovered line; a copy deleted from the pin is written again from its source', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const stray = `${Q}/66666666-6666-4666-8666-666666666666.jsonl`, del = `${P}/sess-named.jsonl`;
    writeFileSync(t.pin(stray), L5);
    rmSync(t.pin(del));
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel]), [['recovered', stray], ['recovered', del]]);
    assert.deepEqual([r.lines[0].bytes, r.lines[0].sha256, r.lines[0].prev], [len(L5), sha(L5), null]);
    assert.deepEqual([r.lines[1].bytes, r.lines[1].sha256, r.lines[1].prev], [len(L2), sha(L2), { bytes: len(L2), sha256: sha(L2) }]);
    assert.equal(readFileSync(t.pin(del), 'utf8'), L2);
    assert.deepEqual([r.coverage.files, r.coverage.bytesCopied], [counts({ seen: 10, unchanged: 10 }), len(L2)]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('win32: a rename failing with EACCES is retried for a bounded time, then given up; on linux it is a failure at once', { skip: NEEDS_PERMISSIONS }, async () => {
  const rel = `${Q}/${SB}.jsonl`;
  const run = async (platform, restoreAt) => {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      appendFileSync(t.src(rel), L4);
      let retries = 0;
      const t0 = Date.now();
      const r = await pinPaths([t.root], t.opts({ platform, onStep(step, s) {
        if (s === rel && step === 'temp-written') chmodSync(join(t.to, Q), 0o500);
        if (s === rel && step === 'rename-retry' && ++retries === restoreAt) chmodSync(join(t.to, Q), 0o700);
      } }));
      chmodSync(join(t.to, Q), 0o700);
      return { r, retries, ms: Date.now() - t0, copy: readFileSync(t.pin(rel), 'utf8'), t: { pin: t.pin(rel) } };
    } finally { t.clean(); }
  };
  const ok = await run('win32', 2);
  assert.deepEqual([ok.retries, ok.r.failures, ok.r.coverage.files.grown, ok.copy], [2, [], 1, L1 + L2 + L3 + L4]);
  const lin = await run('linux', 1);
  assert.deepEqual([lin.retries, lin.r.failures, lin.copy], [0, [{ path: lin.t.pin, rel, op: 'write', code: 'EACCES' }], L1 + L2 + L3]);
  const gave = await run('win32', Infinity);
  assert.deepEqual([gave.r.failures, gave.copy], [[{ path: gave.t.pin, rel, op: 'write', code: 'EACCES' }], L1 + L2 + L3]);
  assert.ok(gave.retries > 2 && gave.ms < 10000, `${gave.retries} retries in ${gave.ms} ms`);
});

test('pin, a copy found holding other bytes of the same size at a rewrite: a recovered line records them; it is kept by the sha12 of those bytes, or, when the source begins with them, the file is grown', async () => {
  const rel = `${Q}/${SB}.jsonl`, P0 = L1 + L2 + L3, X = P0.replace('invented', 'INVENTED');
  assert.equal(len(X), len(P0));
  // the source rewritten so that it does not begin with X: rewritten, the copy kept under the sha12 of X
  {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      writeFileSync(t.pin(rel), X);                // the copy changed in place, at the same size: no recovery sees it
      writeFileSync(t.src(rel), L4);
      const r = await pinPaths([t.root], t.opts());
      const kept = `${Q}/${SB}.superseded-${sha12(X)}.jsonl`;
      assert.deepEqual(r.lines.map((l) => [l.how, l.rel]), [['recovered', rel], ['rewritten', rel]]);
      assert.deepEqual([r.lines[0].bytes, r.lines[0].sha256, r.lines[0].prev], [len(X), sha(X), { bytes: len(P0), sha256: sha(P0) }]);
      assert.deepEqual([r.lines[1].prev, r.lines[1].kept], [{ bytes: len(X), sha256: sha(X) }, kept]);
      assert.equal(readFileSync(t.pin(kept), 'utf8'), X);
      assert.equal(readFileSync(t.pin(rel), 'utf8'), L4);
      // the first version is lost (it was changed in place): the check says so at its line, and only there
      const k = await checkPin(t.to);
      assert.deepEqual(k.mismatches, [{ rel, copy: kept, line: RELS.indexOf(rel) + 2, want: { bytes: len(P0), sha256: sha(P0) }, got: { bytes: len(X), sha256: sha(X) } }]);
    } finally { t.clean(); }
  }
  // the source begins with X: after the recovered line, the file is grown from it, and nothing is kept
  {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      writeFileSync(t.pin(rel), X);
      writeFileSync(t.src(rel), X + L4);
      const r = await pinPaths([t.root], t.opts());
      assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.kept]), [['recovered', rel, undefined], ['grown', rel, undefined]]);
      assert.deepEqual(r.lines[1].prev, { bytes: len(X), sha256: sha(X) });
      assert.equal(readFileSync(t.pin(rel), 'utf8'), X + L4);
    } finally { t.clean(); }
  }
});

test('pin, a symbolic link planted at a temp file\'s name is never written through: the write fails with EEXIST and the file it names is untouched', { skip: process.platform === 'win32' && 'symbolic links need privileges on win32' }, async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, victim = join(t.tmp, 'victim.txt');
    await pinPaths([t.root], t.opts());
    writeFileSync(victim, 'not to be written');
    symlinkSync(victim, join(t.to, Q, `.${SB}.jsonl.ltms-tmp-${process.pid}`));
    appendFileSync(t.src(rel), L4);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.failures, [{ path: t.pin(rel), rel, op: 'write', code: 'EEXIST' }]);
    assert.equal(readFileSync(victim, 'utf8'), 'not to be written');
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L1 + L2 + L3);
  } finally { t.clean(); }
});

test("pin, a waiting pin's lock temp file is left alone while its pid runs on this host, and removed as a leftover when it does not", async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const live = join(t.to, `..ltms-pin.lock.ltms-tmp-${process.ppid}`), dead = join(t.to, `..ltms-pin.lock.ltms-tmp-${deadPid()}`);
    writeFileSync(live, '{}'); writeFileSync(dead, '{}');
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.removedTemps, existsSync(live), existsSync(dead)], [1, true, false]);
    assert.equal((await checkPin(t.to)).temps, 0);
  } finally { t.clean(); }
});

test('pin, failures of the pin directory itself: to cannot be made, the lock cannot be written, PINS.log cannot be appended to (the run stops there, and the next pin records what it left)', { skip: NEEDS_PERMISSIONS }, async () => {
  const t = tree();
  try {
    writeFileSync(join(t.tmp, 'a-file'), 'x');
    const bad = join(t.tmp, 'a-file', 'pins');
    const m = await pinPaths([t.root], t.opts({ to: bad }));
    assert.deepEqual([m.k, m.failures, m.coverage.files, m.coverage.failures], ['pinned', [{ path: bad, rel: null, op: 'to', code: 'ENOTDIR' }], counts({}), 1]);
    mkdirSync(t.to, { mode: 0o500 });
    const l = await pinPaths([t.root], t.opts());
    assert.deepEqual(l.failures, [{ path: lockOf(t), rel: null, op: 'lock', code: 'EACCES' }]);
    assert.deepEqual(readdirSync(t.to), []);
    chmodSync(t.to, 0o700);
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, logPath = join(t.to, 'PINS.log');
    appendFileSync(t.src(rel), L4);
    chmodSync(logPath, 0o400);
    const g = await pinPaths([t.root], t.opts());
    assert.deepEqual(g.failures, [{ path: logPath, rel: null, op: 'log', code: 'EACCES' }]);
    assert.ok(g.notices.some((n) => n.includes('could not be written')), g.notices.join(' | '));
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L1 + L2 + L3 + L4);   // renamed into place before its line failed
    assert.equal(existsSync(lockOf(t)), false);
    chmodSync(logPath, 0o600);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.lines.map((x) => [x.how, x.rel]), [['recovered', rel]]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

// ---- check ------------------------------------------------------------------------------------------------------------

test('check: a clean pin, and a pin after rewrites, where each version is checked against the copy that holds it', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const k = await checkPin(t.to);
    checkClean(k);
    assert.deepEqual([k.dir, k.root, k.lines, k.versions, k.files, k.temps, k.lock], [t.to, t.root, 11, 10, 10, 0, null]);
    assert.deepEqual(k.staleness, { root: t.root, fromLog: true, sources: 10, missing: 0, longer: 0, unfinished: 0, projectsNotPinned: 0, failed: 0 });
    assert.equal(k.lastLog, logLines(t.to).at(-1).t);
    const rel = `${Q}/${SB}.jsonl`;
    writeFileSync(t.src(rel), L4); await pinPaths([t.root], t.opts());
    appendFileSync(t.src(rel), L5); await pinPaths([t.root], t.opts());
    writeFileSync(t.src(rel), L1); await pinPaths([t.root], t.opts());
    const after = await checkPin(t.to);
    checkClean(after);
    assert.deepEqual([after.lines, after.versions, after.files], [14, 13, 12]);
    // the check could fail: the first version is not a prefix of the current copy, so only the kept copy holds it
    assert.equal(readFileSync(t.pin(rel), 'utf8').startsWith(L1 + L2 + L3), false);
  } finally { t.clean(); }
});

test('check: a change planted in a current copy, in a kept copy, or in a log line, and a deleted log line, each found at its line', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, A = L1 + L2 + L3;
    await pinPaths([t.root], t.opts());
    writeFileSync(t.src(rel), L4);
    await pinPaths([t.root], t.opts());
    const log = join(t.to, 'PINS.log'), orig = readFileSync(log);
    const raw = () => readFileSync(log, 'utf8').split('\n').filter((l) => l !== '');
    const lineOf = (how) => raw().findIndex((l) => { const o = JSON.parse(l); return o.rel === rel && o.how === how; }) + 1;
    const newLine = lineOf('new'), rwLine = lineOf('rewritten');
    assert.deepEqual([newLine, rwLine], [11, 12]);
    const flip = (p, at) => { const b = readFileSync(p), bad = Buffer.from(b); bad[at < 0 ? b.length + at : at] ^= 1; writeFileSync(p, bad); return { b, bad }; };
    // a current copy
    const cur = flip(t.pin(rel), -1);
    let k = await checkPin(t.to);
    assert.deepEqual(k.mismatches, [{ rel, copy: rel, line: rwLine, want: { bytes: len(L4), sha256: sha(L4) }, got: { bytes: len(L4), sha256: sha(cur.bad) } }]);
    writeFileSync(t.pin(rel), cur.b);
    // a current copy with bytes appended after the version its newest line records
    appendFileSync(t.pin(rel), 'extra');
    k = await checkPin(t.to);
    assert.deepEqual(k.mismatches, [{ rel, copy: rel, line: rwLine, want: { bytes: len(L4), sha256: sha(L4) }, got: { bytes: len(L4) + 5, sha256: sha(L4 + 'extra') } }]);
    writeFileSync(t.pin(rel), cur.b);
    // a kept copy
    const keptRel = `${Q}/${SB}.superseded-${sha12(A)}.jsonl`, keptPath = t.pin(keptRel);
    const kc = flip(keptPath, 0);
    k = await checkPin(t.to);
    assert.deepEqual(k.mismatches, [{ rel, copy: keptRel, line: newLine, want: { bytes: len(A), sha256: sha(A) }, got: { bytes: len(A), sha256: sha(kc.bad) } }]);
    writeFileSync(keptPath, kc.b);
    checkClean(await checkPin(t.to));
    // a log line: its sha256 changed
    const lines = raw(), o = JSON.parse(lines[newLine - 1]);
    o.sha256 = '0'.repeat(64);
    lines[newLine - 1] = JSON.stringify(o);
    writeFileSync(log, lines.join('\n') + '\n');
    k = await checkPin(t.to);
    assert.deepEqual(k.mismatches, [{ rel, copy: keptRel, line: newLine, want: { bytes: len(A), sha256: '0'.repeat(64) }, got: { bytes: len(A), sha256: sha(A) } }]);
    assert.deepEqual(k.chainBreaks, [{ line: newLine + 1, want: sha(lines[newLine - 1]), got: JSON.parse(lines[newLine]).chain }]);
    // a log line deleted: the chain breaks there, and the file it named is no longer named by any line
    writeFileSync(log, orig);
    const cut = raw();
    const [gone] = cut.splice(4, 1);
    writeFileSync(log, cut.join('\n') + '\n');
    k = await checkPin(t.to);
    assert.deepEqual(k.chainBreaks, [{ line: 5, want: sha(cut[3]), got: sha(gone) }]);
    assert.deepEqual([k.unlogged, k.mismatches], [[JSON.parse(gone).rel], []]);
  } finally { t.clean(); }
});

test('check: the staleness, against the root PINS.log records or one given: sources missing from the pin, longer than their copy, and projects with nothing pinned', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), L4);
    t.put(`${Q}/77777777-7777-4777-8777-777777777777.jsonl`, L1);
    t.put('-home-u-gamma/88888888-8888-4888-8888-888888888888.jsonl', L1);
    const k = await checkPin(t.to);
    checkClean(k);
    assert.deepEqual(k.staleness, { root: t.root, fromLog: true, sources: 12, missing: 2, longer: 1, unfinished: 0, projectsNotPinned: 1, failed: 0 });
    assert.equal((await checkPin(t.to, { root: t.root })).staleness.fromLog, false);
    const none = join(t.tmp, 'no-such-root');
    assert.deepEqual((await checkPin(t.to, { root: none })).staleness, { root: none, fromLog: false, sources: 0, missing: 0, longer: 0, unfinished: 0, projectsNotPinned: 0, failed: 1 });
  } finally { t.clean(); }
});

test('check: a directory without PINS.log is refused; a lock, a temp file, an unlogged file and a copy missing from the pin are reported', async () => {
  const t = tree();
  try {
    mkdirSync(t.to);
    const n = await checkPin(t.to);
    assert.deepEqual([n.k, n.reason], ['refused', 'not-a-pin']);
    assert.ok(n.message.includes(`'${t.to}'`), n.message);
    await pinPaths([t.root], t.opts());
    // a lock left by a pin that stopped (its pid runs no more): the check does not wait for it, and reports it
    const holder = { pid: deadPid(), host: hostname(), started: '2026-11-08T10:00:00.000Z' };
    writeFileSync(lockOf(t), JSON.stringify(holder));
    writeFileSync(join(t.to, Q, `.${SB}.jsonl.ltms-tmp-4242`), 'left over');
    const stray = `${Q}/66666666-6666-4666-8666-666666666666.jsonl`, gone = `${P}/sess-named.jsonl`;
    writeFileSync(t.pin(stray), L5);
    rmSync(t.pin(gone));
    const k = await checkPin(t.to);
    assert.deepEqual([k.lock, k.temps, k.unlogged], [holder, 1, [stray]]);
    assert.deepEqual(k.mismatches, [{ rel: gone, copy: gone, line: RELS.indexOf(gone) + 2, want: { bytes: len(L2), sha256: sha(L2) }, got: null }]);
  } finally { t.clean(); }
});

// ---- the repair round (S358): verify.pin, verify.lib and the merge's findings ----------------------------------------
// Each test below was run red first on the merged build (notes-R-pin/), unless it says it is a guard.

/** pinPaths in a child process that first patches node:fs or process (the code in `patch`, with fs in scope);
 *  syncBuiltinESMExports carries a patch of fs into pin.js's own imports. */
function childPinPatched(t, paths, patch) {
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    ${patch}
    syncBuiltinESMExports();
    const { pinPaths } = await import(${JSON.stringify(pathToFileURL(PIN).href)});
    const r = await pinPaths(${JSON.stringify(paths)}, ${JSON.stringify(t.opts())});
    process.stdout.write(JSON.stringify(r));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000 });
  if (r.error) throw r.error;
  return r;
}

test('pin, a signal the moment the lock is made: the listeners are there before the lock, so the pin stops before its first file and removes the lock (lib[5])', async () => {
  const t = tree();
  try {
    const c = childPinPatched(t, [t.root], `
      const link = fs.linkSync;
      fs.linkSync = function (from, to) {
        const r = link.apply(this, arguments);
        if (String(to).endsWith('.ltms-pin.lock')) process.kill(process.pid, 'SIGTERM');
        return r;
      };`);
    assert.equal(c.signal, 'SIGTERM', `status ${c.status}: ${c.stderr}`);
    assert.equal(existsSync(lockOf(t)), false, 'the lock is left');
    // it stopped between two files, early: when the signal is seen depends on the event loop (none pinned on Node 26,
    // one on Node 20, measured), so only that it stopped, and that what it pinned is whole and logged
    assert.ok(logLines(t.to).filter((l) => l.rel !== undefined).length < RELS.length, 'the pin went on to its last file');
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('pin, a signal the moment the pin has finished: the lock is removed before the listeners, so it is never left (lib[5])', async () => {
  const t = tree();
  try {
    const c = childPinPatched(t, [t.root], `
      const remove = process.removeListener;
      let sent = false;
      process.removeListener = function (event) {
        const r = remove.apply(this, arguments);
        if (event === 'SIGTERM' && !sent) { sent = true; process.kill(process.pid, 'SIGTERM'); }
        return r;
      };`);
    assert.equal(c.signal, 'SIGTERM', `status ${c.status}: ${c.stderr}`);
    assert.equal(existsSync(lockOf(t)), false, 'the lock is left');
    assert.deepEqual(logLines(t.to).filter((l) => l.how === 'new').map((l) => l.rel), RELS);   // the pin had finished
  } finally { t.clean(); }
});

test('pin, a signal while waiting for the lock ends the wait at once; the other pin\'s lock is left as it was, and the waiting pin\'s own temp file is removed', async () => {
  const t = tree();
  try {
    const holder = { pid: process.pid, host: hostname(), started: '2026-11-08T10:00:00.000Z' };   // this test's process: alive
    plantLock(t, holder);
    const t0 = Date.now();
    const c = childPinPatched({ ...t, opts: () => t.opts({ lockWaitMs: 20000 }) }, [t.root], `setTimeout(() => process.kill(process.pid, 'SIGINT'), 300);`);
    assert.equal(c.signal, 'SIGINT', `status ${c.status}: ${c.stderr}`);
    assert.ok(Date.now() - t0 < 10000, `the wait went on for ${Date.now() - t0} ms after the signal`);
    assert.equal(readFileSync(lockOf(t), 'utf8'), JSON.stringify(holder));
    assert.deepEqual(readdirSync(t.to), ['.ltms-pin.lock']);   // no ..ltms-pin.lock.ltms-tmp-<pid> left
  } finally { t.clean(); }
});

test("pin, a symbolic link planted at the lock's temp file name is removed, never written through: the file it names is untouched (pin[0])", { skip: process.platform === 'win32' && 'symbolic links need privileges on win32' }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const victim = join(t.tmp, 'victim.txt');
    writeFileSync(victim, 'not to be written');
    symlinkSync(victim, join(t.to, `..ltms-pin.lock.ltms-tmp-${process.pid}`));
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), L4);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.k, r.failures, r.coverage.files.grown], ['pinned', [], 1]);
    assert.equal(readFileSync(victim, 'utf8'), 'not to be written');
    assert.deepEqual(readdirSync(t.to).filter((n) => n.startsWith('.')), []);   // no lock, no temp file, no link
  } finally { t.clean(); }
});

test("pin, a link put at the lock's temp file name between its removal and its making (a race, simulated) is not written through either: 'wx' refuses it, and the lock is a failure (pin[0])", { skip: process.platform === 'win32' && 'symbolic links need privileges on win32' }, async () => {
  const t = tree();
  try {
    const victim = join(t.tmp, 'victim.txt');
    writeFileSync(victim, 'not to be written');
    const c = childPinPatched(t, [t.root], `
      const unlink = fs.unlinkSync, symlink = fs.symlinkSync;
      let planted = false;
      fs.unlinkSync = function (p) {
        try { return unlink.apply(this, arguments); }
        finally { if (!planted && String(p).includes('..ltms-pin.lock.ltms-tmp-')) { planted = true; symlink(${JSON.stringify(victim)}, p); } }
      };`);
    assert.equal(c.status, 0, c.stderr);
    const r = JSON.parse(c.stdout);
    assert.deepEqual([r.k, r.failures.map((f) => [f.op, f.code])], ['pinned', [['lock', 'EEXIST']]]);
    assert.equal(readFileSync(victim, 'utf8'), 'not to be written');
  } finally { t.clean(); }
});

test('pin, a directory inside the pin that is a symbolic link is never written through: each file under it is a failure (symlink-in-pin), what it leads to is untouched, and PINS.log does not grow (pin[1])', { skip: process.platform === 'win32' && 'symbolic links need privileges on win32' }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const other = join(t.tmp, 'other-disk'), rel = `${Q}/${SB}.jsonl`;
    renameSync(join(t.to, Q), other);    // a project's copies moved to another disk,
    symlinkSync(other, join(t.to, Q));   // and a link left in their place
    const before = snapshot(other), lines = logLines(t.to).length;
    for (const run of [1, 2]) {
      const r = await pinPaths([t.root], t.opts());
      assert.deepEqual(r.failures, [{ path: t.pin(rel), rel, op: 'write', code: 'symlink-in-pin' }], `run ${run}`);
      assert.deepEqual([r.coverage.files, r.coverage.failures], [counts({ seen: 10, unchanged: 9, failed: 1 }), 1], `run ${run}`);
      assert.deepEqual(snapshot(other), before, `run ${run}`);
      assert.equal(logLines(t.to).length, lines, `run ${run}`);
    }
  } finally { t.clean(); }
});

test("pin, a --to that holds files and no PINS.log is refused (to-holds-files), and nothing in it is adopted or written; a --to holding only a pin's own lock, left before its log was made, is pinned into (pin[3])", async () => {
  const t = tree();
  try {
    mkdirSync(join(t.to, 'notes'), { recursive: true });
    writeFileSync(join(t.to, 'notes', 'todo.jsonl'), L1);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.k, r.reason], ['refused', 'to-holds-files'], JSON.stringify(r));
    assert.equal(r.message, `the pin directory '${t.to}' already holds 'notes', and no PINS.log: it is not a pin, and pin does not write among files it did not make.`);
    writeFileSync(join(t.to, 'more.txt'), 'x');
    assert.match((await pinPaths([t.root], t.opts())).message, /already holds 2 entries \('more\.txt' first, by name\), and no PINS\.log/);
    assert.deepEqual(filesUnder(t.to), ['more.txt', 'notes/todo.jsonl']);
    const u = join(t.tmp, 'pins-left');
    mkdirSync(u, { mode: 0o700 });
    writeFileSync(join(u, '.ltms-pin.lock'), JSON.stringify({ pid: deadPid(), host: hostname(), started: '2026-11-08T10:00:00.000Z' }));
    writeFileSync(join(u, `..ltms-pin.lock.ltms-tmp-${deadPid()}`), '{}');
    const k = await pinPaths([t.root], t.opts({ to: u }));
    assert.deepEqual([k.k, k.coverage?.files.new, k.removedTemps], ['pinned', 10, 1]);
  } finally { t.clean(); }
});

test('pin, a --to that names an existing file is refused (to-not-a-directory); failures that are not of a source file are counted in failures, outside seen (pin[9])', async () => {
  const t = tree();
  try {
    const file = join(t.tmp, 'a-file');
    writeFileSync(file, 'x');
    const f = await pinPaths([t.root], t.opts({ to: file }));
    assert.deepEqual([f.k, f.reason], ['refused', 'to-not-a-directory']);
    assert.equal(f.message, `the pin directory '${file}' exists and is not a directory (a file), so pin cannot write its copies into it.`);
    assert.equal(readFileSync(file, 'utf8'), 'x');
    // a pin of one project and a given path that is missing: one file seen, one failure, which is not a file's
    const gone = await pinPaths([t.src(Q), t.src('-home-u-missing')], t.opts());
    assert.deepEqual([gone.coverage.files, gone.coverage.failures, gone.failures.map((x) => x.op)], [counts({ seen: 1, new: 1 }), 1, ['walk']]);
  } finally { t.clean(); }
});

test('pin, a .jsonl with no new line yet, or empty, is not copied and is counted apart (notCopied), not as unchanged; partial counts the one with bytes; a check leaves both out of missing (pin[10])', async () => {
  const t = tree();
  try {
    const empty = `${Q}/44444444-4444-4444-8444-444444444444.jsonl`, noNl = `${Q}/99999999-9999-4999-8999-999999999999.jsonl`;
    t.put(empty, '');
    t.put(noNl, '{"type":"user","text":"an invented first line not yet whole');
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.coverage.files, r.coverage.partial], [counts({ seen: 12, new: 10, notCopied: 2 }), 1]);
    for (const rel of [empty, noNl]) assert.equal(existsSync(t.pin(rel)), false, rel);
    const k = await checkPin(t.to);
    assert.deepEqual([k.staleness.sources, k.staleness.missing, k.staleness.longer], [12, 0, 0]);
    appendFileSync(t.src(noNl), '"}\n');   // its first line whole: now it is copied, and missing until it is
    assert.equal((await checkPin(t.to)).staleness.missing, 1);
    const g = await pinPaths([t.root], t.opts());
    assert.deepEqual([g.coverage.files, g.coverage.partial], [counts({ seen: 12, new: 1, unchanged: 10, notCopied: 1 }), 0]);
  } finally { t.clean(); }
});

test('pin --rehash, a copy changed in place at the same size: a check finds it; a pin without --rehash leaves it; --rehash writes it again from its source, which still holds that version, with a recovered line (pin[2])', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel];
    const bad = Buffer.from(good);
    bad[3] ^= 1;
    writeFileSync(t.pin(rel), bad);
    const line = logLines(t.to).findIndex((l) => l.rel === rel) + 1;
    assert.deepEqual((await checkPin(t.to)).mismatches.map((m) => [m.line, m.copy]), [[line, rel]]);
    const plain = await pinPaths([t.root], t.opts());
    assert.deepEqual([plain.lines, plain.coverage.files.unchanged], [[], 10]);
    const r = await pinPaths([t.root], t.opts({ rehash: true }));
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev]), [['recovered', rel, len(good), sha(good), { bytes: len(good), sha256: sha(good) }]]);
    assert.deepEqual([r.coverage.files, r.coverage.bytesCopied], [counts({ seen: 10, unchanged: 10 }), len(good)]);
    assert.deepEqual(r.notices, [`1 copy in '${t.to}' held other bytes than its last line in PINS.log records, and was written again from its source, which still holds that version (--rehash), with a recovered line each.`]);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), good);
    checkClean(await checkPin(t.to));
    // a copy that holds its version is left as it is by --rehash: no line
    assert.deepEqual((await pinPaths([t.root], t.opts({ rehash: true }))).lines, []);
  } finally { t.clean(); }
});

test('pin, a copy missing from the pin whose source has been rewritten since: nothing can keep its version, and a notice says that version is lost (pin[2])', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${P}/sess-named.jsonl`;
    rmSync(t.pin(rel));
    writeFileSync(t.src(rel), L5);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.kept]), [['rewritten', rel, undefined]]);
    assert.deepEqual(r.notices, [`1 copy was missing from '${t.to}' while its source had been rewritten: the version its last line in PINS.log records is lost, and a check of the pin reports it at that line.`]);
    assert.deepEqual((await checkPin(t.to)).mismatches.map((m) => m.line), [RELS.indexOf(rel) + 2]);
  } finally { t.clean(); }
});

test('check: a lock held by a running pin is waited for, as a pin waits for it, then the pin is read; still held after the wait, the check is busy; a lock whose pid no longer runs is not waited for (pin[5])', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const holder = { pid: process.ppid, host: hostname(), started: '2026-11-08T10:00:00.000Z' };
    plantLock(t, holder);
    setTimeout(() => unlinkSync(lockOf(t)), 300);
    let t0 = Date.now();
    const k = await checkPin(t.to, { lockWaitMs: 10000 });
    assert.ok(Date.now() - t0 >= 300, `the check did not wait: ${Date.now() - t0} ms`);
    checkClean(k);
    assert.equal(k.lock, null);
    plantLock(t, holder);
    const b = await checkPin(t.to, { lockWaitMs: 200 });
    assert.deepEqual([b.k, b.holder, b.otherHost, b.lock], ['busy', holder, false, lockOf(t)]);
    assert.ok(b.waitedMs >= 200 && b.message.includes(`rm '${lockOf(t)}'`), b.message);
    const dead = { ...holder, pid: deadPid() };
    plantLock(t, dead);
    t0 = Date.now();
    const d = await checkPin(t.to, { lockWaitMs: 10000 });
    assert.ok(Date.now() - t0 < 5000, `waited ${Date.now() - t0} ms for a pin that is not running`);
    assert.deepEqual([d.k, d.lock], ['checked', dead]);
  } finally { t.clean(); }
});

test('check: a pin that takes the lock while the check runs (after its wait): a notice says so, since what that pin writes can read as damage (pin[5])', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const holder = { pid: process.ppid, host: hostname(), started: '2026-11-08T10:00:00.000Z' };
    const p = checkPin(t.to, { lockWaitMs: 0 });   // no lock at its start: it reads on, yielding between copies
    setImmediate(() => writeFileSync(lockOf(t), JSON.stringify(holder)));
    const k = await p;
    assert.deepEqual([k.k, k.lock], ['checked', holder]);
    assert.deepEqual(k.notices, [`a pin took the lock '${lockOf(t)}' while this check ran (pid ${holder.pid} on ${holder.host}, since ${holder.started}): a copy it was writing can read as damage here; check again when it is done.`]);
  } finally { t.clean(); }
});

test("pin, the files under a session directory's mcp-tasks/ are pinned, as the cleanup deletes them with the session (addition g)", async () => {
  const t = tree();
  try {
    const rel = `${P}/${SA}/mcp-tasks/task-0001.json`, body = '{"invented":"an MCP task"}';
    t.put(rel, body);
    const r = await pinPaths([t.src(P)], t.opts());
    assert.ok(r.lines.some((l) => l.rel === rel && l.how === 'new'), JSON.stringify(r.lines.map((l) => l.rel)));
    assert.equal(readFileSync(t.pin(rel), 'utf8'), body);
    assert.equal(r.coverage.skipped.notSessionShaped, 4);   // the project's own four (notes.txt, y.txt, raw/'s copy, README.txt)
  } finally { t.clean(); }
});

test("claudeConfigDir: $CLAUDE_CONFIG_DIR, else (also when it is empty) the home directory's .claude, and which of the two (merge 10)", () => {
  const saved = { c: process.env.CLAUDE_CONFIG_DIR, h: process.env.HOME };
  try {
    process.env.CLAUDE_CONFIG_DIR = '/an/invented/config';
    assert.deepEqual(claudeConfigDir(), { path: '/an/invented/config', fromEnv: true });
    process.env.HOME = '/an/invented/home';
    for (const unset of [undefined, '']) {
      if (unset === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = unset;
      assert.deepEqual(claudeConfigDir(), { path: join('/an/invented/home', '.claude'), fromEnv: false }, JSON.stringify(unset));
    }
  } finally {
    process.env.CLAUDE_CONFIG_DIR = saved.c;
    if (saved.h === undefined) delete process.env.HOME; else process.env.HOME = saved.h;
  }
});

test('pin, a pin directory open to other users is pinned into, with a notice giving its mode and the chmod command; at 0700, no notice (pin[15])', { skip: process.platform === 'win32' && 'modes do not apply on win32' }, async () => {
  const t = tree();
  try {
    mkdirSync(t.to);
    chmodSync(t.to, 0o755);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.k, r.coverage.files.new], ['pinned', 10]);
    // S358 last fix [9]: the notice no longer says they cannot read pin's files, which is not so when they can write there
    assert.deepEqual(r.notices, [`the pin directory '${t.to}' is open to other users (mode 0755): those its mode lets read it can list the names in it, and those it lets write into it can replace pin's files with their own. To close it: chmod 700 '${t.to}'`]);
    chmodSync(t.to, 0o700);
    assert.deepEqual((await pinPaths([t.root], t.opts())).notices, []);
  } finally { t.clean(); }
});

// ---- adopted from the verifier's throwaway tests (verify-pin/throwaway/), each red on its mutant -------------------

test('check: a PINS.log line whose rel leads out of the pin (a .. segment) is not a log line, and no copy outside the pin is read (M01)', async () => {
  const t = tree();
  try {
    await pinPaths([t.src(Q)], t.opts());
    const outside = join(t.tmp, 'outside.txt');
    writeFileSync(outside, 'an invented file outside the pin\n');
    const b = readFileSync(outside), raw = logText(t.to).split('\n').filter((l) => l !== '');
    appendFileSync(join(t.to, 'PINS.log'), JSON.stringify({ t: '2026-11-08T10:00:00.000Z', rel: `${Q}/../../outside.txt`, how: 'new', bytes: b.length, sha256: sha(b), prev: null, mtime: '2026-11-08T10:00:00.000000000Z', chain: sha(raw.at(-1)) }) + '\n');
    const c = await checkPin(t.to);
    assert.deepEqual([c.unreadableLines, c.versions, c.files], [[3], 1, 1]);
  } finally { t.clean(); }
});

test('pin, a kept copy that recovery records (a pin stopped right after its link) is not counted in keptSourceGone (M03)', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`;
    await pinPaths([t.src(Q)], t.opts());
    writeFileSync(t.src(rel), L4);
    await assert.rejects(pinPaths([t.src(Q)], t.opts({ onStep(step) { if (step === 'linked') throw new Error('stopped after the link'); } })), /stopped after the link/);
    writeFileSync(t.src(rel), L5);
    const r = await pinPaths([t.src(Q)], t.opts());
    assert.ok(r.lines.some((l) => l.how === 'recovered' && /\.superseded-[0-9a-f]{12}\.jsonl$/.test(l.rel ?? '')), 'precondition: the kept copy has its own recovered line');
    assert.equal(r.coverage.keptSourceGone, 0);
  } finally { t.clean(); }
});

test("pin, a file in a pin that is not of the pin's shape is never adopted by recovery (M09)", async () => {
  const t = tree();
  try {
    await pinPaths([t.src(Q)], t.opts());
    writeFileSync(join(t.to, Q, 'notes.txt'), 'an invented note of my own\n');
    assert.deepEqual((await pinPaths([t.src(Q)], t.opts())).lines, []);
  } finally { t.clean(); }
});

test('check: a root line after line 1 is not the root: the check keeps line 1\'s, and reports the later one as not a log line (M10)', async () => {
  const t = tree();
  try {
    await pinPaths([t.src(Q)], t.opts());
    const raw = logText(t.to).split('\n').filter((l) => l !== '');
    appendFileSync(join(t.to, 'PINS.log'), JSON.stringify({ t: '2026-11-08T10:00:00.000Z', how: 'root', root: join(t.tmp, 'elsewhere'), ltms: 'x', chain: sha(raw.at(-1)) }) + '\n');
    const c = await checkPin(t.to);
    assert.deepEqual([c.root, c.unreadableLines], [t.root, [3]]);
  } finally { t.clean(); }
});

test('pin, the lock is removed only while it holds what this pin wrote: another holder\'s lock, put in its place, is left (M11)', async () => {
  const t = tree();
  try {
    const other = JSON.stringify({ pid: 4242, host: 'another-host.invalid', started: '2026-11-08T10:00:00.000Z' });
    const r = await pinPaths([t.src(Q)], t.opts({ onStep(step) { if (step === 'stat') { unlinkSync(lockOf(t)); writeFileSync(lockOf(t), other); } } }));
    assert.equal(r.k, 'pinned');
    assert.equal(readFileSync(lockOf(t), 'utf8'), other);
  } finally { t.clean(); }
});

test('pin, the notices of recovery: temp files removed (M12), a copy written again (M13), lines that are not log lines (M14), and a cut line named by its number (M23)', async () => {
  const t = tree();
  try {
    await pinPaths([t.src(Q)], t.opts());
    // half a write of the version a killed pin was writing: a prefix of it, which its source still holds (S367: a temp
    // holding bytes nothing else holds is kept, not removed)
    writeFileSync(join(t.to, Q, `.${SB}.jsonl.ltms-tmp-${deadPid()}`), (L1 + L2 + L3).slice(0, 12));
    rmSync(t.pin(`${Q}/${SB}.jsonl`));
    appendFileSync(join(t.to, 'PINS.log'), 'not a log line\n{"t":"cut sh');
    const r = await pinPaths([t.src(Q)], t.opts());
    assert.deepEqual(r.notices, [
      `'${join(t.to, 'PINS.log')}' did not end in a new line: line 4 was cut short; it is closed as it was, and the recovered line after it names it.`,
      `removed 1 temp file left in '${t.to}' by a pin that did not finish, each holding what a copy or its source holds.`,
      `'${join(t.to, 'PINS.log')}' has 1 line that is not a log line (first: line 3); it is passed over here, and a check of the pin reports it.`,
      `1 copy was missing from '${t.to}' and written again from its source, with a recovered line each.`,
    ]);
  } finally { t.clean(); }
});

test('check: mismatches come in the order of their lines in PINS.log, whatever the names of the copies (M15)', async () => {
  const t = tree();
  try {
    // q's line comes first, and p's copy comes first by name (-home-u-alpha before -home-u-beta)
    const q = `${Q}/${SB}.jsonl`, p = `${P}/sess-named.jsonl`;
    await pinPaths([t.src(q)], t.opts());
    await pinPaths([t.src(p)], t.opts());
    for (const rel of [q, p]) writeFileSync(t.pin(rel), '{"changed":true}\n');
    assert.deepEqual((await checkPin(t.to)).mismatches.map((m) => m.rel), [q, p]);
  } finally { t.clean(); }
});

test('check: an empty file pinned (a 0-byte version) checks clean (M19)', async () => {
  const t = tree();
  try {
    t.put(`${P}/${SA}/tool-results/empty.txt`, '');
    await pinPaths([t.src(`${P}/${SA}`)], t.opts());
    const c = await checkPin(t.to);
    checkClean(c);
    assert.equal(c.versions, 5);
  } finally { t.clean(); }
});

test('pin, a symbolic link met twice (listed in a project directory given, and as the <sid>/ of a <sid>.jsonl given) is counted once (M20)', { skip: process.platform === 'win32' && 'symbolic links need privileges on win32' }, async () => {
  const t = tree();
  try {
    const U = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
    t.put(`-home-u-delta/${U}.jsonl`, L1);
    mkdirSync(join(t.tmp, 'elsewhere'));
    symlinkSync(join(t.tmp, 'elsewhere'), t.src(`-home-u-delta/${U}`));
    const r = await pinPaths([t.src('-home-u-delta'), t.src(`-home-u-delta/${U}.jsonl`)], t.opts());
    assert.equal(r.coverage.skipped.symlinks, 1);
  } finally { t.clean(); }
});

test("pin, a waiting pin whose lock temp file is removed writes it again, and takes the lock when it is free (M28)", { skip: process.platform === 'win32' && 'needs sleep(1) as a running process' }, async () => {
  const t = tree();
  const holder = spawn('sleep', ['20']);
  try {
    plantLock(t, { pid: holder.pid, host: hostname(), started: '2026-11-08T10:00:00.000Z' });
    const p = pinPaths([t.src(Q)], t.opts({ lockWaitMs: 10000 }));
    await new Promise((r) => setTimeout(r, 350));
    unlinkSync(join(t.to, `..ltms-pin.lock.ltms-tmp-${process.pid}`));
    await new Promise((r) => setTimeout(r, 350));
    unlinkSync(lockOf(t));
    const r = await p;
    assert.deepEqual([r.k, r.failures, r.coverage?.files.new], ['pinned', [], 1]);
  } finally { holder.kill(); t.clean(); }
});

test("pin, a lock naming this process's pid, which this process did not take, is taken over (M30)", async () => {
  const t = tree();
  try {
    plantLock(t, { pid: process.pid, host: hostname(), started: '2026-11-08T10:00:00.000Z' });
    const r = await pinPaths([t.src(Q)], t.opts({ lockWaitMs: 300 }));
    assert.deepEqual([r.k, r.takeover?.pid], ['pinned', process.pid]);
  } finally { t.clean(); }
});

test('recovery names a waiting kept copy only when it holds the version the last line records (M36)', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, v1 = PINNED[rel];
    await pinPaths([t.src(Q)], t.opts());
    writeFileSync(t.pin(rel), '{"invented":"other, longer bytes than the first version had"}\n');   // its size differs: read
    writeFileSync(t.pin(`${Q}/${SB}.superseded-${sha12(v1)}.jsonl`), '{"not":"v1"}\n');           // other bytes than v1
    const r = await pinPaths([t.src(Q)], t.opts());
    const line = r.lines.find((l) => l.rel === rel && l.how === 'recovered');
    assert.ok(line, 'precondition: a recovered line for the copy');
    assert.equal(line.kept, undefined);
  } finally { t.clean(); }
});

test('check: files counts only the copies read; a missing copy is a mismatch with got null (M41)', async () => {
  const t = tree();
  try {
    await pinPaths([t.src(P)], t.opts());
    rmSync(t.pin(`${P}/sess-named.jsonl`));
    const c = await checkPin(t.to);
    assert.deepEqual([c.versions, c.files, c.mismatches.map((m) => m.got)], [9, 8, [null]]);
  } finally { t.clean(); }
});

// ---- the command: ltms pin -----------------------------------------------------------------------------------------
// dist/cli.js in a child process, CLAUDE_CONFIG_DIR set to the tree's stand-in config, the current directory the tree's
// temp directory (so a relative path the command wrongly wrote would show up there). Expected values come from the
// tree's own bytes, as above.

const CLI = process.env.LTMS_CLI || join(here, '..', 'dist', 'cli.js');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ltms run with the tree's config: its exit status, the signal that ended it, stdout and stderr. */
function ltms(t, args, { input, cwd = t.tmp, env = {}, stdio } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000, cwd, input, stdio,
    env: { ...process.env, CLAUDE_CONFIG_DIR: t.config, ...env } });
  if (r.error) throw r.error;
  return { code: r.status, signal: r.signal, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const rowsOf = (out) => out.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
/** The sentence before the --rehash command in --check's closing line (S358, notes-F3: in place of PinMismatch.restorable). */
const REHASH = 'To write back into the current copies what their sources still hold (ltms pin --check, run again, then says what remains):';
/** --check's words on the files behind the pin when its closing line gives the --rehash command (0.1.2). */
const REHASH_FIRST = 'To pin them, first run the --rehash command above: a pin run before it may record a damaged copy as a version. ltms pin --check, run again, then says what remains.';
/** The --rehash command at the end of --check's closing line, as printed, or null when the line gives none. */
const rehashOf = (err) => err.split('\n').find((l) => l.includes(REHASH))?.split(`${REHASH} `)[1] ?? null;
/** A command line ltms printed, run by /bin/sh as a user pastes it, with ltms a function that runs this build. */
function runPrinted(t, line) {
  const sh = spawnSync('/bin/sh', ['-c', `ltms() { "$PIN_TEST_NODE" "$PIN_TEST_CLI" "$@"; }; ${line}`], { encoding: 'utf8', cwd: t.tmp, timeout: 60000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: t.config, PIN_TEST_NODE: process.execPath, PIN_TEST_CLI: CLI } });
  if (sh.error) throw sh.error;
  return { code: sh.status, out: sh.stdout ?? '', err: sh.stderr ?? '' };
}
const COVERAGE_KEYS = ['k', 'root', 'to', 'files', 'failures', 'partial', 'skipped', 'bytesCopied', 'keptSourceGone', 'lastLog', 'ms'];
const FILES_KEYS = ['seen', 'new', 'grown', 'rewritten', 'unchanged', 'notCopied', 'failed'];
const SKIPPED_KEYS = ['notSessionShaped', 'symlinks', 'memory', 'git'];
const CHECK_KEYS = ['k', 'dir', 'root', 'lines', 'versions', 'files', 'mismatches', 'chainBreaks', 'unreadableLines', 'unlogged', 'temps', 'lock', 'lastLog', 'staleness', 'ms'];
const STALENESS_KEYS = ['root', 'fromLog', 'sources', 'missing', 'longer', 'unfinished', 'projectsNotPinned', 'failed'];
const BYTES = RELS.reduce((n, rel) => n + len(PINNED[rel]), 0);

/** A pin that finds its lock held by a running pid on this host waits the command's 30 s, then exits 1. Started when
 *  this file loads, so the wait runs beside the other tests; its test, at the end, awaits it. */
const busyRun = (() => {
  const t = tree();
  const holder = { pid: process.pid, host: hostname(), started: '2026-11-08T10:00:00.000Z' };
  plantLock(t, holder);
  const t0 = Date.now();
  const child = spawn(process.execPath, [CLI, 'pin', t.root, '--to', t.to], { cwd: t.tmp, env: { ...process.env, CLAUDE_CONFIG_DIR: t.config } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ t, holder, code, out, err, ms: Date.now() - t0 })));
})();
after(async () => { (await busyRun).t.clean(); });   // also when its test is filtered out by name
/** --check meets a lock held by a running pid on this host: it waits the command's 30 s too, then exits 1. Started when
 *  this file loads, beside busyRun. */
const checkBusyRun = (() => {
  const t = tree();
  const holder = { pid: process.pid, host: hostname(), started: '2026-11-08T10:00:00.000Z' };
  plantLock(t, holder);
  const t0 = Date.now();
  const child = spawn(process.execPath, [CLI, 'pin', '--check', t.to], { cwd: t.tmp, env: { ...process.env, CLAUDE_CONFIG_DIR: t.config } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ t, holder, code, out, err, ms: Date.now() - t0 })));
})();
after(async () => { (await checkBusyRun).t.clean(); });

test('ltms pin <path> --to <dir>: exit 0; stdout is one coverage line, its fields in the documented order, its counts as the tree was built; nothing on stderr; the pin directory 0700 and PINS.log 0600; a second run reads unchanged', () => {
  const t = tree();
  try {
    const r = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual([r.code, r.err], [0, '']);
    const rows = rowsOf(r.out);
    assert.equal(rows.length, 1);
    const c = rows[0];
    assert.deepEqual([Object.keys(c), Object.keys(c.files), Object.keys(c.skipped)], [COVERAGE_KEYS, FILES_KEYS, SKIPPED_KEYS]);
    assert.deepEqual({ ...c, ms: 0 }, { k: 'coverage', root: t.root, to: t.to, files: counts({ seen: 10, new: 10 }), failures: 0, partial: 0,
      skipped: BASE_SKIPPED, bytesCopied: BYTES, keptSourceGone: 0, lastLog: logLines(t.to).at(-1).t, ms: 0 });
    assert.ok(Number.isInteger(c.ms) && c.ms >= 0);
    for (const rel of RELS) assert.deepEqual(readFileSync(t.pin(rel)), Buffer.from(PINNED[rel]), rel);
    assert.deepEqual([modeOf(t.to), modeOf(join(t.to, 'PINS.log'))], [0o700, 0o600]);
    const again = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual([again.code, again.err, rowsOf(again.out).length, rowsOf(again.out)[0].files], [0, '', 1, counts({ seen: 10, unchanged: 10 })]);
  } finally { t.clean(); }
});

test('ltms pin --list: one line per line appended to PINS.log for a file, after the coverage line, in rel order: new, then rewritten and grown with prev and kept; without --list, the coverage line alone', () => {
  const t = tree();
  try {
    const first = ltms(t, ['pin', t.root, '--to', t.to, '--list']);
    assert.equal(first.code, 0, first.err);
    assert.deepEqual(rowsOf(first.out).slice(1), RELS.map((rel) => ({ k: 'pin', rel, how: 'new', bytes: len(PINNED[rel]), prev: null })));
    const grown = `${Q}/${SB}.jsonl`, rewritten = `${P}/sess-named.jsonl`;
    appendFileSync(t.src(grown), L4);
    writeFileSync(t.src(rewritten), L5);
    const second = ltms(t, ['pin', '--list', t.root, '--to', t.to]);
    assert.equal(second.code, 0, second.err);
    const rows = rowsOf(second.out);
    assert.deepEqual(rows[0].files, counts({ seen: 10, grown: 1, rewritten: 1, unchanged: 8 }));
    assert.deepEqual(rows.slice(1), [
      { k: 'pin', rel: rewritten, how: 'rewritten', bytes: len(L5), prev: len(L2), kept: `${P}/sess-named.superseded-${sha12(L2)}.jsonl` },
      { k: 'pin', rel: grown, how: 'grown', bytes: len(L1 + L2 + L3 + L4), prev: len(L1 + L2 + L3) },
    ]);
    appendFileSync(t.src(grown), L5);
    const third = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual(rowsOf(third.out).map((o) => o.k), ['coverage']);
    assert.equal(rowsOf(third.out)[0].files.grown, 1);
  } finally { t.clean(); }
});

test('ltms pin --rehash: a same-size rewrite with its mtime put back reads unchanged without it, and rewritten with it', () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, old = L1 + L2 + L3, neu = old.replace('invented', 'INVENTED');
    utimesSync(t.src(rel), 1700000000, 1700000000);   // a whole second: an mtime that can be put back exactly
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    writeFileSync(t.src(rel), neu); utimesSync(t.src(rel), 1700000000, 1700000000);
    assert.deepEqual(rowsOf(ltms(t, ['pin', t.root, '--to', t.to]).out)[0].files, counts({ seen: 10, unchanged: 10 }));
    const r = ltms(t, ['pin', t.root, '--to', t.to, '--rehash']);
    assert.deepEqual([r.code, rowsOf(r.out)[0].files], [0, counts({ seen: 10, rewritten: 1, unchanged: 9 })]);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), neu);
  } finally { t.clean(); }
});

test("ltms pin, the option forms: --to=<dir>, options before and after the paths, -- before a path that starts with '-' (as every project directory's name does), relative to the current directory; --root <dir> and --root=<dir>", () => {
  const t = tree();
  try {
    const r = ltms(t, ['pin', `--to=${t.to}`, '--', Q], { cwd: t.root });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(rowsOf(r.out)[0].files, counts({ seen: 1, new: 1 }));
    assert.deepEqual(filesUnder(t.to), ['PINS.log', `${Q}/${SB}.jsonl`].sort());
    const bare = ltms(t, ['pin', Q, '--to', t.to], { cwd: t.root });
    assert.deepEqual([bare.code, bare.out], [2, '']);
    assert.match(bare.err, new RegExp(`^ltms pin: unknown option '${escapeRe(Q)}'\\. .*; put -- before a path that starts with '-'\\.\\n$`));
    const alt = join(t.tmp, 'alt-root'), altTo = join(t.tmp, 'alt-pins');
    mkdirSync(join(alt, 'proj'), { recursive: true });
    writeFileSync(join(alt, 'proj', `${SA}.jsonl`), L1);
    for (const args of [['--root', alt], [`--root=${alt}`]]) {
      rmSync(altTo, { recursive: true, force: true });
      const a = ltms(t, ['pin', join(alt, 'proj'), ...args, '--to', altTo]);
      assert.equal(a.code, 0, a.err);
      assert.deepEqual([rowsOf(a.out)[0].root, rowsOf(a.out)[0].files.new, logLines(altTo)[0].root], [alt, 1, alt], args.join(' '));
    }
  } finally { t.clean(); }
});

test("ltms pin, the default config directory: $CLAUDE_CONFIG_DIR, else (also when it is empty) the home directory's .claude, as the messages and the root show", () => {
  const t = tree();
  try {
    const home = join(t.tmp, 'home'), config = join(home, '.claude');
    mkdirSync(join(config, 'projects', 'proj'), { recursive: true });
    writeFileSync(join(config, 'projects', 'proj', `${SA}.jsonl`), L1);
    for (const env of [{ HOME: home, CLAUDE_CONFIG_DIR: '' }, { HOME: home, CLAUDE_CONFIG_DIR: undefined }]) {
      const e = ltms(t, ['pin'], { env });
      assert.equal(e.code, 2);
      assert.ok(e.err.includes(`outside Claude Code's config directory '${config}', e.g. ltms pin '${join(config, 'projects')}' --to ~/claude-pins`), e.err);
      const r = ltms(t, ['pin', join(config, 'projects', 'proj'), '--to', join(t.tmp, 'home-pins')], { env });
      assert.equal(r.code, 0, r.err);
      assert.equal(rowsOf(r.out)[0].root, join(config, 'projects'));
      rmSync(join(t.tmp, 'home-pins'), { recursive: true, force: true });
    }
    const set = ltms(t, ['pin'], { env: { HOME: home } });   // the tree's config, set by the helper
    assert.ok(set.err.includes(`config directory '${t.config}'`), set.err);
  } finally { t.clean(); }
});

test('ltms pin, usage errors: exit 2, nothing on stdout, nothing written, and the message echoes the input and gives the next step', () => {
  const t = tree();
  try {
    const root = escapeRe(t.root), to = escapeRe(t.to), config = escapeRe(t.config);
    const cases = [
      [['pin'], new RegExp(`^ltms pin: no paths and no --to: name the directory to write the copies into, outside Claude Code's config directory '${config}', e\\.g\\. ltms pin '${root}' --to ~/claude-pins\\n$`)],
      [['pin', t.root], new RegExp(`^ltms pin: no --to: name the directory to write the copies into, outside Claude Code's config directory '${config}', e\\.g\\. ltms pin '${root}' --to ~/claude-pins\\n$`)],
      [['pin', '--from-hook'], /^ltms pin: no --to: .* e\.g\. ltms pin --from-hook --to ~\/claude-pins\n$/],
      [['pin', '--to', t.to], new RegExp(`^ltms pin: no paths: give the directories or files to pin, under the root '${root}', e\\.g\\. ltms pin '${root}' --to '${to}'; in a hook, ltms pin --from-hook --to '${to}'\\n$`)],
      [['pin', t.root, '--to'], /^ltms pin: --to needs a directory after it: --to <dir>\.\n$/],
      [['pin', t.root, '--to', '--list'], /^ltms pin: --to needs a directory after it, and '--list' starts with '-': for a directory whose name starts with '-', write --to=<dir> or --to \.\/<dir>\.\n$/],
      [['pin', t.root, '--to', '-x'], /^ltms pin: --to needs a directory after it, and '-x' starts with '-': for a directory whose name starts with '-', write --to=<dir> or --to \.\/<dir>\.\n$/],   // C21
      [['pin', t.root, '--to', ''], /^ltms pin: --to is empty: name a directory, --to <dir>\.\n$/],
      [['pin', t.root, '--to='], /^ltms pin: --to is empty: name a directory, --to <dir>\.\n$/],
      [['pin', t.root, '--to', 'a', '--to', 'b'], /^ltms pin: --to is given twice \('a' and 'b'\): give it once\.\n$/],
      [['pin', t.root, '--to', t.to, '--root', 'x', '--root=y'], /^ltms pin: --root is given twice \('x' and 'y'\): give it once\.\n$/],
      [['pin', '--check', 'x', '--check', 'y'], /^ltms pin: --check is given twice \('x' and 'y'\): give it once\.\n$/],
      [['pin', t.root, '--to', t.to, '--frobnicate'], /^ltms pin: unknown option '--frobnicate'\. The options are --to, --root, --from-hook, --check, --list, --rehash, --help and --version; put -- before a path that starts with '-'\.\n$/],
      [['pin', t.root, '--to', t.to, '--list=yes'], /^ltms pin: unknown option '--list=yes'\./],
      [['pin', '-', '--to', t.to], /^ltms pin: '-' is not a path: pin reads no file from standard input \(a hook's JSON comes in with --from-hook\)\.\n$/],
      [['pin', '--check', t.to, t.root], new RegExp(`^ltms pin: --check reads a pin and takes only --root besides it, and '${root}' was given too\\. To check: ltms pin --check '${to}'\\n$`)],
      [['pin', '--check', t.to, '--to', t.to, '--from-hook', '--list', '--rehash'], new RegExp(`^ltms pin: --check reads a pin and takes only --root besides it, and --to '${to}', --from-hook, --list, --rehash were given too\\. To check: ltms pin --check '${to}'\\n$`)],
      [['pin', '--from-hook', t.root, '--to', t.to], new RegExp(`^ltms pin: --from-hook takes the path from the hook's JSON, so it takes no paths, and '${root}' was given\\. In a hook: ltms pin --from-hook --to '${to}'\\n$`)],
    ];
    for (const [args, message] of cases) {
      const r = ltms(t, args);
      assert.deepEqual([r.code, r.out], [2, ''], args.join(' '));
      assert.match(r.err, message, args.join(' '));
    }
    assert.deepEqual(readdirSync(t.tmp), ['claude']);
  } finally { t.clean(); }
});

test("ltms pin, refusals: exit 2, nothing on stdout, nothing written; the library's sentence, echoing the input, then the next command", () => {
  const t = tree();
  try {
    const refused = (args, ...parts) => {
      const r = ltms(t, args);
      assert.deepEqual([r.code, r.out], [2, ''], args.join(' '));
      assert.ok(r.err.startsWith('ltms pin: ') && r.err.endsWith('\n') && r.err.split('\n').length === 2, r.err);
      for (const p of parts) assert.ok(r.err.includes(p), `${args.join(' ')}: '${p}' is not in: ${r.err}`);
      return r;
    };
    const inConfig = join(t.config, 'pins');
    refused(['pin', t.root, '--to', inConfig], `the pin directory '${inConfig}' is inside Claude Code's config directory '${t.config}', which its cleanup manages.`,
      ` Choose a directory outside it, e.g. ltms pin '${t.root}' --to ~/claude-pins`);
    const r0 = join(t.tmp, 'r'), p0 = join(r0, 'p');
    mkdirSync(p0, { recursive: true });
    refused(['pin', p0, '--root', r0, '--to', join(p0, 'pins')], `is inside '${p0}', a path given to pin.`,
      ` Choose a pin directory outside the paths given and outside the root, e.g. ltms pin '${p0}' --to ~/claude-pins`);
    refused(['pin', p0, '--root', r0, '--to', join(r0, 'pins')], `is inside the root '${r0}', whose files it would pin.`, ' Choose a pin directory outside the paths given');
    refused(['pin', p0, '--root', r0, '--to', t.tmp], `'${p0}' is inside the pin directory '${t.tmp}'.`,
      ` A pin is not pinned again: give paths under the root '${r0}'. To check this pin: ltms pin --check '${t.tmp}'`);
    const out = join(t.tmp, 'elsewhere');
    mkdirSync(out);
    refused(['pin', out, '--to', t.to], `'${out}' is outside the root '${t.root}'`,
      ` Give paths under '${t.root}', or name the root they are under: ltms pin '${out}' --to '${t.to}' --root <dir>`);
    assert.deepEqual(readdirSync(t.tmp).sort(), ['claude', 'elsewhere', 'r']);
    // a root other than the one PINS.log records, and a PINS.log that does not open with its root line
    assert.equal(ltms(t, ['pin', t.src(Q), '--to', t.to]).code, 0);
    const before = logText(t.to);
    // paths outside the root it records: that root would refuse them too, so the next command is another directory
    refused(['pin', p0, '--root', r0, '--to', t.to], `records the root '${t.root}', and this pin's root is '${r0}'`,
      ` The paths given are not under the root it records, so pin them into another directory, e.g. ltms pin '${p0}' --to ~/claude-pins --root '${r0}'`);
    // paths under the root it records: the same command with that root, which then runs
    refused(['pin', t.src(Q), '--root', t.config, '--to', t.to], `records the root '${t.root}', and this pin's root is '${t.config}'`,
      ` Pin with the root it records: ltms pin '${t.src(Q)}' --to '${t.to}' --root '${t.root}'; or pin into another directory (--to).`);
    assert.equal(logText(t.to), before);
    assert.equal(ltms(t, ['pin', t.src(Q), '--to', t.to, '--root', t.root]).code, 0);
    const bad = join(t.tmp, 'bad-log');
    mkdirSync(bad);
    writeFileSync(join(bad, 'PINS.log'), 'not a log line\n');
    refused(['pin', t.src(Q), '--to', bad], `'${join(bad, 'PINS.log')}' opens with another line`,
      ` Look at its first line: head -n 1 '${join(bad, 'PINS.log')}'; to start a pin elsewhere, give another --to.`);
    assert.deepEqual(readdirSync(bad), ['PINS.log']);
  } finally { t.clean(); }
});

test("ltms pin --from-hook: pins the directory of the hook's transcript_path, its project directory, and says so on stderr; a transcript outside the root is refused with --root as the next step", () => {
  const t = tree();
  try {
    const tp = t.src(`${P}/${SA}.jsonl`);
    const hook = JSON.stringify({ session_id: SA, transcript_path: tp, cwd: '/home/u/alpha', hook_event_name: 'SessionEnd', reason: 'other' });
    const r = ltms(t, ['pin', '--from-hook', '--to', t.to], { input: hook });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, `ltms pin: --from-hook: the hook names '${tp}', so the path to pin is its directory '${t.src(P)}'.\n`);
    const inP = RELS.filter((rel) => rel.startsWith(`${P}/`));
    assert.deepEqual(rowsOf(r.out)[0].files, counts({ seen: inP.length, new: inP.length }));
    assert.deepEqual(filesUnder(t.to), ['PINS.log', ...inP].sort());
    const away = join(t.tmp, 'away', 'proj', `${SA}.jsonl`);
    const o = ltms(t, ['pin', '--from-hook', '--to', t.to], { input: JSON.stringify({ transcript_path: away }) });
    assert.deepEqual([o.code, o.out], [2, '']);
    assert.ok(o.err.includes(`'${dirname(away)}' is outside the root '${t.root}'`) && o.err.includes(`--root <dir>`), o.err);
  } finally { t.clean(); }
});

test("ltms pin --from-hook, each bad input on standard input: exit 2, nothing written, what was wrong, never a value from the JSON (its keys only, label-checked), and how to try it by hand", () => {
  const t = tree();
  try {
    const SECRET = 'an invented prompt that must never be echoed';
    const notJson = `{"transcript_path": "${SECRET}"`;
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, SECRET]));
    const cases = [
      [{ input: '' }, 'standard input is empty'],
      [{ stdio: ['ignore', 'pipe', 'pipe'] }, 'standard input is empty'],
      [{ input: ' \n\t ' }, 'standard input holds only blanks (4 bytes)'],
      [{ input: notJson }, `standard input (${len(notJson)} bytes) is not JSON`],
      [{ input: '[1,2]' }, 'standard input holds JSON that is not an object (an array)'],
      [{ input: '"x"' }, 'standard input holds JSON that is not an object (a string)'],
      [{ input: '7' }, 'standard input holds JSON that is not an object (a number)'],
      [{ input: 'null' }, 'standard input holds JSON that is not an object (null)'],
      [{ input: JSON.stringify({ session_id: SA, prompt: SECRET, hook_event_name: 'UserPromptSubmit' }) }, 'its JSON object has no transcript_path (its keys: session_id, prompt, hook_event_name)'],
      [{ input: JSON.stringify({ 'a key with spaces': SECRET, '': SECRET, ok_key: SECRET }) }, 'its JSON object has no transcript_path (its keys: (withheld), (empty), ok_key)'],
      [{ input: JSON.stringify(many) }, 'its JSON object has no transcript_path (its keys: k0, k1, k2, k3, k4, k5, k6, k7, and 2 more)'],
      [{ input: '{}' }, 'its JSON object has no transcript_path (it has no keys)'],
      [{ input: JSON.stringify({ transcript_path: 42 }) }, 'its transcript_path is not a path (a number)'],
      [{ input: JSON.stringify({ transcript_path: null }) }, 'its transcript_path is not a path (null)'],
      [{ input: JSON.stringify({ transcript_path: '' }) }, 'its transcript_path is not a path (an empty string)'],
      [{ input: JSON.stringify({ transcript_path: [SECRET] }) }, 'its transcript_path is not a path (an array)'],
      [{ input: JSON.stringify({ transcript_path: { p: SECRET } }) }, 'its transcript_path is not a path (an object)'],
      [{ input: JSON.stringify({ transcript_path: true }) }, 'its transcript_path is not a path (a boolean)'],
      [{ input: 'true' }, 'standard input holds JSON that is not an object (a boolean)'],
    ];
    const byHand = ` In a hook, Claude Code writes that JSON; to try it by hand: printf '%s\\n' '{"transcript_path":"${t.root}/<project>/<session>.jsonl"}' | ltms pin --from-hook --to '${t.to}'\n`;
    for (const [opts, why] of cases) {
      const r = ltms(t, ['pin', '--from-hook', '--to', t.to], opts);
      assert.deepEqual([r.code, r.out], [2, ''], why);
      assert.equal(r.err, `ltms pin: --from-hook reads a Claude Code hook's JSON from standard input, and ${why}.${byHand}`);
      assert.ok(!r.err.includes(SECRET), `${why}: a value from the JSON is echoed`);
    }
    assert.deepEqual(readdirSync(t.tmp), ['claude']);
  } finally { t.clean(); }
});

/** util-linux script gives a child a terminal: script -qec <command> /dev/null runs it, and returns its status. */
const SCRIPT = process.platform === 'linux' && /util-linux/.test(spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout ?? '');
test('ltms pin --from-hook with a terminal on standard input: exit 2 at once, saying so, without waiting for input', { skip: !SCRIPT && 'needs util-linux script, to give the command a terminal' }, () => {
  const t = tree();
  try {
    const command = [process.execPath, CLI, 'pin', '--from-hook', '--to', t.to].map((a) => `'${a}'`).join(' ');
    const r = spawnSync('script', ['-qec', command, '/dev/null'], { encoding: 'utf8', timeout: 20000, cwd: t.tmp, env: { ...process.env, CLAUDE_CONFIG_DIR: t.config } });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /ltms pin: --from-hook reads a Claude Code hook's JSON from standard input, and standard input is a terminal\./);
    assert.equal(existsSync(t.to), false);
  } finally { t.clean(); }
});

test('ltms pin, a source that cannot be read: exit 1; a failure line after the coverage line, its fields in order; one closing line on stderr naming the first failure', { skip: NEEDS_PERMISSIONS }, () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`;
    chmodSync(t.src(rel), 0o000);
    const r = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.equal(r.code, 1);
    const rows = rowsOf(r.out);
    assert.deepEqual(rows.map((o) => o.k), ['coverage', 'failure']);
    assert.deepEqual([rows[0].files, rows[0].failures], [counts({ seen: 10, new: 9, failed: 1 }), 1]);
    assert.deepEqual(Object.keys(rows[1]), ['k', 'path', 'rel', 'op', 'code']);
    assert.deepEqual(rows[1], { k: 'failure', path: t.src(rel), rel, op: 'read', code: 'EACCES' });
    assert.equal(r.err, `ltms pin: 1 failure, each named on stdout ("k":"failure": the path, the step and the error code; the first: read '${t.src(rel)}', EACCES). Every file pinned is whole and in PINS.log; once the cause is fixed, the same command pins the rest.\n`);
  } finally { t.clean(); }
});

test('ltms pin, failures without permissions: a given path that does not exist is a failure (exit 1, op walk, ENOENT), and the other paths are pinned', () => {
  const t = tree();
  try {
    const missing = t.src('-home-u-missing');
    const r = ltms(t, ['pin', missing, t.src(Q), '--to', t.to]);
    assert.equal(r.code, 1);
    const rows = rowsOf(r.out);
    assert.deepEqual([rows[0].files, rows[0].failures], [counts({ seen: 1, new: 1 }), 1]);   // a path is not a file seen
    assert.deepEqual(rows.slice(1), [{ k: 'failure', path: missing, rel: '-home-u-missing', op: 'walk', code: 'ENOENT' }]);
    assert.match(r.err, new RegExp(`^ltms pin: 1 failure, each named on stdout .*the first: walk '${escapeRe(missing)}', ENOENT\\)`));
  } finally { t.clean(); }
});

test('ltms pin, nothing of the sweep\'s shape under the paths: exit 0, the zero counts, and a closing line saying what was passed over and what to pin instead', () => {
  const t = tree();
  try {
    const memory = t.src(`${P}/memory`), stray = t.src('stray.txt');
    const r = ltms(t, ['pin', memory, stray, '--to', t.to]);
    assert.equal(r.code, 0, r.err);
    const c = rowsOf(r.out)[0];
    assert.deepEqual([c.files, c.skipped], [counts({}), { notSessionShaped: 1, symlinks: 0, memory: 1, git: 0 }]);
    assert.equal(r.err, `ltms pin: nothing to pin under '${memory}', '${stray}': no file there is of a transcript's shape (<name>.jsonl and <name>.jsonl.superseded-* in a project directory, and the files under a session's subagents/, tool-results/, workflows/ and mcp-tasks/); passed over: 1 other file, 0 symbolic links, 1 memory/ directory and 0 .git directories. Pin a project directory under the root, e.g. ltms pin '${t.root}' --to '${t.to}'\n`);
  } finally { t.clean(); }
});

test('ltms pin, the notices of recovery reach stderr: a lock left by a pin that is gone is taken over (exit 0)', () => {
  const t = tree();
  try {
    const holder = { pid: deadPid(), host: hostname(), started: '2026-11-08T10:00:00.000Z' };
    plantLock(t, holder);
    const r = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, `ltms pin: took over the lock '${lockOf(t)}': pid ${holder.pid} took it at ${holder.started} and is no longer running on this host; PINS.log has a takeover line.\n`);
    assert.equal(existsSync(lockOf(t)), false);
  } finally { t.clean(); }
});

test('ltms pin --check: a clean pin is exit 0 with one line, its fields in the documented order, nothing on stderr; --check=<dir> and --root are read', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.code, r.err], [0, '']);
    const rows = rowsOf(r.out);
    assert.equal(rows.length, 1);
    assert.deepEqual([Object.keys(rows[0]), Object.keys(rows[0].staleness)], [CHECK_KEYS, STALENESS_KEYS]);
    assert.deepEqual({ ...rows[0], ms: 0 }, { k: 'check', dir: t.to, root: t.root, lines: 11, versions: 10, files: 10, mismatches: 0, chainBreaks: 0,
      unreadableLines: 0, unlogged: 0, temps: 0, lock: null, lastLog: logLines(t.to).at(-1).t,
      staleness: { root: t.root, fromLog: true, sources: 10, missing: 0, longer: 0, unfinished: 0, projectsNotPinned: 0, failed: 0 }, ms: 0 });
    const g = ltms(t, ['pin', `--check=${t.to}`, '--root', t.root]);
    assert.deepEqual([g.code, rowsOf(g.out)[0].staleness.fromLog], [0, false]);
  } finally { t.clean(); }
});

test('ltms pin --check: a changed copy, a changed log line and a line that is not a log line are each exit 1, with their lines after the first, in order, and a closing line giving the sed command', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`, A3 = L1 + L2 + L3, B3 = A3.replace('first', 'FIRST');
    const log = join(t.to, 'PINS.log'), orig = readFileSync(log);
    const line = logLines(t.to).findIndex((l) => l.rel === rel) + 1;
    writeFileSync(t.pin(rel), B3);
    let r = ltms(t, ['pin', '--check', t.to]);
    let rows = rowsOf(r.out);
    assert.equal(r.code, 1);
    assert.deepEqual([rows[0].mismatches, rows[0].chainBreaks, rows[0].unreadableLines], [1, 0, 0]);
    assert.deepEqual(rows.slice(1), [{ k: 'mismatch', rel, copy: rel, line, want: { bytes: len(A3), sha256: sha(A3) }, got: { bytes: len(B3), sha256: sha(B3) } }]);
    assert.deepEqual(Object.keys(rows[1]), ['k', 'rel', 'copy', 'line', 'want', 'got']);
    assert.equal(r.err, `ltms pin: '${t.to}' does not hold what '${log}' records: 1 mismatch, 0 chain breaks and 0 lines that are not log lines, each on stdout with its line in PINS.log. To read the first: sed -n '${line}p' '${log}'. ${REHASH} ltms pin '${t.src(Q)}' --to '${t.to}' --root '${t.root}' --rehash\n`);
    // the command it gives, run: the copy is written again from its source, and the pin checks clean
    const fix = ltms(t, ['pin', t.src(Q), '--to', t.to, '--root', t.root, '--rehash']);
    assert.deepEqual([fix.code, readFileSync(t.pin(rel), 'utf8')], [0, A3], fix.err);
    assert.equal(ltms(t, ['pin', '--check', t.to]).code, 0);
    writeFileSync(t.pin(rel), A3);
    // a log line's time changed: the line after it no longer holds its sha256; then a line that is not a log line
    const raw = orig.toString('utf8').split('\n').filter((l) => l !== '');
    const o = JSON.parse(raw[2]); o.t = '2000-01-01T00:00:00.000Z';
    raw[2] = JSON.stringify(o);
    writeFileSync(log, raw.join('\n') + '\nnot a log line\n');
    r = ltms(t, ['pin', '--check', t.to]);
    rows = rowsOf(r.out);
    assert.equal(r.code, 1);
    // the line that is not a log line is reported as such; the chain is checked between log lines
    assert.deepEqual([rows[0].mismatches, rows[0].chainBreaks, rows[0].unreadableLines, rows[0].lines], [0, 1, 1, 12]);
    assert.deepEqual(rows.slice(1), [
      { k: 'chain', line: 4, want: sha(raw[2]), got: JSON.parse(raw[3]).chain },
      { k: 'unreadable', line: 12 },
    ]);
    assert.match(r.err, /: 0 mismatches, 1 chain break and 1 line that is not a log line, each on stdout with its line in PINS\.log\. To read the first: sed -n '4p' /);
  } finally { t.clean(); }
});

test('ltms pin --check, damage in a kept copy only: the closing line gives no --rehash command, since no source holds that version any more (pin[2])', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`, A = PINNED[rel];
    writeFileSync(t.src(rel), L4);
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);   // A is kept, by the sha12 of its bytes
    const kept = `${Q}/${SB}.superseded-${sha12(A)}.jsonl`, b = readFileSync(t.pin(kept));
    b[0] ^= 1;
    writeFileSync(t.pin(kept), b);
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.code, rowsOf(r.out).slice(1).map((o) => [o.k, o.rel, o.copy])], [1, [['mismatch', rel, kept]]]);
    assert.ok(r.err.includes("To read the first: sed -n '") && !r.err.includes('--rehash'), r.err);
  } finally { t.clean(); }
});

test('ltms pin --check: the four kinds of finding at once come in the documented order, mismatches, chain breaks, lines that are not log lines, unlogged files, each kind by line', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const relA = `${Q}/${SB}.jsonl`, relB = `${P}/sess-named.jsonl`;
    writeFileSync(t.pin(relA), 'changed');
    writeFileSync(t.pin(relB), 'changed too');
    const log = join(t.to, 'PINS.log');
    const raw = logText(t.to).split('\n').filter((l) => l !== '');
    raw[1] = JSON.stringify({ ...JSON.parse(raw[1]), t: '2000-01-01T00:00:00.000Z' });
    writeFileSync(log, raw.join('\n') + '\nnot a log line\n');
    const stray = `${Q}/66666666-6666-4666-8666-666666666666.jsonl`;
    writeFileSync(t.pin(stray), L5);
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.equal(r.code, 1);
    const lineOf = (rel) => raw.findIndex((l) => JSON.parse(l).rel === rel) + 1;
    assert.deepEqual(rowsOf(r.out).slice(1).map((o) => [o.k, o.line ?? o.rel]),
      [['mismatch', Math.min(lineOf(relA), lineOf(relB))], ['mismatch', Math.max(lineOf(relA), lineOf(relB))], ['chain', 3], ['unreadable', 12], ['unlogged', stray]]);
  } finally { t.clean(); }
});

test('ltms pin --check: an unlogged file, a temp file, a lock, and sources missing or longer are reported (exit 0), each with what happens next; a root that cannot be read is exit 1; a directory with no PINS.log is exit 2', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const stray = `${Q}/66666666-6666-4666-8666-666666666666.jsonl`;
    writeFileSync(t.pin(stray), L5);
    writeFileSync(join(t.to, Q, `.${SB}.jsonl.ltms-tmp-4242`), 'left over');
    const holder = { pid: deadPid(), host: hostname(), started: '2026-11-08T10:00:00.000Z' };   // a pin that stopped
    writeFileSync(lockOf(t), JSON.stringify(holder));
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), L4);
    t.put(`${Q}/77777777-7777-4777-8777-777777777777.jsonl`, L1);
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.equal(r.code, 0, r.err);
    const rows = rowsOf(r.out);
    assert.deepEqual([rows[0].unlogged, rows[0].temps, rows[0].lock, rows[0].staleness], [1, 1, holder,
      { root: t.root, fromLog: true, sources: 11, missing: 1, longer: 1, unfinished: 0, projectsNotPinned: 0, failed: 0 }]);
    assert.deepEqual(rows.slice(1), [{ k: 'unlogged', rel: stray }]);
    const lines = r.err.split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 4, r.err);
    assert.equal(lines[0], `ltms pin: 1 file in '${t.to}' is named by no line in PINS.log (on stdout, "k":"unlogged"); the next pin records each with a recovered line.`);
    assert.equal(lines[1], `ltms pin: 1 temp file in '${t.to}' was left by a pin that stopped; the next pin removes it if a copy or its source holds what it holds, and otherwise keeps it as a kept copy.`);
    assert.equal(lines[2], `ltms pin: '${lockOf(t)}' names pid ${holder.pid} on ${hostname()}, since 2026-11-08T10:00:00.000Z: a pin is running, or one stopped without removing it (the next pin takes over a lock whose pid is no longer running on this host).`);
    assert.match(lines[3], new RegExp(`^ltms pin: 1 file under the root '${escapeRe(t.root)}' is missing from the pin, and 1 is longer than its copy \\(PINS\\.log's last line: ${escapeRe(rows[0].lastLog)}, \\d+ min ago\\)\\. To pin them: ltms pin '${escapeRe(t.root)}' --to '${escapeRe(t.to)}' --root '${escapeRe(t.root)}'$`));
    const none = join(t.tmp, 'no-such-root');
    const f = ltms(t, ['pin', '--check', t.to, '--root', none]);
    assert.equal(f.code, 1);
    assert.deepEqual(rowsOf(f.out)[0].staleness, { root: none, fromLog: false, sources: 0, missing: 0, longer: 0, unfinished: 0, projectsNotPinned: 0, failed: 1 });
    assert.ok(f.err.includes(`ltms pin: the root '${none}' could not be read (ENOENT), so no file under it was counted, and the counts of files missing from the pin are short of the truth. Check it: ls -ld '${none}'\n`), f.err);
    const n = ltms(t, ['pin', '--check', t.tmp]);
    assert.deepEqual([n.code, n.out], [2, '']);
    assert.equal(n.err, `ltms pin: '${t.tmp}' holds no PINS.log, so it is not a pin this check can read. Give the directory a pin wrote into (the --to of ltms pin): ltms pin --check <dir>\n`);
  } finally { t.clean(); }
});

test('ltms pin, SIGTERM while pinning: the process ends by the signal (or has finished); either way no lock is left, the pin checks clean, and the next pin completes it', async () => {
  const t = tree();
  try {
    for (let i = 0; i < 400; i++) t.put(`${P}/${SA}/tool-results/c${String(i).padStart(8, '0')}.txt`, `invented output ${i}\n`);
    const child = spawn(process.execPath, [CLI, 'pin', t.root, '--to', t.to], { cwd: t.tmp, env: { ...process.env, CLAUDE_CONFIG_DIR: t.config } });
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    let ended = false;
    closed.then(() => { ended = true; });
    for (let waited = 0; !ended && !existsSync(lockOf(t)) && waited < 10000; waited += 2) await new Promise((r) => setTimeout(r, 2));
    if (!ended) child.kill('SIGTERM');
    const { code, signal } = await closed;
    // how it ended, in every message: the code, the signal, what the lock holds when it is left, and whether PINS.log
    // was made (a lock left with no PINS.log is a signal that came between the lock and the listeners)
    const lock = existsSync(lockOf(t)) ? readFileSync(lockOf(t), 'utf8') : null;
    const ending = `code ${code}, signal ${signal}, child pid ${child.pid}, the lock ${lock === null ? 'removed' : `left, holding ${lock}`}, PINS.log ${existsSync(join(t.to, 'PINS.log')) ? 'made' : 'not made'}`;
    assert.ok(signal === 'SIGTERM' || code === 0, ending);
    assert.equal(lock, null, ending);
    const k = ltms(t, ['pin', '--check', t.to]);
    assert.equal(k.code, 0, k.err);
    assert.deepEqual([rowsOf(k.out)[0].mismatches, rowsOf(k.out)[0].chainBreaks], [0, 0]);
    const again = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.equal(again.code, 0, again.err);
    assert.equal(rowsOf(again.out)[0].files.seen, 410);
    assert.deepEqual(rowsOf(ltms(t, ['pin', '--check', t.to]).out)[0].staleness.missing, 0);
  } finally { t.clean(); }
});

// ---- the command: the repair round (S358). Each test was run red first on the merged build, unless it says it is a
// guard; the adopted ones are named by the verifier's mutant they kill.

test("ltms pin, a --to that is a file, or that holds files and no PINS.log: exit 2, nothing written, and a next command that then pins (pin[3], pin[9])", () => {
  const t = tree();
  try {
    const file = join(t.tmp, 'a-file');
    writeFileSync(file, 'x');
    const f = ltms(t, ['pin', t.src(Q), '--to', file]);
    assert.deepEqual([f.code, f.out], [2, '']);
    assert.equal(f.err, `ltms pin: the pin directory '${file}' exists and is not a directory (a file), so pin cannot write its copies into it. Give a directory, new or a pin, e.g. ltms pin '${t.src(Q)}' --to ~/claude-pins\n`);
    const held = join(t.tmp, 'backup');
    mkdirSync(held);
    writeFileSync(join(held, 'mine.txt'), 'an invented file of my own');
    const h = ltms(t, ['pin', t.src(Q), '--to', held]);
    assert.deepEqual([h.code, h.out], [2, '']);
    assert.equal(h.err, `ltms pin: the pin directory '${held}' already holds 'mine.txt', and no PINS.log: it is not a pin, and pin does not write among files it did not make. Pin into a directory of its own, e.g. ltms pin '${t.src(Q)}' --to '${join(held, 'claude-pins')}'; what it holds now: ls -A '${held}'\n`);
    assert.deepEqual(readdirSync(held), ['mine.txt']);
    const again = ltms(t, ['pin', t.src(Q), '--to', join(held, 'claude-pins')]);
    assert.deepEqual([again.code, rowsOf(again.out)[0].files.new], [0, 1], again.err);
  } finally { t.clean(); }
});

test('ltms pin, a pin directory whose name holds a quote: the next command it prints is one the shell reads back, and it runs (pin[14])', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    const to = join(t.tmp, "it's pins");
    assert.equal(ltms(t, ['pin', t.root, '--to', to]).code, 0);
    const r = ltms(t, ['pin', join(to, Q), '--to', to]);
    assert.equal(r.code, 2);
    const next = /To check this pin: (ltms pin --check .*)$/m.exec(r.err)?.[1];
    assert.ok(next, r.err);
    const sh = spawnSync('/bin/sh', ['-c', `ltms() { "$PIN_TEST_NODE" "$PIN_TEST_CLI" "$@"; }; ${next}`], { encoding: 'utf8', cwd: t.tmp,
      env: { ...process.env, CLAUDE_CONFIG_DIR: t.config, PIN_TEST_NODE: process.execPath, PIN_TEST_CLI: CLI } });
    assert.equal(sh.status, 0, `${next}: ${sh.stderr}`);
    assert.equal(rowsOf(sh.stdout)[0].dir, to);
  } finally { t.clean(); }
});

test('ltms pin, a project directory under the root that is a symbolic link: a pin of it, by hand or by the hook, is refused, saying it is a link and where it leads, with the command that pins there; a whole-root pin counts it in symlinks (pin[16])', { skip: process.platform === 'win32' && 'symbolic links need privileges on win32' }, () => {
  const t = tree();
  try {
    const away = join(t.tmp, 'other-disk', '-home-u-moved');
    mkdirSync(away, { recursive: true });
    writeFileSync(join(away, `${SA}.jsonl`), L1);
    const link = t.src('-home-u-moved');
    symlinkSync(away, link);
    const next = ` '${link}' is a symbolic link to '${away}', and pin measures a path by where it leads, so it does not pin through a link. To pin where it leads, into a pin directory of its own: ltms pin '${away}' --to <dir> --root '${dirname(away)}'\n`;
    const r = ltms(t, ['pin', link, '--to', t.to]);
    assert.deepEqual([r.code, r.out], [2, '']);
    assert.ok(r.err.endsWith(next), r.err);
    const h = ltms(t, ['pin', '--from-hook', '--to', t.to], { input: JSON.stringify({ transcript_path: join(link, `${SA}.jsonl`) }) });
    assert.equal(h.code, 2);
    assert.ok(h.err.endsWith(next), h.err);
    const w = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual([w.code, rowsOf(w.out)[0].skipped.symlinks], [0, 2]);   // link.jsonl, and this one
  } finally { t.clean(); }
});

test("README: the cron line runs as written under cron's short PATH, which lacks node's directory: its own PATH names it (pin[4])", { skip: process.platform === 'win32' && 'cron and /bin/sh' }, () => {
  const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
  const cron = readme.split('\n').find((l) => /^\d+ [\d*]+ \* \* \* /.test(l));
  assert.ok(cron, 'no cron line');
  const t = tree();
  try {
    // the README's paths made real: /usr/local/bin holds node and ltms; /home/me is a home with a .claude in it
    const bin = join(t.tmp, 'usr-local-bin'), home = join(t.tmp, 'home-me'), empty = join(t.tmp, 'no-node-here');
    mkdirSync(bin);
    mkdirSync(empty);
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync(CLI, join(bin, 'ltms'));
    mkdirSync(join(home, '.claude', 'projects', '-home-me-app'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-home-me-app', `${SA}.jsonl`), L1);
    const command = cron.split(' ').slice(5).join(' ').replaceAll('/usr/local/bin', bin).replaceAll('/home/me', home);
    // cron runs the line with /bin/sh and a short PATH: here, one with no node in it at all
    const r = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: empty, HOME: home }, cwd: t.tmp });
    assert.equal(r.status, 0, `${command}: ${r.stderr}`);
    assert.deepEqual(rowsOf(readFileSync(join(home, 'claude-pins.log'), 'utf8')).map((o) => [o.k, o.files.new]), [['coverage', 1]]);
  } finally { t.clean(); }
});

test('ltms pin -v prints the version, as --version does (C01)', () => {
  const t = tree();
  try {
    assert.deepEqual([ltms(t, ['pin', '-v']).code, ltms(t, ['pin', '-v']).out], [0, `${VERSION}\n`]);
  } finally { t.clean(); }
});

test("ltms pin --check: the time of the last log line in hours, past 2 h (C09); a source only longer than its copy is reported on stderr (C10)", () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const raw = logText(t.to).trimEnd().split('\n'), last = JSON.parse(raw.at(-1));
    last.t = new Date(Date.now() - 3 * 3600_000).toISOString();
    raw[raw.length - 1] = JSON.stringify(last);   // the last line: no line chains to it
    writeFileSync(join(t.to, 'PINS.log'), raw.join('\n') + '\n');
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), L4);   // longer than its copy, and nothing missing
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, `ltms pin: 0 files under the root '${t.root}' are missing from the pin, and 1 is longer than its copy (PINS.log's last line: ${last.t}, 3 h ago). To pin them: ltms pin '${t.root}' --to '${t.to}' --root '${t.root}'\n`);
  } finally { t.clean(); }
});

test('ltms pin, an internal error inside pin.js: reported by its kind and its place in pin.js, never its message, with exit 1 (C13, C14)', () => {
  const t = tree();
  try {
    // a copy of the build whose pinPaths throws, its message holding a planted text
    const planted = join(t.tmp, 'planted'), dist = join(planted, 'dist');
    mkdirSync(dist, { recursive: true });
    for (const f of readdirSync(dirname(CLI))) writeFileSync(join(dist, f), readFileSync(join(dirname(CLI), f)));
    writeFileSync(join(planted, 'package.json'), readFileSync(join(dirname(CLI), '..', 'package.json')));
    const js = readFileSync(join(dist, 'pin.js'), 'utf8'), head = 'export async function pinPaths(paths, options) {';
    assert.equal(js.split(head).length, 2, 'the planted line is found once');
    writeFileSync(join(dist, 'pin.js'), js.replace(head, `${head} throw new TypeError('PLANTED-TRANSCRIPT-TEXT ' + paths[0]);`));
    const r = spawnSync(process.execPath, [join(dist, 'cli.js'), 'pin', t.src(Q), '--to', t.to], { encoding: 'utf8', cwd: t.tmp, env: { ...process.env, CLAUDE_CONFIG_DIR: t.config } });
    assert.deepEqual([r.status, r.stdout], [1, ''], r.stderr);
    assert.match(r.stderr, /^ltms pin: stopped with an internal error \(TypeError at pin\.js:\d+\)\. This is a bug in ltms/);
    assert.ok(!r.stderr.includes('PLANTED'), r.stderr);
  } finally { t.clean(); }
});

test('ltms pin --check: a line that is not a log line exits 1 also as the last line, where no chain breaks after it (C19)', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    appendFileSync(join(t.to, 'PINS.log'), 'not a log line\n');
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.code, rowsOf(r.out).slice(1)], [1, [{ k: 'unreadable', line: 12 }]]);
  } finally { t.clean(); }
});

test("source: cli.ts's comments say what pin and the a6 rule made true: a transcript is appended to and rarely rewritten, and the verb reads the command's end (pin[12])", () => {
  const comments = readFileSync(join(here, '..', 'src', 'cli.ts'), 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('//')).map((l) => l.slice(2).trim()).join(' ');
  assert.ok(!comments.includes('only ever appended'), 'a comment says the transcript is only ever appended to');
  assert.ok(comments.includes('it can rewrite one only in rare cases, and pin keeps both versions'), 'the header');
  assert.ok(comments.includes("What follows the program is never read, but for the command's end"), 'the verb');
});

test("ltms pin --help: pin's own part, naming every field the command prints in every mode; -h and --help anywhere print it; ltms --help gains the paragraph that points to it", () => {
  const t = tree();
  try {
    const h = ltms(t, ['pin', '--help']);
    assert.deepEqual([h.code, h.err], [0, '']);
    assert.ok(h.out.startsWith("ltms pin: copies of Claude Code's transcripts"), h.out.slice(0, 80));
    assert.equal(ltms(t, ['pin', '-h']).out, h.out);
    assert.equal(ltms(t, ['pin', t.root, '--help', '--to']).out, h.out);
    // every key the command prints, collected from its output in each mode, is named in its help as "key"
    const keys = new Set();
    const collect = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { keys.add(k); collect(v); } };
    const outputs = [ltms(t, ['pin', t.root, t.src('-home-u-missing'), '--to', t.to, '--list'])];
    writeFileSync(t.src(`${P}/sess-named.jsonl`), L5);
    outputs.push(ltms(t, ['pin', t.root, '--to', t.to, '--list']));
    writeFileSync(t.pin(`${Q}/${SB}.jsonl`), 'changed');
    const lines = logText(t.to).split('\n').filter((l) => l !== '');
    lines[1] = JSON.stringify({ ...JSON.parse(lines[1]), t: '2000-01-01T00:00:00.000Z' });   // the next line's chain breaks
    writeFileSync(join(t.to, 'PINS.log'), lines.join('\n') + '\nnot a log line\n');
    writeFileSync(t.pin(`${Q}/66666666-6666-4666-8666-666666666666.jsonl`), L5);
    outputs.push(ltms(t, ['pin', '--check', t.to]));
    for (const o of outputs) for (const row of rowsOf(o.out)) { collect(row); keys.add(row.k); }
    assert.ok(keys.size >= 40, `only ${keys.size} keys were collected`);
    for (const k of ['failure', 'pin', 'kept', 'mismatch', 'chain', 'unreadable', 'unlogged', 'staleness']) assert.ok(keys.has(k), `no output held '${k}'`);
    for (const k of keys) assert.ok(h.out.includes(`"${k}"`), `ltms pin --help does not name "${k}"`);
    for (const line of h.out.split('\n')) assert.ok(line.length <= 80, `a help line longer than 80 columns: ${line}`);
    const g = ltms(t, ['--help']).out;
    assert.match(g.replace(/\s+/g, ' '), /pin keeps copies of the transcripts that Claude Code's cleanup deletes \(after 30 days by default\), in a directory of your own, with a log to check them against: ltms pin <path>\.\.\. --to <dir>\. ltms pin --help has its forms and output\./);
    assert.match(g, /^ {2}ltms pin <path>\.\.\. --to <dir> {3}copies the cleanup does not delete, and a log$/m);
    assert.ok(!g.includes('"k":"coverage"'), 'the general help holds pin\'s part');
    assert.equal(ltms(t, ['pin', '--version']).out, `${VERSION}\n`);
  } finally { t.clean(); }
});

test('ltms pin, the lock held by a running pin: it waits 30 s, then exits 1 with the holder, its start time and the rm command, writes nothing on stdout, and leaves the lock as it was', { timeout: 120000 }, async () => {
  const { t, holder, code, out, err, ms } = await busyRun;
  try {
    assert.deepEqual([code, out], [1, '']);
    assert.match(err, new RegExp(`^ltms pin: the lock '${escapeRe(lockOf(t))}' is held by pid ${holder.pid} on this host, since ${escapeRe(holder.started)}; a process with that pid is running, and it still held the lock after 3\\d\\.\\d s\\. If no pin is running, remove the lock: rm '${escapeRe(lockOf(t))}'\\n$`));
    assert.ok(ms >= 30000, `it waited ${ms} ms`);
    assert.equal(readFileSync(lockOf(t), 'utf8'), JSON.stringify(holder));
    assert.deepEqual(readdirSync(t.to), ['.ltms-pin.lock']);
  } finally { t.clean(); }
});

test('ltms pin --check, a lock held by a running pin: it waits 30 s, as a pin waits, then exits 1 with the holder, its start time and the rm command, writes nothing on stdout, and leaves the lock as it was (pin[5])', { timeout: 120000 }, async () => {
  const { t, holder, code, out, err, ms } = await checkBusyRun;
  try {
    assert.deepEqual([code, out], [1, ''], err);
    assert.match(err, new RegExp(`^ltms pin: the lock '${escapeRe(lockOf(t))}' is held by pid ${holder.pid} on this host, since ${escapeRe(holder.started)}; a process with that pid is running, and it still held the lock after 3\\d\\.\\d s\\. If no pin is running, remove the lock: rm '${escapeRe(lockOf(t))}'\\n$`));
    assert.ok(ms >= 30000, `it waited ${ms} ms`);
    assert.equal(readFileSync(lockOf(t), 'utf8'), JSON.stringify(holder));
  } finally { t.clean(); }
});

test("README: pin's section sits after stats', its example lines have the command's fields in the command's order and add up, its hook block is settings.json that runs --from-hook within 60 s, and its cron line names everything in full", () => {
  const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
  const at = (s) => { const i = readme.indexOf(s); assert.ok(i >= 0, `the README has no ${s}`); return i; };
  const start = at('### `ltms pin <path>... --to <dir>`'), end = at('## What it reads');
  assert.ok(at('### `ltms stats <file.jsonl>...`') < start && start < end);
  const section = readme.slice(start, end);
  // the example lines are indented inside their code blocks: 0.0.5's README test reads lines that START with {"k": as
  // skeleton's and stats' own examples
  const examples = section.split('\n').filter((l) => l.startsWith('  {"k":')).map((l) => JSON.parse(l));
  assert.deepEqual(examples.map((o) => o.k), ['coverage', 'check']);
  const [c, k] = examples;
  assert.deepEqual([Object.keys(c), Object.keys(c.files), Object.keys(c.skipped)], [COVERAGE_KEYS, FILES_KEYS, SKIPPED_KEYS]);
  assert.equal(c.files.seen, c.files.new + c.files.grown + c.files.rewritten + c.files.unchanged + c.files.notCopied + c.files.failed);
  assert.deepEqual([Object.keys(k), Object.keys(k.staleness)], [CHECK_KEYS, STALENESS_KEYS]);
  assert.deepEqual([k.dir, k.root, k.staleness.root, k.lines, k.versions, k.files], [c.to, c.root, c.root, c.files.new + 1, c.files.new, c.files.new]);
  assert.equal(section.split('\n').filter((l) => l.startsWith('{"k":')).length, 0);
  // every field the coverage line has is in the table
  for (const key of COVERAGE_KEYS.slice(1)) assert.match(section, new RegExp(`^\\| [^|]*\`${key}\``, 'm'), `no row for ${key}`);
  // the SessionEnd block
  const json = /```json\n([\s\S]*?)\n```/.exec(section);
  assert.ok(json, 'no json block');
  const hooks = JSON.parse(json[1]).hooks.SessionEnd;
  assert.equal(hooks.length, 1);
  const h = hooks[0].hooks[0];
  assert.deepEqual([h.type, h.timeout], ['command', 60]);
  assert.match(h.command, /^ltms pin --from-hook --to \S+$/);
  // the cron line: ltms by its full path, CLAUDE_CONFIG_DIR, the paths in full
  const cron = section.split('\n').find((l) => /^\d+ [\d*]+ \* \* \* /.test(l));
  assert.ok(cron, 'no cron line');
  assert.match(cron, /^\d+ [\d*]+ \* \* \* PATH=\/\S+ CLAUDE_CONFIG_DIR=\/\S+ \/\S+\/ltms pin \/\S+ --to \/\S+/);
  // the exit statuses, and the a5/a6 sentence in "The Bash verb"
  assert.match(section.replace(/\s+/g, ' '), /\*\*Exit status:\*\* 0 when every file was pinned; 1 when a file or directory failed .*; 2 on a usage error or a refusal\./);
  assert.match(readme.slice(at('### The Bash verb'), start).replace(/\s+/g, ' '), /a command that ends in `&&`, `\|\|` or `\|` \(or `\|&`\), with nothing after it but blanks, new lines, line continuations and comment lines, is `\(withheld\)`/);
});

// ---- the last repair round (S358): the final verifier's findings ------------------------------------------------------
// final[0] and final[1]: the pin's own files (PINS.log, the lock, a kept copy's name, and the copies the check reads)
// are read and appended to only as regular files: never through a symbolic link, never waiting on a FIFO. final[2] to
// final[5] are the verifier's throwaway tests, adopted. final[6]: the staleness counts a .jsonl longer than its copy only
// by an unfinished line apart. final[7]: --check gives the --rehash command only for what it writes back. Each test was
// run red first on the build of final.patch (notes-F2/), unless it says it is a guard; a pin or a check that waits on a
// FIFO runs in a child process ended by SIGKILL, so a red run fails instead of hanging the suite.

const NO_LINKS = process.platform === 'win32' && 'symbolic links need privileges on win32';
const NO_FIFOS = process.platform === 'win32' && 'no FIFOs on win32';
/** Runs `body` (an ES module's code, with pinPaths, checkPin, fs and execFileSync in scope, after `patch`) in a child
 *  process, ended by SIGKILL after `ms`: its exit status, the signal that ended it, stdout, stderr and how long it ran. */
function childModule(body, { patch = '', ms = 15000 } = {}) {
  const code = `
    import fs from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    ${patch}
    syncBuiltinESMExports();
    const { pinPaths, checkPin } = await import(${JSON.stringify(pathToFileURL(PIN).href)});
    ${body}`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL' });
  if (r.error && r.error.code !== 'ETIMEDOUT') throw r.error;
  return { status: r.status, signal: r.signal, out: r.stdout ?? '', err: r.stderr ?? '', ms: Date.now() - t0 };
}
/** childModule's result, which must have ended by itself, as JSON. */
const ranTo = (c) => {
  assert.equal(c.signal, null, `the child was still running after ${c.ms} ms (it took a SIGKILL): ${c.err}`);
  assert.equal(c.status, 0, c.err);
  return JSON.parse(c.out);
};
/** ltms, its run ended by SIGKILL after `ms` (a pin that waits on a FIFO catches the SIGTERM spawnSync sends first). */
function ltmsKilled(t, args, ms = 15000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', cwd: t.tmp,
    env: { ...process.env, CLAUDE_CONFIG_DIR: t.config } });
  if (r.error && r.error.code !== 'ETIMEDOUT') throw r.error;
  return { code: r.status, signal: r.signal, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const mkfifo = (p) => spawnSync('mkfifo', [p]).status === 0 || assert.fail(`mkfifo ${p} failed`);
const isFifo = (p) => lstatSync(p).isFIFO();

test('pin, PINS.log as a symbolic link to a file outside --to: refused before anything is read or written (log-unreadable), and the file it leads to is untouched (final[0], adopted from pins-log-link.test.mjs)', { skip: NO_LINKS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const log = join(t.to, 'PINS.log'), outside = join(t.tmp, 'outside'), victim = join(outside, 'victim.log');
    mkdirSync(outside);
    renameSync(log, victim);
    symlinkSync(victim, log);
    const before = readFileSync(victim);
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), L4);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.k, r.reason], ['refused', 'log-unreadable'], JSON.stringify(r).slice(0, 300));
    assert.equal(r.message, `'${log}' is a symbolic link: pin neither reads nor appends to its log through a link, which could lead out of the pin directory.`);
    assert.deepEqual(readFileSync(victim), before, 'the file outside --to that PINS.log links to was written');
    // the command: exit 2, nothing on stdout, the library's sentence and the next command, which reads nothing through it
    const c = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual([c.code, c.out], [2, '']);
    assert.equal(c.err, `ltms pin: ${r.message} See what it is: ls -l '${log}'; to start a pin elsewhere, give another --to.\n`);
    // --check reads no log through a link either
    const k = await checkPin(t.to);
    assert.deepEqual([k.k, k.reason, k.message], ['refused', 'not-a-pin', `'${t.to}' has a PINS.log that is a symbolic link, so it is not a pin this check can read.`]);
    assert.deepEqual(readFileSync(victim), before);
  } finally { t.clean(); }
});

test('pin, PINS.log made a symbolic link after the refusals were checked, before the pin reads it under the lock: a failure, op log, not-a-regular-file, and the file it leads to is untouched (final[0])', { skip: NO_LINKS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), L4);
    const log = join(t.to, 'PINS.log'), victim = join(t.tmp, 'victim.log');
    const before = readFileSync(log);
    // the link is put in place the moment the lock is taken: after prepare() read the log, before the run reads it
    const c = childModule(`process.stdout.write(JSON.stringify(await pinPaths([${JSON.stringify(t.root)}], ${JSON.stringify(t.opts())})));`, { patch: `
      const link = fs.linkSync;
      fs.linkSync = function (from, to) {
        const r = link.apply(this, arguments);
        if (String(to).endsWith('.ltms-pin.lock')) { fs.renameSync(${JSON.stringify(log)}, ${JSON.stringify(victim)}); fs.symlinkSync(${JSON.stringify(victim)}, ${JSON.stringify(log)}); }
        return r;
      };` });
    const r = ranTo(c);
    assert.deepEqual([r.k, r.failures, r.lines, r.notices], ['pinned', [{ path: log, rel: null, op: 'log', code: 'not-a-regular-file' }], [], []]);
    assert.deepEqual(readFileSync(victim), before, 'the file the link leads to was written');
    assert.equal(readFileSync(t.pin(`${Q}/${SB}.jsonl`), 'utf8'), L1 + L2 + L3);   // it stopped at the log: nothing copied
    assert.equal(existsSync(lockOf(t)), false);
  } finally { t.clean(); }
});

test('pin, PINS.log made a symbolic link between the lstat and the open of an append: the open refuses it (O_NOFOLLOW), a failure, op log, and the file it leads to is untouched (final[0])', { skip: (NO_LINKS || fsConstants.O_NOFOLLOW === undefined) && 'needs symbolic links and O_NOFOLLOW' }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), L4);
    const log = join(t.to, 'PINS.log'), victim = join(t.tmp, 'victim.log');
    const before = readFileSync(log);
    // armed by the first file's stat (after the log was read), the next lstat of PINS.log, the append's, returns the
    // regular file it saw, and the link is put in place before the open
    const c = childModule(`
      const r = await pinPaths([${JSON.stringify(t.root)}], { ...${JSON.stringify(t.opts())}, onStep(step) { if (step === 'stat') globalThis.armed ??= true; } });
      process.stdout.write(JSON.stringify(r));`, { patch: `
      const lstat = fs.lstatSync;
      fs.lstatSync = function (p) {
        const s = lstat.apply(this, arguments);
        if (globalThis.armed === true && String(p) === ${JSON.stringify(log)}) {
          globalThis.armed = false;
          fs.renameSync(${JSON.stringify(log)}, ${JSON.stringify(victim)});
          fs.symlinkSync(${JSON.stringify(victim)}, ${JSON.stringify(log)});
        }
        return s;
      };` });
    const r = ranTo(c);
    const loop = ['linux', 'darwin'].includes(process.platform) ? 'ELOOP' : r.failures[0]?.code;
    assert.deepEqual([r.k, r.failures], ['pinned', [{ path: log, rel: null, op: 'log', code: loop }]]);
    assert.deepEqual(readFileSync(victim), before, 'the append went through the link');
    assert.ok(r.notices.some((n) => n === `'${log}' could not be written (${loop}), so the pin stopped there; the next pin records what this one left without a line.`), r.notices.join(' | '));
  } finally { t.clean(); }
});

test('pin, PINS.log as a FIFO: refused at once (log-unreadable, not a regular file), never opened; --check too (not-a-pin); the FIFO is left as it was (final[1])', { skip: NO_FIFOS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const log = join(t.to, 'PINS.log');
    rmSync(log);
    mkfifo(log);
    const r = ranTo(childModule(`process.stdout.write(JSON.stringify(await pinPaths([${JSON.stringify(t.root)}], ${JSON.stringify(t.opts())})));`));
    assert.deepEqual([r.k, r.reason, r.message], ['refused', 'log-unreadable', `'${log}' is not a regular file (it is a FIFO): pin reads and appends to its log only as a regular file.`]);
    const k = ranTo(childModule(`process.stdout.write(JSON.stringify(await checkPin(${JSON.stringify(t.to)})));`));
    assert.deepEqual([k.k, k.reason, k.message], ['refused', 'not-a-pin', `'${t.to}' has a PINS.log that is not a regular file (it is a FIFO), so it is not a pin this check can read.`]);
    // the command: the next command does not read the FIFO either
    const c = ltmsKilled(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual([c.signal, c.code, c.out], [null, 2, '']);
    assert.equal(c.err, `ltms pin: ${r.message} See what it is: ls -l '${log}'; to start a pin elsewhere, give another --to.\n`);
    assert.ok(isFifo(log));
  } finally { t.clean(); }
});

test('ltms pin with a FIFO at the lock: it does not wait on it; a failure, op lock, not-a-regular-file, exit 1 at once, and the FIFO is left as it was (final[1], adopted from fifo-lock.test.mjs)', { skip: NO_FIFOS }, async () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    mkfifo(lockOf(t));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config };
    const child = spawn(process.execPath, [CLI, 'pin', t.root, '--to', t.to], { cwd: t.tmp, env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    await new Promise((r) => setTimeout(r, 1000));
    child.kill('SIGTERM');
    const ended = await Promise.race([closed, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (ended === null) { child.kill('SIGKILL'); await closed; }
    assert.notEqual(ended, null, 'the pin was still running 5 s after its SIGTERM (it took a SIGKILL)');
    // it did not wait for the SIGTERM: it had ended by itself, with the failure
    assert.deepEqual(ended, { code: 1, signal: null }, err);
    const rows = rowsOf(out);
    assert.deepEqual(rows.slice(1), [{ k: 'failure', path: lockOf(t), rel: null, op: 'lock', code: 'not-a-regular-file' }]);
    assert.deepEqual(rows[0].files, counts({}));
    // S358 last fix [2]: the closing line gives the command that looks at what is at the lock's name
    assert.equal(err, `ltms pin: 1 failure, each named on stdout ("k":"failure": the path, the step and the error code; the first: lock '${lockOf(t)}', not-a-regular-file). Every file pinned is whole and in PINS.log; once the cause is fixed, the same command pins the rest. See what is at the lock: ls -l '${lockOf(t)}'\n`);
    assert.ok(isFifo(lockOf(t)));
    assert.deepEqual(readdirSync(t.to).filter((n) => n.includes('ltms-tmp')), []);   // its own temp file is removed
  } finally { t.clean(); }
});

test('pin, a symbolic link at the lock: a failure, op lock, not-a-regular-file, and the file it leads to is untouched; --check does not wait on a FIFO or a link at the lock, and says what it is (final[1])', { skip: (NO_LINKS || NO_FIFOS) && 'needs symbolic links and FIFOs' }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const victim = join(t.tmp, 'victim.txt');
    writeFileSync(victim, JSON.stringify({ pid: process.ppid, host: hostname(), started: '2026-11-08T10:00:00.000Z' }));
    symlinkSync(victim, lockOf(t));
    const before = readFileSync(victim);
    const r = await pinPaths([t.root], t.opts({ lockWaitMs: 300 }));
    assert.deepEqual([r.k, r.failures], ['pinned', [{ path: lockOf(t), rel: null, op: 'lock', code: 'not-a-regular-file' }]]);
    assert.deepEqual(readFileSync(victim), before);
    assert.ok(lstatSync(lockOf(t)).isSymbolicLink());
    // the check: not waited for (the link leads to a live pid's lock), and a notice names it
    const t0 = Date.now();
    const k = await checkPin(t.to, { lockWaitMs: 5000 });
    assert.ok(Date.now() - t0 < 4000, `the check waited ${Date.now() - t0} ms`);
    checkClean(k);
    assert.deepEqual([k.lock, k.notices], [null, [`'${lockOf(t)}' is a symbolic link, so it is not read as a pin's lock; a pin fails at it (not-a-regular-file) until it is gone. See what it is: ls -l '${lockOf(t)}'`]]);
    rmSync(lockOf(t));
    mkfifo(lockOf(t));
    const f = ranTo(childModule(`process.stdout.write(JSON.stringify(await checkPin(${JSON.stringify(t.to)})));`));
    assert.deepEqual([f.k, f.mismatches, f.lock, f.notices], ['checked', [], null, [`'${lockOf(t)}' is not a regular file (it is a FIFO), so it is not read as a pin's lock; a pin fails at it (not-a-regular-file) until it is gone. See what it is: ls -l '${lockOf(t)}'`]]);
  } finally { t.clean(); }
});

test("pin, a FIFO put at the lock's name while the pin runs: the pin ends, and leaves it, since it removes only a lock that holds what it wrote (final[1])", { skip: NO_FIFOS }, async () => {
  const t = tree();
  try {
    const lock = lockOf(t);
    const c = childModule(`
      let done = false;
      const r = await pinPaths([${JSON.stringify(t.root)}], { ...${JSON.stringify(t.opts())}, onStep(step) {
        if (step === 'stat' && !done) { done = true; fs.unlinkSync(${JSON.stringify(lock)}); execFileSync('mkfifo', [${JSON.stringify(lock)}]); }
      } });
      process.stdout.write(JSON.stringify(r));`);
    const r = ranTo(c);
    assert.deepEqual([r.k, r.failures, r.coverage.files.new], ['pinned', [], 10]);
    assert.ok(isFifo(lock));
  } finally { t.clean(); }
});

test("pin, a kept copy's name that is a symbolic link or a FIFO: a failure, op keep, not-a-regular-file; the copy is left as it was, and what the link leads to is untouched (final[1])", { skip: (NO_LINKS || NO_FIFOS) && 'needs symbolic links and FIFOs' }, async () => {
  for (const kind of ['link', 'fifo']) {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      const rel = `${Q}/${SB}.jsonl`, A = PINNED[rel];
      const kept = t.pin(`${Q}/${SB}.superseded-${sha12(A)}.jsonl`), victim = join(t.tmp, 'victim.txt');
      writeFileSync(victim, A);   // the bytes the kept copy must hold: read through the link, they would pass
      if (kind === 'link') symlinkSync(victim, kept); else mkfifo(kept);
      writeFileSync(t.src(rel), L4);   // rewritten: the old copy is to be kept by that name
      const r = ranTo(childModule(`process.stdout.write(JSON.stringify(await pinPaths([${JSON.stringify(t.root)}], ${JSON.stringify(t.opts())})));`));
      assert.deepEqual([r.failures, r.coverage.files.failed, r.lines], [[{ path: kept, rel, op: 'keep', code: 'not-a-regular-file' }], 1, []], kind);
      assert.equal(readFileSync(t.pin(rel), 'utf8'), A, kind);
      assert.equal(readFileSync(victim, 'utf8'), A, kind);
      assert.ok(kind === 'link' ? lstatSync(kept).isSymbolicLink() : isFifo(kept), kind);
    } finally { t.clean(); }
  }
});

test("check: a FIFO at a copy's place is read as missing (got null), never opened to wait on, and a pin then writes the copy again (final[1])", { skip: NO_FIFOS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${P}/sess-named.jsonl`;
    rmSync(t.pin(rel));
    mkfifo(t.pin(rel));
    const k = ranTo(childModule(`process.stdout.write(JSON.stringify(await checkPin(${JSON.stringify(t.to)})));`));
    assert.deepEqual(k.mismatches.map((m) => [m.rel, m.copy, m.got]), [[rel, rel, null]]);
    assert.equal(k.files, RELS.length - 1);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel]), [['recovered', rel]]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('pin, waiting for a lock held by a running pin: SIGINT, SIGTERM and SIGHUP each end the wait at once, and the other pin\'s lock is left as it was (a guard: green before the change too)', async () => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const t = tree();
    try {
      const holder = { pid: process.pid, host: hostname(), started: '2026-11-08T10:00:00.000Z' };   // this test's process: alive
      plantLock(t, holder);
      const c = childModule(`
        setTimeout(() => process.kill(process.pid, '${sig}'), 300);
        await pinPaths([${JSON.stringify(t.root)}], ${JSON.stringify(t.opts({ lockWaitMs: 20000 }))});`);
      assert.equal(c.signal, sig, `${sig}: status ${c.status}, ${c.err}`);
      assert.ok(c.ms < 10000, `${sig}: the wait went on for ${c.ms} ms after the signal`);
      assert.equal(readFileSync(lockOf(t), 'utf8'), JSON.stringify(holder), sig);
    } finally { t.clean(); }
  }
});

test('pin: a --to that is a symbolic link to nothing, or a FIFO, is refused (to-not-a-directory), before anything is written (final[3], adopted from to-not-a-directory.test.mjs)', { skip: (NO_LINKS || NO_FIFOS) && 'needs symbolic links and FIFOs' }, async () => {
  for (const [kind, plant, said] of [['a symbolic link to nothing', (to, t) => symlinkSync(join(t.tmp, 'nowhere'), to), 'a symbolic link that leads to nothing'], ['a FIFO', (to) => mkfifo(to), 'a socket, a FIFO or a device']]) {
    const t = tree();
    try {
      plant(t.to, t);
      const r = await pinPaths([t.root], t.opts({ lockWaitMs: 500 }));
      assert.deepEqual([r.k, r.reason], ['refused', 'to-not-a-directory'], `${kind}: ${JSON.stringify(r).slice(0, 300)}`);
      assert.equal(r.message, `the pin directory '${t.to}' exists and is not a directory (${said}), so pin cannot write its copies into it.`, kind);
      assert.equal(existsSync(join(t.tmp, 'nowhere')), false, kind);
    } finally { t.clean(); }
  }
});

test('pin: a pin directory open to its group only (0750) draws the notice, with its mode and the chmod command (final[4], adopted from to-open-to-group.test.mjs)', { skip: process.platform === 'win32' && 'modes do not apply on win32' }, async () => {
  const t = tree();
  try {
    mkdirSync(t.to);
    chmodSync(t.to, 0o750);
    const r = await pinPaths([t.root], t.opts({ lockWaitMs: 500 }));
    assert.equal(r.k, 'pinned');
    assert.deepEqual(r.notices.filter((n) => n.includes('open to other users')).map((n) => n.match(/mode (\d+)/)?.[1]), ['0750']);
  } finally { t.clean(); }
});

test('check: a .jsonl longer than its copy only by an unfinished line is counted apart (unfinished), not as longer: a pin copies whole lines only; one with a whole line past its copy is longer, and so is any other file larger than its copy (final[6])', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const half = '{"type":"user","text":"an invented line not yet fin';
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), half);                          // only an unfinished line: unfinished
    appendFileSync(t.src(`${P}/${SA}.jsonl`), L3 + half);                     // a whole line, then an unfinished one: longer
    appendFileSync(t.src(`${P}/${SA}/tool-results/b000000001.txt`), 'more');  // not a .jsonl, larger: longer
    const k = await checkPin(t.to);
    checkClean(k);
    assert.deepEqual(k.staleness, { root: t.root, fromLog: true, sources: 10, missing: 0, longer: 2, unfinished: 1, projectsNotPinned: 0, failed: 0 });
    // what a pin then does agrees: the file longer only by an unfinished line is unchanged (and partial), the others grown
    const r = await pinPaths([t.root], t.opts({ rehash: true }));
    assert.deepEqual([r.coverage.files, r.coverage.partial], [counts({ seen: 10, grown: 2, unchanged: 8 }), 2]);
    assert.deepEqual((await checkPin(t.to)).staleness, { root: t.root, fromLog: true, sources: 10, missing: 0, longer: 0, unfinished: 2, projectsNotPinned: 0, failed: 0 });
  } finally { t.clean(); }
});

test('ltms pin --check: files longer than their copies only by an unfinished line are reported on their own line, with no command (a pin copies nothing of them); exit 0 (final[6])', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), '{"type":"user","text":"an invented line not yet fin');
    let r = ltms(t, ['pin', '--check', t.to]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(rowsOf(r.out)[0].staleness, { root: t.root, fromLog: true, sources: 10, missing: 0, longer: 0, unfinished: 1, projectsNotPinned: 0, failed: 0 });
    assert.equal(r.err, `ltms pin: 1 file under the root '${t.root}' ends in an unfinished line, which a pin does not copy: it is longer than its copy only by that line, and is not counted as longer.\n`);
    appendFileSync(t.src(`${P}/${SA}.jsonl`), '{"type":"user","text":"another invented line not yet fin');
    t.put(`${Q}/77777777-7777-4777-8777-777777777777.jsonl`, L1);   // and one missing
    r = ltms(t, ['pin', '--check', t.to]);
    const last = rowsOf(r.out)[0].lastLog;
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, new RegExp(`^ltms pin: 1 file under the root '${escapeRe(t.root)}' is missing from the pin, and 0 are longer than their copies \\(PINS\\.log's last line: ${escapeRe(last)}, \\d+ min ago\\)\\. To pin them: ltms pin '${escapeRe(t.root)}' --to '${escapeRe(t.to)}' --root '${escapeRe(t.root)}'\\nltms pin: 2 files under the root '${escapeRe(t.root)}' end in an unfinished line, which a pin does not copy: they are longer than their copies only by that line, and are not counted as longer\\.\\n$`));
  } finally { t.clean(); }
});

// The last narrow fix (S358, notes-F3) replaced the two final[7] tests built on PinMismatch.restorable, which is gone:
// --check's closing line now gives the --rehash command for the projects whose current copies have a mismatch and
// whose sources are there, and says that ltms pin --check, run again, says what remains (REHASH, with the command's
// helpers, beside ltms() above).

test('ltms pin --check, a copy missing while its source was rewritten (its version lost from the pin): while the source is there, the closing line gives the --rehash command and says that a check run again says what remains; run, the command writes back what the source holds, and the check then gives the same line (S358 last fix [0])', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const b = `${P}/sess-named.jsonl`;
    rmSync(t.pin(b));
    writeFileSync(t.src(b), L5);
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const log = join(t.to, 'PINS.log'), line = logLines(t.to).findIndex((l) => l.rel === b) + 1;
    const closing = `ltms pin: '${t.to}' does not hold what '${log}' records: 1 mismatch, 0 chain breaks and 0 lines that are not log lines, each on stdout with its line in PINS.log. To read the first: sed -n '${line}p' '${log}'. ${REHASH} ltms pin '${t.src(P)}' --to '${t.to}' --root '${t.root}' --rehash\n`;
    let r = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.code, r.err], [1, closing]);
    const fix = runPrinted(t, rehashOf(r.err));
    assert.equal(fix.code, 0, fix.err);
    assert.equal(readFileSync(t.pin(b), 'utf8'), L5);   // what the source holds
    r = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.code, r.err], [1, closing]);    // the version its first line records is in no source: what remains
  } finally { t.clean(); }
});

test('ltms pin --check: an older version longer than its copy\'s newest (a file cut back while its copy was missing) is not in its source, so the --rehash command writes back only what the source holds; once the source has grown back past it, the same command writes it back, and the check exits 0 (S358 last fix [0])', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`, Y = L1 + L2, Z = L3;   // pinned as Y + Z
    rmSync(t.pin(rel));
    writeFileSync(t.src(rel), Y);   // cut back to Y while its copy was missing: the version Y + Z is lost from the pin
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const line = logLines(t.to).findIndex((l) => l.rel === rel) + 1;
    const command = `ltms pin '${t.src(Q)}' --to '${t.to}' --root '${t.root}' --rehash`;
    let k = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual(rowsOf(k.out).slice(1).map((m) => [m.rel, m.line, m.got]), [[rel, line, { bytes: len(Y), sha256: sha(Y) }]]);
    assert.equal(rehashOf(k.err), command);
    assert.equal(runPrinted(t, command).code, 0);
    k = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([k.code, rehashOf(k.err), readFileSync(t.pin(rel), 'utf8')], [1, command, Y]);   // what remains
    appendFileSync(t.src(rel), Z);   // the source grows back to Y + Z: a pin grows the copy from it
    assert.equal(rehashOf(ltms(t, ['pin', '--check', t.to]).err), command);
    assert.equal(runPrinted(t, command).code, 0);
    assert.deepEqual([ltms(t, ['pin', '--check', t.to]).code, readFileSync(t.pin(rel), 'utf8')], [0, Y + Z]);
  } finally { t.clean(); }
});

test('pin, PINS.log made a FIFO between the lstat and the open of the read under the lock: the open does not wait (O_NONBLOCK), fstat sees what was opened, and the pin stops there, a failure, op log (final[1])', { skip: (NO_FIFOS || fsConstants.O_NONBLOCK === undefined) && 'needs FIFOs and O_NONBLOCK' }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const log = join(t.to, 'PINS.log');
    // the second lstat of PINS.log is the read under the lock (the first, prepare's): it sees the regular file, and the
    // FIFO is put in its place right after it, before the open
    const c = childModule(`process.stdout.write(JSON.stringify(await pinPaths([${JSON.stringify(t.root)}], ${JSON.stringify(t.opts())})));`, { patch: `
      const lstat = fs.lstatSync;
      let n = 0;
      fs.lstatSync = function (p) {
        const s = lstat.apply(this, arguments);
        if (String(p) === ${JSON.stringify(log)} && ++n === 2) { fs.renameSync(${JSON.stringify(log)}, ${JSON.stringify(log + '.moved')}); execFileSync('mkfifo', [${JSON.stringify(log)}]); }
        return s;
      };` });
    const r = ranTo(c);
    assert.deepEqual([r.k, r.failures, r.lines, r.notices], ['pinned', [{ path: log, rel: null, op: 'log', code: 'not-a-regular-file' }], [], []]);
    assert.ok(isFifo(log));
  } finally { t.clean(); }
});

test("pin, a copy made a FIFO after the pin's scan saw it (at its stat step): the read that keeps it before a rewrite, and --rehash's read, never wait on it: a failure, op keep, and a copy written again (final[1])", { skip: NO_FIFOS }, async () => {
  for (const rehash of [false, true]) {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      const rel = `${Q}/${SB}.jsonl`, dst = t.pin(rel);
      if (!rehash) writeFileSync(t.src(rel), L4);   // rewritten: the old copy is read, to be kept
      const c = childModule(`
        let done = false;
        const r = await pinPaths([${JSON.stringify(t.root)}], { ...${JSON.stringify(t.opts({ rehash }))}, onStep(step, rel) {
          if (step === 'stat' && rel === ${JSON.stringify(rel)} && !done) { done = true; fs.unlinkSync(${JSON.stringify(dst)}); execFileSync('mkfifo', [${JSON.stringify(dst)}]); }
        } });
        process.stdout.write(JSON.stringify(r));`);
      const r = ranTo(c);
      if (!rehash) {
        assert.deepEqual([r.failures, r.lines], [[{ path: dst, rel, op: 'keep', code: 'not-a-regular-file' }], []]);
        assert.ok(isFifo(dst));
      } else {
        // --rehash reads the copy, which does not hold its version: written again from its source, which does
        assert.deepEqual([r.failures, r.lines.map((l) => [l.how, l.rel])], [[], [['recovered', rel]]]);
        assert.equal(readFileSync(dst, 'utf8'), L1 + L2 + L3);
      }
    } finally { t.clean(); }
  }
});

test("recovery, a copy made a FIFO after the pin's scan saw it: recovery's read never waits on it, a failure, op recover (final[1])", { skip: NO_FIFOS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, dst = t.pin(rel);
    appendFileSync(dst, 'grown in the pin');   // its size is no longer its line's: recovery reads it
    // the scan's lstat of the copy sees the regular file; the FIFO is put in its place right after it
    const c = childModule(`process.stdout.write(JSON.stringify(await pinPaths([${JSON.stringify(t.root)}], ${JSON.stringify(t.opts())})));`, { patch: `
      const lstat = fs.lstatSync;
      let done = false;
      fs.lstatSync = function (p) {
        const s = lstat.apply(this, arguments);
        if (String(p) === ${JSON.stringify(dst)} && !done) { done = true; fs.unlinkSync(${JSON.stringify(dst)}); execFileSync('mkfifo', [${JSON.stringify(dst)}]); }
        return s;
      };` });
    const r = ranTo(c);
    assert.deepEqual(r.failures.filter((f) => f.op === 'recover'), [{ path: dst, rel, op: 'recover', code: 'not-a-regular-file' }]);
  } finally { t.clean(); }
});

test('ltms pin --check, a PINS.log whose first line is not its root line: the closing line gives no --rehash command, since no source can be looked for, even with --root given (final[7]; S358 last fix [0])', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`, log = join(t.to, 'PINS.log');
    const lines = logText(t.to).split('\n');
    lines[0] = 'not the root line';
    writeFileSync(log, lines.join('\n'));
    const b = readFileSync(t.pin(rel));
    b[0] ^= 1;
    writeFileSync(t.pin(rel), b);
    const r = ltms(t, ['pin', '--check', t.to, '--root', t.root]);
    assert.equal(r.code, 1);
    const closing = r.err.split('\n').find((l) => l.startsWith(`ltms pin: '${t.to}' does not hold`));
    assert.equal(closing, `ltms pin: '${t.to}' does not hold what '${log}' records: 1 mismatch, 1 chain break and 1 line that is not a log line, each on stdout with its line in PINS.log. To read the first: sed -n '${RELS.indexOf(rel) + 2}p' '${log}'`);
  } finally { t.clean(); }
});

// ---- the last narrow fix (S358, notes-F3): the checker's findings 0-9 (lastfix_result.json) -------------------------
// [0] PinMismatch.restorable is gone: --check's closing line gives the --rehash command for the projects whose current
// copies have a mismatch and whose sources are there, and says that a check run again says what remains. [1] unfinished
// only when the copy is a byte prefix of the source. [2] ls -l for a PINS.log or a lock that is not a regular file.
// [3]-[8] the checker's throwaway tests (verify-f2/throwaway/f2-survivors.test.mjs), adopted. [9] a PINS.log with
// another name is refused. Each test was run red first on the build of final2.patch (notes-F3/), except the adopted
// ones, which are green there and red on their mutants, and the two that say in their titles that they are guards.

test('ltms pin --check after a pin killed between the rename of a copy and its line (the file grown, or rewritten): the closing line gives the --rehash command; run as printed, it exits 0, and the check then exits 0 with nothing to say (S358 last fix [0], the checker\'s crash-then-check)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  for (const [name, change] of [['grown', (p) => appendFileSync(p, L4)], ['rewritten', (p) => writeFileSync(p, L4)]]) {
    const t = tree();
    try {
      assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
      const rel = `${Q}/${SB}.jsonl`, log = join(t.to, 'PINS.log');
      const line = logLines(t.to).findIndex((l) => l.rel === rel) + 1;
      change(t.src(rel));
      assert.equal(childPin(t, [t.root], 'renamed', rel, KILL).signal, 'SIGKILL', name);
      const k = ltms(t, ['pin', '--check', t.to]);
      assert.equal(k.code, 1, name);
      const closing = k.err.split('\n').find((l) => l.startsWith(`ltms pin: '${t.to}' does not hold`));
      assert.equal(closing, `ltms pin: '${t.to}' does not hold what '${log}' records: 1 mismatch, 0 chain breaks and 0 lines that are not log lines, each on stdout with its line in PINS.log. To read the first: sed -n '${line}p' '${log}'. ${REHASH} ltms pin '${t.src(Q)}' --to '${t.to}' --root '${t.root}' --rehash`, name);
      const fix = runPrinted(t, rehashOf(k.err));
      assert.equal(fix.code, 0, `${name}: ${fix.err}`);
      const again = ltms(t, ['pin', '--check', t.to]);
      assert.deepEqual([again.code, again.err], [0, ''], name);
    } finally { t.clean(); }
  }
});

test('ltms pin --check: the --rehash command names only the projects of current copies with a mismatch whose source is there, under the root PINS.log records, as itself (a regular file reached through no symbolic link); a kept copy, a source gone, a source that is a link or a directory, and a source only under a --root given give none (S358 last fix [0])', { skip: NO_LINKS }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const flip0 = (rel) => { const b = readFileSync(t.pin(rel)); b[0] ^= 1; writeFileSync(t.pin(rel), b); };
    const A = PINNED[`${Q}/${SB}.jsonl`], log = join(t.to, 'PINS.log');
    // a kept copy changed: Q's transcript rewritten and pinned, then the copy that keeps its first version changed
    writeFileSync(t.src(`${Q}/${SB}.jsonl`), L4);
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    flip0(`${Q}/${SB}.superseded-${sha12(A)}.jsonl`);
    // a current copy changed whose source is gone
    flip0(`${P}/sess-named.jsonl`);
    rmSync(t.src(`${P}/sess-named.jsonl`));
    // a current copy changed whose source is now a symbolic link to a file that holds its bytes
    const away = join(t.tmp, 'away.jsonl');
    writeFileSync(away, L4);
    rmSync(t.src(`${Q}/${SB}.jsonl`));
    symlinkSync(away, t.src(`${Q}/${SB}.jsonl`));
    flip0(`${Q}/${SB}.jsonl`);
    // a current copy changed whose source's place now holds a directory
    const meta = `${P}/${SA}/subagents/agent-a0000000000000001.meta.json`;
    flip0(meta);
    rmSync(t.src(meta));
    mkdirSync(t.src(meta));
    const closingOf = (r) => r.err.split('\n').find((l) => l.startsWith(`ltms pin: '${t.to}' does not hold`));
    const none = new RegExp(`: 4 mismatches, 0 chain breaks and 0 lines that are not log lines, each on stdout with its line in PINS\\.log\\. To read the first: sed -n '\\d+p' '${escapeRe(log)}'$`);
    let r = ltms(t, ['pin', '--check', t.to]);
    assert.equal(r.code, 1);
    assert.match(closingOf(r), none);
    // the source gone from under the root PINS.log records is there under a root given to the check: still none
    const other = join(t.tmp, 'other-root');
    mkdirSync(join(other, P), { recursive: true });
    writeFileSync(join(other, P, 'sess-named.jsonl'), PINNED[`${P}/sess-named.jsonl`]);
    r = ltms(t, ['pin', '--check', t.to, '--root', other]);
    assert.equal(r.code, 1);
    assert.match(closingOf(r), none);
    // a current copy changed whose source is there: the command names its project, and only that one
    flip0(`${P}/${SA}.jsonl`);
    r = ltms(t, ['pin', '--check', t.to]);
    assert.equal(rehashOf(r.err), `ltms pin '${t.src(P)}' --to '${t.to}' --root '${t.root}' --rehash`);
  } finally { t.clean(); }
});

test('ltms pin --check, a project directory under the root that is a symbolic link (a project moved): no --rehash command for it, since a pin of it would be refused (path-outside-root) (S358 last fix [0]; a guard: final2 left it out too)', { skip: NO_LINKS }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const moved = join(t.tmp, 'elsewhere');
    mkdirSync(moved);
    renameSync(t.src(Q), join(moved, Q));
    symlinkSync(join(moved, Q), t.src(Q));
    const b = readFileSync(t.pin(`${Q}/${SB}.jsonl`));
    b[0] ^= 1;
    writeFileSync(t.pin(`${Q}/${SB}.jsonl`), b);
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.code, rehashOf(r.err)], [1, null], r.err);
    // what that command would have met
    assert.equal(ltms(t, ['pin', t.src(Q), '--to', t.to, '--root', t.root, '--rehash']).code, 2);
  } finally { t.clean(); }
});

test('ltms pin --check, damage in two projects: the --rehash command names both, each a word of its own; run as printed, it writes both back, and the check then exits 0 (S358 last fix [7], adopted from the checker\'s V18)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    for (const rel of [`${P}/${SA}.jsonl`, `${Q}/${SB}.jsonl`]) { const b = readFileSync(t.pin(rel)); b[0] ^= 1; writeFileSync(t.pin(rel), b); }
    const command = rehashOf(ltms(t, ['pin', '--check', t.to]).err);
    assert.equal(command, `ltms pin '${t.src(P)}' '${t.src(Q)}' --to '${t.to}' --root '${t.root}' --rehash`);
    const words = spawnSync('/bin/sh', ['-c', `printf '%s\\n' ${command.slice('ltms pin '.length)}`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.deepEqual(words, [t.src(P), t.src(Q), '--to', t.to, '--root', t.root, '--rehash']);
    assert.equal(runPrinted(t, command).code, 0);
    assert.equal(ltms(t, ['pin', '--check', t.to]).code, 0);
  } finally { t.clean(); }
});

test('check: a .jsonl larger than its copy, with no new line past the copy\'s length, is unfinished only when its copy is a byte prefix of it: rewritten under an unfinished line (to the copy\'s length, or shorter) it is longer, and a pin then rewrites it; after that pin, each is unfinished (S358 last fix [1])', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const same = `${Q}/${SB}.jsonl`, shorter = `${P}/${SA}.jsonl`, half = '{"type":"user","text":"an invented line not yet fin';
    const X = PINNED[same].replace('invented', 'INVENTED');   // as long as its copy, other bytes
    assert.ok(len(X) === len(PINNED[same]) && X !== PINNED[same] && len(L5) < len(PINNED[shorter]));
    writeFileSync(t.src(same), X + half);
    writeFileSync(t.src(shorter), L5 + half + 'x'.repeat(len(PINNED[shorter])));   // its whole lines shorter than the copy, larger in all
    const k = await checkPin(t.to);
    checkClean(k);
    assert.deepEqual(k.staleness, { root: t.root, fromLog: true, sources: 10, missing: 0, longer: 2, unfinished: 0, projectsNotPinned: 0, failed: 0 });
    // what a pin then does agrees: both rewritten (each keeps its old copy), each partial
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.coverage.files, r.coverage.partial], [counts({ seen: 10, rewritten: 2, unchanged: 8 }), 2]);
    // now each copy is a prefix of its source, which is longer only by its unfinished line
    assert.deepEqual((await checkPin(t.to)).staleness, { root: t.root, fromLog: true, sources: 10, missing: 0, longer: 0, unfinished: 2, projectsNotPinned: 0, failed: 0 });
  } finally { t.clean(); }
});

test('check: a .jsonl larger than its copy only by an unfinished line, whose copy cannot be read, is longer: that its copy is a prefix of it cannot be shown (S358 last fix [1])', { skip: NEEDS_PERMISSIONS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`;
    appendFileSync(t.src(rel), '{"type":"user","text":"an invented line not yet fin');
    assert.deepEqual([(await checkPin(t.to)).staleness.unfinished], [1]);   // readable: unfinished
    chmodSync(t.pin(rel), 0o000);
    const k = await checkPin(t.to);
    assert.deepEqual([k.staleness.longer, k.staleness.unfinished, k.mismatches.map((m) => [m.rel, m.got])], [1, 0, [[rel, null]]]);
  } finally { t.clean(); }
});

test('check: a .jsonl longer only by an unfinished line that cannot be opened for the prefix test (gone between the read of its new bytes and that test) is longer: that its copy is a prefix of it cannot be shown (S358 last fix [1], the mutation gap F03)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const src = t.src(`${Q}/${SB}.jsonl`);
    appendFileSync(src, '{"type":"user","text":"an invented line not yet fin');
    // the check opens the source twice: for the bytes past its copy's length, then for the prefix test; the second fails
    const c = childModule(`process.stdout.write(JSON.stringify((await checkPin(${JSON.stringify(t.to)})).staleness));`, { patch: `
      const open = fs.openSync;
      let n = 0;
      fs.openSync = function (p) {
        if (String(p) === ${JSON.stringify(src)} && ++n === 2) { const e = new Error('gone'); e.code = 'ENOENT'; e.syscall = 'open'; throw e; }
        return open.apply(this, arguments);
      };` });
    const s = ranTo(c);
    assert.deepEqual([s.longer, s.unfinished], [1, 0]);
    assert.deepEqual([(await checkPin(t.to)).staleness.unfinished], [1]);   // opened both times: unfinished
  } finally { t.clean(); }
});

test('ltms pin --check, a PINS.log that is a FIFO, a symbolic link or a directory: refused (exit 2), and the next command looks at it with ls -l, which reads nothing through it (S358 last fix [2])', { skip: (NO_LINKS || NO_FIFOS) && 'needs symbolic links and FIFOs' }, () => {
  const kinds = [['FIFO', (p) => mkfifo(p), 'is not a regular file (it is a FIFO)'], ['link', (p, t) => symlinkSync(join(t.tmp, 'elsewhere.log'), p), 'is a symbolic link'],
    ['directory', (p) => mkdirSync(p), 'is not a regular file (it is a directory)']];
  for (const [kind, plant, said] of kinds) {
    const t = tree();
    try {
      assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
      const log = join(t.to, 'PINS.log');
      rmSync(log);
      plant(log, t);
      const r = ltmsKilled(t, ['pin', '--check', t.to]);
      assert.deepEqual([r.signal, r.code, r.out], [null, 2, ''], kind);
      assert.equal(r.err, `ltms pin: '${t.to}' has a PINS.log that ${said}, so it is not a pin this check can read. See what it is: ls -l '${log}'\n`, kind);
    } finally { t.clean(); }
  }
});

test('pin, a PINS.log with another name (a hard link, here outside --to): refused before anything is read or written (log-unreadable), saying so, with the command that finds its other names; nothing reaches the other name; --check reads it as it is; once that name is gone, the pin goes on (S358 last fix [9])', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const log = join(t.to, 'PINS.log'), other = join(t.tmp, 'outside', 'PINS.log');
    mkdirSync(dirname(other));
    linkSync(log, other);
    const before = readFileSync(other);
    const rel = `${Q}/${SB}.jsonl`;
    appendFileSync(t.src(rel), L4);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.k, r.reason, r.message], ['refused', 'log-unreadable', `'${log}' has 2 names (hard links to one file): pin does not append to a log that has another name, since whoever can read that name, which can lie outside the pin directory, could read every line appended later.`]);
    const c = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual([c.code, c.out, c.err], [2, '', `ltms pin: ${r.message} Find its other names: find / -samefile '${log}' 2>/dev/null; to start a pin elsewhere, give another --to.\n`]);
    assert.deepEqual(readFileSync(other), before);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), PINNED[rel]);
    checkClean(await checkPin(t.to));
    // a third name, inside --to: the message counts the names of the file read
    const third = join(t.to, 'PINS.log.bak');
    linkSync(log, third);
    assert.match((await pinPaths([t.root], t.opts())).message, new RegExp(`^'${escapeRe(log)}' has 3 names \\(hard links to one file\\): `));
    rmSync(third);
    rmSync(other);
    const g = await pinPaths([t.root], t.opts());
    assert.deepEqual([g.k, g.failures, g.coverage.files.grown], ['pinned', [], 1]);
  } finally { t.clean(); }
});

test('pin, a socket at the lock: a failure, op lock, not-a-regular-file (it is never opened, which gives ENXIO); a socket at PINS.log: refused, saying it is a socket (S358 last fix [4], adopted from the checker\'s V01)', { skip: process.platform === 'win32' && 'no socket at a path on win32' }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const srv = createServer(() => {});
    await new Promise((r) => srv.listen(lockOf(t), r));
    try {
      const r = await pinPaths([t.root], t.opts({ lockWaitMs: 500 }));
      assert.deepEqual(r.failures.map((f) => [f.op, f.code]), [['lock', 'not-a-regular-file']]);
    } finally { await new Promise((r) => srv.close(r)); }
    const log = join(t.to, 'PINS.log');
    renameSync(log, join(t.tmp, 'PINS.log.real'));
    const srv2 = createServer(() => {});
    await new Promise((r) => srv2.listen(log, r));
    try {
      const r = await pinPaths([t.root], t.opts());
      assert.deepEqual([r.k, r.reason, r.message], ['refused', 'log-unreadable', `'${log}' is not a regular file (it is a socket): pin reads and appends to its log only as a regular file.`]);
    } finally { await new Promise((r) => srv2.close(r)); }
  } finally { t.clean(); }
});

test('pin, a directory at PINS.log: refused as not a regular file (it is a directory), never as a symbolic link; --check says the same (S358 last fix [4], adopted from the checker\'s V03)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const log = join(t.to, 'PINS.log');
    renameSync(log, join(t.tmp, 'PINS.log.real'));
    mkdirSync(log);
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual([r.k, r.reason, r.message], ['refused', 'log-unreadable', `'${log}' is not a regular file (it is a directory): pin reads and appends to its log only as a regular file.`]);
    const k = await checkPin(t.to, { lockWaitMs: 0 });
    assert.deepEqual([k.k, k.reason, k.message], ['refused', 'not-a-pin', `'${t.to}' has a PINS.log that is not a regular file (it is a directory), so it is not a pin this check can read.`]);
  } finally { t.clean(); }
});

test('pin, a new PINS.log is never read back: a FIFO put at its name right after it is linked is never waited on (the pin ends: a failure, op log, not-a-regular-file) (S358 last fix [3], adopted from the checker\'s V04)', { skip: NO_FIFOS }, () => {
  const t = tree();
  try {
    const log = join(t.to, 'PINS.log');
    const c = childModule(`process.stdout.write(JSON.stringify(await pinPaths([${JSON.stringify(t.root)}], ${JSON.stringify(t.opts())})));`, { patch: `
      const link = fs.linkSync;
      fs.linkSync = function (from, to) {
        const r = link.apply(this, arguments);
        if (String(to) === ${JSON.stringify(log)}) { fs.renameSync(${JSON.stringify(log)}, ${JSON.stringify(log + '.made')}); execFileSync('mkfifo', [${JSON.stringify(log)}]); }
        return r;
      };` });
    const r = ranTo(c);
    assert.deepEqual(r.failures.map((f) => [f.op, f.code]), [['log', 'not-a-regular-file']]);
    assert.ok(isFifo(log));
  } finally { t.clean(); }
});

test('pin, a dead lock that becomes a FIFO between its two reads is never waited on: a failure, op lock, not-a-regular-file (S358 last fix [3], adopted from the checker\'s V05)', { skip: NO_FIFOS }, () => {
  const t = tree();
  try {
    const dead = 2147483646;   // past every pid_max: no process has it
    plantLock(t, { pid: dead, host: hostname(), started: '2026-01-01T00:00:00.000Z' });
    const lock = lockOf(t);
    const c = childModule(`process.stdout.write(JSON.stringify(await pinPaths([${JSON.stringify(t.root)}], ${JSON.stringify(t.opts())})));`, { patch: `
      const kill = process.kill.bind(process);
      let swapped = false;
      process.kill = function (pid, sig) {
        if (pid === ${dead} && sig === 0 && !swapped) { swapped = true; fs.renameSync(${JSON.stringify(lock)}, ${JSON.stringify(lock + '.was')}); execFileSync('mkfifo', [${JSON.stringify(lock)}]); }
        return kill(pid, sig);
      };` });
    const r = ranTo(c);
    assert.deepEqual(r.failures.map((f) => [f.op, f.code]), [['lock', 'not-a-regular-file']]);
  } finally { t.clean(); }
});

test('check: a source .jsonl with no copy that cannot be read counts as missing, though a readable one with no new line would not (S358 last fix [6], adopted from the checker\'s V07)', { skip: NEEDS_PERMISSIONS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const p = t.put(`${Q}/77777777-7777-4777-8777-777777777777.jsonl`, '{"type":"user","text":"an invented line not yet fin');
    assert.deepEqual([(await checkPin(t.to)).staleness.missing], [0]);   // readable, with no new line: a pin does not copy it
    chmodSync(p, 0o000);
    assert.deepEqual([(await checkPin(t.to)).staleness.missing], [1]);
  } finally { t.clean(); }
});

test('check: a .jsonl grown by an empty line (a new line right at its copy\'s end) is longer, not unfinished (S358 last fix [6], adopted from the checker\'s V15)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    appendFileSync(t.src(`${Q}/${SB}.jsonl`), '\n');
    const k = await checkPin(t.to);
    assert.deepEqual([k.staleness.longer, k.staleness.unfinished], [1, 0]);
  } finally { t.clean(); }
});

test('ltms pin: the closing line looks at the lock with ls -l only after a lock that is not a regular file: a FIFO at a kept copy\'s name (op keep, not-a-regular-file) and a lock that cannot be written (op lock, EACCES) get no such command (S358 last fix [2]; a guard of its two conditions)', { skip: (NO_FIFOS || NEEDS_PERMISSIONS) && 'needs FIFOs, and file permissions that stop the user' }, () => {
  const tail = 'Every file pinned is whole and in PINS.log; once the cause is fixed, the same command pins the rest.\n';
  {
    const t = tree();
    try {
      assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
      const rel = `${Q}/${SB}.jsonl`, kept = t.pin(`${Q}/${SB}.superseded-${sha12(PINNED[rel])}.jsonl`);
      mkfifo(kept);
      writeFileSync(t.src(rel), L4);   // rewritten: the old copy is to be kept by that name
      const r = ltmsKilled(t, ['pin', t.root, '--to', t.to]);
      assert.deepEqual([r.signal, r.code], [null, 1]);
      assert.equal(r.err, `ltms pin: 1 failure, each named on stdout ("k":"failure": the path, the step and the error code; the first: keep '${kept}', not-a-regular-file). ${tail}`);
    } finally { t.clean(); }
  }
  {
    const t = tree();
    try {
      mkdirSync(t.to, { mode: 0o500 });
      const r = ltms(t, ['pin', t.root, '--to', t.to]);
      assert.equal(r.code, 1);
      assert.equal(r.err, `ltms pin: 1 failure, each named on stdout ("k":"failure": the path, the step and the error code; the first: lock '${lockOf(t)}', EACCES). ${tail}`);
    } finally { t.clean(); }
  }
});

test('README, ltms pin --help and docs/library.md say what this fix changed: the --rehash command --check gives and what it does, unfinished only for a copy that is a prefix, the refusal of a PINS.log with another name, and that whoever can write into the pin directory can replace pin\'s files; none says that no command restores a version (S358 last fix [0], [1], [9])', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const readme = flat(readFileSync(join(here, '..', 'README.md'), 'utf8'));
  const docs = flat(readFileSync(join(here, '..', 'docs', 'library.md'), 'utf8'));
  const help = flat(spawnSync(process.execPath, [CLI, 'pin', '--help'], { encoding: 'utf8' }).stdout);
  const says = (where, text, phrases) => { for (const p of phrases) assert.ok(text.includes(p), `${where} does not say: ${p}`); };
  says('README', readme, [
    'has another name (a hard link, under which every line appended later could be read)',
    // 0.1.1 (E2) puts the file itself, for one where a pin of its project does not go, between these two
    'the closing line gives the `--rehash` command for the projects of those copies',
    ': it writes back into the current copies what their sources still hold, and `ltms pin --check`, run again, says what remains.',
    'one whose copy is a byte prefix of it, longer only by an unfinished line, is counted apart, `unfinished`',
    "- Whoever can write into the pin directory can replace pin's files there with their own",
    'its closing line still gives the `--rehash` command, which writes back only what the source holds.',
  ]);
  says('ltms pin --help', help, [
    'has another name (a hard link)',
    'one whose copy is a prefix of it, longer only by an unfinished line',
    // 0.1.1 (E2) puts the file itself, for one where a pin of its project does not go, between these two
    'its closing line gives the --rehash command for the projects of those copies',
    ': it writes back what the sources still hold, and --check, run again, says what remains.',
  ]);
  says('docs/library.md', docs, [
    'has another name (a hard link, under which every line appended later could be read)',
    'the copy is a byte prefix of the file',
  ]);
  for (const [where, text] of [['README', readme], ['ltms pin --help', help], ['docs/library.md', docs]]) {
    assert.ok(!/no command restores|restorable/.test(text), `${where} still says that no command restores a version, or names restorable`);
  }
});

// ---- the closure fix (S358, notes-F4): the checker's findings 0-5 (restorable_result.json, "check") -------------------
// [0] with --rehash, recovery leaves to the run a copy that no longer holds the version its last line records (no kept
// copy waiting beside it) when its source, pinned in that run, still holds that version: the run writes it again from
// the source, so the --rehash command --check gives clears it (the checker's FP-resized). [1] that command only for a
// source of the cleanup's shape. [2] --check's notice on a PINS.log with another name, and no pin command while it has
// one. [3] ls -l on a PINS.log that cannot be read. [4] the checker's throwaway tests (verify-f3/throwaway/
// f3-survivors.test.mjs), adopted. [5] the help: the projects of those copies. Each test was run red first on the build
// of final3.patch (notes-F4/), except the adopted ones, which are green there and red on their mutants, and the guards,
// which say so in their titles.

/** A copy damaged as the checker's FP-resized damages it: its byte 3 changed, and its last `cut` bytes cut off. */
const damage = (p, cut) => { const b = readFileSync(p); b[3] ^= 1; writeFileSync(p, b.subarray(0, b.length - cut)); return b.subarray(0, b.length - cut); };
const versionOf = (s) => ({ bytes: len(s), sha256: sha(s) });
/** The rels of the kept copies in a pin (named by a sha12), not Claude Code's own set-aside copies. */
const keptIn = (to) => filesUnder(to).filter((f) => /\.superseded-[0-9a-f]{12}(?:\.jsonl)?$/.test(f));

test('ltms pin --check after a copy was cut inside its last line and changed at a byte, its source unchanged (and the same after its source has grown, and for a tool result, copied whole): the --rehash command, run as printed, writes each back from its source, and the check then exits 0 with nothing to say (S358 closure fix [0], the checker\'s FP-resized)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  for (const [name, project, rel, after] of [['source unchanged', Q, `${Q}/${SB}.jsonl`, ''], ['source grown since', Q, `${Q}/${SB}.jsonl`, L4],
    ['a tool result', P, `${P}/${SA}/tool-results/b000000001.txt`, '']]) {
    const t = tree();
    try {
      assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
      damage(t.pin(rel), 5);
      appendFileSync(t.src(rel), after);
      const k = ltms(t, ['pin', '--check', t.to]);
      assert.equal(k.code, 1, name);
      const command = rehashOf(k.err);
      assert.equal(command, `ltms pin '${t.src(project)}' --to '${t.to}' --root '${t.root}' --rehash`, name);
      const fix = runPrinted(t, command);
      assert.equal(fix.code, 0, `${name}: ${fix.err}`);
      assert.equal(readFileSync(t.pin(rel), 'utf8'), PINNED[rel] + after, name);
      const again = ltms(t, ['pin', '--check', t.to]);
      assert.deepEqual([again.code, again.err], [0, ''], name);
    } finally { t.clean(); }
  }
});

test('pin --rehash, a copy cut inside its last line and changed at a byte (it holds its version no more, and no kept copy waits beside it), its source still holding that version: no recovered line records the copy\'s bytes; the run writes it again from the source, with a recovered line for that version (grown, after its source has grown), keeps nothing, and the pin checks clean; a damaged copy in a project the run does not pin still gets recovery\'s line (S358 closure fix [0])', async () => {
  for (const after of ['', L4]) {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel], other = `${P}/${SA}.jsonl`;
      damage(t.pin(rel), 5);
      const bad = damage(t.pin(other), 5);
      appendFileSync(t.src(rel), after);
      const r = await pinPaths([t.src(Q)], t.opts({ rehash: true }));   // Q only: P's damaged copy is not pinned in this run
      assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev]), [
        ['recovered', other, bad.length, sha(bad), versionOf(PINNED[other])],   // recovery's, as before: P is not pinned here
        after ? ['grown', rel, len(good + after), sha(good + after), versionOf(good)] : ['recovered', rel, len(good), sha(good), versionOf(good)],
      ]);
      assert.deepEqual(r.coverage.files, after ? counts({ seen: 1, grown: 1 }) : counts({ seen: 1, unchanged: 1 }));
      assert.deepEqual(r.notices, [
        `1 file in '${t.to}' held other bytes than its last line in PINS.log records, or was named by no line: a recovered line now records what each one holds.`,
        ...(after ? [] : [`1 copy in '${t.to}' held other bytes than its last line in PINS.log records, and was written again from its source, which still holds that version (--rehash), with a recovered line each.`]),
      ]);
      assert.equal(readFileSync(t.pin(rel), 'utf8'), good + after);
      assert.deepEqual(keptIn(t.to), []);
      const k = await checkPin(t.to);
      assert.deepEqual(k.mismatches.map((m) => [m.rel, m.copy]), [[other, other]]);   // P's: its recovered line holds, its earlier version does not
    } finally { t.clean(); }
  }
});

test('pin --rehash after a pin killed between the rename of a grown copy and its line, its source then cut back to the version that line records: the grown copy, a version only the pin holds, still gets recovery\'s line and is kept as the old copy of a rewrite, never written over (S358 closure fix [0]; a guard: final3 kept it too)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel];
    appendFileSync(t.src(rel), L4);
    assert.equal(childPin(t, [t.root], 'renamed', rel, KILL).signal, 'SIGKILL');
    assert.equal(readFileSync(t.pin(rel), 'utf8'), good + L4);   // renamed, with no line
    writeFileSync(t.src(rel), good);                              // cut back to the version its last line records
    const r = await pinPaths([t.root], t.opts({ rehash: true }));
    const kept = `${Q}/${SB}.superseded-${sha12(good + L4)}.jsonl`;
    assert.deepEqual(r.lines.filter((l) => l.rel !== undefined).map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [
      ['recovered', rel, len(good + L4), sha(good + L4), versionOf(good), undefined],
      ['rewritten', rel, len(good), sha(good), versionOf(good + L4), kept],
    ]);
    assert.deepEqual([readFileSync(t.pin(kept), 'utf8'), readFileSync(t.pin(rel), 'utf8')], [good + L4, good]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('pin without --rehash, a copy cut inside its last line and changed at a byte, its source unchanged: recovery records the copy\'s bytes, and the pin keeps them as the old copy of a rewrite; --check then reads the first version from that kept copy, at every check, with no command, and --rehash does not clear it, as README Limits says (S358 closure fix [0]; a guard: final3 did the same)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel], line = logLines(t.to).findIndex((l) => l.rel === rel) + 1;
    const bad = damage(t.pin(rel), 5);
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);   // the hook's pin, or cron's
    const kept = `${Q}/${SB}.superseded-${sha12(bad)}.jsonl`;
    assert.deepEqual(keptIn(t.to), [kept]);
    for (let i = 0; i < 2; i++) {
      const k = ltms(t, ['pin', '--check', t.to]);
      assert.deepEqual([k.code, rowsOf(k.out).slice(1), rehashOf(k.err)],
        [1, [{ k: 'mismatch', rel, copy: kept, line, want: versionOf(good), got: versionOf(bad) }], null], k.err);
      assert.equal(ltms(t, ['pin', t.src(Q), '--to', t.to, '--root', t.root, '--rehash']).code, 0);
    }
  } finally { t.clean(); }
});

test('ltms pin --check, a changed copy whose source is a regular file no longer of the cleanup\'s shape (its session directory, not named by a UUID, has lost its transcript): no --rehash command, since no pin copies that source; the same change in a session directory named by a UUID gets it (S358 closure fix [1], the checker\'s F2)', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const named = `${P}/sess-named/tool-results/x.txt`, uuid = `${P}/${SO}/tool-results/z.txt`;
    const flip0 = (rel) => { const b = readFileSync(t.pin(rel)); b[0] ^= 1; writeFileSync(t.pin(rel), b); };
    flip0(named);
    rmSync(t.src(`${P}/sess-named.jsonl`));   // sess-named/ is now a directory beside no transcript: no pin copies its files
    const log = join(t.to, 'PINS.log'), line = logLines(t.to).findIndex((l) => l.rel === named) + 1;
    let r = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.code, r.err], [1, `ltms pin: '${t.to}' does not hold what '${log}' records: 1 mismatch, 0 chain breaks and 0 lines that are not log lines, each on stdout with its line in PINS.log. To read the first: sed -n '${line}p' '${log}'\n`]);
    flip0(uuid);
    r = ltms(t, ['pin', '--check', t.to]);
    assert.equal(rehashOf(r.err), `ltms pin '${t.src(P)}' --to '${t.to}' --root '${t.root}' --rehash`);
  } finally { t.clean(); }
});

test('ltms pin --check, a PINS.log with another name (a hard link): a notice says that every pin into the directory is refused until only one name is left, with the find command; no pin command is given, neither the --rehash command nor "To pin them"; once the other name is gone, the --rehash command comes back, and the line on the files behind the pin says to run it first and gives no pin command beside it (0.1.2), and checkPin\'s logNames counts the names (S358 closure fix [2], the checker\'s F3)', async () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const log = join(t.to, 'PINS.log'), other = join(t.tmp, 'other-name.log');
    linkSync(log, other);
    const rel = `${Q}/${SB}.jsonl`, line = logLines(t.to).findIndex((l) => l.rel === rel) + 1;
    const b = readFileSync(t.pin(rel)); b[3] ^= 1; writeFileSync(t.pin(rel), b);   // a mismatch
    t.put(`${Q}/77777777-7777-4777-8777-777777777777.jsonl`, L1);                  // and a source missing from the pin
    const notice = `ltms pin: '${log}' has 2 names (hard links to one file): a pin refuses a log that has another name, so every pin into '${t.to}' is refused until only one name is left. Find its other names: find / -samefile '${log}' 2>/dev/null`;
    const closing = `ltms pin: '${t.to}' does not hold what '${log}' records: 1 mismatch, 0 chain breaks and 0 lines that are not log lines, each on stdout with its line in PINS.log. To read the first: sed -n '${line}p' '${log}'`;
    const stale = (last) => `ltms pin: 1 file under the root '${escapeRe(t.root)}' is missing from the pin, and 0 are longer than their copies \\(PINS\\.log's last line: ${escapeRe(last)}, \\d+ min ago\\)`;
    let r = ltms(t, ['pin', '--check', t.to]);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`^${escapeRe(notice)}\\n${escapeRe(closing)}\\n${stale(rowsOf(r.out)[0].lastLog)}\\.\\n$`));
    let k = await checkPin(t.to);
    assert.deepEqual([k.logNames, k.notices], [2, [notice.slice('ltms pin: '.length)]]);
    rmSync(other);
    r = ltms(t, ['pin', '--check', t.to]);
    assert.match(r.err, new RegExp(`^${escapeRe(closing)}\\. ${escapeRe(REHASH)} ltms pin '${escapeRe(t.src(Q))}' --to '${escapeRe(t.to)}' --root '${escapeRe(t.root)}' --rehash\\n${stale(rowsOf(r.out)[0].lastLog)}\\. ${escapeRe(REHASH_FIRST)}\\n$`));
    k = await checkPin(t.to);
    assert.deepEqual([k.logNames, k.notices], [1, []]);
  } finally { t.clean(); }
});

test('ltms pin --check and ltms pin, a PINS.log that is a regular file they cannot read: each refusal (exit 2) gives ls -l on it, which shows its mode and owner, never a guessed cause nor a command that meets the same refusal; with a second name too, the pin still names the read that failed (S358 closure fix [3], the checker\'s eacces-log)', { skip: NEEDS_PERMISSIONS }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const log = join(t.to, 'PINS.log');
    chmodSync(log, 0o000);
    const k = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([k.code, k.out, k.err], [2, '', `ltms pin: '${t.to}' has a PINS.log that cannot be read (EACCES), so it is not a pin this check can read. See its mode and owner: ls -l '${log}'\n`]);
    const pinned = `ltms pin: '${log}' cannot be read (EACCES). See its mode and owner: ls -l '${log}'; to start a pin elsewhere, give another --to.\n`;
    const p = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual([p.code, p.out, p.err], [2, '', pinned]);
    const ls = spawnSync('/bin/sh', ['-c', `ls -l '${log}'`], { encoding: 'utf8' });   // the command given, as printed
    assert.deepEqual([ls.status, ls.stdout.slice(0, 10)], [0, '----------']);
    linkSync(log, join(t.tmp, 'other-name.log'));   // the read fails before the names are counted: the message and the command say so
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).err, pinned);
  } finally { t.clean(); }
});

test('ltms pin --help, the --check paragraph: the closing line\'s --rehash command is for the projects of those copies, as the README says, and their sources are looked for under the root PINS.log records (S358 closure fix [5]; C11 adopted from the checker\'s f3-survivors)', () => {
  const help = spawnSync(process.execPath, [CLI, 'pin', '--help'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ');
  // 0.1.1 (E2): the file itself, for one where a pin of its project does not go, comes between the two halves
  assert.ok(help.includes('its closing line gives the --rehash command for the projects of those copies (for a file under .git, or under memory/ directly under a project directory, where a pin of its project does not go, the file itself): it writes back what the sources still hold, and --check, run again, says what remains.'), help);
  assert.ok(help.includes('After a mismatch in a current copy whose source is there (under the root PINS.log records'), help);
  assert.ok(!help.includes('for that project'), help);
});

test('ltms pin, a directory at PINS.log that has two names, as ext4 and tmpfs give every directory (here a stubbed lstat: btrfs gives one): the next command is ls -l on it, never find -samefile (S358 closure fix [4], C01 adopted from the checker\'s f3-survivors, with a stubbed lstat)', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const log = join(t.to, 'PINS.log'), used = join(t.tmp, 'stub-used'), stub = join(t.tmp, 'two-names.mjs');
    renameSync(log, join(t.tmp, 'PINS.log.real'));
    mkdirSync(log);
    writeFileSync(stub, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const lstat = fs.lstatSync;
fs.lstatSync = function (p) {
  const s = lstat.apply(this, arguments);
  if (String(p) === ${JSON.stringify(log)} && s.isDirectory()) { s.nlink = 2; fs.writeFileSync(${JSON.stringify(used)}, ''); }
  return s;
};
syncBuiltinESMExports();
`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, CLI, 'pin', t.root, '--to', t.to], { encoding: 'utf8', timeout: 60000, cwd: t.tmp,
      env: { ...process.env, CLAUDE_CONFIG_DIR: t.config } });
    assert.ok(existsSync(used), `the stub gave the directory no second name: ${r.stderr}`);
    assert.deepEqual([r.status, r.stderr], [2, `ltms pin: '${log}' is not a regular file (it is a directory): pin reads and appends to its log only as a regular file. See what it is: ls -l '${log}'; to start a pin elsewhere, give another --to.\n`]);
  } finally { t.clean(); }
});

test('ltms pin --check, a changed copy whose source\'s place now holds a FIFO: no --rehash command, since a pin does not copy a FIFO, and the FIFO is never waited on (S358 closure fix [4], C05 adopted from the checker\'s f3-survivors)', { skip: NO_FIFOS }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`;
    const b = readFileSync(t.pin(rel)); b[3] ^= 1; writeFileSync(t.pin(rel), b);
    rmSync(t.src(rel));
    mkfifo(t.src(rel));
    const r = ltmsKilled(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.signal, r.code, rehashOf(r.err)], [null, 1, null], r.err);
  } finally { t.clean(); }
});

test('ltms pin --check, a changed copy of one of Claude Code\'s own set-aside copies (<name>.jsonl.superseded-<n>, a current copy, not a kept one): the --rehash command names its project; run as printed, it writes the copy back, and the check then exits 0 (S358 closure fix [4], C06 adopted from the checker\'s f3-survivors)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const aside = `${P}/22222222-2222-4222-8222-222222222222.jsonl.superseded-1731067200000`;
    const b = readFileSync(t.pin(aside)); b[3] ^= 1; writeFileSync(t.pin(aside), b);
    const command = rehashOf(ltms(t, ['pin', '--check', t.to]).err);
    assert.equal(command, `ltms pin '${t.src(P)}' --to '${t.to}' --root '${t.root}' --rehash`);
    assert.equal(runPrinted(t, command).code, 0);
    assert.deepEqual([ltms(t, ['pin', '--check', t.to]).code, readFileSync(t.pin(aside), 'utf8')], [0, PINNED[aside]]);
  } finally { t.clean(); }
});

test('ltms pin --check, the root PINS.log records moved and linked back from its old place: no --rehash command, since a pin with that root would be refused (root-differs) (S358 closure fix [4], C14 adopted from the checker\'s f3-survivors)', { skip: NO_LINKS }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`;
    const b = readFileSync(t.pin(rel)); b[3] ^= 1; writeFileSync(t.pin(rel), b);
    const moved = join(t.tmp, 'moved-projects');
    renameSync(t.root, moved);
    symlinkSync(moved, t.root);
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([r.code, rehashOf(r.err)], [1, null], r.err);
    // what such a command would meet
    assert.equal(ltms(t, ['pin', t.src(Q), '--to', t.to, '--root', t.root, '--rehash']).code, 2);
  } finally { t.clean(); }
});

test('ltms pin --check, a mismatch with a chain break beside it: the --rehash command is still given (S358 closure fix [4], C19 adopted from the checker\'s f3-survivors)', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const log = join(t.to, 'PINS.log');
    const lines = readFileSync(log, 'utf8').split('\n');
    const o = JSON.parse(lines[1]); o.mtime = '2001-01-01T00:00:00.000000000Z'; lines[1] = JSON.stringify(o);   // line 2's bytes change: line 3's chain breaks
    writeFileSync(log, lines.join('\n'));
    const rel = `${Q}/${SB}.jsonl`;
    const b = readFileSync(t.pin(rel)); b[3] ^= 1; writeFileSync(t.pin(rel), b);
    const r = ltms(t, ['pin', '--check', t.to]);
    assert.match(r.err, /: 1 mismatch, 1 chain break and 0 lines that are not log lines, /);
    assert.equal(rehashOf(r.err), `ltms pin '${t.src(Q)}' --to '${t.to}' --root '${t.root}' --rehash`);
  } finally { t.clean(); }
});

test('README, ltms pin --help and docs/library.md say what the closure fix changed: recovery under --rehash, the damage --rehash cannot clear, the cleanup\'s shape of the --rehash command\'s sources, the notice on a PINS.log with another name, isSweepShaped and logNames; and the sentences of the last fix (T1-T6 adopted from the checker\'s f3-survivors, T4 and T5 adjusted to the shape) (S358 closure fix [0], [1], [2], [4])', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const readme = flat(readFileSync(join(here, '..', 'README.md'), 'utf8'));
  const docs = flat(readFileSync(join(here, '..', 'docs', 'library.md'), 'utf8'));
  const help = flat(spawnSync(process.execPath, [CLI, 'pin', '--help'], { encoding: 'utf8' }).stdout);
  const says = (where, text, phrases) => { for (const p of phrases) assert.ok(text.includes(p), `${where} does not say: ${p}`); };
  says('README', readme, [
    // this fix, in 0.1.1's words: the same rule, with E1's and E4's cases beside it, and the Limits' doors named
    'Under `--rehash`, a copy with no kept copy beside it, whose source is pinned in that run, gets none when',
    'when the copy no longer holds that version at its start, and its source still holds the version at its start (as whole lines, for a `.jsonl`);',
    '- `--rehash` cannot clear damage in a kept copy, which is never written again, and `--check` reports the versions such a copy no longer holds at every check, with no command. A pin keeps a damaged copy that is no prefix of its source as it is, as the old copy of a rewrite, when the source has been rewritten since the version the copy\'s last line records;',
    'which a pin without `--rehash` does for a copy whose size is not that version\'s,',
    'While `PINS.log` has another name (a hard link), which makes every pin into the directory a refusal, a notice says so, with the `find` command that names the others; no pin command is given,',
    // T1-T3 and T6, as the checker wrote them; T4 and T5 with the cleanup's shape
    'and, when none was, its first bytes, as many as its copy holds, to see whether its copy is a prefix of it',
    'one rewritten under an unfinished line is longer)',
    'those whose copy is a prefix of them, longer only by an unfinished line (`unfinished`)',
    'whether the source of a damaged copy is there, as a regular file of the cleanup\'s shape reached through no symbolic link (not its bytes), to give the `--rehash` command',
    'After a mismatch in a current copy (not a kept one) whose source is there, under the root PINS.log records, as itself (a regular file of the cleanup\'s shape, reached through no symbolic link),',
  ]);
  says('ltms pin --help', help, [
    'there (under the root PINS.log records, as a file pin copies), its closing line gives the --rehash command for the projects of those copies',
    'While PINS.log has another name (a hard link), which a pin refuses, it says so, gives no pin command,',   // 0.1.1 adds E3's clause after it
  ]);
  says('docs/library.md', docs, [
    '| `longer` | of those, the ones larger than their copy, by size, except those counted in `unfinished` |',
    '#### `isSweepShaped(root, rel)`',
    '| `logNames` |',
    // in 0.1.1's words: the same rule, with E1's and E4's cases beside it
    'With `rehash`, a copy that does not hold that version, beside which no kept copy waits, and whose source is among those this run pins, gets no `recovered` line',
    'It no longer holds the version at its start, and its source still holds it at its start (as whole lines, for a `.jsonl`): the run writes it again from that source',
  ]);
});

// The mutation gaps of this fix (notes-F4/mut/): each test below is green on this code and red on its mutant.

test('pin --rehash after a pin killed between the rename of a rewritten copy and its line (the old copy kept beside it, named by no line), its source then rewritten back to that old version: recovery still records what the copy holds, with that kept copy, and the run keeps the newer version as the old copy of a rewrite; nothing is written over, nothing is left unlogged (S358 closure fix [0], the mutation gap P02)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, old = PINNED[rel];
    writeFileSync(t.src(rel), L4);   // rewritten
    assert.equal(childPin(t, [t.root], 'renamed', rel, KILL).signal, 'SIGKILL');
    const keptOld = `${Q}/${SB}.superseded-${sha12(old)}.jsonl`, keptNew = `${Q}/${SB}.superseded-${sha12(L4)}.jsonl`;
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), readFileSync(t.pin(keptOld), 'utf8')], [L4, old]);   // renamed, with no line
    writeFileSync(t.src(rel), old);   // back to the version its last line records
    const r = await pinPaths([t.root], t.opts({ rehash: true }));
    assert.deepEqual(r.lines.filter((l) => l.rel !== undefined).map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [
      ['recovered', rel, len(L4), sha(L4), versionOf(old), keptOld],
      ['rewritten', rel, len(old), sha(old), versionOf(L4), keptNew],
    ]);
    assert.deepEqual([readFileSync(t.pin(keptNew), 'utf8'), readFileSync(t.pin(rel), 'utf8')], [L4, old]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('pin --rehash, a copy whose last line records a version that ends in an unfinished line (recorded by recovery in a pin of another project), cut since, its source holding that version\'s bytes but no new line after them: recovery records the copy as without --rehash, since a pin does not copy that version back (S358 closure fix [0], the mutation gap P04)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, N = PINNED[rel];
    appendFileSync(t.pin(rel), 'abc');
    await pinPaths([t.src(P)], t.opts());   // Q's copy is recorded as it is now (N + 'abc') by recovery; Q is not pinned
    assert.deepEqual(logLines(t.to).filter((l) => l.rel === rel).map((l) => [l.how, l.bytes]), [['new', len(N)], ['recovered', len(N) + 3]]);
    writeFileSync(t.src(rel), N + 'abcdef');   // holds those bytes, with no new line after them
    writeFileSync(t.pin(rel), N + 'a');        // and the copy is cut
    const r = await pinPaths([t.src(Q)], t.opts({ rehash: true }));
    const kept = `${Q}/${SB}.superseded-${sha12(N + 'a')}.jsonl`;
    assert.deepEqual(r.lines.map((l) => [l.how, l.bytes, l.prev, l.kept]), [
      ['recovered', len(N) + 1, versionOf(N + 'abc'), undefined],
      ['rewritten', len(N), versionOf(N + 'a'), kept],
    ]);
    assert.deepEqual(r.notices, [`1 file in '${t.to}' held other bytes than its last line in PINS.log records, or was named by no line: a recovered line now records what each one holds.`]);
  } finally { t.clean(); }
});

test('ltms pin --check after a file copied whole with no new line at its end was cut and changed at a byte, its source unchanged: the --rehash command, run as printed, writes it back, and the check then exits 0 (S358 closure fix [0], the mutation gap P05)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${P}/${SA}/workflows/wf_00000001-001.json`;
    assert.ok(!PINNED[rel].includes('\n'));
    damage(t.pin(rel), 5);
    const command = rehashOf(ltms(t, ['pin', '--check', t.to]).err);
    assert.equal(command, `ltms pin '${t.src(P)}' --to '${t.to}' --root '${t.root}' --rehash`);
    assert.equal(runPrinted(t, command).code, 0);
    assert.deepEqual([ltms(t, ['pin', '--check', t.to]).code, readFileSync(t.pin(rel), 'utf8')], [0, PINNED[rel]]);
  } finally { t.clean(); }
});

// P13 changed in 0.1.1 (E1 of 0.1.0's known limits). 0.1.0 pinned the fail-closed choice here: recovery recorded the
// damaged copy, since that its source holds the version could not be shown. Once the source could be read again, the
// --rehash that --check gives found the source "rewritten" against those recorded bytes and kept them as the old copy,
// and --check then reported the first version from that kept copy at every check, with no command. Now recovery records
// nothing from a copy it cannot check against its source: the run fails on that file, and the next --rehash decides.
test('pin --rehash, a copy cut and changed at a byte while its source cannot be read: recovery records nothing, since it cannot check the copy against that source; the read of the source is the run\'s failure, and the copy is left as it is; once the source can be read, the next --rehash writes the copy again from it, with a recovered line, keeps nothing, and the pin checks clean (S358 closure fix [0], the mutation gap P13; changed in 0.1.1, E1)', { skip: NEEDS_PERMISSIONS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel];
    const bad = damage(t.pin(rel), 5);
    const log = logText(t.to);
    chmodSync(t.src(rel), 0o000);
    const r = await pinPaths([t.root], t.opts({ rehash: true }));
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.failures, [{ path: t.src(rel), rel, op: 'read', code: 'EACCES' }]);
    assert.deepEqual([r.coverage.files, r.coverage.failures, r.notices], [counts({ seen: RELS.length, unchanged: RELS.length - 1, failed: 1 }), 1, []]);
    assert.deepEqual([logText(t.to), readFileSync(t.pin(rel))], [log, bad]);
    chmodSync(t.src(rel), 0o600);
    const again = await pinPaths([t.root], t.opts({ rehash: true }));
    assert.deepEqual(again.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [['recovered', rel, len(good), sha(good), versionOf(good), undefined]]);
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), keptIn(t.to)], [good, []]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

// ---- 0.1.1: the four known limits of 0.1.0's pin (S359, track P) --------------------------------------------------
// E1 (P13 above, and two tests here), E2, E3 and E4 of 0.1.0's CHANGELOG, "Known limits (to be fixed in 0.1.1)". Each
// test was run first against 0.1.0's build and seen red for the reason its title gives, except the guards, which say
// so in their titles. Expected values come from how each tree is built, as above.

/** A path as one word of a shell command, as ltms writes one: in single quotes, each single quote in it written '\''. */
const shQuoted = (s) => `'${s.replace(/'/g, "'\\''")}'`;
/** The words /bin/sh makes of a command line's text, each printed on its own line by printf. */
const wordsOf = (text) => spawnSync('/bin/sh', ['-c', `printf '%s\\n' ${text}`], { encoding: 'utf8' }).stdout.split('\n').slice(0, -1);
/** A command line ltms printed, run as printed by /bin/sh, its program a shell function that prints the words given it. */
const wordsRun = (program, line) => spawnSync('/bin/sh', ['-c', `${program}() { printf '%s\\n' "$@"; }; ${line}`], { encoding: 'utf8' }).stdout.split('\n').slice(0, -1);

test('ltms pin --check, a copy cut and changed at a byte while its source cannot be read: the --rehash command it gives fails on that file (exit 1, a failure line naming the file and EACCES) and records nothing, each time it is run; once the source can be read, the same command writes the copy back, keeps nothing, and the check then exits 0 with nothing to say (0.1.1, E1; the closure check\'s V4-FP-resized-source-unreadable and its then-readable step)', { skip: (NEEDS_PERMISSIONS || process.platform === 'win32') && 'needs file permissions and /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel];
    const bad = damage(t.pin(rel), 5);
    const log = logText(t.to);
    chmodSync(t.src(rel), 0o000);
    const command = `ltms pin '${t.src(Q)}' --to '${t.to}' --root '${t.root}' --rehash`;
    for (let i = 0; i < 2; i++) {
      assert.equal(rehashOf(ltms(t, ['pin', '--check', t.to]).err), command);
      const fix = runPrinted(t, command);
      assert.deepEqual([fix.code, rowsOf(fix.out).filter((o) => o.k === 'failure')], [1, [{ k: 'failure', path: t.src(rel), rel, op: 'read', code: 'EACCES' }]], fix.err);
      assert.deepEqual([logText(t.to), readFileSync(t.pin(rel))], [log, bad]);
    }
    chmodSync(t.src(rel), 0o600);
    assert.equal(rehashOf(ltms(t, ['pin', '--check', t.to]).err), command);
    assert.equal(runPrinted(t, command).code, 0);
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), keptIn(t.to)], [good, []]);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('pin --rehash after a pin killed between the rename of a grown copy and its line, while the source cannot be read: recovery records nothing of that copy either, since it cannot check it against that source, and the run fails on that file; the copy is left as it is, and once the source can be read, the next --rehash records it as before (0.1.1, E1)', { skip: NEEDS_PERMISSIONS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel];
    appendFileSync(t.src(rel), L4);
    assert.equal(childPin(t, [t.root], 'renamed', rel, KILL).signal, 'SIGKILL');
    chmodSync(t.src(rel), 0o000);
    const r = await pinPaths([t.src(Q)], t.opts({ rehash: true }));
    assert.deepEqual([r.lines.filter((l) => l.rel !== undefined), r.failures], [[], [{ path: t.src(rel), rel, op: 'read', code: 'EACCES' }]]);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), good + L4);
    chmodSync(t.src(rel), 0o600);
    const again = await pinPaths([t.src(Q)], t.opts({ rehash: true }));
    assert.deepEqual(again.lines.filter((l) => l.rel !== undefined).map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev]), [['recovered', rel, len(good + L4), sha(good + L4), versionOf(good)]]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('ltms pin --check, a changed copy of a file pinned by its own path where the walk of its project directory does not go (under a .git directory, or under memory/ directly under a project directory): the --rehash command names that file by its own path, quoted as the CLI quotes, beside the project of a changed copy the walk reaches; run as printed, it writes each back, and the check then exits 0 (0.1.1, E2; the closure check\'s item1 cases d and e)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    const git = `${P}/${SA}/tool-results/.git/it's a "result".txt`, mem = `${P}/memory/subagents/agent-a0000000000000002.jsonl`, reached = `${P}/${SA}.jsonl`;
    const reachedToo = `${P}/${SA}/subagents/agent-a0000000000000001.jsonl`;   // a second in that project: it is named once
    const held = { [git]: 'an invented result under .git\n', [mem]: L2, [reached]: PINNED[reached], [reachedToo]: PINNED[reachedToo] };
    t.put(git, held[git]);
    t.put(`${P}/memory.jsonl`, L1);   // beside it, memory/ is a session directory: the files under its subagents/ are of the cleanup's shape
    t.put(mem, held[mem]);
    const whole = ltms(t, ['pin', t.root, '--to', t.to]);
    assert.deepEqual([whole.code, rowsOf(whole.out)[0].skipped], [0, { ...BASE_SKIPPED, git: BASE_SKIPPED.git + 1 }]);   // the walk passes over both
    for (const rel of [git, mem]) assert.equal(ltms(t, ['pin', t.src(rel), '--to', t.to]).code, 0);   // each pinned by its own path
    for (const rel of [reached, reachedToo, git, mem]) { const b = readFileSync(t.pin(rel)); b[0] ^= 1; writeFileSync(t.pin(rel), b); }
    const k = ltms(t, ['pin', '--check', t.to]);
    assert.equal(k.code, 1);
    const command = rehashOf(k.err);
    assert.equal(command, `ltms pin ${[t.src(P), t.src(git), t.src(mem)].map(shQuoted).join(' ')} --to '${t.to}' --root '${t.root}' --rehash`, k.err);
    assert.deepEqual(wordsOf(command.slice('ltms pin '.length)), [t.src(P), t.src(git), t.src(mem), '--to', t.to, '--root', t.root, '--rehash']);
    const fix = runPrinted(t, command);
    assert.equal(fix.code, 0, fix.err);
    for (const rel of [reached, reachedToo, git, mem]) assert.equal(readFileSync(t.pin(rel), 'utf8'), held[rel], rel);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('projectPinReaches: true for exactly the files a pin of their project directory copies, as measured here by such a pin (files under .git and memory/ at several depths, project directories named .git and memory, and files the walk reaches), and as listed by hand from the walk\'s rule (0.1.1, E2)', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ltms-pin-')));
  try {
    const config = join(tmp, 'claude'), root = join(config, 'projects');
    // rel -> whether the walk of its project directory reaches it; every one is of the cleanup's shape
    const want = {
      [`${P}/${SA}.jsonl`]: true,
      [`${P}/${SA}/tool-results/x.txt`]: true,
      [`${P}/${SA}/tool-results/.git/x.txt`]: false,
      [`${P}/${SA}/tool-results/a/.git/b/x.txt`]: false,
      [`${P}/${SO}/tool-results/.git`]: true,          // a file named .git: the walk passes over directories only
      [`${P}/${SA}/subagents/memory/x.jsonl`]: true,   // a memory/ deeper than directly under the project directory
      [`${P}/memory.jsonl`]: true,
      [`${P}/memory/subagents/x.jsonl`]: false,       // memory/ directly under the project directory
      [`${P}/.git.jsonl`]: true,
      [`${P}/.git/subagents/x.jsonl`]: false,         // .git/ beside .git.jsonl: a session directory the walk does not enter
      [`.git/${SA}.jsonl`]: false,                    // a project directory named .git
      [`memory/${SA}.jsonl`]: true,                   // a project directory named memory
      ['memory/memory.jsonl']: true,
      ['memory/memory/subagents/x.jsonl']: false,
    };
    for (const rel of Object.keys(want)) { const p = join(root, ...rel.split('/')); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, L1); }
    const copied = new Set();
    for (const project of [P, '.git', 'memory']) {
      const r = await pinPaths([join(root, project)], { to: join(tmp, `pins${project}`), root, configDir: config });
      assert.equal(r.k, 'pinned');
      for (const l of r.lines) if (l.rel !== undefined) copied.add(l.rel);
    }
    const reached = Object.keys(want).filter((rel) => want[rel]).sort();
    assert.deepEqual([...copied].sort(), reached);
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((rel) => [rel, projectPinReaches(rel)])), want);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('pin, a file pinned by its own path under a source\'s .git directory: the pin\'s own scan sees its copy, so a pin of it again, unchanged, appends nothing, and one after its source is rewritten keeps the old copy first (0.1.0 read that copy as missing: it wrote it again with a recovered line at every pin, and lost the old version at a rewrite) (0.1.1, E2)', async () => {
  const t = tree();
  try {
    const rel = `${P}/${SA}/tool-results/.git/x.txt`, OLD = 'an invented first version\n', NEW = 'an invented second version, written over the first\n';
    t.put(rel, OLD);
    const one = await pinPaths([t.src(rel)], t.opts());
    assert.deepEqual(one.lines.filter((l) => l.rel !== undefined).map((l) => [l.how, l.rel]), [['new', rel]]);
    const again = await pinPaths([t.src(rel)], t.opts());
    assert.deepEqual([again.lines, again.notices, again.coverage.files], [[], [], counts({ seen: 1, unchanged: 1 })]);
    writeFileSync(t.src(rel), NEW);
    const kept = `${rel}.superseded-${sha12(OLD)}`;
    const r = await pinPaths([t.src(rel)], t.opts());
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.bytes, l.prev, l.kept]), [['rewritten', rel, len(NEW), versionOf(OLD), kept]]);
    assert.deepEqual([r.notices, readFileSync(t.pin(kept), 'utf8'), readFileSync(t.pin(rel), 'utf8')], [[], OLD, NEW]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('ltms pin --check, a PINS.log with another name: nothing is said of what a next pin would do (an unlogged file, a temp file, a lock left by a pin that stopped, a line cut short); the notice says once that every pin into the directory is refused, with a find command that /bin/sh reads back as the pin\'s PINS.log, for a pin directory whose name holds a space, a quote or a double quote, and that finds the other name; with one name again, each line says what the next pin does (0.1.1, E3; the closure check\'s item2 "quoted")', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  for (const name of ['my pins', "it's pins", 'say "pins"']) {
    const t = tree();
    try {
      const to = join(t.tmp, name), log = join(to, 'PINS.log'), lock = join(to, '.ltms-pin.lock'), other = join(t.tmp, 'other-name.log');
      assert.equal(ltms(t, ['pin', t.root, '--to', to]).code, 0);
      writeFileSync(join(to, Q, '66666666-6666-4666-8666-666666666666.jsonl'), L5);   // a file no line names
      writeFileSync(join(to, Q, `.${SB}.jsonl.ltms-tmp-4242`), 'left over');         // a temp file
      const holder = { pid: deadPid(), host: hostname(), started: '2026-11-08T10:00:00.000Z' };
      writeFileSync(lock, JSON.stringify(holder));                                      // a lock left by a pin that stopped
      appendFileSync(log, '{"t":"2026-11-0');                                           // a line cut short
      linkSync(log, other);
      const n = RELS.length + 2;   // the root line and a line per file come before it
      const closing = `ltms pin: ${shQuoted(to)} does not hold what ${shQuoted(log)} records: 0 mismatches, 0 chain breaks and 1 line that is not a log line, each on stdout with its line in PINS.log. To read the first: sed -n '${n}p' ${shQuoted(log)}`;
      const notice = `ltms pin: '${log}' has 2 names (hard links to one file): a pin refuses a log that has another name, so every pin into '${to}' is refused until only one name is left. Find its other names: find / -samefile ${shQuoted(log)} 2>/dev/null`;
      const r = ltms(t, ['pin', '--check', to]);
      assert.equal(r.code, 1, name);
      assert.deepEqual(r.err.split('\n'), [
        notice,
        `ltms pin: '${log}' does not end in a new line: line ${n} is cut short.`,
        closing,
        `ltms pin: 1 file in ${shQuoted(to)} is named by no line in PINS.log (on stdout, "k":"unlogged").`,
        `ltms pin: 1 temp file in ${shQuoted(to)} was left by a pin that stopped.`,
        `ltms pin: ${shQuoted(lock)} names pid ${holder.pid} on ${hostname()}, since ${holder.started}: a pin is running, or one stopped without removing it.`,
        '',
      ], name);
      // the find command, run as printed: /bin/sh hands find the pin's PINS.log; and the same predicate, searching this
      // test's directory rather than the whole file system (/, which would take minutes), finds both names
      const find = notice.slice(notice.indexOf('Find its other names: ') + 'Find its other names: '.length);
      assert.deepEqual(wordsRun('find', find), ['/', '-samefile', log], name);
      const found = spawnSync('/bin/sh', ['-c', find.replace(/^find \/ /, `find ${shQuoted(t.tmp)} `)], { encoding: 'utf8' });
      assert.deepEqual(found.stdout.split('\n').slice(0, -1).sort(), [log, other].sort(), name);
      rmSync(other);
      const one = ltms(t, ['pin', '--check', to]);
      assert.deepEqual(one.err.split('\n'), [
        `ltms pin: '${log}' does not end in a new line: line ${n} is cut short; the next pin closes it with a recovered line.`,
        closing,
        `ltms pin: 1 file in ${shQuoted(to)} is named by no line in PINS.log (on stdout, "k":"unlogged"); the next pin records each with a recovered line.`,
        `ltms pin: 1 temp file in ${shQuoted(to)} was left by a pin that stopped; the next pin removes it if a copy or its source holds what it holds, and otherwise keeps it as a kept copy.`,
        `ltms pin: ${shQuoted(lock)} names pid ${holder.pid} on ${hostname()}, since ${holder.started}: a pin is running, or one stopped without removing it (the next pin takes over a lock whose pid is no longer running on this host).`,
        '',
      ], name);
    } finally { t.clean(); }
  }
});

test('check, a PINS.log with another name and a lock that is not a regular file: the lock\'s notice says what it is, not that a pin fails at it, since every pin is refused before it reaches the lock; its ls -l command, like the find command, quotes the path as the CLI quotes one; with one name, the notice says that a pin fails at it (0.1.1, E3)', { skip: (NO_LINKS || process.platform === 'win32') && 'needs symbolic links and /bin/sh' }, async () => {
  const t = tree();
  try {
    const to = join(t.tmp, "it's pins"), log = join(to, 'PINS.log'), lock = join(to, '.ltms-pin.lock'), other = join(t.tmp, 'other-name.log');
    await pinPaths([t.root], { ...t.opts(), to });
    symlinkSync(join(t.tmp, 'nowhere'), lock);
    linkSync(log, other);
    let k = await checkPin(to);
    checkClean(k);
    assert.deepEqual([k.logNames, k.notices], [2, [
      `'${log}' has 2 names (hard links to one file): a pin refuses a log that has another name, so every pin into '${to}' is refused until only one name is left. Find its other names: find / -samefile ${shQuoted(log)} 2>/dev/null`,
      `'${lock}' is a symbolic link, so it is not read as a pin's lock. See what it is: ls -l ${shQuoted(lock)}`,
    ]]);
    assert.deepEqual(wordsRun('ls', k.notices[1].slice(k.notices[1].indexOf('ls -l '))), ['-l', lock]);
    rmSync(other);
    k = await checkPin(to);
    assert.deepEqual([k.logNames, k.notices], [1, [`'${lock}' is a symbolic link, so it is not read as a pin's lock; a pin fails at it (not-a-regular-file) until it is gone. See what it is: ls -l ${shQuoted(lock)}`]]);
  } finally { t.clean(); }
});

test('pin --rehash, a .jsonl copy holding its version followed by bytes with no new line, which no pin wrote (a pin copies a .jsonl up to a new line): recovery records nothing, and the run pins the source against that version, keeping none of those bytes: unchanged, the copy is written again with a recovered line; grown, a grown line; rewritten, the copy is first cut back to that version, which the rewrite keeps; with no whole line left in the source, the copy is cut back and nothing is copied; each checks clean (0.1.1, E4; the closure check\'s appended-junk-source-unchanged)', async () => {
  const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel], keptGood = `${Q}/${SB}.superseded-${sha12(good)}.jsonl`;
  const repaired = (to) => `1 copy in '${to}' held other bytes than its last line in PINS.log records, and was written again from its source, which still holds that version (--rehash), with a recovered line each.`;
  // the last column: the copy cut back to the version, which then has the mtime the version's source had (its line's)
  for (const [name, change, lines, copy, kept, files, notices, cutBack] of [
    ['source unchanged', () => {}, [['recovered', len(good), sha(good), versionOf(good), undefined]], good, [], counts({ seen: 1, unchanged: 1 }), (to) => [repaired(to)], null],
    ['source grown', (p) => appendFileSync(p, L4), [['grown', len(good + L4), sha(good + L4), versionOf(good), undefined]], good + L4, [], counts({ seen: 1, grown: 1 }), () => [], null],
    ['source rewritten', (p) => writeFileSync(p, L5), [['rewritten', len(L5), sha(L5), versionOf(good), keptGood]], L5, [keptGood], counts({ seen: 1, rewritten: 1 }), () => [], keptGood],
    ['source left with no whole line', (p) => writeFileSync(p, 'an invented line still being written'), [], good, [], counts({ seen: 1, notCopied: 1 }), () => [], rel],
  ]) {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      const pinnedNs = statSync(t.src(rel), { bigint: true }).mtimeNs;   // the source's mtime when that version was pinned
      appendFileSync(t.pin(rel), 'zz');
      change(t.src(rel));
      const r = await pinPaths([t.src(Q)], t.opts({ rehash: true }));
      assert.deepEqual(r.lines.map((l) => [l.how, l.bytes, l.sha256, l.prev, l.kept]), lines, name);
      assert.deepEqual([r.coverage.files, r.notices, r.failures], [files, notices(t.to), []], name);
      assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), keptIn(t.to)], [copy, kept], name);
      if (kept.length) assert.equal(readFileSync(t.pin(keptGood), 'utf8'), good, name);
      if (cutBack !== null) {
        const off = statSync(t.pin(cutBack), { bigint: true }).mtimeNs - pinnedNs;
        assert.ok(off > -1000n && off < 1000n, `${name}: the cut-back copy's mtime is ${off} ns from its source's when that version was pinned`);
        assert.equal(modeOf(t.pin(cutBack)), 0o600, `${name}: the cut-back copy's mode, under umask 022`);
      }
      checkClean(await checkPin(t.to));
    } finally { t.clean(); }
  }
});

test('pin --rehash, that copy (its version, then bytes with no new line) whose source was rewritten, the pin killed just after it kept the old copy: the copy was cut back to its version first, so the next pin finds it as its line says, gives the kept copy its own recovered line (as after any crash between the link and the rename), finds that version kept already, and completes the rewrite; no line records those bytes (0.1.1, E4)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel], keptGood = `${Q}/${SB}.superseded-${sha12(good)}.jsonl`;
    appendFileSync(t.pin(rel), 'zz');
    writeFileSync(t.src(rel), L5);
    assert.equal(childPin(t, [t.src(Q)], 'linked', rel, KILL, { rehash: true }).signal, 'SIGKILL');
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), readFileSync(t.pin(keptGood), 'utf8')], [good, good]);
    assert.equal(statSync(t.pin(keptGood)).ino, statSync(t.pin(rel)).ino);   // the kept copy is the cut-back copy, linked
    const r = await pinPaths([t.src(Q)], t.opts());
    assert.deepEqual(r.lines.filter((l) => l.rel !== undefined).map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [
      ['recovered', keptGood, len(good), sha(good), null, undefined],   // the kept copy's own line, as after any crash between the link and the rename
      ['rewritten', rel, len(L5), sha(L5), versionOf(good), keptGood],
    ]);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L5);
    checkClean(await checkPin(t.to));
    assert.ok(!logText(t.to).includes(sha(`${good}zz`)), 'a line records the bytes past the version');
  } finally { t.clean(); }
});

test('ltms pin --check after bytes with no new line were appended to a .jsonl copy, its source unchanged: the --rehash command it gives, run as printed, writes the copy again from its source; PINS.log gains one recovered line, for that version, and no rewritten line; nothing is kept, and the check then exits 0 with nothing to say (0.1.1, E4; the closure check\'s appended-junk-source-unchanged)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel], before = logLines(t.to).length;
    appendFileSync(t.pin(rel), 'zz');
    const command = rehashOf(ltms(t, ['pin', '--check', t.to]).err);
    assert.equal(command, `ltms pin '${t.src(Q)}' --to '${t.to}' --root '${t.root}' --rehash`);
    assert.equal(runPrinted(t, command).code, 0);
    assert.deepEqual(logLines(t.to).slice(before).map((l) => [l.how, l.rel, l.bytes, l.sha256]), [['recovered', rel, len(good), sha(good)]]);
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), keptIn(t.to)], [good, []]);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('pin --rehash, a copy holding its version followed by bytes a pin could have written (a whole line of a .jsonl, or any bytes of a file copied whole), its source holding only that version: recovery records them, and the run keeps them as the old copy of a rewrite, as 0.1.0 did, since they can be a version that only the pin holds (a pin stopped between the rename of a grown copy and its line; README Limits) (0.1.1, E4; a guard: 0.1.0 did the same)', async () => {
  // a whole line; an empty line, the new line right after the version; and bytes after a file copied whole
  for (const [rel, extra] of [[`${Q}/${SB}.jsonl`, 'an invented line appended to the copy\n'], [`${Q}/${SB}.jsonl`, '\n'], [`${P}/${SA}/tool-results/b000000001.txt`, 'zz']]) {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      const good = PINNED[rel], held = good + extra;
      appendFileSync(t.pin(rel), extra);
      const kept = rel.endsWith('.jsonl') ? `${rel.slice(0, -'.jsonl'.length)}.superseded-${sha12(held)}.jsonl` : `${rel}.superseded-${sha12(held)}`;
      const r = await pinPaths([t.src(rel.split('/')[0])], t.opts({ rehash: true }));
      assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [
        ['recovered', rel, len(held), sha(held), versionOf(good), undefined],
        ['rewritten', rel, len(good), sha(good), versionOf(held), kept],
      ], rel);
      assert.deepEqual([readFileSync(t.pin(kept), 'utf8'), readFileSync(t.pin(rel), 'utf8')], [held, good], rel);
      checkClean(await checkPin(t.to));
    } finally { t.clean(); }
  }
});

test('README, ltms pin --help and docs/library.md say what 0.1.1 changed: recovery under --rehash leaves a copy whose source cannot be read (E1) and one whose bytes after its version no pin wrote (E4); the --rehash command names a file where a pin of its project does not go by its own path (E2), with projectPinReaches; nothing is said of a next pin while PINS.log has another name (E3); and the Limits name what 0.1.1 leaves (0.1.1)', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const readme = flat(readFileSync(join(here, '..', 'README.md'), 'utf8'));
  const docs = flat(readFileSync(join(here, '..', 'docs', 'library.md'), 'utf8'));
  const help = flat(spawnSync(process.execPath, [CLI, 'pin', '--help'], { encoding: 'utf8' }).stdout);
  const says = (where, text, phrases) => { for (const p of phrases) assert.ok(text.includes(p), `${where} does not say: ${p}`); };
  says('README', readme, [
    'gets none when that source cannot be read (the run fails on the file, and the copy is left as it is until a `--rehash` can read the source);',
    'and when the copy is a `.jsonl` that holds the version at its start followed by bytes with no new line, which no pin wrote, since a pin copies a `.jsonl` up to a new line.',
    'In the last two, the run pins the source against that version:',
    'a copy holding its version and such bytes is first cut back to the version (also when its source holds no whole line, and nothing is copied), so those bytes are never recorded or kept.',
    'and for a file under `.git` or under `memory/` directly under a project directory, where a pin of its project does not go, the file itself (a file of the cleanup\'s shape given by its own path is pinned whatever directories it is under)',
    'no pin command is given, and nothing is said of what a next pin would do.',
    'and so does a pin with `--rehash` that does not pin that copy\'s source (one given other paths).',
    '- Under `--rehash` too, a copy that holds its version followed by bytes that a pin could have written (whole lines of a `.jsonl`, or any bytes of a file copied whole) is recorded as it is,',
  ]);
  says('ltms pin --help', help, [
    '(for a file under .git, or under memory/ directly under a project directory, where a pin of its project does not go, the file itself)',
    'it says so, gives no pin command, and says nothing of what a next pin would do.',
  ]);
  says('docs/library.md', docs, [
    'import { pinPaths, checkPin, claudeConfigDir, isSweepShaped, projectPinReaches } from',
    '#### `projectPinReaches(rel)`',
    'Its source cannot be read: the run fails on that file (`read`, with the error code), and the copy is left as it is',
    'It is a `.jsonl` that holds the version at its start followed by bytes with no new line, which no pin wrote',
    'then no other notice says what a next pin would do.',
  ]);
  // 0.1.0's sentences on what 0.1.1 changed are gone
  assert.ok(!readme.includes('a pin without `--rehash` also when the copy\'s size is not that version\'s'), 'README still has the Limits sentence of 0.1.0');
  assert.ok(!help.includes('it says so and gives no pin command.'), 'ltms pin --help still has the sentence of 0.1.0');
});

test('pin without --rehash, bytes with no new line appended to a .jsonl copy after recovery read it (at the copy\'s stat step): recorded and kept as the old copy of a rewrite when the source was rewritten, and left as they are when the source holds no whole line, as 0.1.0 did: only --rehash cuts such a copy back (0.1.1, E4; a guard: 0.1.0 did the same)', async () => {
  const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel], held = `${good}zz`;
  for (const [name, change, lines, copy] of [
    ['source rewritten', (p) => writeFileSync(p, L5), [['recovered', len(held), versionOf(good)], ['rewritten', len(L5), versionOf(held)]], L5],
    ['source with no whole line', (p) => writeFileSync(p, 'an invented line still being written'), [], held],
  ]) {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      change(t.src(rel));
      const r = await pinPaths([t.src(Q)], t.opts({ onStep(step, at) { if (step === 'stat' && at === rel) appendFileSync(t.pin(rel), 'zz'); } }));
      assert.deepEqual(r.lines.map((l) => [l.how, l.bytes, l.prev]), lines, name);
      assert.equal(readFileSync(t.pin(rel), 'utf8'), copy, name);
    } finally { t.clean(); }
  }
});

// ---- 0.1.1, the closure round of track P (S359): the verifier's F1 and F2 ------------------------------------------
// F1: E1 by the directory door. Under --rehash, recovery recorded a damaged copy whose source the run could not reach
// because its walk could not read a path at or above it (the copy's source is then not among the files the run pins),
// and the next --rehash kept those bytes as the old copy of a rewrite: E1's 0.1.0 end state. The F1 tests were run
// first against the track's build before this fix and seen red (recovery's line), except the guards, which say so.
// F2: a test for each mutant of the verifier's that no test killed (V14, V15, V05, V06, V07, V01, V17). Each passes on
// the track's build, which already behaves so, and was seen red on that mutant, built from the track's sources.

/** A failure line of `ltms pin`, as stdout gives it. */
const failureRow = (path, rel, op, code) => ({ k: 'failure', path, rel, op, code });
const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

test('ltms pin --check, a copy cut and changed at a byte while its source\'s directory can be searched but not listed (mode 0300): the --rehash command it gives fails on that directory (exit 1, a walk failure line naming it and EACCES) and records nothing, each time it is run; once the directory can be listed, the same command writes the copy back with a recovered line, keeps nothing, and the check then exits 0 with nothing to say (0.1.1, E1; the closure\'s F1, the verifier\'s case dir-300)', { skip: (NEEDS_PERMISSIONS || process.platform === 'win32') && 'needs file permissions and /bin/sh' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const dir = `${P}/${SA}/subagents`, rel = `${dir}/agent-a0000000000000001.jsonl`, good = PINNED[rel];
    const bad = damage(t.pin(rel), 5);
    const log = logText(t.to), before = logLines(t.to).length;
    chmodSync(t.src(dir), 0o300);
    const command = `ltms pin '${t.src(P)}' --to '${t.to}' --root '${t.root}' --rehash`;
    for (let i = 0; i < 2; i++) {
      assert.equal(rehashOf(ltms(t, ['pin', '--check', t.to]).err), command);
      const fix = runPrinted(t, command);
      assert.deepEqual([fix.code, rowsOf(fix.out).filter((o) => o.k === 'failure')], [1, [failureRow(t.src(dir), dir, 'walk', 'EACCES')]], fix.err);
      assert.deepEqual([logText(t.to), readFileSync(t.pin(rel))], [log, bad]);
    }
    chmodSync(t.src(dir), 0o700);
    assert.equal(rehashOf(ltms(t, ['pin', '--check', t.to]).err), command);
    assert.equal(runPrinted(t, command).code, 0);
    assert.deepEqual(logLines(t.to).slice(before).map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev]), [['recovered', rel, len(good), sha(good), versionOf(good)]]);
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), keptIn(t.to)], [good, []]);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('pin --rehash, a copy cut and changed at a byte whose source the run cannot reach, because its walk could not read a path at or above it (a directory it cannot list; the file given by its own path, in a directory it cannot search; a given <sid>.jsonl in a project directory it cannot search, its own copy and one under its <sid>/, which the walk then does not enter; the root, which it cannot list): recovery records nothing, the run fails on that path (walk, EACCES), and each copy is left as it is; once the path can be read, the next --rehash writes each copy again from its source with a recovered line, keeps nothing, and the pin checks clean (0.1.1, E1; the closure\'s F1)', { skip: NEEDS_PERMISSIONS }, async () => {
  const sub = `${P}/${SA}/subagents`, rel = `${sub}/agent-a0000000000000001.jsonl`, sid = `${P}/${SA}.jsonl`;
  // [case, the path closed ('' is the root), its mode then, the paths given, the rel of the walk's failure, the copies damaged]
  for (const [name, closed, mode, given, failed, damaged] of [
    ['a directory it cannot list', sub, 0o000, [P], sub, [rel]],
    ['the file given by its own path, in a directory it cannot search', sub, 0o000, [rel], rel, [rel]],
    ['a given <sid>.jsonl, in a project directory it cannot search', P, 0o600, [sid], sid, [sid, rel]],
    ['the root, which it cannot list', '', 0o300, [''], '', [rel]],
  ]) {
    const t = tree();
    try {
      const abs = (r) => (r === '' ? t.root : t.src(r));
      await pinPaths([t.root], t.opts());
      const bad = damaged.map((d) => damage(t.pin(d), 5));
      const log = logText(t.to);
      chmodSync(abs(closed), mode);
      const r = await pinPaths(given.map(abs), t.opts({ rehash: true }));
      assert.deepEqual([r.lines, r.notices, r.failures], [[], [], [{ path: abs(failed), rel: failed, op: 'walk', code: 'EACCES' }]], name);
      assert.deepEqual([logText(t.to), damaged.map((d) => readFileSync(t.pin(d)))], [log, bad], name);
      chmodSync(abs(closed), 0o700);
      const again = await pinPaths(given.map(abs), t.opts({ rehash: true }));
      assert.deepEqual(again.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), damaged.map((d) => ['recovered', d, len(PINNED[d]), sha(PINNED[d]), versionOf(PINNED[d]), undefined]), name);
      assert.deepEqual([again.failures, damaged.map((d) => readFileSync(t.pin(d), 'utf8')), keptIn(t.to)], [[], damaged.map((d) => PINNED[d]), []], name);
      checkClean(await checkPin(t.to));
    } finally { t.clean(); }
  }
});

test('pin, a damaged copy beside a path the walk could not read, recorded as 0.1.0 did: by a pin without --rehash (the door README Limits names); with --rehash, when a kept copy waits beside it, recorded with that kept copy, as after any crash; and with --rehash, a damaged copy whose source is gone and whose rel is only spelled like that path (<name>.jsonl beside an unreadable <name>/) (0.1.1, E1; the closure\'s F1; guards: 0.1.0 and the track\'s build did the same)', { skip: NEEDS_PERMISSIONS }, async () => {
  const sub = `${P}/${SA}/subagents`, rel = `${sub}/agent-a0000000000000001.jsonl`, good = PINNED[rel];
  let t = tree();
  try {   // a pin without --rehash records the damage, though the walk could not list the directory of its source
    await pinPaths([t.root], t.opts());
    const bad = damage(t.pin(rel), 5);
    chmodSync(t.src(sub), 0o000);
    const r = await pinPaths([t.src(P)], t.opts());
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [['recovered', rel, bad.length, sha(bad), versionOf(good), undefined]]);
    assert.deepEqual(r.failures, [{ path: t.src(sub), rel: sub, op: 'walk', code: 'EACCES' }]);
  } finally { t.clean(); }
  t = tree();
  try {   // a rewrite killed after its rename, before its line: the kept copy of the old version waits beside the copy
    await pinPaths([t.root], t.opts());
    writeFileSync(t.src(rel), L5);
    assert.equal(childPin(t, [t.root], 'renamed', rel, KILL).signal, 'SIGKILL');
    const kept = `${sub}/agent-a0000000000000001.superseded-${sha12(good)}.jsonl`;
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), readFileSync(t.pin(kept), 'utf8')], [L5, good]);
    chmodSync(t.src(sub), 0o000);
    const r = await pinPaths([t.src(P)], t.opts({ rehash: true }));   // its takeover line first: the killed pin left its lock
    assert.deepEqual(r.lines.filter((l) => l.rel !== undefined).map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [['recovered', rel, len(L5), sha(L5), versionOf(good), kept]]);
    assert.deepEqual(r.failures, [{ path: t.src(sub), rel: sub, op: 'walk', code: 'EACCES' }]);
    chmodSync(t.src(sub), 0o700);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
  t = tree();
  try {   // P/sess-named.jsonl, its source gone, beside P/sess-named/, which the walk cannot list
    await pinPaths([t.root], t.opts());
    const gone = `${P}/sess-named.jsonl`, bad = damage(t.pin(gone), 5);
    rmSync(t.src(gone));
    chmodSync(t.src(`${P}/sess-named`), 0o000);
    const r = await pinPaths([t.src(P)], t.opts({ rehash: true }));
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev]), [['recovered', gone, bad.length, sha(bad), versionOf(PINNED[gone])]]);
    assert.deepEqual(r.failures, [{ path: t.src(`${P}/sess-named`), rel: `${P}/sess-named`, op: 'walk', code: 'EACCES' }]);
  } finally { t.clean(); }
});

test('ltms pin --rehash on a file system that gives no entry type (here a stubbed readdirSync), a copy cut and changed at a byte whose source the walk could not lstat (its directory can be listed, not searched: mode 0600): recovery records nothing, the run fails on each file of that directory (walk, EACCES), and the copy is left as it is; once the directory can be searched, the same command writes it back (0.1.1, E1; the closure\'s F1, the walk\'s third kind of failure)', { skip: (NEEDS_PERMISSIONS || process.platform === 'win32') && 'needs file permissions' }, () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const dir = `${P}/${SA}/subagents`, rel = `${dir}/agent-a0000000000000001.jsonl`, meta = `${dir}/agent-a0000000000000001.meta.json`;
    const bad = damage(t.pin(rel), 5);
    const log = logText(t.to);
    const used = join(t.tmp, 'stub-used'), stub = join(t.tmp, 'no-entry-types.mjs');
    writeFileSync(stub, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const readdir = fs.readdirSync, none = () => false;
fs.readdirSync = function (p, o) {
  const r = readdir.apply(this, arguments);
  if (String(p) !== ${JSON.stringify(t.src(dir))} || !(o && o.withFileTypes)) return r;
  fs.writeFileSync(${JSON.stringify(used)}, '');
  return r.map((e) => ({ name: e.name, isFile: none, isDirectory: none, isSymbolicLink: none, isFIFO: none, isSocket: none, isBlockDevice: none, isCharacterDevice: none }));
};
syncBuiltinESMExports();
`);
    chmodSync(t.src(dir), 0o600);
    const args = ['pin', t.src(P), '--to', t.to, '--root', t.root, '--rehash'];
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, CLI, ...args], { encoding: 'utf8', timeout: 60000, cwd: t.tmp,
      env: { ...process.env, CLAUDE_CONFIG_DIR: t.config } });
    assert.ok(existsSync(used), `the stub gave the entries their types: ${r.stderr}`);
    assert.deepEqual([r.status, rowsOf(r.stdout).filter((o) => o.k === 'failure').sort(byRel)],
      [1, [failureRow(t.src(rel), rel, 'walk', 'EACCES'), failureRow(t.src(meta), meta, 'walk', 'EACCES')]], r.stderr);
    assert.deepEqual([logText(t.to), readFileSync(t.pin(rel))], [log, bad]);
    chmodSync(t.src(dir), 0o700);
    assert.equal(ltms(t, args).code, 0);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), PINNED[rel]);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('pin --rehash, a tool result (a file copied whole) cut and changed at a byte while its source cannot be read: recovery records nothing, the read of the source is the run\'s failure, and the copy is left as it is; once the source can be read, the next --rehash writes it again from its source with a recovered line, keeps nothing, and the pin checks clean (0.1.1, E1; the closure\'s F2, the verifier\'s V14)', { skip: NEEDS_PERMISSIONS }, async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${P}/${SA}/tool-results/b000000001.txt`, good = PINNED[rel], inP = RELS.filter((r) => r.startsWith(`${P}/`)).length;
    const bad = damage(t.pin(rel), 5);
    const log = logText(t.to);
    chmodSync(t.src(rel), 0o000);
    const r = await pinPaths([t.src(P)], t.opts({ rehash: true }));
    assert.deepEqual([r.lines, r.notices, r.failures], [[], [], [{ path: t.src(rel), rel, op: 'read', code: 'EACCES' }]]);
    assert.deepEqual(r.coverage.files, counts({ seen: inP, unchanged: inP - 1, failed: 1 }));
    assert.deepEqual([logText(t.to), readFileSync(t.pin(rel))], [log, bad]);
    chmodSync(t.src(rel), 0o600);
    const again = await pinPaths([t.src(P)], t.opts({ rehash: true }));
    assert.deepEqual(again.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [['recovered', rel, len(good), sha(good), versionOf(good), undefined]]);
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), keptIn(t.to)], [good, []]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('pin --rehash, a single byte with no new line after a .jsonl copy\'s version (the fewest bytes no pin writes), its source unchanged: recovery records nothing, and the run writes the copy again from its source with a recovered line, keeping nothing (0.1.1, E4; the closure\'s F2, the verifier\'s V15)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel];
    appendFileSync(t.pin(rel), 'z');
    const r = await pinPaths([t.src(Q)], t.opts({ rehash: true }));
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [['recovered', rel, len(good), sha(good), versionOf(good), undefined]]);
    assert.deepEqual([r.coverage.files, r.failures], [counts({ seen: 1, unchanged: 1 }), []]);
    assert.deepEqual([readFileSync(t.pin(rel), 'utf8'), keptIn(t.to)], [good, []]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('pin --rehash, the copy of a source of mode 0400 (a copy has its source\'s mode when that is stricter than 0600), holding its version followed by bytes with no new line: the copy cut back to its version keeps the copy\'s mode, 0400, as the old copy of a rewrite, and as the current copy when the source holds no whole line (0.1.1, E4; the closure\'s F2, the verifier\'s V05)', async () => {
  const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel], keptGood = `${Q}/${SB}.superseded-${sha12(good)}.jsonl`;
  for (const [name, content, cutBack] of [['source rewritten', L5, keptGood], ['source left with no whole line', 'an invented line still being written', rel]]) {
    const t = tree();
    try {
      chmodSync(t.src(rel), 0o400);
      await pinPaths([t.root], t.opts());
      assert.equal(modeOf(t.pin(rel)), 0o400, name);
      chmodSync(t.pin(rel), 0o600); appendFileSync(t.pin(rel), 'zz'); chmodSync(t.pin(rel), 0o400);
      chmodSync(t.src(rel), 0o600); writeFileSync(t.src(rel), content); chmodSync(t.src(rel), 0o400);
      const r = await pinPaths([t.src(Q)], t.opts({ rehash: true }));
      assert.deepEqual(r.failures, [], name);
      assert.deepEqual([readFileSync(t.pin(cutBack), 'utf8'), modeOf(t.pin(cutBack))], [good, 0o400], name);
      checkClean(await checkPin(t.to));
    } finally { t.clean(); }
  }
});

test('pin --rehash, a copy holding its version followed by bytes with no new line, whose cut-back cannot be written (its directory in the pin is mode 0500): a failure of the run, write and EACCES, naming the copy, and no line, whether its source was rewritten or holds no whole line; the copy is left as it is, with no temp file, and once the directory can be written the next --rehash completes (0.1.1, E4; the closure\'s F2, the verifier\'s V06 and V07)', { skip: NEEDS_PERMISSIONS }, async () => {
  const rel = `${Q}/${SB}.jsonl`, good = PINNED[rel];
  for (const [name, content, how] of [['source rewritten', L5, 'rewritten'], ['source left with no whole line', 'an invented line still being written', 'notCopied']]) {
    const t = tree();
    try {
      await pinPaths([t.root], t.opts());
      appendFileSync(t.pin(rel), 'zz');
      writeFileSync(t.src(rel), content);
      const log = logText(t.to);
      chmodSync(t.pin(Q), 0o500);
      const r = await pinPaths([t.src(Q)], t.opts({ rehash: true }));
      assert.deepEqual([r.lines, r.failures, r.coverage.files], [[], [{ path: t.pin(rel), rel, op: 'write', code: 'EACCES' }], counts({ seen: 1, failed: 1 })], name);
      assert.deepEqual([logText(t.to), readFileSync(t.pin(rel), 'utf8'), readdirSync(t.pin(Q))], [log, `${good}zz`, [`${SB}.jsonl`]], name);
      chmodSync(t.pin(Q), 0o700);
      const again = await pinPaths([t.src(Q)], t.opts({ rehash: true }));
      assert.deepEqual([again.failures, again.coverage.files], [[], counts({ seen: 1, [how]: 1 })], name);
      checkClean(await checkPin(t.to));
    } finally { t.clean(); }
  }
});

test('pin --rehash, Claude Code\'s own set-aside copy (<name>.jsonl.superseded-<n>: a file copied whole, though its name holds .jsonl) holding its version followed by bytes with no new line: recorded as they are, and kept as the old copy of a rewrite, as for any file copied whole, since a pin could have written them (README Limits) (0.1.1, E4; the closure\'s F2, the verifier\'s V01; a guard: 0.1.0 did the same)', async () => {
  const t = tree();
  try {
    await pinPaths([t.root], t.opts());
    const rel = `${P}/22222222-2222-4222-8222-222222222222.jsonl.superseded-1731067200000`, good = PINNED[rel], held = `${good}zz`, kept = `${rel}.superseded-${sha12(held)}`;
    appendFileSync(t.pin(rel), 'zz');
    const r = await pinPaths([t.src(P)], t.opts({ rehash: true }));
    assert.deepEqual(r.lines.map((l) => [l.how, l.rel, l.bytes, l.sha256, l.prev, l.kept]), [
      ['recovered', rel, len(held), sha(held), versionOf(good), undefined],
      ['rewritten', rel, len(good), sha(good), versionOf(held), kept],
    ]);
    assert.deepEqual([readFileSync(t.pin(kept), 'utf8'), readFileSync(t.pin(rel), 'utf8')], [held, good]);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('ltms pin --check, a changed copy of a file pinned by its own path directly in a project directory named .git, which no walk enters (of the root, or of that directory): the --rehash command names the file itself, not its project directory; run as printed, it writes the copy back, and the check then exits 0 (0.1.1, E2; the closure\'s F2, the verifier\'s V17)', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  const t = tree();
  try {
    const rel = `.git/${SA}.jsonl`;
    t.put(rel, L1);
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    assert.equal(ltms(t, ['pin', t.src(rel), '--to', t.to]).code, 0);
    const b = readFileSync(t.pin(rel)); b[0] ^= 1; writeFileSync(t.pin(rel), b);
    const k = ltms(t, ['pin', '--check', t.to]);
    const command = rehashOf(k.err);
    assert.equal(command, `ltms pin ${shQuoted(t.src(rel))} --to '${t.to}' --root '${t.root}' --rehash`, k.err);
    assert.equal(runPrinted(t, command).code, 0);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L1);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('README and docs/library.md say what the closure round of 0.1.1 changed: under --rehash, recovery also leaves a damaged copy whose source the run cannot reach, because its walk could not read a path on the way (F1); and the README says that a pin without --rehash records such a copy meanwhile (the verifier\'s F4), and that bytes after a .jsonl copy\'s version that hold a new line but do not end in one are recorded too (F3) (0.1.1, the closure)', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const readme = flat(readFileSync(join(here, '..', 'README.md'), 'utf8'));
  const docs = flat(readFileSync(join(here, '..', 'docs', 'library.md'), 'utf8'));
  const says = (where, text, phrases) => { for (const p of phrases) assert.ok(text.includes(p), `${where} does not say: ${p}`); };
  says('README', readme, [
    'Under `--rehash`, a copy with no kept copy beside it also gets none when the run cannot read the way to its source: a directory on that way that it cannot list, or a path on it that it cannot look at (each a `walk` failure of the run).',
    'It is left as it is until a `--rehash` can read the source, as one whose source cannot be read is.',
    'A pin without `--rehash` records either one\'s bytes meanwhile, and a `--rehash` that can read the source then keeps them as the old copy of a rewrite (see Limits).',
    'Of a `.jsonl` copy, bytes after the version that hold a new line but do not end in one are recorded too, since what they hold up to their last new line can be such a version.',
  ]);
  says('docs/library.md', docs, [
    'gets no `recovered` line either when its rel is at or under a path the walk could not read: a directory it could not list, or a path it could not `lstat` (a given path, with the `<sid>/` of a given `<sid>.jsonl`, which the walk then does not enter; or an entry, on a file system that gives no entry types).',
  ]);
});

// 0.1.2: the line on the files behind the pin (no plain pin beside the --rehash; --root named), and the paths in the
// commands pin prints (one quoting rule). Each test but the GUARD was run red on 0.1.1's build first.

/** The command after "To pin them: " on --check's line on the files behind the pin, or null when it gives none. */
const pinCommandOf = (err) => err.split('\n').find((l) => l.includes('To pin them: '))?.split('To pin them: ')[1] ?? null;

test('ltms pin --check, a current copy cut and changed at a byte, its source unchanged: the line on the files behind the pin gives no pin command beside the --rehash and says to run that first; the --rehash, run as printed, writes the copy back, nothing is kept as an old copy, and a check run again is clean (0.1.2: 0.1.1 gave the plain pin there)', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`;
    damage(t.pin(rel), 5);
    const k = ltms(t, ['pin', '--check', t.to]);
    assert.equal(k.code, 1, k.err);
    const behind = k.err.split('\n').find((l) => l.includes(' is longer than its copy'));
    assert.ok(behind, k.err);
    assert.ok(behind.endsWith(`. ${REHASH_FIRST}`), behind);
    assert.equal(pinCommandOf(k.err), null, k.err);
    const fix = runPrinted(t, rehashOf(k.err));
    assert.equal(fix.code, 0, fix.err);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), PINNED[rel]);
    assert.deepEqual(keptIn(t.to), []);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('GUARD (green on 0.1.1 too): the plain pin, run before the --rehash after a copy was cut and changed at a byte, keeps the damaged copy as an old copy, and --check then stays at exit 1 with no command (README, Limits): the reason --check gives no pin command beside the --rehash (0.1.2). If this ever fails, the withholding can be narrowed.', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    damage(t.pin(`${Q}/${SB}.jsonl`), 5);
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    assert.equal(keptIn(t.to).length, 1, filesUnder(t.to).join('\n'));
    for (let i = 0; i < 2; i++) {
      const k = ltms(t, ['pin', '--check', t.to]);
      assert.equal(k.code, 1, k.err);
      assert.equal(rehashOf(k.err), null, k.err);
    }
  } finally { t.clean(); }
});

test('ltms pin --check, a pin made under a root other than the default: the pin command on the files behind the pin names that root with --root, and runs as printed (0.1.2: 0.1.1 left --root out, and its command was refused, exit 2)', () => {
  const t = tree();
  try {
    const other = join(t.tmp, 'other root');
    const src = join(other, '-home-u-gamma', `${SB}.jsonl`);
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, L1);
    assert.equal(ltms(t, ['pin', other, '--to', t.to, '--root', other]).code, 0);
    appendFileSync(src, '{"type":"user","text":"an invented second prompt"}\n');
    const k = ltms(t, ['pin', '--check', t.to]);
    assert.equal(k.code, 0, k.err);
    const command = pinCommandOf(k.err);
    assert.equal(command, `ltms pin ${shQuoted(other)} --to ${shQuoted(t.to)} --root ${shQuoted(other)}`);
    const fix = runPrinted(t, command);
    assert.equal(fix.code, 0, fix.err);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('ltms pin --check --root <a root PINS.log does not record>: the files behind the pin are counted from that root, and no pin command is given, since a pin into the directory from that root is refused (0.1.2: 0.1.1 gave one)', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const other = join(t.tmp, 'other');
    const src = join(other, '-home-u-gamma', `${SB}.jsonl`);
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, L1);
    const k = ltms(t, ['pin', '--check', t.to, '--root', other]);
    const behind = k.err.split('\n').find((l) => l.includes(' missing from the pin'));
    assert.ok(behind, k.err);
    assert.match(behind, /\)\.$/);
    assert.equal(pinCommandOf(k.err), null, k.err);
    const refused = ltms(t, ['pin', other, '--to', t.to, '--root', other]);
    assert.equal(refused.code, 2, refused.err);
  } finally { t.clean(); }
});

test("pin into a directory whose name holds a single quote, open to other users: the notice's chmod command runs as printed and closes it (0.1.2: 0.1.1 put the path between bare quotes, which /bin/sh cannot read)", { skip: process.platform === 'win32' && 'modes do not apply on win32' }, async () => {
  const t = tree();
  try {
    const to = join(t.tmp, "it's pins");
    mkdirSync(to);
    chmodSync(to, 0o755);
    const r = await pinPaths([t.root], t.opts({ to }));
    const notice = r.notices.find((n) => n.includes('To close it: '));
    assert.ok(notice, JSON.stringify(r.notices));
    const command = notice.split('To close it: ')[1];
    assert.equal(command, `chmod 700 ${shQuoted(to)}`);
    const run = runPrinted(t, command);
    assert.equal(run.code, 0, run.err);
    assert.equal(statSync(to).mode & 0o777, 0o700);
  } finally { t.clean(); }
});

test("checkPin while a pin holds the lock, in a directory whose name holds a single quote: the rm command in its message gives /bin/sh the lock's path as one word (0.1.2: 0.1.1 put it between bare quotes)", async () => {
  const t = tree();
  try {
    const to = join(t.tmp, "it's pins"), t2 = { ...t, to };
    assert.equal((await pinPaths([t.root], t.opts({ to }))).k, 'pinned');
    plantLock(t2, { pid: process.ppid, host: hostname(), started: '2026-11-08T10:00:00.000Z' });
    const b = await checkPin(to, { lockWaitMs: 200 });
    assert.equal(b.k, 'busy');
    const line = b.message.split('remove the lock: ')[1];
    assert.ok(line, b.message);
    assert.deepEqual(wordsRun('rm', line), [lockOf(t2)]);
  } finally { t.clean(); }
});

test("ltms pin --from-hook with nothing on standard input, its root holding a single quote, a double quote and a backslash: the usage message's command prints JSON whose transcript_path is under that root, in /bin/sh and in dash where there is one (0.1.2: 0.1.1 put the root unescaped between bare quotes, and gave echo, which dash reads backslashes in)", () => {
  const t = tree();
  try {
    const weird = join(t.tmp, `a'b"c\\d`);
    mkdirSync(weird);
    const r = ltms(t, ['pin', '--from-hook', '--to', t.to, '--root', weird], { input: '' });
    assert.equal(r.code, 2, r.err);
    const m = /to try it by hand: (.*) \| ltms pin --from-hook --to /.exec(r.err);
    assert.ok(m, r.err);
    const shells = ['/bin/sh', ...['/usr/bin/dash', '/bin/dash'].filter((p) => existsSync(p)).slice(0, 1)];
    for (const shell of shells) {
      const sh = spawnSync(shell, ['-c', m[1]], { encoding: 'utf8' });
      assert.equal(sh.status, 0, `${shell}: ${sh.stderr}`);
      assert.equal(JSON.parse(sh.stdout).transcript_path, `${weird}/<project>/<session>.jsonl`, shell);
    }
  } finally { t.clean(); }
});

test('ltms pin --check, a mismatch only in a kept copy (which no --rehash writes) and a source missing from the pin: the closing line gives no --rehash, so the line on the files behind the pin gives the pin command, with --root, and it runs as printed (0.1.2: the pin command is withheld only beside a --rehash, not beside any damage)', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`;
    writeFileSync(t.src(rel), '{"type":"user","text":"an invented rewrite"}\n');
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const [kept] = keptIn(t.to);
    assert.ok(kept, filesUnder(t.to).join('\n'));
    const b = readFileSync(join(t.to, kept)); b[3] ^= 1; writeFileSync(join(t.to, kept), b);
    t.put(`${Q}/77777777-7777-4777-8777-777777777777.jsonl`, L1);
    const k = ltms(t, ['pin', '--check', t.to]);
    assert.equal(k.code, 1, k.err);
    assert.equal(rehashOf(k.err), null, k.err);
    const command = pinCommandOf(k.err);
    assert.equal(command, `ltms pin ${shQuoted(t.root)} --to ${shQuoted(t.to)} --root ${shQuoted(t.root)}`);
    const fix = runPrinted(t, command);
    assert.equal(fix.code, 0, fix.err);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.equal(again.code, 1, again.err);
    assert.equal(pinCommandOf(again.err), null, again.err);
    assert.doesNotMatch(again.err, / missing from the pin/);
  } finally { t.clean(); }
});

test('ltms pin --check, a current copy deleted while its source is moved out of the root: a missing copy holds no bytes a pin could record, so the pin command is still given, and run as printed it pins the other files and keeps nothing; with the source back, the --rehash restores the copy and the check is clean (0.1.2; S360: the mutant that withholds here too survived every other test)', () => {
  const t = tree();
  try {
    assert.equal(ltms(t, ['pin', t.root, '--to', t.to]).code, 0);
    const rel = `${Q}/${SB}.jsonl`, away = join(t.tmp, 'moved-away.jsonl');
    unlinkSync(t.pin(rel));
    renameSync(t.src(rel), away);
    t.put(`${P}/77777777-7777-4777-8777-777777777777.jsonl`, L1);
    const k = ltms(t, ['pin', '--check', t.to]);
    assert.equal(k.code, 1, k.err);
    assert.equal(rehashOf(k.err), null, k.err);
    const command = pinCommandOf(k.err);
    assert.equal(command, `ltms pin ${shQuoted(t.root)} --to ${shQuoted(t.to)} --root ${shQuoted(t.root)}`, k.err);
    const run = runPrinted(t, command);
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(keptIn(t.to), []);
    assert.ok(existsSync(t.pin(`${P}/77777777-7777-4777-8777-777777777777.jsonl`)));
    renameSync(away, t.src(rel));
    const k2 = ltms(t, ['pin', '--check', t.to]);
    const fix = runPrinted(t, rehashOf(k2.err));
    assert.equal(fix.code, 0, fix.err);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), PINNED[rel]);
    const again = ltms(t, ['pin', '--check', t.to]);
    assert.deepEqual([again.code, again.err], [0, '']);
  } finally { t.clean(); }
});

test('README and ltms pin --help say when --check gives the pin command and when it withholds it, and what to do then (0.1.2; S360 V-A: its mutants M27 and M28, the help lines removed or "gives none" turned, survived every test)', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const readme = flat(readFileSync(join(here, '..', 'README.md'), 'utf8'));
  const help = flat(spawnSync(process.execPath, [CLI, 'pin', '--help'], { encoding: 'utf8' }).stdout);
  for (const p of ['get the command that pins them, `ltms pin <root> --to <dir> --root <root>` from the root `PINS.log` records, when that is the root the check walked.',
    'Beside the `--rehash` command it gives none, and says to run the `--rehash` first, since a pin run before it may record a damaged copy as a version']) {
    assert.ok(readme.includes(p), `README does not say: ${p}`);
  }
  for (const p of ['get the command that pins them, from the root PINS.log records (with --root), when that is the root walked.',
    'Beside the --rehash command it gives none, and says to run the --rehash first: a pin run before it may record a damaged copy.']) {
    assert.ok(help.includes(p), `ltms pin --help does not say: ${p}`);
  }
});

// ---- S367: what the temp sweep may remove (the adversarial reading of "nothing ltms does destroys a record") -----------
// The next pin removed every file named like its temp files (/^\..+\.ltms-tmp-\d+$/) anywhere in the pin, unread and
// before reading PINS.log: a copy of a source so named, and a temp holding the only copy of a version (seats A, B, C).

test('S367 temps: a source of the sweep\'s shape named like a temp file is pinned, and no later pin removes its copy, also after its source is gone', async () => {
  const t = tree();
  try {
    const rel = `${P}/${SA}/tool-results/.out.ltms-tmp-42`, body = 'invented output named like a temp file\n';
    t.put(rel, body);
    const r1 = await pinPaths([t.root], t.opts());
    assert.ok(r1.lines.some((l) => l.how === 'new' && l.rel === rel), 'logged new');
    unlinkSync(t.src(rel));                                      // the cleanup deletes it by its own age
    const r2 = await pinPaths([t.root], t.opts());
    assert.equal(r2.removedTemps, 0, 'not a temp: PINS.log names it');
    assert.equal(readFileSync(t.pin(rel), 'utf8'), body, 'the only copy is still there');
    const k = await checkPin(t.to);
    checkClean(k);
    assert.equal(k.temps, 0, 'a check does not count it as a temp file either');
  } finally { t.clean(); }
});

test('S367 temps: a temp a killed pin left, holding a version that neither the source nor any copy holds any more, is kept, not removed', async () => {
  const t = tree();
  try {
    const rel = `${P}/${SA}.jsonl`, only = '{"type":"user","text":"an invented line that only the temp file will hold"}\n';
    await pinPaths([t.root], t.opts());
    appendFileSync(t.src(rel), only);                            // the session grows
    const c = childPin(t, [t.root], 'temp-written', rel, KILL);  // a pin dies with the grown version in its temp
    assert.equal(c.signal, 'SIGKILL', c.stderr);
    assert.equal(readFileSync(join(t.to, P, `.${SA}.jsonl.ltms-tmp-${c.pid}`), 'utf8'), L1 + L2 + only);
    writeFileSync(t.src(rel), L4);                               // Claude Code rewrites the transcript before the next pin
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.failures, []);
    const held = filesUnder(t.to).filter((f) => f !== 'PINS.log').map((f) => readFileSync(join(t.to, f), 'utf8'));
    assert.equal(held.filter((x) => x.includes(only)).length, 1, `the version only the temp held is kept (the pin holds ${held.length} files, none with that line)`);
    assert.equal(readFileSync(t.pin(rel), 'utf8'), L4, 'the source as it is now is pinned');
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('S367 temps: a temp a killed pin left, whose bytes only a kept copy of its target holds now, is removed: nothing is lost', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, v1 = L1 + L2 + L3;
    await pinPaths([t.root], t.opts());
    writeFileSync(t.src(rel), L5);                               // rewritten: the next pin keeps v1's copy under its sha12
    const r1 = await pinPaths([t.root], t.opts());
    const kept = r1.lines.find((l) => l.how === 'rewritten' && l.rel === rel)?.kept;
    assert.equal(typeof kept, 'string', 'v1 kept');
    const temp = join(t.to, Q, `.${SB}.jsonl.ltms-tmp-${deadPid()}`);
    writeFileSync(temp, v1.slice(0, 20));                        // half a write of v1, left by a pin that died
    const r2 = await pinPaths([t.root], t.opts());
    assert.deepEqual(r2.failures, []);
    assert.deepEqual([r2.removedTemps, existsSync(temp)], [1, false], 'removed: only the kept copy holds what it held');
    assert.equal(readFileSync(t.pin(kept), 'utf8'), v1);
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});

test('S367 temps: a temp a killed pin left, whose bytes only the copy holds when the next pin starts (its source rewritten since), is removed; the rewrite then keeps that copy', async () => {
  const t = tree();
  try {
    const rel = `${Q}/${SB}.jsonl`, v1 = L1 + L2 + L3;
    await pinPaths([t.root], t.opts());
    const temp = join(t.to, Q, `.${SB}.jsonl.ltms-tmp-${deadPid()}`);
    writeFileSync(temp, v1.slice(0, 20));                        // half a write of v1, left by a pin that died
    writeFileSync(t.src(rel), L5);                               // rewritten since: the source no longer holds it
    const r = await pinPaths([t.root], t.opts());
    assert.deepEqual(r.failures, []);
    assert.deepEqual([r.removedTemps, existsSync(temp)], [1, false], 'removed: the copy holds what it held');
    const kept = r.lines.find((l) => l.how === 'rewritten' && l.rel === rel)?.kept;
    assert.equal(readFileSync(t.pin(kept), 'utf8'), v1, 'and the rewrite keeps the copy');
    checkClean(await checkPin(t.to));
  } finally { t.clean(); }
});
