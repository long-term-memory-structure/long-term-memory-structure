// Tests for the package as npm ships it (build first): this tree is packed with npm pack, the tarball is installed
// offline into a fresh project, and there every import path that 0.0.5 resolved must resolve to the same file, by
// import and by require; the parser's paths load; dist/cli.js is resolved, never loaded (loading it runs the command);
// the bin runs; and strict TypeScript consumers compile against the installed declarations, under each module
// resolution. Also: every file "exports" and "typesVersions" name is packed, and package.json's files and scripts.test.
//
// LTMS_PACKAGE_TARBALL=<file.tgz> tests that tarball instead of packing this tree: the known-answer run on 0.0.5's own
// tarball, or a run in another Node (docker). Every test that needs npm is skipped, saying why, when npm is not on PATH.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const NAME = 'long-term-memory-structure';
const WIN = process.platform === 'win32';
const DEMO = join(here, 'fixtures', 'demo.jsonl');

/** An option in scripts.test that filters tests out. With one there, `npm test` passes having run none of them, the test
 *  below that rejects it included (measured: --test-name-pattern matching no test gave tests 7, pass 7, fail 0, exit 0).
 *  So it is also checked when this file is loaded, before any test is chosen: the file then fails, and npm test with it. */
const FILTERS = /^--test-(?:name-pattern|skip-pattern|only|shard)(?:=|$)/;
{
  const filters = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.test ?? '').split(/\s+/).filter((w) => FILTERS.test(w));
  if (filters.length) throw new Error(`package.json's scripts.test holds ${filters.join(' ')}, which filters tests out: npm test would pass having run none. Remove it from scripts.test.`);
}

/** The parser's runtime exports in 0.0.5 (src/parser.ts: 12 functions and NOT_A_STRING), listed by hand, sorted. */
const PARSER_EXPORTS = ['NOT_A_STRING', 'blocksOf', 'hasEnvelope', 'inputChannel', 'isInputTurn', 'isToolResultRecord', 'livePath',
  'parseLines', 'parseTranscript', 'pathTo', 'repairedLivePath', 'replayMask', 'turnsOf'];
/** Every path 0.0.5 resolved, and the file in the package each one must name. 0.0.5 had no "exports", so every file
 *  resolved, and require also found a path without its extension (.js, then .json). The bare name is new: 0.0.5 had no
 *  main and no index.js, so it resolved nowhere. */
const RESOLVES = [
  ['', 'dist/index.js'],
  ['dist/parser.js', 'dist/parser.js'], ['dist/parser', 'dist/parser.js'],
  ['dist/cli.js', 'dist/cli.js'], ['dist/cli', 'dist/cli.js'],
  ['package.json', 'package.json'], ['package', 'package.json'],
  ['README.md', 'README.md'], ['CHANGELOG.md', 'CHANGELOG.md'], ['LICENSE', 'LICENSE'],
];
/** The paths that are loaded, by import() and by require(). dist/cli.js is never loaded: it runs the command. */
const LOADS = ['', 'dist/parser.js', 'dist/parser'];
const spec = (sub) => (sub ? `${NAME}/${sub}` : NAME);

/** npm's environment without the npm_* variables that `npm test` sets for its script, so that the npm run here reads
 *  only its own command line; the cache is the test's own directory, so nothing is written outside it. */
function npmEnv(work) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
  return { ...env, npm_config_cache: join(work, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
}
const npm = (args, opts) => spawnSync(WIN ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: WIN, timeout: 120000, ...opts });
const probeNpm = npm(['--version'], { env: npmEnv(tmpdir()) });
const noNpm = probeNpm.error || probeNpm.status !== 0
  ? `npm is not on PATH (${probeNpm.error ? probeNpm.error.code : `npm --version exited ${probeNpm.status}`}): these tests pack and install the package with it`
  : false;
const failed = (what, r) => `${what} exited ${r.status ?? r.error?.code}.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

/** The probe, run in the consumer project: one JSON object, the result of every resolve and every load. */
const PROBE = `import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const [resolves, loads, parserFile, parserUrl] = JSON.parse(process.argv[2]);
const error = (e) => ({ error: String(e?.code ?? e?.name ?? e) });
const located = (file) => ({ file, exists: existsSync(file) });
const out = { node: process.versions.node, requireModule: process.features.require_module === true, resolve: [], load: [] };
for (const s of resolves) {
  let esm, cjs;
  try { const u = import.meta.resolve(s); esm = u.startsWith('file:') ? located(fileURLToPath(u)) : { url: u }; } catch (e) { esm = error(e); }
  try { cjs = located(require.resolve(s)); } catch (e) { cjs = error(e); }
  out.resolve.push({ spec: s, esm, cjs });
}
// dist/parser.js loaded by its file, the reference the loads below are compared with
const reference = { esm: await import(parserUrl).catch(() => null), cjs: (() => { try { return require(parserFile); } catch { return null; } })() };
for (const s of loads) {
  const row = { spec: s };
  for (const [how, load] of [['esm', (x) => import(x)], ['cjs', async (x) => require(x)]]) {
    try {
      const m = await load(s), ref = reference[how];
      row[how] = { names: Object.keys(m).sort(), same: ref !== null && Object.keys(ref).every((k) => m[k] === ref[k]) };
    } catch (e) { row[how] = error(e); }
  }
  out.load.push(row);
}
process.stdout.write(JSON.stringify(out) + '\\n');
`;

let setup, work;
/** Packs this tree (or takes LTMS_PACKAGE_TARBALL), installs it offline into a fresh project, and runs the probe there;
 *  once, for every test below. */
function install() {
  setup ??= (() => { try { return { ok: installOnce() }; } catch (error) { return { error }; } })();
  if (setup.error) throw setup.error;
  return setup.ok;
}
function installOnce() {
  work = mkdtempSync(join(tmpdir(), 'ltms-package-'));
  const env = npmEnv(work);
  let tarball = process.env.LTMS_PACKAGE_TARBALL;
  if (!tarball) {
    const p = npm(['pack', '--ignore-scripts', '--pack-destination', work], { cwd: root, env });
    assert.equal(p.status, 0, failed(`npm pack in ${root}`, p));
    const made = readdirSync(work).filter((f) => f.endsWith('.tgz'));
    assert.equal(made.length, 1, `npm pack wrote ${made.length} tarballs in ${work}: ${made.join(', ')}`);
    tarball = join(work, made[0]);
  }
  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'ltms-consumer', version: '0.0.0', private: true }) + '\n');
  const i = npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer, tarball], { cwd: consumer, env });
  assert.equal(i.status, 0, failed(`npm install --offline ${tarball}`, i));
  const pkgDir = join(consumer, 'node_modules', NAME);
  const parserFile = join(pkgDir, 'dist', 'parser.js');
  writeFileSync(join(consumer, 'probe.mjs'), PROBE);
  const arg = JSON.stringify([RESOLVES.map(([s]) => spec(s)), LOADS.map(spec), parserFile, pathToFileURL(parserFile).href]);
  const r = spawnSync(process.execPath, [join(consumer, 'probe.mjs'), arg], { cwd: consumer, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, failed('the probe', r));
  return { tarball, consumer, pkgDir, probe: JSON.parse(r.stdout), probeErr: r.stderr };
}
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

/** A file the probe found, as a '/'-separated path inside the installed package, or what went wrong. */
function seen(res, pkgDir) {
  if (res.error) return `error ${res.error}`;
  if (!res.file) return `not a file: ${res.url}`;
  const rel = relative(pkgDir, res.file).split(sep).join('/');
  return res.exists ? rel : `${rel}, which does not exist`;
}

test('the package: every path 0.0.5 resolved names the same file in the packed tarball, by import and by require', { skip: noNpm }, () => {
  const { probe, pkgDir, tarball } = install();
  const wrong = [];
  for (const [sub, want] of RESOLVES) {
    const row = probe.resolve.find((x) => x.spec === spec(sub));
    for (const how of ['esm', 'cjs']) {
      const got = seen(row[how], pkgDir);
      if (got !== want) wrong.push(`${how === 'esm' ? 'import.meta.resolve' : 'require.resolve'}('${spec(sub)}'): ${got}, not ${want}`);
    }
  }
  assert.deepEqual(wrong, [], `in node ${probe.node}, against ${tarball}`);
});

test('the package: the bare name, dist/parser.js and dist/parser load by import and by require, with the parser\'s exports', { skip: noNpm }, () => {
  const { probe, tarball, probeErr } = install();
  const wrong = [];
  for (const row of probe.load) {
    for (const how of ['esm', 'cjs']) {
      const r = row[how], call = `${how === 'esm' ? 'import' : 'require'}('${row.spec}')`;
      if (how === 'cjs' && !probe.requireModule) {
        // require() of an ES module needs node 20.19 or newer (process.features.require_module); docs/library.md says so
        if (r.error !== 'ERR_REQUIRE_ESM') wrong.push(`${call} in node ${probe.node}, which cannot require an ES module: ${JSON.stringify(r)}, not ERR_REQUIRE_ESM`);
        continue;
      }
      if (r.error) { wrong.push(`${call}: error ${r.error}`); continue; }
      const missing = PARSER_EXPORTS.filter((n) => !r.names.includes(n));
      if (missing.length) wrong.push(`${call} lacks ${missing.join(', ')}`);
      // the parser's own paths export the parser and nothing else; the bare name may export more (search's functions)
      if (row.spec !== NAME && r.names.join() !== PARSER_EXPORTS.join()) wrong.push(`${call} exports ${r.names.join(', ')}`);
      if (!r.same) wrong.push(`${call}: its exports are not the very functions of dist/parser.js`);
    }
  }
  assert.deepEqual(wrong, [], `in node ${probe.node}, against ${tarball}; the probe's stderr: ${probeErr}`);
});

test('the package: main and types name the files of the "." entry, and both are in the packed tarball', { skip: noNpm }, () => {
  const { pkgDir, tarball } = install();
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const dot = pkg.exports?.['.'];
  // two fields that state one fact can disagree: a resolver that reads main or types, and not exports, gets another file
  assert.deepEqual({ main: pkg.main, types: pkg.types }, { main: dot?.default, types: dot?.types }, `in ${tarball}: main and types against exports["."]`);
  assert.deepEqual([pkg.main, pkg.types].filter((f) => typeof f !== 'string' || !existsSync(join(pkgDir, f))), [], `in ${tarball}: main or types names no file of the package`);
});

test('the package: the installed bin runs: ltms and long-term-memory-structure --version, and ltms skeleton on a fixture', { skip: noNpm }, () => {
  const { consumer, pkgDir } = install();
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  // the bin's #!/usr/bin/env node finds the node that runs this test first
  const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH };
  const bin = (name, args) => spawnSync(join(consumer, 'node_modules', '.bin', WIN ? `${name}.cmd` : name), args, { encoding: 'utf8', env, shell: WIN, timeout: 20000 });
  for (const name of ['ltms', NAME]) {
    const v = bin(name, ['--version']);
    assert.deepEqual([v.status, v.stdout, v.stderr], [0, `${version}\n`, ''], `${name} --version`);
  }
  const s = bin('ltms', ['skeleton', DEMO]);
  assert.deepEqual([s.status, s.stderr], [0, ''], `ltms skeleton ${DEMO}`);
  // known answers: the README's example lines for this fixture (the contract), each printed by the installed copy
  // (search's three line shapes are checked against search's own output in test/search.test.mjs)
  const examples = readFileSync(join(root, 'README.md'), 'utf8').split('\n').filter((l) => l.startsWith('{"k":') && !/^\{"k":"(?:coverage","query"|file"|hit")/.test(l));
  assert.ok(examples.length >= 6, `only ${examples.length} example lines were read from the README`);
  // 0.2.0: index's example, run by the installed copy as the README shows it, its coverage line's time made the README's
  const ix = spawnSync(join(consumer, 'node_modules', '.bin', WIN ? 'ltms.cmd' : 'ltms'), ['index', 'test/fixtures/compacted.jsonl', 'test/fixtures/demo.jsonl'], { encoding: 'utf8', env, shell: WIN, timeout: 20000, cwd: root });
  assert.equal(ix.status, 0, ix.stderr);
  const readmeMs = /^\{"k":"coverage","files".*"ms":(\d+)\}$/m.exec(readFileSync(join(root, 'README.md'), 'utf8'))?.[1];
  const printed = new Set([...s.stdout.split('\n'), ...ix.stdout.replace(/"ms":\d+\}/, `"ms":${readmeMs}}`).split('\n')]);
  assert.deepEqual(examples.filter((l) => !printed.has(l)), [], 'README example lines the installed ltms does not print');
  // and the installed copy prints what this tree's own build prints
  const inTree = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'skeleton', DEMO], { encoding: 'utf8', timeout: 20000 });
  assert.equal(s.stdout, inTree.stdout);
});

let ts = null, noTs = false;
try { ts = createRequire(import.meta.url)('typescript'); }
catch (e) { noTs = `the typescript package cannot be imported from ${root} (${e?.code ?? e?.name}): npm install installs it, as a devDependency`; }

test('the package: a strict NodeNext TypeScript consumer, with no Node types, compiles against the installed declarations', { skip: noNpm || noTs }, () => {
  const { consumer, tarball } = install();
  const file = join(consumer, 'consumer.mts');
  writeFileSync(file, [
    `import { parseTranscript, repairedLivePath, turnsOf, NOT_A_STRING } from '${NAME}';`,
    `import type { Transcript, Turn, ToolCall, LineProblem, CompactionJoin } from '${NAME}';`,
    `import { parseTranscript as deep } from '${NAME}/dist/parser.js';`,
    `import { turnsOf as deepNoExtension } from '${NAME}/dist/parser';`,
    'const t: Transcript = parseTranscript(\'\', { repairNul: true });',
    'const turns: Turn[] = turnsOf(t, repairedLivePath(t).path);',
    'const calls: ToolCall[] = turns.flatMap((turn) => turn.toolCalls);',
    'const problems: LineProblem[] = t.problems;',
    'const joins: CompactionJoin[] = repairedLivePath(t).compactions;',
    'const same: typeof parseTranscript = deep;',
    'const sameTurns: typeof turnsOf = deepNoExtension;',
    'const label: \'(not a string)\' = NOT_A_STRING;',
    'export { calls, problems, joins, same, sameTurns, label };',
  ].join('\n') + '\n');
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
    strict: true, noEmit: true, types: [], skipLibCheck: false,
  });
  const messages = ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${relative(consumer, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : '(no file)';
    return `${where}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
  assert.deepEqual(messages, [], `typescript ${ts.version}, against ${tarball}`);
});

test('the package: strict TypeScript consumers find the types of ".", ./pin, dist/parser.js and dist/parser under node10, node16, nodenext and bundler resolution', { skip: noNpm || noTs }, () => {
  // node10 (moduleResolution "node", the default with module commonjs) does not read "exports": the types of "." come
  // from "types", and those of ./pin from "typesVersions"
  const { consumer, pkgDir, tarball } = install();
  const lines = [`import { parseTranscript } from '${NAME}';`, `import { pinPaths } from '${NAME}/pin';`, `import type { PinResult } from '${NAME}/pin';`,
    `import { turnsOf } from '${NAME}/dist/parser.js';`, `import { livePath } from '${NAME}/dist/parser';`,
    'export const fns = [parseTranscript, pinPaths, turnsOf, livePath];', 'export type Result = PinResult;'];
  writeFileSync(join(consumer, 'modes.ts'), lines.join('\n') + '\n');
  writeFileSync(join(consumer, 'modes.mts'), lines.join('\n') + '\n');
  const want = { [NAME]: 'dist/index.d.ts', [`${NAME}/pin`]: 'dist/pin.d.ts', [`${NAME}/dist/parser.js`]: 'dist/parser.d.ts', [`${NAME}/dist/parser`]: 'dist/parser.d.ts' };
  const wrong = [];
  for (const [mode, m, file] of [
    ['node10', { module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 }, 'modes.ts'],
    ['node16', { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 }, 'modes.mts'],
    ['nodenext', { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }, 'modes.mts'],
    ['bundler', { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }, 'modes.ts'],
  ]) {
    const options = { ...m, target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, types: [], skipLibCheck: false };
    const f = join(consumer, file);
    for (const [spec, types] of Object.entries(want)) {
      const r = ts.resolveModuleName(spec, f, options, ts.sys).resolvedModule;
      const got = r ? relative(pkgDir, r.resolvedFileName).split(sep).join('/') : 'nothing';
      if (got !== types) wrong.push(`${mode}: the types of '${spec}' resolve to ${got}, not ${types}`);
    }
    for (const d of ts.getPreEmitDiagnostics(ts.createProgram([f], options))) wrong.push(`${mode}: ${d.file ? `${relative(consumer, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : '(no file)'}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  assert.deepEqual(wrong, [], `typescript ${ts.version}, against ${tarball}`);
});

test('the build: dist/ holds what tsc makes of src/ with tsconfig.json, file for file and byte for byte', { skip: noTs }, () => {
  // tsc never deletes what it no longer makes (a declaration file, once "declaration" is off), and the package ships dist/
  const out = mkdtempSync(join(tmpdir(), 'ltms-build-'));
  try {
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, ' ')); } };
    const cfg = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), { outDir: out }, host);
    const program = ts.createProgram(cfg.fileNames, cfg.options);
    const emitted = program.emit();
    const messages = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics).map((d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    assert.deepEqual(messages, [], 'tsc reports');
    const made = readdirSync(out).sort(), committed = readdirSync(join(root, 'dist')).sort();
    assert.deepEqual(committed, made, 'the files of dist/, against the files the build makes (npm run build makes them)');
    const differ = made.filter((f) => !readFileSync(join(out, f)).equals(readFileSync(join(root, 'dist', f))));
    assert.deepEqual(differ, [], 'files of dist/ that differ from what the build makes of src/: run npm run build');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the package: every file "exports" and "typesVersions" name is in the packed tarball, and ./pin resolves and loads by import and by require', { skip: noNpm }, () => {
  const { consumer, pkgDir, tarball } = install();
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  // each condition's target of every entry that names one file (the "*" patterns name none), and each typesVersions path
  const named = Object.values(pkg.exports ?? {}).flatMap((t) => (typeof t === 'string' ? [t] : Object.values(t ?? {})))
    .concat(Object.values(pkg.typesVersions ?? {}).flatMap((map) => Object.values(map).flat()))
    .filter((f) => typeof f === 'string' && !f.includes('*'));
  assert.ok(named.length > 0, `in ${tarball}: package.json's "exports" names no file`);
  assert.deepEqual(named.filter((f) => !existsSync(join(pkgDir, f))), [], `in ${tarball}: files package.json's "exports" or "typesVersions" names that the package does not hold (its "files" list decides what is packed)`);
  writeFileSync(join(consumer, 'pin-probe.mjs'), `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const m = await import('${NAME}/pin'), c = require('${NAME}/pin');
console.log(JSON.stringify([import.meta.resolve('${NAME}/pin'), require.resolve('${NAME}/pin'), Object.keys(m).length, Object.keys(c).length]));
`);
  const r = spawnSync(process.execPath, [join(consumer, 'pin-probe.mjs')], { cwd: consumer, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, failed('the ./pin probe', r));
  const [esm, cjs, nEsm, nCjs] = JSON.parse(r.stdout);
  assert.equal(relative(pkgDir, fileURLToPath(esm)).split(sep).join('/'), 'dist/pin.js');
  assert.equal(relative(pkgDir, cjs).split(sep).join('/'), 'dist/pin.js');
  assert.ok(nEsm > 0 && nEsm === nCjs, `./pin exports ${nEsm} names by import and ${nCjs} by require`);
});

test('the package: scripts.test names every test file in test/, without a glob, and every file it names exists', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const words = String(pkg.scripts?.test ?? '').split(/\s+/).filter(Boolean);
  assert.deepEqual(words.slice(0, 2), ['node', '--test'], `scripts.test is '${pkg.scripts?.test}'`);
  // a glob is not expanded where npm's shell is cmd.exe, and node 20's --test does not expand it either
  assert.deepEqual(words.filter((w) => /[*?[]/.test(w)), [], 'scripts.test holds a glob');
  // an option that filters tests out (FILTERS above; also checked when the file is loaded)
  assert.deepEqual(words.filter((w) => FILTERS.test(w)), [], 'scripts.test holds an option that filters tests out');
  const named = words.slice(2).filter((w) => !w.startsWith('-'));
  // node 22 and 26 pass without a word about a named file that does not exist; node 20 stops at it
  assert.deepEqual(named.filter((f) => !existsSync(join(root, f))), [], 'scripts.test names files that do not exist');
  const present = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`).sort();
  assert.deepEqual(present.filter((f) => !named.includes(f)), [], 'test files that scripts.test does not run');
});

test('the package: "files" is 0.0.5\'s and skills (0.2.0, the SKILL.md ltms skill prints): dist, skills, README.md, CHANGELOG.md and LICENSE (docs/ and test/ are not shipped)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files, ['dist', 'skills', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  assert.deepEqual(readdirSync(join(root, 'skills'), { recursive: true }).sort(), ['ltms', 'ltms/SKILL.md'], 'skills/ holds the one SKILL.md');
});

test('the package: the entry point "." imports nothing from Node: dist/index.js and every module it reaches import only each other', () => {
  const reached = [], wrong = [], stack = ['index.js'];
  while (stack.length) {
    const f = stack.pop();
    if (reached.includes(f)) continue;
    reached.push(f);
    const file = join(root, 'dist', f);
    if (!existsSync(file)) { wrong.push(`dist/${f} does not exist (npm run build writes it)`); continue; }
    const src = readFileSync(file, 'utf8');
    for (const [, s] of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
      if (/^\.\/[\w.-]+\.js$/.test(s)) stack.push(s.slice(2)); else wrong.push(`dist/${f} imports '${s}'`);
    }
    for (const m of src.matchAll(/\brequire\s*\(|\bimport\s*\(|\bprocess\s*[.[]|\bBuffer\s*[.(]|\bglobalThis\s*\.\s*(?:process|Buffer)\b/g))
      wrong.push(`dist/${f} uses '${m[0]}'`);
  }
  assert.ok(reached.includes('parser.js'), `dist/index.js does not reach dist/parser.js: ${reached.join(', ')}`);
  assert.deepEqual(wrong, []);
});
