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
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate } from './shapes-validate.mjs';

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
/** The fixtures' own schema, which the prototype's curated vocabulary named and the shipped one does not. */
const ALLOW = ['.message.type', '.attachment.type=hook_success', '.attachment.hookName', '.attachment.content', '.snapshot.trackedFileBackups',
  '.snapshot.messageId', '.snapshot.timestamp', '.messageId', '.isSnapshotUpdate', '.durationMs'].flatMap((a) => ['--allow', a]);
const tmp = () => mkdtempSync(join(tmpdir(), 'ltms-shapes-'));
const rm = (d) => rmSync(d, { recursive: true, force: true });

let validated = 0;
/** ltms shapes, spawned (from the repository's root). Every report it prints is read by the independent validator, with
 *  the vocabulary it was made with: a report outside the language fails the test that made it. */
function shapes(args, opts = {}) {
  const r = spawnSync(process.execPath, [...(opts.node ?? []), CLI, 'shapes', ...args], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 120000, cwd: opts.cwd ?? root });
  if (r.error) throw r.error;
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (lines[0]?.k === 'shapes') {
    const i = args.indexOf('--vocabulary');
    assert.deepEqual(validate(lines, [i >= 0 ? args[i + 1] : DOCS]), [], `the independent validator, on the report of ltms shapes ${args.join(' ')}`);
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

test('shapes: the write guard refuses each line that holds a token outside the language, whatever built it, and writes nothing of it; the command prints what writeReport writes', () => {
  const V = SH.loadVocabulary(DOCS), allowed = SH.applyAllow(V, []);
  const R = SH.buildReport(V, SH.readShapes(V, [...CC].sort(), { maxLine: SH.SHAPES_MAX_LINE, unlisted: false }), 3, allowed);
  const Lg = SH.shapesLanguage(V, allowed, { floor: 3, lines: R.lines.length });
  let text = '';
  const all = SH.writeReport(R.lines, Lg, (s) => { text += s; });
  assert.deepEqual([all.refused, all.written], [0, R.lines.length]);
  assert.equal(text, shapes([...CC]).out, 'the command prints what writeReport writes');
  const head = R.lines[0];
  // one line per channel a defect upstream could leak through
  const planted = [
    ['a raw name in a path', { k: 'path', kind: 'user', path: '.zqPrivateParam', n: '1', files: '4-7' }],
    ['a raw name below a .* step', { k: 'path', kind: 'user', path: '.toolUseResult.zqPrivateParam', n: '1', files: '4-7' }],
    ['a raw kind', { k: 'kind', kind: 'zqcanarytype3', records: '1', files: '1', versions: {} }],
    ['a raw sub-kind', { k: 'kind', kind: 'system:zq_sub3', records: '1', files: '1', versions: {} }],
    ['a raw value', { k: 'path', kind: '(unlisted)', path: '.type', n: '1', files: '4-7', values: { zqcanarytype3: '1' } }],
    ['a raw name as the key of a count', { k: 'path', kind: 'user', path: '.toolUseResult.*', n: '1', files: '4-7', types: { zqPrivateParam: '1' } }],
    ['a class that is not one', { k: 'path', kind: 'user', path: '.type', n: '1', files: '4-7', strings: { zq7canary: '1' } }],
    ['an exact count', { k: 'path', kind: 'user', path: '.type', n: '5', files: '4-7' }],
    ['a number where a count is a string', { k: 'path', kind: 'user', path: '.type', n: 31337, files: '4-7' }],
    ['a count in an array', { k: 'path', kind: 'user', path: '.type', n: ['2-3'], files: '4-7' }],
    ['a count with more digits than a bucket has', { k: 'path', kind: 'user', path: '.type', n: '9007199254740993-18014398509481983', files: '4-7' }],
    ['a suffixed version', { k: 'version', v: '9.9.9-zqcanary', records: '1', files: '1' }],
    ['a version with a five-digit part', { k: 'version', v: '31337.1.1', records: '1', files: '1' }],
    ['a word as a version', { k: 'path', kind: 'user', path: '.type', n: '1', files: '1', first: 'zq-not-a-version' }],
    ['a version of a kind that is not one', { k: 'kind', kind: 'user', records: '1', files: '1', versions: { 'zq-not-a-version': '1' } }],
    ['an extra field', { k: 'path', kind: 'user', path: '.type', n: '1', files: '4-7', x: 'zq7canary' }],
    ['a timing field', { k: 'end', lines: R.lines.length, ms: 4242 }],
    ['names on a line that is not .*', { k: 'path', kind: 'user', path: '.type', n: '1', files: '4-7', names: '64+' }],
    ['values at a path that is not a value path', { k: 'path', kind: 'user', path: '.uuid', n: '1', files: '4-7', values: { user: '1' } }],
    ['a line kind that is not one', { k: 'zq7canary' }],
    ['a line that is not an object', 'zq7canary'],
    ['a first line with an allowed entry it was not given', { ...head, allowed: ['.zq7canary'] }],
    ['a first line with another floor', { ...head, floor: 31337 }],
    ['a first line with another vocabulary', { ...head, vocabulary: [{ ...head.vocabulary[0], name: 'zq7canary' }] }],
    ['an end line with another count', { k: 'end', lines: 31337 }],
    ['a rare line of a raw kind', { k: 'rare', kind: 'zqcanarytype', paths: '1', n: '1' }],
  ];
  for (const [what, line] of planted) {
    let wrote = '';
    const w = SH.writeReport([line], Lg, (s) => { wrote += s; });
    assert.deepEqual([w.refused, w.written, wrote], [1, 0, ''], what);
    assert.match(w.reasons[0].why, /^[a-z .]+$/, `${what}: the reason is one of the guard's own words: ${w.reasons[0].why}`);
  }
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
  // the command's section: one writeReport call writes the report; out() writes its help and the review list, nothing else
  const cli = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');
  const section = cli.slice(cli.indexOf('// ---- ltms shapes'), cli.indexOf('\n// ---- ltms records'));   // 0.3.0: records' section follows
  assert.ok(section.length > 1000, 'the shapes section of src/cli.ts');
  assert.equal(section.match(/\bwriteReport\(/g)?.length, 1, 'one writeReport call');
  assert.deepEqual([...section.matchAll(/\bout\(([A-Za-z_]+)/g)].map((m) => m[1]).sort(), ['SHAPES_HELP', 'review'], "shapes' out() calls: its help, and the review list");
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
    [['--floor', '1', ...CC], /--floor takes a whole number of files, 2 or more \(the default is 3\); '1' is not one/],
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
    assert.match(ok.err, /: \d+ lines, every token in the report's language \(vocabulary claude-code-docs@[0-9a-f]{12}; allowed: \.zqa \.zqb\)\.\n$/);
    const other = f('good2.jsonl', ls, ['--vocabulary', CODEX_V]);
    assert.equal(other.code, 1);
    assert.match(other.err, /line 1: the first line names another vocabulary than the one given, codex-sketch@[0-9a-f]{12}/);
    const head = (fn) => [fn(ls[0]), ...ls.slice(1)];
    assert.equal(f('order.jsonl', head((l) => l.replace('"allowed":[".zqa",".zqb"]', '"allowed":[".zqb",".zqa"]'))).code, 1, 'out of order');
    assert.equal(f('twice.jsonl', head((l) => l.replace('"allowed":[".zqa",".zqb"]', '"allowed":[".zqa",".zqa",".zqb"]'))).code, 1, 'repeated');
    const bad = f('bad-allow.jsonl', head((l) => l.replace('"allowed":[".zqa",".zqb"]', '"allowed":["zq7canary words"]')));
    assert.equal(bad.code, 1);
    assert.match(bad.err, /its first line's allowed list holds an entry that is not an --allow argument/);
    const kinds = [...ls.slice(0, -1), '{"k":"zq7canary"}', JSON.stringify({ k: 'end', lines: ls.length + 1 })];
    const k = f('kind.jsonl', kinds);
    assert.equal(k.code, 1);
    assert.match(k.err, new RegExp(`line ${ls.length}: its unknown line kind is not in the report's language`));
    for (const r of [other, bad, k]) assert.ok(!r.err.includes('zq7canary'), r.err);
    const not = f('not.jsonl', ['not json zq7canary']);
    assert.equal(not.code, 1);
    assert.match(not.err, /its first line is not a report's/);
    assert.ok(!not.err.includes('zq7canary'));
    assert.equal(shapes(['--check', join(dir, 'no-such-report.jsonl')]).code, 1);
  } finally { rm(dir); }
});

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
  const words = ['shapes', 'version', 'kind', 'path', 'rare', 'end', 'format', 'vocabulary', 'name', 'sha256', 'paths', 'values', 'floor', 'allowed', 'files', 'read', 'failed',
    'lines', 'records', 'blank', 'notJson', 'notObject', 'tooLong', 'v', 'versions', 'n', 'first', 'last', 'types', 'strings', 'numbers', 'booleans', 'lengths', 'names',
    'array', 'boolean', 'null', 'number', 'object', 'string', 'empty', 'uuid', 'iso8601-utc', 'iso8601-offset', 'iso8601-local', 'date', 'digits', 'hex', 'label', 'text',
    'int', 'float', 'epoch-s', 'epoch-ms', 'true', 'false', '(rare)', '(unlisted)', '(none)', '(withheld)', '(not a string)', '(all)', '64+', '*',
    'unlisted-review', 'unlisted', 'unlisted-more', 'unlisted-value', 'send', 'note', 'at', 'allow'];
  assert.deepEqual(words.filter((w) => !section.includes('`' + w + '`')), [], "words of the language the README's section on ltms shapes does not name as code");
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
// A/x.jsonl a second time, so the two orders of the same two paths read the same files in another order.
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
