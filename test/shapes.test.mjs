// Tests for ltms shapes (0.3.0), run against the built dist/cli.js (build first), and its module dist/shapes.js for the
// write guard as a unit. The fixtures are synthetic (test/shapes-fixtures/, written by node test/make-shapes-fixtures.mjs
// test/shapes-fixtures): every text invented, a canary in every channel a leak could use. Two instruments stand beside
// the command and share no code with src/shapes.ts: test/shapes-validate.mjs, the receiver's check of the closed
// language, which reads every report this file makes; and test/shapes-recompute.mjs, a second implementation of the
// report from its rules, whose every field must equal the command's. Both are the S373 prototype's.
//
// The first 35 tests are the prototype's (shapes.test.mjs), ported. Its curated vocabulary was built from the owner's
// own corpus and is not in this repository: where the prototype read with it, these tests read with the vocabulary that
// ships (vocab/claude-code.docs.json) and ten --allow arguments naming the fixtures' own schema (ALLOW below), which give
// the curated vocabulary's lines on these fixtures, byte for byte after the first line (measured on the prototype).
//
// LTMS_DIST=<a dist directory> runs the same tests against another build (the mutation check of the write guard); that
// build reads its vocabulary from vocab/ beside it, as an installed package reads its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate, validateText } from './shapes-validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DIST = process.env.LTMS_DIST || join(root, 'dist');
const CLI = join(DIST, 'cli.js');
const SH = await import(pathToFileURL(join(DIST, 'shapes.js')).href);
const RECOMPUTE = join(here, 'shapes-recompute.mjs');
const FX = (n) => join(here, 'shapes-fixtures', n);
const DOCS = join(root, 'vocab', 'claude-code.docs.json');
const CODEX_V = FX('codex.sketch.json'), GEMINI_V = FX('gemini-cli.sketch.json');
const CC = ['cc-a.jsonl', 'cc-b.jsonl', 'cc-c.jsonl', 'cc-map.jsonl'].map(FX);
const CODEX = ['codex-a.jsonl', 'codex-b.jsonl', 'codex-c.jsonl'].map(FX);
const GEMINI = ['gemini-a.jsonl', 'gemini-b.jsonl', 'gemini-c.jsonl'].map(FX);
const LENS = ['len-a.jsonl', 'len-b.jsonl', 'len-c.jsonl'].map(FX);
/** The fixtures' own schema, which the prototype's curated vocabulary named and the shipped one does not. */
const ALLOW = ['.message.type', '.attachment.type=hook_success', '.attachment.hookName', '.attachment.content', '.snapshot.trackedFileBackups',
  '.snapshot.messageId', '.snapshot.timestamp', '.messageId', '.isSnapshotUpdate', '.durationMs'].flatMap((a) => ['--allow', a]);
const tmp = () => mkdtempSync(join(tmpdir(), 'ltms-shapes-'));
const rm = (d) => rmSync(d, { recursive: true, force: true });

let validated = 0;
/** ltms shapes, spawned (from the repository's root). Every report it prints is read by the independent validator, its
 *  bytes and then its lines, with the vocabulary it was made with: a report outside the language fails the test that made
 *  it. */
function shapes(args, opts = {}) {
  const r = spawnSync(process.execPath, [...(opts.node ?? []), CLI, 'shapes', ...args], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 120000, cwd: opts.cwd ?? root });
  if (r.error) throw r.error;
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (lines[0]?.k === 'shapes') {
    const i = args.indexOf('--vocabulary');
    assert.deepEqual(validateText(r.stdout, [i >= 0 ? args[i + 1] : DOCS]), [], `the independent validator, on the report of ltms shapes ${args.join(' ')}`);
    validated++;
  }
  return { code: r.status, out: r.stdout, err: r.stderr, lines };
}
/** The second implementation's report, each line's keys sorted. */
function recompute(args) {
  const r = spawnSync(process.execPath, [RECOMPUTE, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}
const canon = (o) => (Array.isArray(o) ? '[' + o.map(canon).join(',') + ']' : o && typeof o === 'object' ? '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}' : JSON.stringify(o));

/** The report `lines` with `line` put where the format puts a line of its kind and key: in place of the line with the
 *  same key, or else between its neighbours in order (versions in numeric order, then (none) and (withheld); kind and
 *  rare lines by kind; path lines by kind, then path); a first line in place of the first, an end line in place of the
 *  last, a line of no kind of the format just after the first. The end line then counts the lines (but a planted one).
 *  Returns [the lines, the planted line's number]. The order is the format's, written here from its rules, not the
 *  module's code. */
function plant(lines, line) {
  const ORDER = ['shapes', 'version', 'kind', 'path', 'rare', 'end'];
  const isV = (v) => typeof v === 'string' && /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,5})$/.test(v);
  const str = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const vord = (a, b) => (isV(a) && isV(b) ? a.split('.').map(Number).reduce((c, x, i) => c || x - Number(b.split('.')[i]), 0) || str(a, b) : isV(a) ? -1 : isV(b) ? 1 : str(a, b));
  const order = (a, b) => (a.k === 'version' ? vord(a.v, b.v) : a.k === 'path' ? str(a.kind, b.kind) || str(a.path, b.path) : str(a.kind, b.kind));
  const body = lines.slice(0, -1);
  const k = line !== null && typeof line === 'object' && !Array.isArray(line) ? line.k : undefined;
  const rank = ORDER.indexOf(k);
  if (k === 'end') return [[...body, line], body.length + 1];
  let at;
  if (k === 'shapes') { body[0] = line; at = 0; }
  else if (rank < 0) { body.splice(1, 0, line); at = 1; }
  else {
    at = body.findIndex((o, i) => i > 0 && (ORDER.indexOf(o.k) > rank || (o.k === k && order(o, line) >= 0)));
    if (at < 0) at = body.length;
    if (at < body.length && body[at].k === k && order(body[at], line) === 0) body[at] = line; else body.splice(at, 0, line);
  }
  return [[...body, { k: 'end', lines: body.length + 1 }], at + 1];
}

/** A copy of the build (DIST) in a temporary folder whose buildReport returns, in place of the lines it builds, the
 *  lines of the JSON file that LTMS_TEST_LINES names: a defect of the builder, made to order, for the write guard to meet
 *  through the command as a user runs it. Nothing of it is in src/: a wrapper module, and dist/cli.js's one import of
 *  ./shapes.js turned to it. Returns the folder (its dist/cli.js is the command); the caller removes it. */
function plantedBuild() {
  const dir = tmp();
  mkdirSync(join(dir, 'dist'));
  mkdirSync(join(dir, 'vocab'));
  for (const f of readdirSync(DIST)) if (f.endsWith('.js')) copyFileSync(join(DIST, f), join(dir, 'dist', f));
  copyFileSync(DOCS, join(dir, 'vocab', 'claude-code.docs.json'));
  copyFileSync(join(root, 'package.json'), join(dir, 'package.json'));
  const cli = readFileSync(join(dir, 'dist', 'cli.js'), 'utf8');
  assert.equal(cli.split("from './shapes.js'").length, 2, "dist/cli.js imports ./shapes.js once");
  writeFileSync(join(dir, 'dist', 'cli.js'), cli.replace("from './shapes.js'", "from './shapes-planted.js'"));
  writeFileSync(join(dir, 'dist', 'shapes-planted.js'), [
    "import { readFileSync } from 'node:fs';",
    "import { buildReport as built } from './shapes.js';",
    "export * from './shapes.js';",
    "export function buildReport(...args) { const r = built(...args); return { ...r, lines: JSON.parse(readFileSync(process.env.LTMS_TEST_LINES, 'utf8')) }; }",
  ].join('\n') + '\n');
  return dir;
}
/** The planted build run as `ltms shapes <args>`, its builder giving `lines`. */
function plantedRun(build, lines, args) {
  const f = join(build, 'lines.json');
  writeFileSync(f, JSON.stringify(lines));
  const r = spawnSync(process.execPath, [join(build, 'dist', 'cli.js'), 'shapes', ...args], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 120000, cwd: root, env: { ...process.env, LTMS_TEST_LINES: f } });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Every token planted in the fixtures. None may appear in a report, in any case. ('call_' is not one: it is a prefix of
 *  the Codex sketch's name call_id; the planted call_zq7canary is caught by 'zq'.) */
const CANARIES = ['zq', 'canary', '31337', '4242', '03:04', '/home', 'secret', 'msg_', 'req_', 'toolu_', 'mcp__', 'claude-zqmodel', '9.9.9', 'codex_cli_rs', 'shell', 'read_file', 'on-request', 'medium', 'plain', 'legacy', 'external', 'hook_success-zq'];
function assertNoCanary(text, ownWords = []) {
  const low = text.toLowerCase();
  for (const c of CANARIES) {
    if (ownWords.includes(c)) continue;
    assert.ok(!low.includes(c.toLowerCase()), `the report holds the planted token '${c}'`);
  }
}

// ---- the prototype's 35 tests ----------------------------------------------------------------------------------------
// [name, the arguments, the vocabulary (null: the one that ships), planted words the vocabulary itself holds]
const CONFIGS = [
  ["cc, the shipped vocabulary and the fixtures' schema allowed (the prototype's curated)", [...ALLOW, ...CC], null, []],
  ['cc, the shipped vocabulary', [...CC], null, []],
  ['cc, --max-line 4096', [...ALLOW, '--max-line', '4096', ...CC], null, []],
  ['cc, floor 2', [...ALLOW, '--floor', '2', ...CC], null, []],
  // 'legacy' is a value of the Codex sketch (.payload.history_mode): only a value path may print it
  ['codex', [...CODEX], CODEX_V, ['legacy']],
  ['gemini', [...GEMINI], GEMINI_V, []],
  ['codex and gemini files, the shipped vocabulary', [...ALLOW, ...CODEX, ...GEMINI], null, []],
  // (S374's closure read, S2) arrays of 0 to 200 elements in three files: every lengths label printed, 0 to 64+
  ['arrays of 0 to 200 elements in three files', [...LENS], null, []],
];
const withVocabulary = (args, vocab) => (vocab === null ? args : ['--vocabulary', vocab, ...args]);

for (const [name, args, vocab, own] of CONFIGS) {
  test(`shapes: no planted token reaches the report (${name})`, () => {
    const r = shapes(withVocabulary(args, vocab));
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /failed the report's own language/, 'no line refused at the write');
    assertNoCanary(r.out, own);
  });
  test(`shapes: every token is in the closed language, by an independent validator (${name})`, () => {
    const r = shapes(withVocabulary(args, vocab));
    assert.ok(r.lines.length > 2, `${r.lines.length} lines`);
    assert.deepEqual(validate(r.lines, [vocab ?? DOCS]), [], 'every token in the language');
  });
  test(`shapes: every field equals the independent recompute (${name})`, () => {
    assert.deepEqual(shapes(withVocabulary(args, vocab)).lines.map(canon), recompute(['--vocabulary', vocab ?? DOCS, ...args]));
  });
}

test("shapes: the floor: a path in 2 files is withheld at floor 3 (its kind's rare line counts it) and printed at floor 2", () => {
  const at3 = shapes(['--allow', '.floorProbe', ...CC]);
  assert.equal(at3.code, 0);
  assert.ok(!at3.lines.some((o) => o.path === '.floorProbe'));
  assert.ok(at3.lines.some((o) => o.k === 'rare' && o.kind === 'user'));
  const at2 = shapes(['--allow', '.floorProbe', '--floor', '2', ...CC]);
  const line = at2.lines.find((o) => o.path === '.floorProbe');
  assert.ok(line, 'printed at floor 2');
  assert.equal(line.files, '2-3');
  assert.deepEqual(at2.lines[0].allowed, ['.floorProbe']);
});

test('shapes: a sub-count over fewer files than the floor folds into (rare)', () => {
  const r = shapes([...CC]);
  const t = r.lines.find((o) => o.k === 'path' && o.kind === 'user' && o.path === '.message.content[].type');
  assert.deepEqual(Object.keys(t.values).sort(), ['(unlisted)', 'tool_result'].concat(t.values['(rare)'] ? ['(rare)'] : []).sort());
  // (the port's addition) the planted true of isSnapshotUpdate is in one file, cc-map: at floor 3 it is (rare), and the
  // recompute at floor 1 names it
  const snap = r.lines.find((o) => o.k === 'path' && o.kind === 'file-history-snapshot' && o.path === '.*');
  assert.deepEqual(snap.booleans, { false: '2-3', '(rare)': '1' });
  const at1 = recompute(['--vocabulary', DOCS, '--floor', '1', ...CC]).map((l) => JSON.parse(l)).find((o) => o.k === 'path' && o.kind === 'file-history-snapshot' && o.path === '.*');
  assert.deepEqual(at1.booleans, { false: '2-3', true: '1' });
});

test('shapes: deterministic: the same bytes whatever the order of the paths and of the keys in each record', () => {
  const a = shapes([...ALLOW, ...CC]).out;
  assert.equal(shapes([...ALLOW, ...[...CC].reverse()]).out, a);
  const dir = tmp();
  try {
    const rv = (x) => (Array.isArray(x) ? x.map(rv) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).reverse().map((k) => [k, rv(x[k])])) : x);
    writeFileSync(join(dir, 'b.jsonl'), readFileSync(FX('cc-b.jsonl'), 'utf8').split('\n').map((l) => (l ? JSON.stringify(rv(JSON.parse(l))) : l)).join('\n'));
    assert.equal(shapes([...ALLOW, FX('cc-a.jsonl'), join(dir, 'b.jsonl'), FX('cc-c.jsonl'), FX('cc-map.jsonl')]).out, a);
  } finally { rm(dir); }
});

test('shapes: a line longer than --max-line is counted, not read', () => {
  const r = shapes([...ALLOW, '--max-line', '4096', ...CC]);
  assert.equal(r.code, 0);
  assert.equal(r.lines[0].lines.tooLong, '4-7');   // the 8 KB text line, the two 100,000-deep lines, the map line
  assertNoCanary(r.out);
});

test('shapes: --max-line N: a line of exactly N bytes is read, one of N+1 is not; across the read chunk, and a last line without a new line', () => {
  const dir = tmp();
  try {
    const rec = (len) => { const base = '{"type":"user","message":{"role":"user","content":"'; const tail = '"}}'; return base + 'x'.repeat(len - base.length - tail.length) + tail; };
    const N = 1500000;   // longer than the 1 MiB read chunk, so the line spans two reads
    writeFileSync(join(dir, 'a.jsonl'), rec(N) + '\n' + rec(N + 1) + '\n' + rec(N - 1));   // the last line has no new line
    const r = shapes(['--max-line', String(N), '--floor', '2', join(dir, 'a.jsonl')]);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0].lines.records, '2-3');
    assert.equal(r.lines[0].lines.tooLong, '1');
  } finally { rm(dir); }
});

test('shapes: 100,000 levels of nesting: walked only along vocabulary paths, no crash', () => {
  const r = shapes([...CC]);
  assert.equal(r.code, 0);
  assert.equal(r.lines[0].lines.tooLong, '0', 'the deep lines were read, not skipped');
  // the 100,000-deep array under .toolUseResult is in one file: its type is counted, under the floor, as (rare)
  const t = r.lines.find((o) => o.kind === 'user' && o.path === '.toolUseResult');
  assert.ok(t.types['(rare)'], 'the deep array was walked to its first level');
  // and at floor 1 (the recompute's view of the same files) the element line exists, its own type only
  assert.ok(recompute(['--vocabulary', DOCS, '--floor', '1', ...CC]).some((l) => l.includes('"path":".toolUseResult[]"')));
});

test('shapes: an object used as a map prints as one .* line, its distinct names capped at 64+', () => {
  const m = shapes([...ALLOW, ...CC]).lines.find((o) => o.path === '.snapshot.trackedFileBackups.*');
  assert.equal(m.names, '64+');
});

test('shapes: versions: only N.N.N at a version path; a suffix, a long part or a word is (withheld)', () => {
  assert.deepEqual(shapes([...CC]).lines.filter((o) => o.k === 'version').map((o) => o.v), ['2.1.299', '2.1.300', '2.1.301', '(none)', '(withheld)']);
});

test('shapes: --allow prints the name, lists it in the first line, and --check accepts it only from there', () => {
  const dir = tmp();
  try {
    const r = shapes(['--allow', '.message.content[].type=zq_block3', ...CC]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines[0].allowed, ['.message.content[].type=zq_block3']);
    assert.ok(r.out.includes('"zq_block3"'));
    writeFileSync(join(dir, 'r.jsonl'), r.out);
    assert.equal(shapes(['--check', join(dir, 'r.jsonl')]).code, 0);
    const lines = r.out.split('\n'); lines[0] = lines[0].replace('"allowed":[".message.content[].type=zq_block3"]', '"allowed":[]');
    writeFileSync(join(dir, 'r2.jsonl'), lines.join('\n'));
    assert.equal(shapes(['--check', join(dir, 'r2.jsonl')]).code, 1, "the same value with the first line's list emptied is refused");
  } finally { rm(dir); }
  for (const bad of ['.a b', '.x=has space', 'message', '.a..b', '.0abc']) assert.equal(shapes(['--allow', bad, ...CC]).code, 2, `--allow '${bad}' is a usage error`);
});

test('shapes: --unlisted is a local list: every line says send:false, and --check refuses it', () => {
  const dir = tmp();
  try {
    const r = shapes(['--unlisted', ...CC]);
    assert.equal(r.code, 0);
    assert.ok(r.lines.length > 1 && r.lines.every((o) => o.send === false));
    writeFileSync(join(dir, 'u.jsonl'), r.out);
    assert.equal(shapes(['--check', join(dir, 'u.jsonl')]).code, 1);
    assert.notDeepEqual(validate(r.lines, [DOCS]), [], 'the independent validator refuses it too');
  } finally { rm(dir); }
});

test('shapes: --check refuses a token outside the language, an extra field, a cut report, an exact count', () => {
  const dir = tmp();
  try {
    const good = shapes([...CC]).out;
    const f = (name, text) => { writeFileSync(join(dir, name), text); return shapes(['--check', join(dir, name)]).code; };
    assert.equal(f('good.jsonl', good), 0);
    const ls = good.split('\n').filter(Boolean);
    const i = ls.findIndex((l) => l.includes('"k":"path"'));
    const edit = (fn) => ls.map((l, j) => (j === i ? fn(l) : l)).join('\n') + '\n';
    assert.equal(f('path.jsonl', edit((l) => l.replace(/"path":"[^"]*"/, '"path":".zq7canary"'))), 1);
    assert.equal(f('field.jsonl', edit((l) => l.replace('{"k":"path"', '{"k":"path","x":"zq7canary"'))), 1);
    assert.equal(f('exact.jsonl', edit((l) => l.replace(/"n":"[^"]*"/, '"n":"5"'))), 1);
    assert.equal(f('cut.jsonl', ls.slice(0, -1).join('\n') + '\n'), 1);
    assert.equal(f('ver.jsonl', ls.map((l) => (l.includes('"k":"version"') ? l.replace(/"v":"[^"]*"/, '"v":"9.9.9-zq"') : l)).join('\n') + '\n'), 1);
  } finally { rm(dir); }
});

test('shapes: supplier-neutral: Codex- and Gemini-shaped files read with their own vocabularies', () => {
  const c = shapes(['--vocabulary', CODEX_V, ...CODEX]);
  const kinds = c.lines.filter((o) => o.k === 'kind').map((o) => o.kind);
  for (const k of ['session_meta', 'turn_context', 'response_item:message', 'response_item:(unlisted)', 'event_msg:user_message', 'compacted']) assert.ok(kinds.includes(k), k);
  assert.deepEqual(c.lines.filter((o) => o.k === 'version').map((o) => o.v), ['0.169.0']);
  const g = shapes(['--vocabulary', GEMINI_V, ...GEMINI]);
  const paths = g.lines.filter((o) => o.k === 'path').map((o) => o.path);
  for (const p of ['.$set.lastUpdated', '.$rewindTo', '.$patch.removeIds[]', '.toolCalls[].args.*']) assert.ok(paths.includes(p), p);
});

test('shapes: exit status: a missing file gives 1 and the report of the others; usage errors give 2', () => {
  const r = shapes([FX('cc-a.jsonl'), FX('no-such-file.jsonl')]);
  assert.equal(r.code, 1);
  assert.ok(r.lines.length > 2);
  assert.equal(r.lines[0].files.failed, '1');
  assert.equal(shapes([]).code, 2, 'no paths');
  assert.equal(shapes(['--nope', ...CC]).code, 2);
  assert.equal(shapes(['--floor', '1', ...CC]).code, 2);
  // the prototype's 'no vocabulary' (exit 2): here one ships, so a vocabulary that cannot be read, and a supplier with none
  assert.equal(shapes(['--vocabulary', FX('no-such-vocabulary.json'), ...CC]).code, 2);
  assert.equal(shapes(['--supplier', 'zqnone', ...CC]).code, 2);
});

test('shapes: the vocabulary files: every path a path of field names, every value a label, none data-shaped', () => {
  for (const f of [DOCS, CODEX_V, GEMINI_V]) {
    const v = JSON.parse(readFileSync(f, 'utf8'));
    for (const p of v.paths) {
      assert.match(p, /^(?:\.[$@]?[A-Za-z_][A-Za-z0-9_:+-]{0,63}|\[\])+$/);
      for (const seg of p.split(/\.|\[\]/).filter(Boolean)) assert.ok(!/^[0-9a-f]{8}-|^\d+$|^[0-9a-f]{12,}$|^(toolu_|srvtoolu_|call_)[A-Za-z0-9]{8,}$/i.test(seg.replace(/^[$@]/, '')), `${f}: a data-shaped name`);
    }
    for (const vs of Object.values(v.values)) for (const x of vs) assert.match(x, /^[\w.:+-]{1,64}$/);
  }
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ format: 'ltms-shapes-vocabulary/0', name: 'bad', paths: ['./home/zq'], values: {} }));
    assert.equal(shapes(['--vocabulary', join(dir, 'bad.json'), ...CC]).code, 2);
  } finally { rm(dir); }
});

// ---- the port's own: what the core needs beyond the prototype's tests ------------------------------------------------

// S2 (S374's closure read): the planted list held 26 lines, and 16 of checkLine's rules (more, by its refuter's count)
// could be lost with the suite green, since none of these lines needed them. It now holds one line per rule at each line
// kind: seat R's list (guard-unit2.mjs), and its refuter's lines, each a line the builder made with one token changed;
// each with the word the guard must give. Each is refused at the write, alone in a report the builder made: by the module
// (nothing written, that word at that line), and through the command (exit 1, nothing on stdout, and stderr naming that
// line and that word, and nothing else).
test('shapes: the write guard refuses each line that holds a token outside the language, whatever built it, and writes nothing of the report: one planted line per rule of the language at each line kind, refused by the module and by the command, which names the line and the field; the command prints what writeReport writes', () => {
  const V = SH.loadVocabulary(DOCS), allowed = SH.applyAllow(V, []);
  const R = SH.buildReport(V, SH.readShapes(V, [...CC].sort(), { maxLine: SH.SHAPES_MAX_LINE, unlisted: false }), 3, allowed);
  const Lg = SH.shapesLanguage(V, allowed, { floor: 3, lines: R.lines.length });
  let text = '';
  const all = SH.writeReport(R.lines, Lg, (s) => { text += s; });
  assert.deepEqual([all.refused, all.written], [0, R.lines.length]);
  assert.equal(text, shapes([...CC]).out, 'the command prints what writeReport writes');
  const L = R.lines, head = L[0];
  const real = (pred) => { const o = L.find(pred); assert.ok(o, `the report has a line ${pred}`); return o; };
  const vl = real((o) => o.k === 'version' && /^\d/.test(o.v)), kl = real((o) => o.k === 'kind' && Object.keys(o.versions).length);
  const pl = real((o) => o.k === 'path' && o.types && o.strings && o.first), sl = real((o) => o.k === 'path' && o.path.endsWith('.*') && o.names);
  const vp = real((o) => o.k === 'path' && o.values), plain = real((o) => o.k === 'path' && !o.values && !o.names && !o.path.endsWith('[]'));
  const rl = real((o) => o.k === 'rare'), ver = Object.keys(kl.versions)[0];
  const P = (extra) => ({ k: 'path', kind: 'user', path: '.type', n: '1', files: '4-7', ...extra });
  const withProto = (proto, own) => Object.assign(Object.create(proto), own);
  const T = new Date(0x7fffffffff);   // a time
  // [what, the line, the word the guard gives]
  const planted = [
    // the first line
    ['header: an extra field', { ...head, x: 'zq7canary' }, 'fields'],
    ['header: a field missing', (() => { const h = { ...head }; delete h.lines; return h; })(), 'fields'],
    ['header: format', { ...head, format: 'zq7canary' }, 'format'],
    ['header: another vocabulary', { ...head, vocabulary: [{ ...head.vocabulary[0], name: 'zq7canary' }] }, 'vocabulary'],
    ['header: another floor', { ...head, floor: 31337 }, 'floor'],
    ['header: floor 0', { ...head, floor: 0 }, 'floor'],
    ['header: an allowed entry it was not given', { ...head, allowed: ['.zq7canary'] }, 'allowed'],
    ['header: files, an exact count', { ...head, files: { ...head.files, read: '5' } }, 'files'],
    ['header: files, an extra key', { ...head, files: { ...head.files, zq7canary: '1' } }, 'files'],
    ['header: files, a key missing', { ...head, files: { read: head.files.read } }, 'files'],
    ['header: lines, a count not a bucket', { ...head, lines: { ...head.lines, records: '9753102' } }, 'lines'],
    ['header: lines, an extra key', { ...head, lines: { ...head.lines, zq7canary: '1' } }, 'lines'],
    ['header: lines, a key missing', { ...head, lines: { records: head.lines.records } }, 'lines'],
    // version lines
    ['version: an extra field', { ...vl, x: 'zq7canary' }, 'fields'],
    ['version: v a word', { k: 'version', v: 'zq7canary', records: '1', files: '1' }, 'v'],
    ['version: v suffixed', { k: 'version', v: '9.9.9-zqcanary', records: '1', files: '1' }, 'v'],
    ['version: v four parts', { k: 'version', v: '1.2.3.4', records: '1', files: '1' }, 'v'],
    ['version: v a five-digit part', { k: 'version', v: '31337.1.1', records: '1', files: '1' }, 'v'],
    ['version: v an array', { ...vl, v: [vl.v] }, 'v'],
    ['version: records exact', { ...vl, records: '5' }, 'records'],
    ['version: files exact', { ...vl, files: '5' }, 'files'],
    // kind lines
    ['kind: an extra field', { ...kl, x: 'zq7canary' }, 'fields'],
    ['kind: a raw kind', { k: 'kind', kind: 'zqcanarytype3', records: '1', files: '1', versions: {} }, 'kind'],
    ['kind: a raw sub-kind', { k: 'kind', kind: 'system:zq_sub3', records: '1', files: '1', versions: {} }, 'kind'],
    ['kind: a sub-kind on a kind with no sub-kind path', { k: 'kind', kind: 'user:text', records: '1', files: '1', versions: {} }, 'kind'],
    ['kind: records exact', { ...kl, records: '5' }, 'records'],
    ['kind: records a range at any start', { ...kl, records: '37-73' }, 'records'],
    ['kind: files exact', { ...kl, files: '5' }, 'files'],
    ['kind: versions, a raw key', { ...kl, versions: { 'zq-not-a-version': '1' } }, 'versions'],
    ['kind: versions, a count exact', { ...kl, versions: { ...kl.versions, [ver]: '5' } }, 'versions'],
    ['kind: versions, (none) with an exact count', { ...kl, versions: { ...kl.versions, '(none)': '5' } }, 'versions'],
    ['kind: versions an array', { ...kl, versions: [ver] }, 'versions'],
    ['kind: versions a number', { ...kl, versions: 31337 }, 'versions'],
    ['kind: versions a time (a Date)', { ...kl, versions: T }, 'versions'],
    // path lines
    ['path: an extra field', P({ x: 'zq7canary' }), 'fields'],
    ['path: a timing field', { ...pl, ms: 4242 }, 'fields'],
    ['path: a raw kind', P({ kind: 'zqcanarykind' }), 'kind'],
    ['path: a raw sub-kind', P({ kind: 'system:zqsub' }), 'kind'],
    ['path: a raw name', P({ path: '.zqPrivateParam' }), 'path'],
    ['path: a raw name below a map', P({ path: '.toolUseResult.zqPrivateParam' }), 'path'],
    ['path: a raw name before .*', { ...sl, path: '.zqPrivateParam.*' }, 'path'],
    ['path: a raw name before []', { ...plain, path: '.zqPrivateParam[]' }, 'path'],
    ['path: a path that is no string', P({ path: ['.type'] }), 'path'],
    ['path: n exact', P({ n: '5' }), 'n'],
    ['path: n a number', P({ n: 31337 }), 'n'],
    ['path: n in an array', P({ n: ['2-3'] }), 'n'],
    ['path: n a range at any start', P({ n: '37-73' }), 'n'],
    ['path: n a power of two, its top not', P({ n: '4-31337' }), 'n'],
    ['path: n not a power of two', P({ n: '6-11' }), 'n'],
    ['path: n with a leading zero', P({ n: '04-7' }), 'n'],
    ['path: n 1-1', P({ n: '1-1' }), 'n'],
    ['path: n of 17 digits', P({ n: '9007199254740993-18014398509481983' }), 'n'],
    ['path: n 64+, a cap, not a bucket', P({ n: '64+' }), 'n'],
    ['path: files exact', { ...pl, files: '5' }, 'files'],
    ['path: first suffixed', P({ first: '1.2.3-zq', last: '1.2.3' }), 'first'],
    ['path: first a number', P({ first: 12345, last: '1.2.3' }), 'first'],
    ['path: first a five-digit part', P({ first: '31337.1.1', last: '1.2.3' }), 'first'],
    ['path: first an array', { ...pl, first: [pl.first] }, 'first'],
    ['path: last a word', { ...pl, last: 'zq-not-a-version' }, 'last'],
    ['path: types, a raw key', P({ types: { zqPrivateParam: '1' } }), 'types'],
    ['path: types, a count exact', P({ types: { string: '5' } }), 'types'],
    ['path: types a number', { ...pl, types: 31337 }, 'types'],
    ['path: types a time (a Date)', P({ types: T }), 'types'],
    ['path: strings, a raw key', P({ strings: { zq7canary: '1' } }), 'strings'],
    ['path: strings, a count exact', { ...pl, strings: { text: '5' } }, 'strings'],
    ['path: strings a number', { ...pl, strings: 31337 }, 'strings'],
    ['path: numbers, a raw key', P({ numbers: { 9753102: '1' } }), 'numbers'],
    ['path: numbers, a count exact', { ...pl, numbers: { int: '5' } }, 'numbers'],
    ['path: numbers a number', { ...pl, numbers: 31337 }, 'numbers'],
    ['path: booleans, a raw key', P({ booleans: { maybe: '1' } }), 'booleans'],
    ['path: booleans, a count exact', { ...pl, booleans: { true: '5' } }, 'booleans'],
    ['path: booleans a number', { ...pl, booleans: 31337 }, 'booleans'],
    ['path: lengths, an exact length', P({ lengths: { 5: '1' } }), 'lengths'],
    ['path: lengths, an exact length past the cap', { ...pl, lengths: { 65: '1' } }, 'lengths'],
    ['path: lengths, a bucket past the cap', P({ lengths: { '128-255': '1' } }), 'lengths'],
    ['path: lengths, a count exact', P({ lengths: { '2-3': '5' } }), 'lengths'],
    ['path: lengths a string', { ...pl, lengths: '01' }, 'lengths'],
    ['path: values, a raw key', P({ values: { zqvalue: '1' } }), 'values'],
    ["path: values, another value path's value", P({ values: { tool_use: '1' } }), 'values'],
    ['path: values at a path with none', P({ path: '.uuid', values: { user: '1' } }), 'values'],
    ['path: values, a count exact', { ...vp, values: { [Object.keys(vp.values)[0]]: '5' } }, 'values'],
    ['path: values a number', { ...vp, values: 31337 }, 'values'],
    ['path: names on a line that is not .*', P({ names: '1' }), 'names'],
    ['path: names on a [] line', P({ path: '.message.content[]', names: '1' }), 'names'],
    ['path: names exact', { ...sl, names: '17' }, 'names'],
    ['path: names a number', { ...sl, names: 17 }, 'names'],
    // rare lines
    ['rare: an extra field', { ...rl, x: 'zq7canary' }, 'fields'],
    ['rare: a raw kind', { k: 'rare', kind: 'zqcanarytype', paths: '1', n: '1' }, 'kind'],
    ['rare: paths exact', { ...rl, paths: '5' }, 'paths'],
    ['rare: paths a number', { ...rl, paths: 3 }, 'paths'],
    ['rare: n exact', { ...rl, n: '3' }, 'n'],
    ['rare: n a range at any start', { ...rl, n: '37-73' }, 'n'],
    // the end line
    ['end: another count', { k: 'end', lines: 31337 }, 'lines'],
    ['end: a count as a string', { k: 'end', lines: String(L.length) }, 'lines'],
    ['end: a timing field', { k: 'end', lines: L.length, ms: 4242 }, 'fields'],
    // no line of the format
    ['a line kind that is not one', { k: 'zq7canary' }, 'k'],
    ['a string line', 'zq7canary', 'not an object'],
    ['an array line', ['zq7canary'], 'not an object'],
    ['a null line', null, 'not an object'],
    ['a number line', 9753102, 'not an object'],
    // what JSON makes of an object is what the guard reads (S1): its toJSON, inherited, gives the line written
    ['an inherited toJSON gives the header exact counts', { ...head, files: withProto({ toJSON() { return { read: '6', failed: '0' }; } }, { ...head.files }) }, 'files'],
    ['an inherited toJSON gives a path line a raw name', withProto({ toJSON() { return { ...this, path: '.zqPrivateName' }; } }, P({})), 'path'],
    ['an inherited toJSON gives a version line a raw version', withProto({ toJSON() { return { ...this, v: '9.9.9-zqsecret' }; } }, { ...vl }), 'v'],
  ];
  const tiny = tmp(), build = plantedBuild();
  try {
    writeFileSync(join(tiny, 't.jsonl'), '{"type":"user"}\n');
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wrong = [];
    for (const [what, line, word] of planted) {
      // each in a report the builder made, where the format puts a line of its kind and key, so that its token alone can
      // fail it: since S3 and U6 the guard checks the report whole, and a line given alone fails as no report
      const [lines, at] = plant(L, line);
      let wrote = '';
      const w = SH.writeReport(lines, SH.shapesLanguage(V, allowed, { floor: 3, lines: lines.length }), (s) => { wrote += s; });
      if (w.written !== 0 || wrote !== '' || JSON.stringify(w.reasons) !== JSON.stringify([{ line: at, why: word }])) { wrong.push(`${what}: the module wrote ${w.written} lines, reasons ${JSON.stringify(w.reasons)}, not line ${at}: ${word}`); continue; }
      // the command, its builder giving these lines: exit 1, nothing on stdout, and stderr saying this, and nothing more
      const r = plantedRun(build, lines, [join(tiny, 't.jsonl')]);
      const said = new RegExp(`^ltms shapes: 1 line failed the report's own language at the write, so none of the report was written \\(the first, line ${at}: ${esc(word)}\\)\\. This is a bug in ltms\\.\\nltms shapes: 1 files read \\(0 failed\\), 1 records; no report was written; \\d+\\.\\d s\\.\\n$`);
      if (r.code !== 1 || r.out !== '' || !said.test(r.err)) wrong.push(`${what}: the command exits ${r.code}, ${r.out.length} bytes on stdout, stderr ${JSON.stringify(r.err)}`);
    }
    assert.deepEqual(wrong, [], 'each planted line refused at the write, by its rule\'s word, at its line');
    assert.ok(planted.length >= 100, `${planted.length} planted lines`);
    // a String object holding a bucket is written as that bucket: the text, which the guard reads, is in the language
    const [lines] = plant(L, P({ n: new String('2-3'), types: { string: '2-3' } }));
    let wrote = '';
    assert.equal(SH.writeReport(lines, SH.shapesLanguage(V, allowed, { floor: 3, lines: lines.length }), (s) => { wrote += s; }).written, lines.length);
    assert.ok(wrote.includes('{"k":"path","kind":"user","path":".type","n":"2-3","files":"4-7","types":{"string":"2-3"}}\n'));
  } finally { rm(tiny); rm(build); }
});

test('shapes: source: shapes.ts holds ASCII only and no typed backslash-u, names no supplier, writes nothing itself, and imports only node:fs, node:path and node:crypto; cli.ts writes a report only through writeReport', () => {
  const BSL = String.fromCharCode(92);
  const src = readFileSync(join(root, 'src', 'shapes.ts'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(src), 'a character outside ASCII in src/shapes.ts');
  assert.ok(!src.includes(BSL + 'u'), 'a typed backslash-u in src/shapes.ts');
  for (const text of [src, readFileSync(join(DIST, 'shapes.js'), 'utf8')]) {
    const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(specifiers)].sort(), ['node:crypto', 'node:fs', 'node:path']);
    const code = text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    assert.doesNotMatch(code, /\bprocess\b|\bconsole\b|\brequire\s*\(|\bimport\s*\(|\bfetch\s*\(/, 'shapes writes nothing itself and loads nothing at run time');
  }
  // supplier-neutral: no supplier's name, and no name or value of any vocabulary that is shaped like an identifier (a
  // capital, _, -, or a leading $ or @), in the source, comments included
  assert.doesNotMatch(src, /claude|anthropic|codex|gemini/i, 'src/shapes.ts names a supplier');
  const words = new Set();
  for (const f of [DOCS, CODEX_V, GEMINI_V]) {
    const v = JSON.parse(readFileSync(f, 'utf8'));
    const paths = [...v.paths, ...Object.keys(v.values), ...(v.versions ?? []), v.kinds?.path ?? '', ...Object.values(v.kinds?.sub ?? {})];
    for (const p of paths) for (const s of p.split(/\.|\[\]/)) if (s) words.add(s);
    for (const vs of Object.values(v.values)) for (const x of vs) words.add(x);
    for (const t of Object.keys(v.kinds?.sub ?? {})) words.add(t);
  }
  const shaped = [...words].filter((w) => /[A-Z_$@-]/.test(w));
  assert.ok(shaped.length > 50, `${shaped.length} identifier-shaped words in the vocabularies`);
  assert.deepEqual(shaped.filter((w) => src.includes(w)), [], "src/shapes.ts holds a supplier's key or value");
  // the command's section: one writeReport call writes the report; out() writes its help, nothing else; the report and
  // the review list go out through outParts (S374's closure read, U9: a write that fails is reported), the report's parts
  // being what writeReport hands its writer, and nothing else
  const cli = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');
  const section = cli.slice(cli.indexOf('// ---- ltms shapes'), cli.indexOf('\n// ---- ltms records'));   // 0.3.0: records' section follows
  assert.ok(section.length > 1000, 'the shapes section of src/cli.ts');
  assert.equal(section.match(/\bwriteReport\(/g)?.length, 1, 'one writeReport call');
  assert.deepEqual([...section.matchAll(/\bout\(([A-Za-z_]+)/g)].map((m) => m[1]), ['SHAPES_HELP'], "shapes' out() call: its help");
  assert.deepEqual([...section.matchAll(/\boutParts\(([A-Za-z_]+)/g)].map((m) => m[1]).sort(), ['reportParts', 'reviewParts'], "shapes' outParts() calls: the report's parts, and the review list's");
  assert.match(section, /\bwriteReport\([^\n]*, \(text\) => \{ reportParts\.push\(text\); \}\);/, "the report's parts are what writeReport hands its writer");
  assert.equal(section.match(/\breportParts\.push\(/g)?.length, 1, "nothing else is put in the report's parts");
  assert.doesNotMatch(section, /process\.stdout|console\./);
});

test('shapes: the vocabulary that ships, vocab/claude-code.docs.json, is found beside dist/ and named in the first line by its sha256; it is the only vocabulary in vocab/ and in package.json\'s files', () => {
  const bytes = readFileSync(DOCS), v = JSON.parse(bytes.toString('utf8'));
  const r = shapes([...CC]);
  assert.deepEqual(r.lines[0].vocabulary, [{ name: v.name, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 12), paths: v.paths.length, values: Object.values(v.values).flat().length }]);
  assert.equal(v.name, 'claude-code-docs');
  assert.equal(shapes(['--supplier', 'claude-code', ...CC]).out, r.out);
  assert.equal(shapes(['--vocabulary', DOCS, ...CC]).out, r.out);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files.filter((f) => f.startsWith('vocab')), ['vocab/claude-code.docs.json'], "package.json's files names the one vocabulary that ships, by its own name");
  assert.deepEqual(readdirSync(join(root, 'vocab')), ['claude-code.docs.json'], 'vocab/ holds the one vocabulary that ships');
});

test('shapes: an internal error is reported by its kind and its place in shapes.js, never its message: in a file, that file counts as failed and the others are read; outside any file, the run stops; exit 1', () => {
  const dir = tmp();
  try {
    // a stand-in for a future bug whose message quotes the transcript: RegExp.prototype.test throws on one planted key
    const boom = join(dir, 'boom.cjs');
    writeFileSync(boom, "const test = RegExp.prototype.test;\nRegExp.prototype.test = function (s) { if (s === 'zqboom') throw new TypeError('zqcsecret ' + s); return test.call(this, s); };\n");
    mkdirSync(join(dir, 'p'));
    writeFileSync(join(dir, 'p', 'a.jsonl'), JSON.stringify({ type: 'user', zqboom: 1 }) + '\n');
    writeFileSync(join(dir, 'p', 'b.jsonl'), JSON.stringify({ type: 'user' }) + '\n');
    const r = shapes([join(dir, 'p')], { node: ['-r', boom] });
    assert.equal(r.code, 1);
    assert.match(r.err, /^ltms shapes: '[^']*a\.jsonl': stopped with an internal error \(TypeError at shapes\.js:\d+\), so it counts as failed/m);
    assert.deepEqual([r.lines[0].files.read, r.lines[0].files.failed], ['1', '1']);
    assert.ok(!(r.out + r.err).includes('zqcsecret'));
    // outside any file: listing a directory throws
    const top = join(dir, 'top.cjs');
    writeFileSync(top, "const { Dirent } = require('node:fs');\nconst orig = Dirent.prototype.isSymbolicLink;\nDirent.prototype.isSymbolicLink = function () { if (String(this.name).includes('zqtop')) throw new TypeError('zqcsecret ' + this.name); return orig.call(this); };\n");
    writeFileSync(join(dir, 'p', 'zqtop.jsonl'), '{}\n');
    const t = shapes([join(dir, 'p')], { node: ['-r', top] });
    assert.deepEqual([t.code, t.out], [1, '']);
    assert.match(t.err, /^ltms shapes: stopped with an internal error \(TypeError at shapes\.js:\d+\)\. This is a bug in ltms; anything printed before it is incomplete\.\n$/);
    assert.ok(!t.err.includes('zqcsecret'));
  } finally { rm(dir); }
});

test("shapes: the label rule in dist/shapes.js is dist/cli.js's", () => {
  const rule = (f) => /^const LABEL = (\/.+\/[a-z]*);$/m.exec(readFileSync(join(DIST, f), 'utf8'))?.[1];
  assert.ok(rule('cli.js'), 'dist/cli.js has a LABEL');
  assert.equal(rule('shapes.js'), rule('cli.js'));
});

test('shapes: --help describes every field of every line a report and the review list print, and every line kind; ltms --help points to it', () => {
  const h = spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' });
  assert.deepEqual([h.status, h.stderr], [0, '']);
  assert.equal(spawnSync(process.execPath, [CLI, 'shapes', '-h'], { encoding: 'utf8' }).stdout, h.stdout);
  const report = shapes([...ALLOW, ...CC]).lines, review = shapes(['--unlisted', ...CC]).lines;
  const top = new Set(), nested = new Set();
  for (const o of [...report, ...review]) {
    for (const [key, val] of Object.entries(o)) {
      top.add(key);
      if (o.k === 'shapes' && (key === 'files' || key === 'lines')) for (const x of Object.keys(val)) nested.add(x);
      if (key === 'vocabulary') for (const e of val) for (const x of Object.keys(e)) nested.add(x);
    }
  }
  top.delete('k');   // each part of the help opens with its line's k
  assert.ok(top.size >= 25, `${top.size} fields`);
  for (const key of top) assert.match(h.stdout, new RegExp(`^ {2}(?:\\w+, )?${key}(?:,| {2,})`, 'm'), `ltms shapes --help has no row for '${key}'`);
  for (const key of nested) assert.match(h.stdout, new RegExp(`\\b${key}\\b`), `ltms shapes --help does not name '${key}'`);
  for (const kind of new Set([...report, ...review].map((o) => o.k))) assert.ok(h.stdout.includes(kind), `ltms shapes --help does not name the line kind ${kind}`);
  assert.match(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' '), /ltms shapes --help gives its whole part/);
});

test('shapes: usage errors: exit 2, nothing on stdout, and the message names what was given and what to give', () => {
  const cases = [
    [[], /^ltms shapes: no paths: give the transcripts or their folder/],
    [['--check', 'r.jsonl', ...CC], /--check reads a report, and takes only --supplier or --vocabulary besides it/],
    [['--check', 'r.jsonl', '--floor', '2'], /and --floor was given too\. To check: ltms shapes --check 'r\.jsonl'$/m],
    [['--unlisted', '--floor', '2', ...CC], /--unlisted lists every name, in any number of files: it takes no --floor/],
    [['--supplier', 'claude-code', '--vocabulary', DOCS, ...CC], /--supplier and --vocabulary each name the vocabulary: give one of them, once/],
    [['--supplier', 'zqnone', ...CC], /no vocabulary ships with ltms for 'zqnone': the suppliers are claude-code\. To read with a vocabulary of your own, give --vocabulary <file>/],
    [['--frob', ...CC], /unknown option '--frob'\. The options are --supplier, --vocabulary, --floor, --allow, --max-line, --check, --unlisted, --help and --version/],
    [['-', ...CC], /reading from standard input \('-'\) is not supported/],
    [['--floor', '1', ...CC], /--floor takes a whole number of files from 2 to 9007199254740991 \(the default is 3\); '1' is not one/],
    [['--floor', '0x10', ...CC], /'0x10' is not one/],
    [['--max-line', '1023', ...CC], /--max-line takes a number of bytes from 1024 to \d+/],
    [['--unlisted=1', ...CC], /--unlisted takes no value; '--unlisted=1' gives it one/],
    [['--check', 'a', '--check', 'b'], /--check reads one report: give it once/],
    [['--allow'], /--allow needs a value after it/],
    [['--allow', '.a b', ...CC], /--allow '\.a b': the path must be written like \.message\.newField/],
    [['--vocabulary', FX('no-such-vocabulary.json'), ...CC], /cannot read the vocabulary '[^']*no-such-vocabulary\.json' \(ENOENT\)/],
  ];
  for (const [args, message] of cases) {
    const r = shapes(args);
    assert.deepEqual([r.code, r.out], [2, ''], args.join(' '));
    assert.match(r.err, message, args.join(' '));
  }
  // = gives an option its value; -- ends the options, so a path that starts with - is a path
  assert.equal(shapes(['--floor=2', ...CC]).out, shapes(['--floor', '2', ...CC]).out);
  const dash = shapes(['--', '-zq-missing.jsonl']);
  assert.equal(dash.code, 1);
  assert.match(dash.err, /cannot read '-zq-missing\.jsonl'/);
});

test('shapes: what it reads: every .jsonl under a directory, at any depth; symbolic links met there counted, not followed; a directory or a file met twice read once; a file named, whatever its name', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'p', 'deep', 'er'), { recursive: true });
    writeFileSync(join(dir, 'p', 'a.jsonl'), readFileSync(FX('cc-b.jsonl')));
    writeFileSync(join(dir, 'p', 'deep', 'er', 'b.jsonl'), readFileSync(FX('cc-c.jsonl')));
    writeFileSync(join(dir, 'p', 'notes.txt'), '{"type":"user"}\n');
    symlinkSync(FX('cc-a.jsonl'), join(dir, 'p', 'link.jsonl'));
    symlinkSync(join(dir, 'p', 'deep'), join(dir, 'p', 'dirlink'));
    writeFileSync(join(dir, 'named.txt'), '{"type":"user"}\n');
    const r = shapes([join(dir, 'p'), join(dir, 'p'), join(dir, 'p', 'a.jsonl'), join(dir, 'named.txt')]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^ltms shapes: 2 symbolic links met under the directories given were not followed\.$/m);
    assert.match(r.err, /^ltms shapes: 3 files read \(0 failed\)/m);
    // the very report of the three files read, each once
    assert.equal(r.out, shapes([join(dir, 'p', 'a.jsonl'), join(dir, 'p', 'deep', 'er', 'b.jsonl'), join(dir, 'named.txt')]).out);
    // a directory with no .jsonl in it: said, not read as a clean result
    mkdirSync(join(dir, 'empty'));
    const e = shapes([join(dir, 'empty')]);
    assert.equal(e.code, 0);
    assert.match(e.err, /warning: no \.jsonl file was found under the paths given, so the report counts nothing/);
    assert.equal(e.lines[0].files.read, '0');
  } finally { rm(dir); }
});

test("shapes: --check also refuses a report made with another vocabulary, a first line's allowed list out of order or repeated, and a line kind it does not know; its messages say the line and the field, never the report's text", () => {
  const dir = tmp();
  try {
    const good = shapes(['--allow', '.zqa', '--allow', '.zqb', ...CC]).out;
    const ls = good.split('\n').filter(Boolean);
    const f = (name, lines, more = []) => { writeFileSync(join(dir, name), lines.join('\n') + '\n'); return shapes(['--check', join(dir, name), ...more]); };
    const ok = f('good.jsonl', ls);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.err, /: \d+ lines, every token in the report's language and every line in its place \(vocabulary claude-code-docs@[0-9a-f]{12}; allowed: \.zqa \.zqb\)\.\n$/);
    const other = f('good2.jsonl', ls, ['--vocabulary', CODEX_V]);
    assert.equal(other.code, 1);
    assert.match(other.err, /line 1 names another vocabulary than the one given, codex-sketch@[0-9a-f]{12}/);
    const head = (fn) => [fn(ls[0]), ...ls.slice(1)];
    assert.equal(f('order.jsonl', head((l) => l.replace('"allowed":[".zqa",".zqb"]', '"allowed":[".zqb",".zqa"]'))).code, 1, 'out of order');
    assert.equal(f('twice.jsonl', head((l) => l.replace('"allowed":[".zqa",".zqb"]', '"allowed":[".zqa",".zqa",".zqb"]'))).code, 1, 'repeated');
    const bad = f('bad-allow.jsonl', head((l) => l.replace('"allowed":[".zqa",".zqb"]', '"allowed":["zq7canary words"]')));
    assert.equal(bad.code, 1);
    assert.match(bad.err, /its first line's allowed list holds an entry that is not an --allow argument/);
    const kinds = [...ls.slice(0, -1), '{"k":"zq7canary"}', JSON.stringify({ k: 'end', lines: ls.length + 1 })];
    const k = f('kind.jsonl', kinds);
    assert.equal(k.code, 1);
    assert.match(k.err, new RegExp(`line ${ls.length}: its k is not one of the format's line kinds`));
    for (const r of [other, bad, k]) assert.ok(!r.err.includes('zq7canary'), r.err);
    const not = f('not.jsonl', ['not json zq7canary']);
    assert.equal(not.code, 1);
    assert.match(not.err, /its first line is not JSON, so the file is not a report/);
    assert.ok(!not.err.includes('zq7canary'));
    assert.equal(shapes(['--check', join(dir, 'no-such-report.jsonl')]).code, 1);
  } finally { rm(dir); }
});

/** Every field, line kind, type, class and word of the language, and of the review list: the README's section on ltms
 *  shapes names each as code, and ltms shapes --help names each. */
const LANGUAGE_WORDS = ['shapes', 'version', 'kind', 'path', 'rare', 'end', 'format', 'vocabulary', 'name', 'sha256', 'paths', 'values', 'floor', 'allowed', 'files', 'read', 'failed',
  'lines', 'records', 'blank', 'notJson', 'notObject', 'tooLong', 'v', 'versions', 'n', 'first', 'last', 'types', 'strings', 'numbers', 'booleans', 'lengths', 'names',
  'array', 'boolean', 'null', 'number', 'object', 'string', 'empty', 'uuid', 'iso8601-utc', 'iso8601-offset', 'iso8601-local', 'date', 'digits', 'hex', 'label', 'text',
  'int', 'float', 'epoch-s', 'epoch-ms', 'true', 'false', '(rare)', '(unlisted)', '(none)', '(withheld)', '(not a string)', '(all)', '64+', '*',
  'unlisted-review', 'unlisted', 'unlisted-more', 'unlisted-value', 'send', 'note', 'at', 'allow'];

test("README: shapes' section: its example lines are what ltms shapes prints on the fixtures, as it runs them; it names every field, every line kind, and every type, class and word of the language", () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('### `ltms shapes');
  assert.ok(start >= 0, 'the README has no section on ltms shapes');
  const section = readme.slice(start, readme.indexOf('\n## ', start));
  const cmd = /^ltms shapes ((?:test\/shapes-fixtures\/\S+ ?)+)$/m.exec(section);
  assert.ok(cmd, 'the section gives the command its example runs');
  const printed = new Set(shapes(cmd[1].trim().split(' ')).out.split('\n'));
  const examples = section.split('\n').filter((l) => l.startsWith('{"k":'));
  assert.ok(examples.length >= 6, `${examples.length} example lines`);
  assert.deepEqual(examples.filter((l) => !printed.has(l)), [], 'example lines ltms shapes does not print');
  assert.deepEqual(LANGUAGE_WORDS.filter((w) => !section.includes('`' + w + '`')), [], "words of the language the README's section on ltms shapes does not name as code");
});

test('shapes: the independent validator read every report this file made', (t) => {
  t.diagnostic(`${validated} reports, each read by test/shapes-validate.mjs`);
  assert.ok(validated >= 30, `${validated} reports were validated`);
});

// S1 (S374's closure read): the guard checks the text it writes, parsed back, not the object it was given: an object
// whose JSON is not its own fields (an inherited toJSON) cannot pass as one line and be written as another
test('shapes: the write guard checks the very text it writes (an inherited toJSON cannot carry a token past it)', () => {
  const V = SH.loadVocabulary(DOCS);
  const Lg = SH.shapesLanguage(V, [], { floor: 3, lines: 1 });
  const evil = Object.create({ toJSON() { return { k: 'end', lines: 1, leak: 'zqCANARYtojson' }; } });
  evil.k = 'end'; evil.lines = 1;
  assert.equal(SH.checkLine(evil, Lg), null, 'its own fields pass the language');
  let out = '';
  const w = SH.writeReport([evil], Lg, (t) => { out += t; });
  assert.deepEqual([w.written, w.refused], [0, 1]);
  assert.doesNotMatch(out, /zqCANARY/);
});

// S4 (S374's closure read): versions equal as numbers but spelled apart (1.2.3, 01.2.3, 1.02.3) were ordered by where
// they were first met, so the order of the files reached the report (the version lines, each kind's versions, a path
// line's first and last). Three files, one spelling each; B holds A's contents under other names; a hard link reaches
// A/x.jsonl a second time, so the two orders of the same two paths read the same files in another order. Since U3 the
// version rule withholds 01.2.3 and 1.02.3, so no two versions can tie and these files no longer reach the tie-break
// (a mutant without it survives this test): the test still holds the bytes to the order of the files.
test('shapes: versions equal as numbers but spelled apart: the same contents under other names, and the same two paths in either order, give the same bytes, every field equal to the recompute', () => {
  const dir = tmp();
  try {
    const SPELL = ['1.2.3', '01.2.3', '1.02.3'];
    let n = 0;
    const rec = (type, v) => JSON.stringify({ type, version: v, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, message: { role: type, content: 'hi' } });
    const text = (v) => `${rec('user', v)}\n${rec('assistant', v)}\n`;
    const A = join(dir, 'A'), B = join(dir, 'B'), names = ['x', 'y', 'z'];
    mkdirSync(A); mkdirSync(B);
    names.forEach((f, i) => { writeFileSync(join(A, `${f}.jsonl`), text(SPELL[i])); writeFileSync(join(B, `${f}.jsonl`), text(SPELL[(i + 1) % 3])); });
    const link = join(dir, 'zz-hardlink.jsonl');
    linkSync(join(A, 'x.jsonl'), link);
    const a = shapes([A]);
    assert.equal(a.code, 0, a.err);
    assert.equal(shapes([B]).out, a.out, 'the same contents under other names give the same bytes');
    assert.equal(shapes([link, A]).out, shapes([A, link]).out, 'the same two paths in either order give the same bytes');
    for (const d of [A, B]) assert.deepEqual(shapes([d]).lines.map(canon), recompute(['--vocabulary', DOCS, ...names.map((f) => join(d, `${f}.jsonl`))]), `every field equals the recompute (${d === A ? 'A' : 'B'})`);
  } finally { rm(dir); }
});

// U3 (S374's closure read), with S11's bounds: the version rule. Its digit bounds were in the code only, and a part of
// more than one digit could start with 0 (01.2.3, 0000.0000.0), a second spelling of a version. The rule now refuses
// such a part, and the README and --help state it: the bounds read from each text are the ones the command applies.
test('shapes: the version rule: N.N.N, its parts of 1 to 4, 1 to 4 and 1 to 6 digits, none of more than one digit starting with 0; any other value at a version path is (withheld); the README and --help state the rule the command applies', () => {
  const versionsOf = (values) => {
    const dir = tmp();
    try {
      const files = values.map((v, i) => {
        const f = join(dir, `v${String(i).padStart(3, '0')}.jsonl`);
        writeFileSync(f, JSON.stringify({ type: 'user', version: v, message: { role: 'user', content: v } }) + '\n');
        return f;
      });
      const r = shapes([dir]);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(r.lines.map(canon), recompute(['--vocabulary', DOCS, ...files]), 'every field equals the recompute (the class version follows the same rule)');
      versionsOf.last = r.out;
      return r.lines.filter((o) => o.k === 'version').map((o) => o.v);
    } finally { rm(dir); }
  };
  const printed = ['0.0.0', '0.169.0', '1.10.100', '2.1.300', '10.0.1', '2026.11.15', '9999.9999.999999'];
  const withheld = ['01.2.3', '1.02.3', '1.2.03', '0000.0000.0', '00.1.1', '1.01.001', '10000.1.1', '1.10000.1', '1.1.1234567', '31337.1.1',
    '1.2', '1.2.3.4', '1.2.3-beta', 'v1.2.3', ' 1.2.3', '1.2.3\n', '', 1.5, null, [1, 2, 3]];
  assert.deepEqual(versionsOf([...withheld, ...[...printed].reverse()]), [...printed, '(withheld)'], 'the version lines: the versions that follow the rule, in numeric order, then (withheld)');
  // the language refuses what the rule refuses: the report, a version in it spelled with a leading 0, fails --check and
  // the independent validator
  const dir = tmp();
  try {
    const edited = versionsOf.last.replace('"v":"2.1.300"', '"v":"02.1.300"').replace('"first":"0.0.0"', '"first":"00.0.0"');
    assert.notEqual(edited, versionsOf.last);
    writeFileSync(join(dir, 'r.jsonl'), edited);
    const c = shapes(['--check', join(dir, 'r.jsonl')]);
    assert.equal(c.code, 1, c.err);
    assert.match(c.err, /field "v" holds a value the report's language does not allow there/);
    assert.notDeepEqual(validate(edited.split('\n').filter(Boolean).map((l) => JSON.parse(l)), [DOCS]), [], 'the independent validator refuses it too');
  } finally { rm(dir); }
  // the rule as each text states it, read from the text, then applied to the parts at and past each bound
  const flat = (t) => t.replace(/\s+/g, ' ');
  const readme = flat(readFileSync(join(root, 'README.md'), 'utf8'));
  const help = flat(spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout);
  const stated = [['README', readme, /three parts joined by `\.`, of 1 to (\d+), 1 to (\d+) and 1 to (\d+) digits, none of more than one digit starting with `0`/],
    ['--help', help, /three parts joined by '\.', of 1 to (\d+), 1 to (\d+) and 1 to (\d+) digits, none of more than one digit starting with 0/]].map(([where, text, re]) => {
    const m = re.exec(text);
    assert.ok(m, `${where} states the version rule`);
    return m.slice(1).map(Number);
  });
  assert.deepEqual(stated[0], stated[1], 'the README and --help state the same bounds');
  const [a, b, c] = stated[0], nines = (k) => '9'.repeat(k), part = (k) => '1' + '0'.repeat(k - 1);
  const atBounds = [`${nines(a)}.${nines(b)}.${nines(c)}`, `${part(a)}.${part(b)}.${part(c)}`];
  const pastBounds = [`${part(a + 1)}.1.1`, `1.${part(b + 1)}.1`, `1.1.${part(c + 1)}`, '01.1.1', '1.01.1', '1.1.01'];
  assert.deepEqual(versionsOf([...pastBounds, ...atBounds]), [atBounds[1], atBounds[0], '(withheld)'], `the bounds the texts state, ${a}, ${b} and ${c} digits, are the command's`);
  // and the README no longer says a report holds no number from a record without naming this one
  assert.match(readme, /a value at a version path that follows the version rule prints as written, and it can be a date, when a program writes its version as one \(`2026\.11\.15`\)/);
});

// U14 (S374's closure read): a sub-kind gave the bare kind when its path was missing (system, not system:(none)) and
// (unlisted) when it held another type (system:(unlisted) for 314159), where the kind path itself gives (none) and
// (not a string). The sub-kind now gives the kind path's three, and the language admits exactly those.
test('shapes: a sub-kind prints (none) when the record has none there and (not a string) for another type, as the kind does; the language admits exactly these', () => {
  const dir = tmp();
  try {
    const cases = [
      [{ type: 'system', level: 'info' }, 'system:(none)'],
      [{ type: 'system', subtype: 314159 }, 'system:(not a string)'],
      [{ type: 'system', subtype: null }, 'system:(not a string)'],
      [{ type: 'system', subtype: ['turn_duration'] }, 'system:(not a string)'],
      [{ type: 'system', subtype: '' }, 'system:(unlisted)'],
      [{ type: 'system', subtype: 'zq_sub' }, 'system:(unlisted)'],
      [{ type: 'system', subtype: 'turn_duration' }, 'system:turn_duration'],
      [{ type: 'attachment' }, 'attachment:(none)'],
      [{ type: 'attachment', attachment: 'zq7canary' }, 'attachment:(none)'],
      [{ type: 'attachment', attachment: {} }, 'attachment:(none)'],
      [{ type: 'attachment', attachment: { type: 42 } }, 'attachment:(not a string)'],
      [{ type: 'attachment', attachment: { type: 'zq_attach' } }, 'attachment:(unlisted)'],
      [{ subtype: 'turn_duration' }, '(none)'],
      [{ type: 7 }, '(not a string)'],
      [{ type: 'user' }, 'user'],
    ];
    const files = ['a', 'b', 'c'].map((f) => join(dir, `${f}.jsonl`));
    for (const f of files) writeFileSync(f, cases.map(([rec]) => JSON.stringify(rec)).join('\n') + '\n');
    const r = shapes([dir]);
    assert.equal(r.code, 0, r.err);
    assertNoCanary(r.out);
    assert.deepEqual(r.lines.filter((o) => o.k === 'kind').map((o) => o.kind), [...new Set(cases.map(([, kind]) => kind))].sort(), 'the kinds printed');
    assert.deepEqual(r.lines.map(canon), recompute(['--vocabulary', DOCS, ...files]), 'every field equals the recompute');
    writeFileSync(join(dir, 'r.json'), r.out);
    assert.equal(shapes(['--check', join(dir, 'r.json')]).code, 0, '--check accepts the report');
  } finally { rm(dir); }
  // the language: a kind with a sub-kind's path gives kind:sub for each value listed there, and kind:(unlisted),
  // kind:(none) and kind:(not a string), never the kind alone; a kind without one, the kind alone
  const V = SH.loadVocabulary(DOCS), Lg = SH.shapesLanguage(V, []);
  const kindLine = (kind) => ({ k: 'kind', kind, records: '1', files: '1', versions: {} });
  for (const kind of ['system:(none)', 'system:(not a string)', 'system:(unlisted)', 'system:turn_duration', 'attachment:(none)', 'attachment:(not a string)', 'attachment:(unlisted)', 'user', '(none)', '(not a string)', '(unlisted)'])
    assert.equal(SH.checkLine(kindLine(kind), Lg), null, `the language admits the kind ${kind}`);
  for (const kind of ['system', 'attachment', 'user:(none)', 'user:(not a string)', 'system:(all)', 'system:(rare)', 'system:(withheld)', 'system:zq_sub', 'system:(none):(none)'])
    assert.equal(SH.checkLine(kindLine(kind), Lg), 'kind', `the language refuses the kind ${kind}`);
  const head = (lines) => [{ k: 'shapes', format: 'ltms-shapes/0', vocabulary: V.list, floor: 3, allowed: [], files: { read: '1', failed: '0' }, lines: { records: '1', blank: '0', notJson: '0', notObject: '0', tooLong: '0' } }, ...lines, { k: 'end', lines: lines.length + 2 }];
  // (in the format's order: since S3 and U6, the validator holds a report to it)
  assert.deepEqual(validate(head([kindLine('attachment:(not a string)'), kindLine('system:(none)')]), [DOCS]), [], 'the independent validator admits the new kinds');
  assert.notDeepEqual(validate(head([kindLine('system')]), [DOCS]), [], 'the independent validator refuses a kind alone where the vocabulary names its sub-kind');
});

// U15 (S374's closure read): --allow .type=system:turn_duration made the raw type "system:turn_duration" print as the
// kind system:turn_duration, the very token of a system record whose .subtype is turn_duration: two kinds of record
// counted and walked as one line. ':' joins a kind and its sub-kind, so an --allow value at the kind path or at a
// sub-kind's path may not hold it.
test("shapes: an --allow value at the kind path or at a sub-kind's path may not hold ':' (a usage error that names it); elsewhere it may; the vocabulary that ships holds none there", () => {
  for (const spec of ['.type=system:turn_duration', '.subtype=turn:duration', '.attachment.type=hook:success']) {
    const r = shapes(['--allow', spec, ...CC]);
    assert.deepEqual([r.code, r.out], [2, ''], spec);
    const [path, value] = [spec.slice(0, spec.indexOf('=')), spec.slice(spec.indexOf('=') + 1)];
    assert.match(r.err, new RegExp(`^ltms shapes: --allow '${spec.replace(/[.[\]]/g, '\\$&')}': a value at the kind path or at a sub-kind's path \\(\\.type, \\.subtype, \\.attachment\\.type\\) may not hold ':'`), spec);
    assert.ok(r.err.includes(`'${value}' holds one`), `the message names the value: ${r.err}`);
    assert.ok(r.err.includes(path));
  }
  for (const spec of ['.message.content[].type=zq:block', '.type=custom_thing', '.subtype=zq_sub3']) assert.equal(shapes(['--allow', spec, ...CC]).code, 0, spec);
  const v = JSON.parse(readFileSync(DOCS, 'utf8'));
  const kindPaths = [v.kinds.path, ...Object.values(v.kinds.sub)];
  assert.deepEqual(kindPaths, ['.type', '.subtype', '.attachment.type']);
  assert.deepEqual(kindPaths.flatMap((p) => (v.values[p] ?? []).filter((x) => x.includes(':'))), [], "the vocabulary that ships holds no ':' at the kind path or a sub-kind's path");
  // the review list offers no --allow that would be refused: a value with ':' at a kind path gets allow null
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.jsonl'), [{ type: 'zq:colon' }, { type: 'system', subtype: 'zq:sub' }, { type: 'user', message: { role: 'user', content: [{ type: 'zq:block' }] } }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const u = shapes(['--unlisted', join(dir, 'a.jsonl')]);
    assert.equal(u.code, 0, u.err);
    const allowOf = (at, value) => u.lines.find((o) => o.k === 'unlisted-value' && o.at === at && o.value === value)?.allow;
    assert.deepEqual([allowOf('.type', 'zq:colon'), allowOf('.subtype', 'zq:sub'), allowOf('.message.content[].type', 'zq:block')], [null, null, '.message.content[].type=zq:block']);
  } finally { rm(dir); }
});

// U4 (S374's closure read): the vocabulary file's format was not written down, a misspelled field ('value', 'kind',
// 'subs') or a path that paths lacks passed in silence and made a weaker report, and an error named no entry. The
// README now gives the format; the loader refuses any other field, at the top or in kinds, and any path that kinds,
// versions or values name but paths lacks; each message names the entry by its field and index.
test('shapes: a vocabulary file: a field it does not know, at its top or in kinds, and a path that kinds, versions or values name but paths lacks, are refused (exit 2), each message naming the entry by its field and index; the vocabulary that ships passes, and its fields are the README\'s', () => {
  const base = JSON.parse(readFileSync(DOCS, 'utf8'));
  const variant = (fn) => { const v = structuredClone(base); fn(v); return v; };
  const rename = (o, from, to) => { o[to] = o[from]; delete o[from]; };
  const cases = [
    ['values spelled value', variant((v) => rename(v, 'values', 'value')), /: the field "value" is not a vocabulary's; its fields are format, name, source, paths, values, kinds and versions/],
    ['kinds spelled kind', variant((v) => rename(v, 'kinds', 'kind')), /: the field "kind" is not a vocabulary's/],
    ['kinds.sub spelled subs', variant((v) => rename(v.kinds, 'sub', 'subs')), /: kinds holds the field "subs"; its fields are path and sub/],
    ['kinds.path spelled paths', variant((v) => rename(v.kinds, 'path', 'paths')), /: kinds holds the field "paths"; its fields are path and sub/],
    ['a value list at a path paths lacks', variant((v) => { v.values['.zqNotListed'] = ['a']; }), /: values\[".zqNotListed"\] is a path that paths does not list; every path named in kinds, versions and values must be in paths/],
    ['a version path paths lacks', variant((v) => { v.versions = ['.version', '.release']; }), /: versions\[1\] ".release" is a path that paths does not list/],
    ['a kind path paths lacks', variant((v) => { v.kinds.path = '.kind'; }), /: kinds\.path ".kind" is a path that paths does not list/],
    ["a sub-kind's path paths lacks", variant((v) => { v.kinds.sub.system = '.zqSub'; }), /: kinds\.sub\["system"\] ".zqSub" is a path that paths does not list/],
    ['no paths', variant((v) => { delete v.paths; v.values = {}; delete v.kinds; v.versions = []; }), /: paths is missing/],
    ['a bad path', variant((v) => { v.paths[2] = '.zq secret'; }), /: paths\[2\] ".zq secret" is not a key path/],
    ['a path whose step starts with a digit', variant((v) => { v.paths[5] = '.1abc'; }), /: paths\[5\] ".1abc" is not a key path/],
    ['a bad value', variant((v) => { v.values['.type'][3] = 'has space'; }), /: values\["\.type"\]\[3\] "has space" is not a value/],
    ['a version path with a [] step', variant((v) => { v.versions = ['.message.content[]']; }), /: versions\[0\] ".message.content\[\]" is not a plain path/],
    ['a sub-kind path that is not a string', variant((v) => { v.kinds.sub.attachment = 7; }), /: kinds\.sub\["attachment"\] a number is not a plain path/],
  ];
  const dir = tmp();
  try {
    cases.forEach(([what, v], i) => {
      const f = join(dir, `v${i}.json`);
      writeFileSync(f, JSON.stringify(v));
      const r = shapes(['--vocabulary', f, ...CC]);
      assert.deepEqual([r.code, r.out], [2, ''], `${what}: ${r.err}`);
      assert.match(r.err, new RegExp(`^ltms shapes: '${f.replace(/[.[\]\\]/g, '\\$&')}'${cases[i][2].source}`), what);
    });
  } finally { rm(dir); }
  // the vocabulary that ships, and the two sketches, pass the loader as they are
  for (const f of [DOCS, CODEX_V, GEMINI_V]) assert.doesNotThrow(() => SH.loadVocabulary(f), f);
  // the README gives the format: its fields are the ones the loader takes (each field the README's table names, the
  // shipped vocabulary has; one more is refused)
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('#### The vocabulary file');
  assert.ok(start > 0, 'the README has a part on the vocabulary file');
  const part = readme.slice(start, readme.indexOf('\n#', start + 1));
  const fields = [...part.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(fields.slice().sort(), Object.keys(base).sort(), "the README's table names the shipped vocabulary's fields, each once");
  assert.match(readme, /\| `--vocabulary <file>` \|[^\n]*\[The vocabulary file\]\(#the-vocabulary-file\)/, 'the --vocabulary row links the format');
});

// S11 (S374's closure read): --help's kind row did not name (all), which a vocabulary with no kind path prints (the
// README did); and the overviews (ltms --help's paragraph on shapes, the README's architecture) said every name in a
// report comes from a vocabulary that ships or from --allow, where --vocabulary gives one of your own. (Its third part,
// the version rule's digits, is U3's test.)
test("shapes: --help names every word of the language that the README's section names, (all) among them; ltms --help and the README's overview name the vocabulary given with --vocabulary", () => {
  const h = spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a word counts as named where it stands alone: at the start or end of a line, or by white space or punctuation
  const named = (w) => new RegExp(`(^|[\\s,;:"(\\[{])${esc(w)}($|[\\s,;:.")\\]}])`, 'm').test(h);
  assert.deepEqual(LANGUAGE_WORDS.filter((w) => !named(w)), [], 'words of the language ltms shapes --help does not name');
  const top = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout;
  const at = top.indexOf('shapes prints a report');
  assert.ok(at > 0, "ltms --help's paragraph on shapes");
  assert.match(top.slice(at, top.indexOf('\n\n', at)).replace(/\s+/g, ' '), /every name and value in it from a vocabulary that ships with ltms, or from the vocabulary you give with --vocabulary, or from your own --allow/);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const arch = readme.slice(readme.indexOf('## The architecture'), readme.indexOf('\n## ', readme.indexOf('## The architecture') + 1));
  assert.match(arch, /every name and value in it comes from a vocabulary that ships with ltms, or from the vocabulary you give with `--vocabulary`, or from your own `--allow`/);
});

// U7 (S374's closure read): --floor took any run of digits and applied the double nearest to it, without a word:
// 9007199254740993 became 9007199254740992 and 10^20 - 1 became 10^20 in the first line, and a floor of 310 digits became
// Infinity, a line refused at the write ("a bug in ltms", exit 1) for what is a usage error. A floor is now a whole
// number from 2 to 9007199254740991 (2^53 - 1, the largest whole number a double holds with every one below it), and the
// help, the README and the usage message state that range: read from each text, it is the one the command applies.
test('shapes: --floor takes a whole number of files from 2 to 9007199254740991, as --help, the README and the usage message state; past it, a usage error (no floor is rounded)', () => {
  for (const v of ['9007199254740993', '9007199254740992', '99999999999999999999', '1' + '0'.repeat(21), '9'.repeat(310)]) {
    const r = shapes(['--floor', v, ...CC]);
    assert.deepEqual([r.code, r.out], [2, ''], `--floor ${v.length > 30 ? v.slice(0, 12) + '... (' + v.length + ' digits)' : v}: ${r.err}`);
    assert.ok(r.err.includes(`'${v}' is not one`), r.err);
  }
  // the range as each text states it, then applied at and past each end
  const flat = (t) => t.replace(/\s+/g, ' ');
  const help = flat(spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout);
  const readme = flat(readFileSync(join(root, 'README.md'), 'utf8'));
  const message = shapes(['--floor', '1', ...CC]).err;
  const noValue = shapes(['--floor']).err;
  const stated = [['--help', help, /--floor <n> the files a path must be seen in to be printed \(default 3; a whole number from (\d+) to (\d+)\)/],
    ['README', readme, /\| `--floor <n>` \| the files a path must be seen in to be printed: 3 unless set; a whole number from (\d+) to (\d+) \|/],
    ['the usage message', message, /--floor takes a whole number of files from (\d+) to (\d+) \(the default is 3\); '1' is not one\./],
    ['the message for --floor with no value', noValue, /--floor needs a value after it: a whole number of files from (\d+) to (\d+), the files a path must be seen in to be printed\./]].map(([where, text, re]) => {
    const m = re.exec(text);
    assert.ok(m, `${where} states the range: ${text.slice(0, 300)}`);
    return [where, m.slice(1)];
  });
  for (const [where, range] of stated) assert.deepEqual(range, ['2', '9007199254740991'], `${where} states the range the command applies`);
  const [lo, hi] = stated[0][1];
  assert.equal(shapes(['--floor', String(Number(lo) - 1), ...CC]).code, 2, 'below the range');
  assert.equal(shapes(['--floor', lo, ...CC]).code, 0, 'its least');
  const top = shapes(['--floor', hi, ...CC]);
  assert.equal(top.code, 0, top.err);
  assert.ok(top.out.startsWith('{"k":"shapes",') && top.out.includes(`,"floor":${hi},`), 'the first line states the floor given, digit for digit');
  assert.match(top.err, new RegExp(`under the floor of ${hi} files`));
  assert.equal(shapes(['--floor', (BigInt(hi) + 1n).toString(), ...CC]).code, 2, 'past the range');
});

// S3 (S374's closure read), the writer's side: the write guard checked one line at a time, so a defect in the builder
// that repeated a valid line (N copies of it, N taken from the transcripts: an exact count under a bucket), gave a second
// first line or a second end line, or put the lines, or a map's keys, in another order (the order the reading met them
// in) was written whole, exit 0. The guard now checks the report whole before it writes any of it: one first line; the
// line kinds in the format's order; each kind's lines strictly in the builder's order, so none repeats; each line
// written as the builder writes it, its fields and keys in order; a path line in at least the floor's files; one end
// line, the last, counting the lines. A report that fails is not written at all.
test('shapes: the write guard checks the report whole before writing any of it: a build that repeats a line, gives a second first or end line, puts lines or map keys out of order, or prints a path line under the floor writes nothing, exit 1, and names the first line that fails', () => {
  const build = plantedBuild();
  try {
    const base = shapes([...CC]);
    assert.equal(base.code, 0, base.err);
    const own = plantedRun(build, base.lines, [...CC]);
    assert.deepEqual([own.code, own.out], [0, base.out], 'the planted build, given the lines the builder made, writes the same report');
    const body = base.lines.slice(0, -1);
    const withEnd = (b) => [...b, { k: 'end', lines: b.length + 1 }];
    const first = (k) => body.findIndex((o) => o.k === k);
    const lastOf = (k) => body.reduce((j, o, i) => (o.k === k ? i : j), -1);
    const fp = first('path'), fk = first('kind'), fr = first('rare'), lp = lastOf('path');
    const MAPS = ['types', 'strings', 'numbers', 'booleans', 'lengths', 'values'];
    const reversedMaps = (o) => { const x = { ...o }; for (const g of MAPS) if (x[g]) x[g] = Object.fromEntries(Object.entries(x[g]).reverse()); return x; };
    const mapsMoved = body.findIndex((o) => o.k === 'path' && JSON.stringify(reversedMaps(o)) !== JSON.stringify(o));
    const kindMoved = [...body.slice(0, fk), ...body.slice(fk + 1, lp + 1), body[fk], ...body.slice(lp + 1)];
    const endInside = [...body.slice(0, fp), null, ...body.slice(fp)];
    endInside[fp] = { k: 'end', lines: endInside.length + 1 };
    // [what, the lines the builder gives, the number of the first line that fails]
    const cases = [
      ['a rare line 29 times (an exact count, under a bucket)', withEnd([...body.slice(0, fr), ...Array(29).fill(body[fr]), ...body.slice(fr + 1)]), fr + 2],
      ['a path line 29 times', withEnd([...body.slice(0, fp), ...Array(29).fill(body[fp]), ...body.slice(fp + 1)]), fp + 2],
      ["a second end line, holding the report's own count", withEnd(endInside), fp + 1],
      ['a second first line, the same as the first', withEnd([...body.slice(0, fp), body[0], ...body.slice(fp)]), fp + 1],
      ['the path lines in reverse order', withEnd([...body.slice(0, fp), ...body.slice(fp, lp + 1).reverse(), ...body.slice(lp + 1)]), fp + 2],
      ["every path line's maps in reverse key order (the order the reading met the classes in)", withEnd(body.map((o) => (o.k === 'path' ? reversedMaps(o) : o))), mapsMoved + 1],
      ['a kind line after the path lines', withEnd(kindMoved), lp + 1],
      ['a path line in 1 file, under the floor of 3', withEnd(body.map((o, i) => (i === fp ? { ...o, files: '1' } : o))), fp + 1],
      ["a path line's fields in reverse order", withEnd(body.map((o, i) => (i === fp ? Object.fromEntries(Object.entries(o).reverse()) : o))), fp + 1],
      // (S2's sweep: no case needed the rule that line 1 is the first line, so a mutant without it lived)
      ['no first line: the builder gives the others alone', withEnd(body.slice(1)), 1, 'first line'],
      ['no end line: the builder gives the others alone', body, body.length, 'cut'],
    ];
    assert.ok(mapsMoved > fp && fr > lp && lp > fp && fp > fk && fk > 0, 'the fixtures give the lines these cases move');
    for (const [what, lines, line, word] of cases) {
      const r = plantedRun(build, lines, [...CC]);
      assert.deepEqual([r.code, r.out], [1, ''], `${what}: ${r.err}`);
      assert.match(r.err, new RegExp(`failed the report's own language at the write.*\\(the first, line ${line}: ${word ?? '[a-z .]+'}\\)`), `${what}: ${r.err}`);
      assert.match(r.err, /so none of the report was written/, what);
    }
  } finally { rm(build); }
});

// S3 and U6 (S374's closure read), --check's side: it checked each line alone (and floor 1 passed it, which --floor
// refuses), so a report the writer cannot make passed it: a line repeated, lines out of order, a second end line or first
// line holding any whole number, a path line under the floor; and test/shapes-validate.mjs, the second check the README
// names, passed those and more (a sha256 that is not the vocabulary's, a blank line), so the two checks gave two answers
// on one file. Each now checks the report whole, by the same rules, and these hand-edits of a report get one verdict
// from both: refused. A line's bytes are held too (a key given twice to hide a word, a space, an escape, the fields or a
// map's keys in another order), as the S3 refuter found them. The reports the writer makes, both accept.
test("shapes: --check and the receiver's validator give one verdict on each hand-edit of a report that the writer cannot make: refused by both; and both accept the reports the writer makes", () => {
  const dir = tmp();
  try {
    const good = shapes([...CC]).out, allowGood = shapes(['--allow', '.zqa', '--allow', '.zqb', ...CC]).out;
    const rowsOf = (t) => t.slice(0, -1).split('\n');
    const R = rowsOf(good), A = rowsOf(allowGood);
    const text = (rows) => rows.join('\n') + '\n';
    const P = (r) => JSON.parse(r), S = (o) => JSON.stringify(o);
    const first = (rows, k) => rows.findIndex((r) => P(r).k === k);
    const lastOf = (rows, k) => rows.reduce((j, r, i) => (P(r).k === k ? i : j), -1);
    const fixEnd = (rows) => [...rows.slice(0, -1), S({ k: 'end', lines: rows.length })];
    const head = (rows, fn) => [S(fn(P(rows[0]))), ...rows.slice(1)];
    const at = (rows, i, fn) => rows.map((r, j) => (j === i ? fn(r) : r));
    const ins = (rows, i, ...more) => [...rows.slice(0, i), ...more, ...rows.slice(i)];
    const fp = first(R, 'path'), fk = first(R, 'kind'), lp = lastOf(R, 'path'), fv = first(R, 'version'), fr = first(R, 'rare');
    const multi = R.findIndex((r) => { const o = P(r); return o.k === 'path' && o.types && Object.keys(o.types).length >= 2; });
    const word = [...Buffer.from('zqcanary-payload')].reduce((a, b, i) => { if (i % 3 === 0) a.push(b); else a[a.length - 1] = a[a.length - 1] * 256 + b; return a; }, []);
    const edits = [
      ['floor 1, which --floor refuses', text(head(R, (o) => ({ ...o, floor: 1 })))],
      ['floor 0', text(head(R, (o) => ({ ...o, floor: 0 })))],
      ['floor -7', text(head(R, (o) => ({ ...o, floor: -7 })))],
      ['floor 2.5', text(head(R, (o) => ({ ...o, floor: 2.5 })))],
      ['floor a string', text(head(R, (o) => ({ ...o, floor: 'zqEdit' })))],
      ['floor an object', text(head(R, (o) => ({ ...o, floor: { zq: 1 } })))],
      ['floor written 1e300', text(R).replace('"floor":3,', '"floor":1e300,')],
      ['floor 9007199254740993, which a double rounds', text(R).replace('"floor":3,', '"floor":9007199254740993,')],
      ['floor 31337, every path line kept (each under it)', text(head(R, (o) => ({ ...o, floor: 31337 })))],
      ["a path line's files 1, under the floor of 3", text(at(R, fp, (r) => S({ ...P(r), files: '1' })))],
      ["the vocabulary's sha256 000000000000", text(head(R, (o) => ({ ...o, vocabulary: [{ ...o.vocabulary[0], sha256: '000000000000' }] })))],
      ["the vocabulary's paths 31337", text(head(R, (o) => ({ ...o, vocabulary: [{ ...o.vocabulary[0], paths: 31337 }] })))],
      ["the first line's lines the number 42", text(head(R, (o) => ({ ...o, lines: 42 })))],
      ['a kind line moved after the path lines', text([...R.slice(0, fk), ...R.slice(fk + 1, lp + 1), R[fk], ...R.slice(lp + 1)])],
      ['a path line moved before the kind lines', text([...R.slice(0, fk), R[fp], ...R.slice(fk, fp), ...R.slice(fp + 1)])],
      ['a version line moved last, before the end line', text([...R.slice(0, fv), ...R.slice(fv + 1, -1), R[fv], R[R.length - 1]])],
      ['the path lines reversed', text([...R.slice(0, fp), ...R.slice(fp, lp + 1).reverse(), ...R.slice(lp + 1)])],
      ['a path line twice, the end line counting it', text(fixEnd(ins(R, fp, R[fp])))],
      ['a path line 31 times', text(fixEnd(ins(R, fp, ...Array(30).fill(R[fp]))))],
      ['a kind line twice', text(fixEnd(ins(R, fk, R[fk])))],
      ['a version line twice', text(fixEnd(ins(R, fv, R[fv])))],
      ['a rare line twice', text(fixEnd(ins(R, fr, R[fr])))],
      ['a path line twice, the copy with n a 16-digit bucket', text(fixEnd(ins(R, fp + 1, S({ ...P(R[fp]), n: '4503599627370496-9007199254740991' }))))],
      ['an end line inside the report, holding 987654321', text(fixEnd(ins(R, fp, S({ k: 'end', lines: 987654321 }))))],
      ["an end line inside the report, holding the report's count", text(fixEnd(ins(R, fp, S({ k: 'end', lines: R.length + 1 }))))],
      ['an end line inside the report, holding 2.5', text(fixEnd(ins(R, fp, S({ k: 'end', lines: 2.5 }))))],
      ['an end line inside the report, holding a string', text(fixEnd(ins(R, fp, S({ k: 'end', lines: 'zq7canary' }))))],
      ['six end lines before the last, a word in them as whole numbers', text(fixEnd(ins(R, R.length - 1, ...word.map((n) => S({ k: 'end', lines: n })))))],
      ['a second first line, floor 987654321', text(fixEnd(ins(R, 1, S({ ...P(R[0]), floor: 987654321 }))))],
      ['a second first line, the same', text(fixEnd(ins(R, fp, R[0])))],
      ['a path line given "paths":123456789', text(at(R, fp, (r) => S({ ...P(r), paths: 123456789 })))],
      ['a path line given "lines":4294967296', text(at(R, fp, (r) => S({ ...P(r), lines: 4294967296 })))],
      ["a path line's types keys reversed", text(at(R, multi, (r) => { const o = P(r); o.types = Object.fromEntries(Object.entries(o.types).reverse()); return S(o); }))],
      ["a path line's fields reversed", text(at(R, fp, (r) => S(Object.fromEntries(Object.entries(P(r)).reverse()))))],
      ['an end line whose lines is given twice, a word first', text(at(R, R.length - 1, () => `{"k":"end","lines":"zqcanary words in the report","lines":${R.length}}`))],
      ['a path line whose kind is given twice, a word first', text(at(R, fp, (r) => r.replace('{"k":"path",', '{"k":"path","kind":"zqcanarykind private",')))],
      ["the first line's format given twice, a word first", text(at(R, 0, (r) => r.replace('{"k":"shapes",', '{"k":"shapes","format":"zqcanary header text",')))],
      ['spaces inside a line', text(at(R, fp, (r) => r.replace(/,/g, ' ,  ')))],
      ['a key written as an escape', text(at(R, fp, (r) => r.replace('{"k":"path"', '{"\\u006b":"path"')))],
      ['a blank line after the end line', text(R) + '\n'],
      ['a blank line inside the report', text(ins(R, fp, ''))],
      ['a byte-order mark', String.fromCharCode(0xfeff) + text(R)],
      ['every line ended by CR LF', R.map((r) => r + '\r\n').join('')],
      ['the last line cut away', text(R.slice(0, -1))],
      ['a version with a suffix', text(at(R, fv, (r) => r.replace(/"v":"[^"]*"/, '"v":"9.9.9-zq"')))],
      ['a line that is not JSON', text(at(R, fp, () => 'not json zq7canary'))],
      ['a line that is a JSON array', text(at(R, fp, () => '["zq7canary"]'))],
      ["allowed: an entry that is no --allow argument, with a dot", text(head(A, (o) => ({ ...o, allowed: ['zz secret words.and/a path'] })))],
      ['allowed: an entry that is no --allow argument, without a dot', text(head(A, (o) => ({ ...o, allowed: ['zzsecret'] })))],
      ['allowed out of order', text(head(A, (o) => ({ ...o, allowed: ['.zqb', '.zqa'] })))],
      ['allowed with an entry twice', text(head(A, (o) => ({ ...o, allowed: ['.zqa', '.zqa', '.zqb'] })))],
    ];
    const verdict = (name, t) => {
      const f = join(dir, `${name}.jsonl`);
      writeFileSync(f, t);
      const c = spawnSync(process.execPath, [CLI, 'shapes', '--check', f], { encoding: 'utf8' });
      const v = spawnSync(process.execPath, [join(here, 'shapes-validate.mjs'), f, DOCS], { encoding: 'utf8' });
      assert.equal(c.stdout, '', `${name}: --check writes nothing on stdout`);
      return [c.status, v.status];
    };
    const wrong = [];
    edits.forEach(([what, t], i) => {
      assert.notEqual(t, good, `${what}: the edit changes the report`);
      const got = verdict(`e${i}`, t);
      if (got[0] !== 1 || got[1] !== 1) wrong.push(`${what}: --check ${got[0]}, the validator ${got[1]}`);
    });
    assert.deepEqual(wrong, [], 'each hand-edit refused (exit 1) by --check and by the validator');
    // the reports the writer makes: both accept
    const made = [good, allowGood, shapes(['--floor', '2', ...CC]).out, shapes(['--floor', '9007199254740991', ...CC]).out, shapes(['--vocabulary', DOCS, '--floor', '4', ...CC]).out];
    made.forEach((t, i) => assert.deepEqual(verdict(`w${i}`, t), [0, 0], `a report the writer made (${i}): accepted by both`));
  } finally { rm(dir); }
});

// U10 (S374's closure read): --check's messages put a word into "its X is not in the report's language": "its not an
// object", "its path fields", "its version" when the records count failed and v was intact (not the field); an end line
// with an extra field got the message of a cut report; a blank line after the end line got two problems, the second
// "the report is cut, or was edited"; a byte-order mark got "its first line is not a report's ... An --unlisted list is
// not one either". Each message now says what is wrong in plain words, names the field that failed, and for what ltms
// never writes (a byte-order mark, a blank line at the end, CR LF, UTF-16) says so and how to remove it, still exit 1.
test('shapes: --check says what is wrong in plain words, by the line and the field that failed; a byte-order mark, a blank line at the end, CR LF and UTF-16 are named, each with how to remove it', () => {
  const dir = tmp();
  try {
    const good = shapes([...CC]).out, allowGood = shapes(['--allow', '.zqa', '--allow', '.zqb', ...CC]).out;
    const R = good.slice(0, -1).split('\n'), A = allowGood.slice(0, -1).split('\n');
    const P = (r) => JSON.parse(r), S = (o) => JSON.stringify(o);
    const text = (rows) => rows.join('\n') + '\n';
    const at = (rows, i, fn) => rows.map((r, j) => (j === i ? fn(r) : r));
    const set = (rows, i, fn) => at(rows, i, (r) => { const o = P(r); fn(o); return S(o); });
    const find = (pred) => { const i = R.findIndex((r) => pred(P(r))); assert.ok(i > 0, String(pred)); return i; };
    const path = (g) => find((o) => o.k === 'path' && o[g] && Object.keys(o[g]).some((x) => x !== '(rare)'));
    const ver = find((o) => o.k === 'version' && /^\d/.test(o.v)), kind = find((o) => o.k === 'kind' && Object.keys(o.versions).length);
    const p = find((o) => o.k === 'path' && o.first), star = find((o) => o.k === 'path' && o.names), rare = find((o) => o.k === 'rare');
    const first = (m) => Object.keys(m).find((x) => x !== '(rare)');
    const n = R.length, f = (i) => i + 1;
    const BOM = String.fromCharCode(0xfeff);
    // [what, the file's text, the messages stderr holds (each a regular expression), how many problems]
    const cases = [
      ['a line that is not JSON', text(at(R, p, () => 'not json zq7canary')), [new RegExp(`line ${f(p)} is not JSON\\.`)], 1],
      ['a line that is a JSON array', text(at(R, p, () => '["zq7canary"]')), [new RegExp(`line ${f(p)} is JSON, but not an object\\.`)], 1],
      ['a line whose k is no line kind', text(set(R, p, (o) => { o.k = 'zq7canary'; })), [new RegExp(`line ${f(p)}: its k is not one of the format's line kinds \\(shapes, version, kind, path, rare, end\\)\\.`)], 1],
      ['a path line with a field more', text(at(R, p, (r) => r.replace('{"k":"path",', '{"k":"path","zq":"x",'))), [new RegExp(`line ${f(p)}: its fields are not those of its line kind: one is missing, or is not one the format gives it\\.`)], 1],
      ['the first line with a field more', text(at(R, 0, (r) => r.slice(0, -1) + ',"zq":"x"}')), [/line 1: its fields are not those of its line kind/], 1],
      ["a version line's records exact", text(set(R, ver, (o) => { o.records = '5'; })), [new RegExp(`line ${f(ver)}: field "records" holds a value the report's language does not allow there\\.`)], 1],
      ["a kind line's records exact", text(set(R, kind, (o) => { o.records = '5'; })), [new RegExp(`line ${f(kind)}: field "records" holds`)], 1],
      ["a kind line's versions, a count exact", text(set(R, kind, (o) => { o.versions[first(o.versions)] = '5'; })), [new RegExp(`line ${f(kind)}: field "versions" holds`)], 1],
      ["a rare line's n exact", text(set(R, rare, (o) => { o.n = '5'; })), [new RegExp(`line ${f(rare)}: field "n" holds`)], 1],
      ["a path line's n exact", text(set(R, p, (o) => { o.n = '5'; })), [new RegExp(`line ${f(p)}: field "n" holds`)], 1],
      ...['types', 'strings', 'numbers', 'booleans', 'lengths', 'values'].map((g) => { const i = path(g); return [`a path line's ${g}, a count exact`, text(set(R, i, (o) => { o[g][first(o[g])] = '5'; })), [new RegExp(`line ${f(i)}: field "${g}" holds`)], 1]; }),
      ["a .* line's names exact", text(set(R, star, (o) => { o.names = '5'; })), [new RegExp(`line ${f(star)}: field "names" holds`)], 1],
      ["a path line's first not a version", text(set(R, p, (o) => { o.first = 'zq'; })), [new RegExp(`line ${f(p)}: field "first" holds`)], 1],
      ["a path line's last not a version", text(set(R, p, (o) => { o.last = 'zq'; })), [new RegExp(`line ${f(p)}: field "last" holds`)], 1],
      ["the first line's files exact", text(set(R, 0, (o) => { o.files.read = '5'; })), [/line 1: field "files" holds/], 1],
      ["the first line's lines exact", text(set(R, 0, (o) => { o.lines.records = '5'; })), [/line 1: field "lines" holds/], 1],
      ["the first line's format", text(set(R, 0, (o) => { o.format = 'zq'; })), [/line 1: field "format" holds/], 1],
      ['floor 0', text(set(R, 0, (o) => { o.floor = 0; })), [/line 1: its floor is not a whole number of files from 2 to 9007199254740991\./], 1],
      ['the end line with a field more, its count right', text(at(R, n - 1, (r) => r.slice(0, -1) + ',"zq":"x"}')), [new RegExp(`line ${n}: its fields are not those of its line kind`)], 1],
      ['an end line with a field more in place of a line inside', text(at(R, p, () => S({ k: 'end', lines: n, zq: 'x' }))), [new RegExp(`line ${f(p)}: its fields are not those of its line kind`)], 1],
      ['allowed out of order', text(set(A, 0, (o) => { o.allowed = ['.zqb', '.zqa']; })), [/line 1: its allowed list is not the one ltms makes of the --allow it names: each entry a string, sorted, none twice\./], 1],
      ['one blank line after the end line', text(R) + '\n', [new RegExp(`line ${n + 1} is blank: the file ends with a blank line after its end line, which ltms never writes; delete it\\.`)], 1],
      ['a line of white space after the end line', text(R) + ' \n', [new RegExp(`line ${n + 1} is blank: the file ends with a blank line after its end line`)], 1],
      ['two blank lines after the end line', text(R) + '\n\n', [new RegExp(`lines ${n + 1} to ${n + 2} are blank: the file ends with blank lines after its end line, which ltms never writes; delete them\\.`)], 1],
      ['a blank line inside the report', text([...R.slice(0, p), '', ...R.slice(p)]), [new RegExp(`line ${f(p)} is blank\\.`), new RegExp(`the last line is not an end line that counts the report's ${n + 1} lines`)], 2],
      ['a byte-order mark', BOM + text(R), [/line 1 starts with a byte-order mark \(U\+FEFF\), which ltms never writes: save the file as UTF-8 without one, or remove its first 3 bytes \(tail -c \+4 '[^']+' > <a new file>\)\./], 1],
      ['CR LF', R.map((r) => r + '\r\n').join(''), [/the file's lines end with CR LF \(the first, line 1\), which ltms never writes: make them end with LF alone \(dos2unix '[^']+', or the line-ending setting of the editor that saved it\)\./], 1],
      ['a byte-order mark and CR LF', BOM + R.map((r) => r + '\r\n').join(''), [/line 1 starts with a byte-order mark/, /the file's lines end with CR LF/], 2],
    ];
    for (const [what, t, messages, count] of cases) {
      const file = join(dir, 'r.jsonl');
      writeFileSync(file, t);
      const r = shapes(['--check', file]);
      assert.deepEqual([r.code, r.out], [1, ''], `${what}: ${r.err}`);
      for (const m of messages) assert.match(r.err, m, `${what}: ${r.err}`);
      assert.match(r.err, new RegExp(`: ${count} ${count === 1 ? 'problem' : 'problems'}; do not send it as it is\\.\\n$`), `${what}: ${r.err}`);
      assert.doesNotMatch(r.err, / its [a-z. ]+ is not in the report's language|not an object is|line kind is not in/, `${what}: no message of the old wording: ${r.err}`);
      assert.ok(!r.err.includes('zq7canary') && !r.err.includes('"zq"'), `${what}: no text of the report in the message`);
    }
    // what is not a report: each named for what it is
    const not = [
      ['an empty file', '', /: the file is empty: it is not a report\./],
      ['a first line that is not JSON', 'not json zq7canary\n', /: its first line is not JSON, so the file is not a report\./],
      ['a first line that is blank', '\n' + text(R), /: its first line is blank, so the file is not a report: a report's first line is its shapes line \(k "shapes"\)\./],
      ['an --unlisted list', shapes(['--unlisted', ...CC]).out, /: it is an --unlisted list, which is for your own review and never sent: it is not a report\. Make the report without --unlisted\./],
      ['a first line of another kind', text(R.slice(1)), /: its first line is not a report's first line \(k "shapes", with an allowed list\), so the file is not a report\./],
    ];
    for (const [what, t, m] of not) {
      const file = join(dir, 'n.jsonl');
      writeFileSync(file, t);
      const r = shapes(['--check', file]);
      assert.deepEqual([r.code, r.out], [1, ''], `${what}: ${r.err}`);
      assert.match(r.err, m, `${what}: ${r.err}`);
      assert.ok(!r.err.includes('zq7canary'), what);
    }
    // UTF-16, as Windows PowerShell 5.1's > writes (its byte-order mark, then two bytes a character): named, with the remedy
    for (const [bom, le] of [[[0xff, 0xfe], true], [[0xfe, 0xff], false]]) {
      const body = Buffer.from(text(R), 'utf16le');
      if (!le) body.swap16();
      const file = join(dir, 'u.jsonl');
      writeFileSync(file, Buffer.concat([Buffer.from(bom), body]));
      const r = shapes(['--check', file]);
      assert.deepEqual([r.code, r.out], [1, ''], r.err);
      assert.match(r.err, new RegExp(`: it starts with the bytes ${bom.map((b) => b.toString(16).toUpperCase()).join(' ')}, the byte-order mark of UTF-16, and ltms writes a report in UTF-8: save it as UTF-8 without a byte-order mark\\.`), r.err);
    }
    // a final new line left off: a report all the same (the format is about lines)
    writeFileSync(join(dir, 'nl.jsonl'), good.slice(0, -1));
    assert.equal(shapes(['--check', join(dir, 'nl.jsonl')]).code, 0);
  } finally { rm(dir); }
});

// S2 (S374's closure read), --check's side: no test of the suite gave --check a floor of another type (a mutant that let
// any floor through --check, CL15, survived it). A string, an object, 1, 2.5 and 0 are each refused, as is an end line
// inside the report whose count is a string or 2.5; each message names the line and the field, and holds none of the edit.
test('shapes: --check refuses a first line whose floor is not a whole number of files from 2 to 2^53 - 1 (a string, an object, 1, 2.5, 0), and an end line inside the report whose count is not a whole number; each message names the line and the field', () => {
  const dir = tmp();
  try {
    const R = shapes([...CC]).out.slice(0, -1).split('\n');
    const at = R.findIndex((r) => r.startsWith('{"k":"path"'));
    const head = (floor) => [JSON.stringify({ ...JSON.parse(R[0]), floor }), ...R.slice(1)];
    const inside = (lines) => [...R.slice(0, at), JSON.stringify({ k: 'end', lines }), ...R.slice(at, -1), JSON.stringify({ k: 'end', lines: R.length + 1 })];
    const cases = [
      ...['zqEdit', { zq: 'zqEdit' }, 1, 2.5, 0].map((floor) => [`floor ${JSON.stringify(floor)}`, head(floor), /^ltms shapes --check: line 1: its floor is not a whole number of files from 2 to 9007199254740991\.$/m]),
      ...['zqEdit', 2.5].map((lines) => [`an end line inside the report, lines ${JSON.stringify(lines)}`, inside(lines), new RegExp(`^ltms shapes --check: line ${at + 1}: field "lines" holds a value the report's language does not allow there\\.$`, 'm')]),
    ];
    for (const [what, rows, message] of cases) {
      writeFileSync(join(dir, 'r.jsonl'), rows.join('\n') + '\n');
      const r = shapes(['--check', join(dir, 'r.jsonl')]);
      assert.deepEqual([r.code, r.out], [1, ''], what);
      assert.match(r.err, message, `${what}: ${r.err}`);
      assert.match(r.err, /: 1 problem; do not send it as it is\.\n$/, `${what}: ${r.err}`);
      assert.ok(!r.err.includes('zqEdit'), what);
    }
  } finally { rm(dir); }
});

// S2 (S374's closure read), the sweep over the guard's rules: the rules of the report as a whole are each needed by a
// test, but a second first line is refused by the rules of order and of repeats too, so no test held --check to its own
// word (a mutant without it lived). Each place a line can be out of is named by --check, in its own words, one problem.
test("shapes: --check names the place a line is out of, one problem each: a second first line, an end line before the last, a line out of order, a line repeated, a path line under the floor, a line not written as ltms writes one, a report cut", () => {
  const dir = tmp();
  try {
    const R = shapes([...CC]).out.slice(0, -1).split('\n'), n = R.length;
    const fp = R.findIndex((r) => r.startsWith('{"k":"path"')), fv = R.findIndex((r) => r.startsWith('{"k":"version"'));
    const fixEnd = (rows) => [...rows.slice(0, -1), JSON.stringify({ k: 'end', lines: rows.length })];
    const at = (i, fn) => R.map((r, j) => (j === i ? fn(r) : r));
    const cases = [
      ['a second first line', fixEnd([...R.slice(0, fp), R[0], ...R.slice(fp)]), `line ${fp + 1} is a second first line (k "shapes"): a report has one, its first`],
      ['an end line before the last', fixEnd([...R.slice(0, fp), JSON.stringify({ k: 'end', lines: n + 1 }), ...R.slice(fp)]), `line ${fp + 1} is an end line before the last line: a report has one end line, its last`],
      ['a version line after the rare lines', [...R.slice(0, fv), ...R.slice(fv + 1, -1), R[fv], R[n - 1]], `line ${n - 1} is out of the format's order: a report's lines come shapes, version, kind, path, rare, end, and the lines of each kind in ltms's order (versions in numeric order, kinds by their text, paths by kind and then path)`],
      ['a path line twice', fixEnd([...R.slice(0, fp), R[fp], ...R.slice(fp)]), `line ${fp + 2} repeats the line of its kind before it (the same version, kind, or kind and path): a report has one line for each`],
      ['a path line in 1 file, under the floor of 3', at(fp, (r) => JSON.stringify({ ...JSON.parse(r), files: '1' })), `line ${fp + 1} is a path line in fewer files than the floor the first line states: ltms prints no such line`],
      ["a path line's fields in reverse order", at(fp, (r) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(r)).reverse()))), `line ${fp + 1} is not written as ltms writes a line: its fields in the format's order, each map's keys in ltms's order, each key once, no space`],
      ['the end line cut away', R.slice(0, -1), `line ${n - 1}: the last line is not an end line that counts the report's ${n - 1} lines: the report is cut, or was edited`],
    ];
    for (const [what, rows, message] of cases) {
      writeFileSync(join(dir, 'r.jsonl'), rows.join('\n') + '\n');
      const r = shapes(['--check', join(dir, 'r.jsonl')]);
      assert.deepEqual([r.code, r.out], [1, ''], what);
      assert.ok(r.err.startsWith(`ltms shapes --check: ${message}.\n`), `${what}: ${r.err}`);
      assert.match(r.err, /: 1 problem; do not send it as it is\.\n$/, `${what}: ${r.err}`);
    }
  } finally { rm(dir); }
});

// S10 (S374's closure read): the usage message stated the rule for an --allow name as "letters, digits and _ : + -, at
// most 64; a leading $ or @ allowed" (since U4: "a letter or _, then letters, ..."), and --help stated none; read
// plainly, they admitted names the command refuses: a step that starts, after an optional $ or @, with a digit, - : or +
// (.0abc, .-x, .$0x), and a letter outside ASCII. The rule NAME applies is now stated, in the same words, in --help, the
// README and the usage message; and the names it admits are taken and those it refuses are refused, the length read from
// the text.
test("shapes: --allow's rule for a name, in --help, the README and the usage message, is the one the command applies: an optional $ or @, then an ASCII letter or _, then ASCII letters, digits and _ : + -, at most 64 after the $ or @", () => {
  const RULE = 'an optional $ or @, then an ASCII letter or _, then ASCII letters, digits and _ : + -, at most (\\d+) after the $ or @';
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\(\\\\d\\+\\)', '(\\d+)');
  const flat = (t) => t.replace(/\s+/g, ' ');
  const dir = tmp();
  try {
    writeFileSync(join(dir, 't.jsonl'), '{"type":"user"}\n');
    const T = join(dir, 't.jsonl');
    const help = flat(spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout);
    const readme = flat(readFileSync(join(root, 'README.md'), 'utf8')).replace(/`/g, '');
    const message = shapes(['--allow', '.0abc', T]).err;
    const at = /--allow <path>.*?Each name: /.exec(help)?.index;
    assert.ok(at !== undefined, '--help states a rule for a name in its --allow row');
    const stated = [['--help', help.slice(at)], ['the README', readme.slice(readme.indexOf('| --allow <path> |'))], ['the usage message', message]].map(([where, t]) => {
      const m = new RegExp(esc(RULE)).exec(t);
      assert.ok(m, `${where} states the rule: ${t.slice(0, 400)}`);
      return Number(m[1]);
    });
    assert.deepEqual(stated, [64, 64, 64], 'the three state one length');
    const L = stated[0], letter = String.fromCharCode(0xe9);   // e with an acute accent: a letter, not an ASCII one
    const admitted = ['.abc', '._u', '.$id', '.@ok', '.x0', '.x:', '.x-', '.x+', '.a.b_c', '.list[].name', '.' + 'a'.repeat(L), '.$' + 'a'.repeat(L), '.@' + '_'.repeat(L)];
    const refused = ['.0abc', '.9', '.-x', '.:x', '.+x', '.$0x', '.@-x', '.$', '.' + letter, '.a' + letter, '.$' + letter, '.' + 'a'.repeat(L + 1), '.$' + 'a'.repeat(L + 1)];
    for (const n of admitted) assert.equal(shapes(['--allow', n, T]).code, 0, `the rule admits --allow '${n}'`);
    for (const n of refused) {
      const r = shapes(['--allow', n, T]);
      assert.equal(r.code, 2, `the rule refuses --allow '${n}'`);
      assert.ok(r.err.includes(`--allow '${n}': the path must be written like .message.newField or .list[].name`), r.err);
    }
  } finally { rm(dir); }
});

// S9 (S374's closure read): the README said that two reports of the same transcripts, taken on different days, differ
// only where a count crosses a power of two. A report holds no time, so the same files give the same bytes on any day;
// the reports differ when the files do, and then by more than their buckets: lines appear (a version, a kind, a path that
// reaches the floor), lines go (paths whose files fall under the floor when a file is removed), a path line's first or
// last version moves, and the end line, which counts the lines exactly, changes. The test makes each happen on synthetic
// files, a day apart, and the README's sentence names each.
test("README: what tells apart two reports of the same transcripts on different days: the same files give the same bytes; as files grow or one is removed, each way the reports differ here is one the README names", () => {
  const dir = tmp();
  try {
    let n = 0;
    const rec = (type, version, extra = {}) => JSON.stringify({ type, version, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, message: { role: 'user', content: 'hi' }, ...extra });
    const write = (name, files) => { const d = join(dir, name); mkdirSync(d); for (const [f, ls] of Object.entries(files)) writeFileSync(join(d, `${f}.jsonl`), ls.join('\n') + '\n'); return d; };
    const day1 = { a: [rec('user', '2.1.300'), rec('user', '2.1.300', { permissionMode: 'x' })], b: [rec('user', '2.1.300'), rec('user', '2.1.300', { permissionMode: 'x' })], c: [rec('user', '2.1.300')] };
    // a day later: c has grown, under a later version, with a kind of record not seen before and a key that now reaches
    // the floor of 3 files; and two days later, a is gone (as the 30-day cleanup removes a transcript)
    const day2 = { ...day1, c: [...day1.c, rec('user', '2.1.400', { permissionMode: 'x' }), rec('ai-title', '2.1.400'), rec('user', '2.1.400')] };
    const day3 = { b: day2.b, c: day2.c };
    const [r1, r2, r3] = [write('day1', day1), write('day2', day2), write('day3', day3)].map((d) => shapes([d]));
    for (const r of [r1, r2, r3]) assert.equal(r.code, 0, r.err);
    assert.equal(shapes([join(dir, 'day1')]).out, r1.out, 'the same files: the same bytes');
    const key = (o) => (o.k === 'version' ? `version ${o.v}` : o.k === 'path' ? `path ${o.kind} ${o.path}` : `${o.k} ${o.kind ?? ''}`);
    const BUCKETS = ['records', 'files', 'n', 'paths'];
    const seen = new Set();
    for (const [a, b] of [[r1, r2], [r2, r3]]) {
      const A = new Map(a.lines.map((o) => [key(o), o])), B = new Map(b.lines.map((o) => [key(o), o]));
      for (const [k, o] of B) if (!A.has(k)) seen.add(`a ${o.k} line appears`);
      for (const [k, o] of A) if (!B.has(k)) seen.add(`a ${o.k} line goes`);
      for (const [k, o] of B) {
        const p = A.get(k);
        if (!p || o.k === 'end') continue;
        if (p.first !== o.first || p.last !== o.last) seen.add('first or last moves');
        if (BUCKETS.some((f) => f in o && p[f] !== o[f]) || (o.k === 'shapes' && JSON.stringify(p.lines) !== JSON.stringify(o.lines))) seen.add('a count crosses a power of two');
      }
      if (a.lines.at(-1).lines !== b.lines.at(-1).lines) seen.add('the end line counts other lines');
    }
    for (const w of ['a version line appears', 'a kind line appears', 'a path line appears', 'a path line goes', 'first or last moves', 'a count crosses a power of two', 'the end line counts other lines']) assert.ok(seen.has(w), `the files make it happen: ${w} (seen: ${[...seen].join('; ')})`);
    // the README's sentence names each
    const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\s+/g, ' ');
    const at = readme.indexOf('**What a report still says.**');
    const para = readme.slice(at, readme.indexOf('**Before you send one.**', at));
    assert.ok(at > 0 && para.length > 100, "the README's paragraph on what a report still says");
    assert.doesNotMatch(para, /differ only where a count crosses a power of two/, 'the sentence S9 found false is gone');
    const NAMES = {
      'a version line appears': /a kind, a version, a path\b[^.;]*appears/, 'a kind line appears': /a kind, a version, a path\b[^.;]*appears/,
      'a path line appears': /a path\b[^.;]*crosses the floor/, 'a path line goes': /disappears/, 'first or last moves': /`first` or `last` version moves/,
      'a count crosses a power of two': /where a count crosses a power of two/, 'the end line counts other lines': /in `end`, which counts the lines exactly/,
      // a kind's rare line comes and goes with its paths under the floor; a kind or a version goes with its last file
      'a rare line appears': /appears, disappears or crosses the floor/, 'a rare line goes': /appears, disappears or crosses the floor/,
      'a kind line goes': /a kind, a version\b[^.;]*disappears/, 'a version line goes': /a kind, a version\b[^.;]*disappears/,
    };
    for (const w of seen) assert.match(para, NAMES[w] ?? /^$/, `the README names it: ${w}`);
    assert.match(para, /holds no time: the same files give the same bytes on any day/);
  } finally { rm(dir); }
});

// S2 (S374's closure read), its refuter's last part: the planted lines catch a field added to a line kind's list only
// under a name one of them holds ('ms'); a field of any other name, added to the list the guard and the canonical form
// both read (LINE_FIELDS), would pass both (a mutant adding 'zz' to a path line's fields lived). Each line kind's fields,
// as src/shapes.ts and the build under test list them, are the rows --help gives that line kind: no more, no fewer.
test("shapes: each line kind's fields, as src/shapes.ts and the build list them, are the rows --help gives that line kind, no more and no fewer", () => {
  const help = spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout;
  const part = (k) => { const at = help.indexOf(`k "${k}"`); assert.ok(at > 0, `--help has a part on k "${k}"`); return help.slice(at, help.indexOf('\n\n', at)); };
  const rows = (k) => [...part(k).matchAll(/^ {2}(\w+)(?:, (\w+))?(?= {2,}|$)/gm)].flatMap((m) => [m[1], m[2]].filter(Boolean)).sort();
  const words = (t) => [...t.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const file of [join(root, 'src', 'shapes.ts'), join(DIST, 'shapes.js')]) {
    const text = readFileSync(file, 'utf8');
    const block = /\nconst LINE_FIELDS(?::[^=]*)? = \{\n([\s\S]*?)\n\};/.exec(text)?.[1];
    const groups = /\nconst GROUPS = \[([^\]]*)\];/.exec(text)?.[1];
    assert.ok(block && groups, `${file} lists each line kind's fields (LINE_FIELDS) and the maps of a path line (GROUPS)`);
    const kinds = block.split('\n').map((l) => /^\s*(\w+): \[(.*)\],$/.exec(l));
    assert.ok(kinds.every(Boolean), `${file}: one line kind a line in LINE_FIELDS`);
    assert.deepEqual(kinds.map((m) => m[1]), ['shapes', 'version', 'kind', 'path', 'rare', 'end'], `${file}: the line kinds, in the format's order`);
    for (const [, k, list] of kinds) {
      const fields = words(list.replace('...GROUPS', groups)).filter((f) => f !== 'k').sort();
      assert.deepEqual(fields, rows(k), `${file}: the fields of k "${k}" are the rows of --help's part on it`);
    }
  }
});

/** Writes each file of `files` ({name: [records]}) as name.jsonl, one JSON line a record, under a new folder `d` of
 *  `dir`; returns that folder. */
function putFiles(dir, d, files) {
  mkdirSync(join(dir, d));
  for (const [f, recs] of Object.entries(files)) writeFileSync(join(dir, d, `${f}.jsonl`), recs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return join(dir, d);
}
/** A vocabulary file of `fields` under `dir`, named `name`; returns its path. */
function putVocabulary(dir, name, fields) {
  const f = join(dir, `${name}.json`);
  writeFileSync(f, JSON.stringify({ format: 'ltms-shapes-vocabulary/0', name, ...fields }));
  return f;
}

// U1 (S374's closure read): --unlisted kept a value only where the walk notes it at a path that lists values, and the
// vocabulary that ships gave .attachment.type, attachment's sub-kind path, no list: every attachment record printed as
// attachment:(unlisted), as many records as user's on a real corpus, and --unlisted named none of their types, so the
// documented way out (--unlisted, then --allow) gave nothing. The values a kind is read from are now kept at the kind path
// and at each sub-kind's path where the walk does not keep them (a path with no list, or one the walk does not reach),
// each value once; the vocabulary that ships lists queued_command there, the one attachment type ltms's own docs name
// (docs/library.md, SearchKind) that Claude Code's program holds; and the README and --help say what an attachment
// record prints, and how to name its types. Every count below is the files' own, counted here.
test("shapes --unlisted: the values met at the kind path and at a sub-kind's path are listed where the walk does not list them (no value list there, or a path it does not reach), each once, with its --allow; the vocabulary that ships lists the attachment type queued_command; the README and --help say what an attachment record prints and how to name its types", () => {
  const dir = tmp();
  try {
    const valuesAt = (r, at) => r.lines.filter((o) => o.k === 'unlisted-value' && o.at === at).map((o) => [o.value, o.n, o.files, o.allow]);
    const kindsOf = (r) => Object.fromEntries(r.lines.filter((o) => o.k === 'kind').map((o) => [o.kind, o.records]));
    const att = (type) => ({ type: 'attachment', attachment: { type } });
    // the finding's case, with the vocabulary that ships: qq_att in 4 records of 3 files, hook_success in 2 of 2, a value
    // with ':' and one that is not a label (allow null), queued_command (listed), none, and a number
    const s = putFiles(dir, 'shipped', {
      a: [att('qq_att'), att('qq_att'), att('hook_success'), { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt' } }, { type: 'attachment' }, att(7)],
      b: [att('qq_att'), att('hook_success')],
      c: [att('qq_att'), att('zz:colon'), att('has space')],
    });
    const u = shapes(['--unlisted', s]);
    assert.equal(u.code, 0, u.err);
    assert.ok(u.lines.every((o) => o.send === false));
    assert.deepEqual(valuesAt(u, '.attachment.type'), [['has space', 1, 1, null], ['hook_success', 2, 2, '.attachment.type=hook_success'], ['qq_att', 4, 3, '.attachment.type=qq_att'], ['zz:colon', 1, 1, null]], 'the attachment types the vocabulary that ships lacks, each with its counts and its --allow');
    const rep = shapes([s]);
    assert.equal(rep.code, 0, rep.err);
    assert.deepEqual(kindsOf(rep), { 'attachment:(none)': '1', 'attachment:(not a string)': '1', 'attachment:(unlisted)': '8-15', 'attachment:queued_command': '1' }, 'the kinds, with the vocabulary that ships');
    assert.deepEqual(kindsOf(shapes(['--allow', '.attachment.type=qq_att', s])), { 'attachment:(none)': '1', 'attachment:(not a string)': '1', 'attachment:(unlisted)': '4-7', 'attachment:qq_att': '4-7', 'attachment:queued_command': '1' }, 'the --allow the list gives prints the kind');
    // other vocabularies, each value counted once: the walk keeps the values at a path that lists values and that it
    // reaches; the reading of the kind keeps them where it does not
    const nolist = putVocabulary(dir, 't-nolist', { paths: ['.type'], kinds: { path: '.type' } });
    const d1 = putFiles(dir, 'nolist', { a: [{ type: 'rq_x' }, { type: 'rq_x' }, { type: 'user' }], b: [{ type: 'rq_x' }], c: [{ type: 'user' }, { type: 5 }, {}] });
    const u1 = shapes(['--unlisted', '--vocabulary', nolist, d1]);
    assert.equal(u1.code, 0, u1.err);
    assert.deepEqual(valuesAt(u1, '.type'), [['rq_x', 3, 2, '.type=rq_x'], ['user', 2, 2, '.type=user']], 'a kind path with no value list');
    const sub = putVocabulary(dir, 't-sub', { paths: ['.type', '.subtype', '.att', '.att.type'], values: { '.type': ['system', 'att'], '.subtype': ['known_sub'] }, kinds: { path: '.type', sub: { system: '.subtype', att: '.att.type' } } });
    const d2 = putFiles(dir, 'sub', {
      a: [{ type: 'system', subtype: 'rq_sub' }, { type: 'att', att: { type: 'rq_att' } }],
      b: [{ type: 'system', subtype: 'rq_sub' }, { type: 'att', att: { type: 'rq_att' } }, { type: 'system', subtype: 'known_sub' }],
      c: [{ type: 'system', subtype: 'rq_sub' }, { type: 'rq_kind' }],
    });
    const u2 = shapes(['--unlisted', '--vocabulary', sub, d2]);
    assert.equal(u2.code, 0, u2.err);
    assert.deepEqual([valuesAt(u2, '.type'), valuesAt(u2, '.subtype'), valuesAt(u2, '.att.type')], [[['rq_kind', 1, 1, '.type=rq_kind']], [['rq_sub', 3, 3, '.subtype=rq_sub']], [['rq_att', 2, 2, '.att.type=rq_att']]], 'a kind path and a sub-kind path with value lists (once each), and a sub-kind path with none');
    assert.ok(shapes(['--vocabulary', sub, '--allow', '.att.type=rq_att', d2]).lines.some((o) => o.k === 'kind' && o.kind === 'att:rq_att'), 'the --allow the list gives prints the kind');
    const unreached = putVocabulary(dir, 't-unreached', { paths: ['.type', '.ev.kind'], values: { '.type': ['ev'], '.ev.kind': ['known'] }, kinds: { path: '.type', sub: { ev: '.ev.kind' } } });
    const d3 = putFiles(dir, 'unreached', { a: [{ type: 'ev', ev: { kind: 'rq_ev' } }, { type: 'ev', ev: { kind: 'known' } }], b: [{ type: 'ev', ev: { kind: 'rq_ev' } }], c: [{ type: 'ev', ev: { kind: 'rq_ev' } }] });
    const u3 = shapes(['--unlisted', '--vocabulary', unreached, d3]);
    assert.equal(u3.code, 0, u3.err);
    assert.deepEqual(valuesAt(u3, '.ev.kind'), [['rq_ev', 3, 3, '.ev.kind=rq_ev']], "a sub-kind's path with a value list that the walk does not reach (.ev is not in paths)");
    // the reports themselves are the recompute's, field for field
    for (const [v, d] of [[nolist, d1], [sub, d2], [unreached, d3]]) assert.deepEqual(shapes(['--vocabulary', v, d]).lines.map(canon), recompute(['--vocabulary', v, ...['a', 'b', 'c'].map((f) => join(d, `${f}.jsonl`))]), `every field equals the recompute (${v})`);
  } finally { rm(dir); }
  // the vocabulary that ships: queued_command, at attachment's sub-kind path; the README's kind row and its paragraph on
  // printing a new name, and --help's kind row, say what an attachment record prints with it and how to name its types
  const v = JSON.parse(readFileSync(DOCS, 'utf8'));
  assert.deepEqual(v.values['.attachment.type'], ['queued_command']);
  const whole = readFileSync(join(root, 'README.md'), 'utf8');
  const readme = whole.slice(whole.indexOf('### `ltms shapes'), whole.indexOf('\n## ', whole.indexOf('### `ltms shapes')));
  const kindRow = readme.split('\n').find((l) => l.startsWith('| `kind` |'));
  assert.ok(kindRow, "the kind row of the README's section on ltms shapes");
  for (const t of ['attachment:(unlisted)', ...v.values['.attachment.type'].map((x) => `attachment:${x}`)]) assert.ok(kindRow.includes('`' + t + '`'), `the README's kind row names ${t}`);
  const at = readme.indexOf('**To print a new name.**');
  const para = readme.slice(at, readme.indexOf('\n\n', at)).replace(/\s+/g, ' ');
  assert.match(para, /`unlisted-value`[^.]*`\.attachment\.type`/, 'To print a new name: --unlisted lists the attachment types');
  assert.match(para, /`--allow \.attachment\.type=/, 'To print a new name: the --allow that prints one');
  const help = spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ');
  assert.match(help, /attachment:\(unlisted\)/, "--help's kind row");
});

/** Writes each file of `files` ({name: [lines]}) under a new folder `d` of `dir`, its lines joined, each ended by a new
 *  line; returns that folder. */
function putLines(dir, d, files) {
  mkdirSync(join(dir, d));
  for (const [f, lines] of Object.entries(files)) writeFileSync(join(dir, d, f), lines.join('\n') + '\n');
  return join(dir, d);
}
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

// S5 (S374's closure read): past the 2048 values kept at a value path, --unlisted dropped every other one without a line
// or a count: 2048 and 2049 distinct values gave the same bytes, and a value met 10,000 times after the first 2048 was on
// no line, where the names past the 2048 kept at a .* path are counted on an unlisted-more line. Values past the cap are
// now counted as names are: an unlisted-more line at the value path, its n the occurrences not listed.
test('shapes --unlisted: past the 2048 values kept at a path, the occurrences of the others are counted on an unlisted-more line at that path, as the names past the 2048 kept at a .* path are; at 2048 distinct values there is none, at 2049 one of n 1', () => {
  const dir = tmp();
  try {
    const v = (i) => `zv${String(i).padStart(4, '0')}`;
    const rec = (type) => JSON.stringify({ type });
    // 2048 values once each in a.jsonl; in b.jsonl, 52 more once each and one more 10 times: 62 occurrences past the cap
    const over = putLines(dir, 'over', { 'a.jsonl': range(0, 2048).map((i) => rec(v(i))), 'b.jsonl': [...range(2048, 2100).map((i) => rec(v(i))), ...Array(10).fill(rec('zzmany'))] });
    const u = shapes(['--unlisted', over]);
    assert.equal(u.code, 0, u.err);
    const at = u.lines.filter((o) => o.at === '.type');
    assert.deepEqual(at.filter((o) => o.k === 'unlisted-value').map((o) => o.value), range(0, 2048).map(v), 'the first 2048 values met are listed');
    assert.deepEqual(at.filter((o) => o.k === 'unlisted-more'), [{ k: 'unlisted-more', send: false, at: '.type', n: 62 }], 'the occurrences past them, counted at the value path');
    assert.deepEqual(u.lines.at(-1), { k: 'unlisted-more', send: false, at: '.type', n: 62 }, "after the path's values");
    // the boundary: 2048 distinct values are all listed, with no more-line; 2049 give one occurrence past the cap
    const exact = shapes(['--unlisted', putLines(dir, 'exact', { 'a.jsonl': range(0, 2048).map((i) => rec(v(i))) })]);
    const one = shapes(['--unlisted', putLines(dir, 'one', { 'a.jsonl': range(0, 2049).map((i) => rec(v(i))) })]);
    assert.deepEqual(exact.lines.filter((o) => o.k === 'unlisted-more'), [], '2048 values');
    assert.deepEqual(one.lines.filter((o) => o.k === 'unlisted-more'), [{ k: 'unlisted-more', send: false, at: '.type', n: 1 }], '2049 values');
  } finally { rm(dir); }
  // --help and the README say what an unlisted-more line counts: names or values
  const help = spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ');
  assert.match(help, /unlisted-more \(the occurrences past the first 2048 names or values at a path\)/);
  assert.match(readFileSync(join(root, 'README.md'), 'utf8').replace(/\s+/g, ' '), /`unlisted-more` \(the occurrences past the first 2048 names or values at a path/);
});

/** The totals --unlisted's closing line states: [names, their .* paths, values, their paths], then, past the cap, [the
 *  occurrences of names, their paths, of values, their paths] (null when it says every one met was listed); null when
 *  the line does not state them so. */
function closingTotals(err) {
  const m = /^ltms shapes --unlisted: \d+ files read \(\d+ failed\), \d+ records; listed: (\d+) names? \(at (\d+) \.\* paths?\) and (\d+) values? \(at (\d+) paths?\) the vocabulary does not hold, as the transcripts write them(?:, every one met|; past the first 2048 at a path, (\d+) occurrences? of names \(at (\d+) paths?\) and (\d+) of values \(at (\d+) paths?\) are counted on unlisted-more lines, not listed); /m.exec(err);
  if (!m) return null;
  return [m.slice(1, 5).map(Number), m[5] === undefined ? null : m.slice(5, 9).map(Number)];
}
/** The same totals, counted from the list itself. */
function listTotals(lines) {
  const paths = (ls) => new Set(ls.map((o) => o.at)).size, sum = (ls) => ls.reduce((a, o) => a + o.n, 0);
  const names = lines.filter((o) => o.k === 'unlisted'), values = lines.filter((o) => o.k === 'unlisted-value');
  const more = lines.filter((o) => o.k === 'unlisted-more'), moreNames = more.filter((o) => o.at.endsWith('.*')), moreValues = more.filter((o) => !o.at.endsWith('.*'));
  return [[names.length, paths(names), values.length, paths(values)], more.length ? [sum(moreNames), moreNames.length, sum(moreValues), moreValues.length] : null];
}

// U8 (S374's closure read), and S5's closing line: --unlisted's closing line said "N names and values the vocabulary
// does not hold", N the list's lines after the first: names, values and the unlisted-more lines added up, right only
// under the cap (3,100 names at a path gave 2049). It now gives names and values apart, each with its paths, and the
// occurrences past the 2048 kept at a path apart, for names and for values: what the run holds (it keeps no name past
// the cap, so it cannot say how many names those occurrences are).
test("shapes --unlisted: the closing line states the names and the values listed, apart, and the occurrences past the 2048 kept at a path, for names and for values, as the list's own lines count them", () => {
  const dir = tmp();
  try {
    const k = (i) => `zk${String(i).padStart(4, '0')}`, v = (i) => `zv${String(i).padStart(4, '0')}`;
    // 3,100 names once each at .*; 2,100 values once each at .type; one name twice at .message.*
    const d = putLines(dir, 'over', {
      'a.jsonl': range(0, 3100).map((i) => JSON.stringify({ type: 'user', [k(i)]: 1 })),
      'b.jsonl': range(0, 2100).map((i) => JSON.stringify({ type: v(i) })),
      'c.jsonl': [1, 2].map(() => JSON.stringify({ type: 'user', message: { role: 'user', content: 'x', zq_extra: 1 } })),
    });
    const u = shapes(['--unlisted', d]);
    assert.equal(u.code, 0, u.err);
    const truth = [[2048 + 1, 2, 2048, 1], [3100 - 2048, 1, 2100 - 2048, 1]];
    assert.deepEqual(listTotals(u.lines), truth, 'the list, against the files');
    assert.deepEqual(closingTotals(u.err), truth, `the closing line states them: ${u.err}`);
    // under the cap: every one met is listed, and the line says so
    const c = shapes(['--unlisted', ...CC]);
    assert.equal(c.code, 0, c.err);
    const [listed, more] = listTotals(c.lines);
    assert.equal(more, null);
    assert.ok(listed[0] > 0 && listed[2] > 0, `${listed}`);
    assert.deepEqual(closingTotals(c.err), [listed, null], `the closing line states them: ${c.err}`);
  } finally { rm(dir); }
});

// U9 (S374's closure read): a reader that stopped before the end (EPIPE) gave exit 0, and the closing line, printed as
// soon as the report was handed to stdout, said "the report: 216 lines" when none had reached a reader; on a full disk
// (ENOSPC) the closing line claimed every line, and the next line said the output was incomplete. A write to stdout that
// fails is now a failure: exit 1, one line saying the output was cut and how many of its lines were written, and no
// closing line, which is printed only once every line was written. The reader that stops is made here without a race:
// a FIFO whose read end is closed before ltms starts, or one this test reads from and closes after a known count of bytes.
const NO_FIFOS_HERE = process.platform === 'win32' && 'no FIFOs on win32';
test('shapes: a write to stdout that fails (a reader that stopped before the end, a full disk) gives exit 1 and a line saying the output was cut and how many of its lines were written, and no closing line; the closing line is printed once every line is written', { skip: NO_FIFOS_HERE }, async () => {
  const dir = tmp();
  try {
    let fifos = 0;
    const fifo = () => { const f = join(dir, `out-${fifos++}.fifo`); assert.equal(spawnSync('mkfifo', [f]).status, 0); return f; };
    /** The write end of a FIFO whose read end is closed: the first write to it fails with EPIPE. */
    const closedReader = () => { const f = fifo(); const r = openSync(f, constants.O_RDONLY | constants.O_NONBLOCK), w = openSync(f, constants.O_WRONLY); closeSync(r); return w; };
    /** ltms shapes with stdout on `fd` (closed here once it has started). */
    const run = (args, fd) => {
      try {
        const r = spawnSync(process.execPath, [CLI, 'shapes', ...args], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 120000, cwd: root });
        if (r.error) throw r.error;
        return { code: r.status, err: r.stderr };
      } finally { closeSync(fd); }
    };
    const lines = shapes([...CC]).lines.length;
    const reportHead = 'ltms shapes: 4 files read \\(0 failed\\), 49 records; ';
    // the reader is gone before ltms starts
    const a = run([...CC], closedReader());
    assert.equal(a.code, 1, a.err);
    assert.match(a.err, new RegExp(`^${reportHead}the report was cut: writing it to stdout failed \\(EPIPE: the reader stopped before the end\\) after 0 of its ${lines} lines were written`, 'm'), a.err);
    assert.doesNotMatch(a.err, /the report: \d+ lines/, `no closing line claims what was not written: ${a.err}`);
    assert.equal(a.err.split('\n').filter(Boolean).length, 1, `one line for one failure: ${a.err}`);
    // a full disk
    if (existsSync('/dev/full')) {
      const f = run([...CC], openSync('/dev/full', 'w'));
      assert.equal(f.code, 1, f.err);
      assert.match(f.err, new RegExp(`^${reportHead}the report was cut: writing it to stdout failed \\(ENOSPC: the disk is full\\) after 0 of its ${lines} lines were written`, 'm'), f.err);
      assert.equal(f.err.split('\n').filter(Boolean).length, 1, `one line for one failure: ${f.err}`);
    }
    // a regular file: the closing line, printed after the write, says what the file holds
    const file = join(dir, 'r.txt');
    const ok = run([...CC], openSync(file, 'w'));
    assert.equal(ok.code, 0, ok.err);
    const held = readFileSync(file, 'utf8');
    assert.equal(held.split('\n').length - 1, lines);
    assert.match(ok.err, new RegExp(`^${reportHead}the report: ${lines} lines, ${Buffer.byteLength(held)} bytes;`, 'm'), ok.err);
    // the --unlisted list, its reader gone
    const u = run(['--unlisted', ...CC], closedReader());
    assert.equal(u.code, 1, u.err);
    assert.match(u.err, /^ltms shapes --unlisted: 4 files read \(0 failed\), 49 records; the list was cut: writing it to stdout failed \(EPIPE: the reader stopped before the end\) after 0 of its \d+ lines were written/m, u.err);
    assert.doesNotMatch(u.err, /listed: \d+ names?/, `no closing line: ${u.err}`);
    // a reader that takes the list's first 1000 lines (its first write) and stops: 1000 were written. Its second 1000
    // lines are more than a pipe holds, so their write waits until the reader is gone, and fails
    const long = putLines(dir, 'long', { 'a.jsonl': range(0, 2048).map((i) => JSON.stringify({ type: 'user', [`zk${String(i).padStart(4, '0')}${'x'.repeat(200)}`]: 1 })) });
    const whole = join(dir, 'u.txt');
    const all = run(['--unlisted', long], openSync(whole, 'w'));
    assert.equal(all.code, 0, all.err);
    const rows = readFileSync(whole, 'utf8').split('\n').slice(0, -1);
    assert.equal(rows.length, 2049);
    const first = Buffer.byteLength(rows.slice(0, 1000).join('\n') + '\n');
    assert.ok(Buffer.byteLength(rows.slice(1000, 2000).join('\n') + '\n') > 4 * 65536, 'the second write is more than a pipe holds (64 KiB by default; 1 MiB at most, unless raised)');
    const f = fifo();
    const r = openSync(f, constants.O_RDONLY | constants.O_NONBLOCK), w = openSync(f, constants.O_WRONLY);
    const child = spawn(process.execPath, [CLI, 'shapes', '--unlisted', long], { stdio: ['ignore', w, 'pipe'], cwd: root });
    closeSync(w);
    let errText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { errText += d; });
    const closed = new Promise((resolve) => child.on('close', resolve));
    const buf = Buffer.alloc(65536), pause = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 60000;
    let got = 0;
    while (got < first && Date.now() < deadline) {
      let n;
      try { n = readSync(r, buf, 0, Math.min(buf.length, first - got), null); }
      catch (e) { if (e.code !== 'EAGAIN') throw e; Atomics.wait(pause, 0, 0, 5); continue; }
      if (n === 0) break;
      got += n;
    }
    closeSync(r);
    const code = await closed;
    assert.equal(got, first, 'the reader took the first 1000 lines');
    assert.equal(code, 1, errText);
    assert.match(errText, /the list was cut: writing it to stdout failed \(EPIPE: the reader stopped before the end\) after 1000 of its 2049 lines were written/, errText);
  } finally { rm(dir); }
  // the README and --help say that a failed write exits 1
  const flat = (s) => s.replace(/\s+/g, ' ');
  assert.match(flat(readFileSync(join(root, 'README.md'), 'utf8')), /when the write to stdout failed: a reader that stopped before the end/);
  assert.match(flat(spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout), /when the write to stdout failed \(a reader that stopped before the end/);
});

// U5 (S374's closure read): a report saved inside the folder it reads (the README's example, run from that folder) was
// read back as a transcript by the next run: its lines counted as records, a kind and a version (none) added, files
// read 5 for 3, and neither run said so; an --unlisted list the same, its field names listed as names. A file whose first
// line is a report's or an --unlisted list's is now skipped: not read, counted and named in a warning. The README's and
// --help's example save the report under a name that does not end in .jsonl, and say to keep it outside the folder read.
test("shapes: a file whose first line is a report's or an --unlisted list's is not read as a transcript: it is skipped, counted and named in a warning; the README's and --help's example save the report under a name that is not .jsonl, outside the folder read", () => {
  const dir = tmp();
  try {
    const p = join(dir, 'p');
    mkdirSync(p);
    for (const f of ['cc-a.jsonl', 'cc-b.jsonl', 'cc-c.jsonl']) copyFileSync(FX(f), join(p, f));
    const alone = shapes([p]), list = shapes(['--unlisted', p]);
    assert.equal(alone.code, 0, alone.err);
    assert.equal(list.code, 0, list.err);
    // the report and the list saved inside the folder they read, as .jsonl
    writeFileSync(join(p, 'shapes.jsonl'), alone.out);
    writeFileSync(join(p, 'list.jsonl'), list.out);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const warning = new RegExp(`^ltms shapes: warning: 2 files under the paths given are reports of ltms shapes or --unlisted lists, not transcripts, so they were not read: '${esc(join(p, 'list.jsonl'))}' and '${esc(join(p, 'shapes.jsonl'))}'\\. Save a report outside the folder you read, under a name that does not end in \\.jsonl\\.$`, 'm');
    const r = shapes([p]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, alone.out, 'the report of the transcripts alone, byte for byte');
    assert.match(r.err, warning, r.err);
    assert.match(r.err, /^ltms shapes: 3 files read \(0 failed\), /m);
    const u = shapes(['--unlisted', p]);
    assert.equal(u.out, list.out, 'the list of the transcripts alone');
    assert.match(u.err, warning, u.err);
    // named on the command line, too
    const named = shapes([join(p, 'shapes.jsonl'), join(p, 'cc-a.jsonl')]);
    assert.equal(named.out, shapes([join(p, 'cc-a.jsonl')]).out);
    assert.match(named.err, new RegExp(`^ltms shapes: warning: 1 file under the paths given is a report of ltms shapes or an --unlisted list, not a transcript, so it was not read: '${esc(join(p, 'shapes.jsonl'))}'\\.`, 'm'));
  } finally { rm(dir); }
  // the example: the report is saved under a name that does not end in .jsonl, and the section says to keep it outside
  // the folder read; --help's example and the usage messages the same
  const whole = readFileSync(join(root, 'README.md'), 'utf8');
  const section = whole.slice(whole.indexOf('### `ltms shapes'), whole.indexOf('\n## ', whole.indexOf('### `ltms shapes')));
  const sh = /```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  assert.match(sh, /^ltms shapes \S+ > (\S+)$/m, 'the example saves the report');
  assert.doesNotMatch(sh, /\.jsonl\b/, `the example names no .jsonl: ${sh}`);
  assert.match(section.replace(/\s+/g, ' '), /save the report outside the folder you read/i);
  const help = spawnSync(process.execPath, [CLI, 'shapes', '--help'], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(help, /> \S*\.jsonl|<report\.jsonl>/, '--help names no .jsonl for a report');
  for (const args of [[], ['-', ...CC]]) assert.doesNotMatch(shapes(args).err, /> \S*\.jsonl/, `the usage message of ltms shapes ${args.join(' ')}`);
});
