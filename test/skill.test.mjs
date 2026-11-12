// Tests for ltms skill (0.2.0) and the SKILL.md it prints (skills/ltms/SKILL.md), against the built dist/cli.js (build
// first). The skill is checked against the commands it teaches: every command in its sh blocks is run on the fixtures
// as an agent would run it, every field it names is a field of that command's help, and the version it pins is the
// package's. The install line is run with a stub npx, in sh, so that its quoting, its directories and its temporary
// file are what is tested, not the network.
//
// LTMS_CLI=<path to a cli.js> runs the same tests against another build, LTMS_SKILL=<path to a SKILL.md> on its skill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// ltms runs below with the cache off (LTMS_CACHE unset), and any sieve in a directory of this file's own, removed at exit
{ const { mkdtempSync: m, rmSync: r } = await import('node:fs'); const { tmpdir: d } = await import('node:os'); const c = m((await import('node:path')).join(d(), 'ltms-test-cache-')); process.env.XDG_CACHE_HOME = c; delete process.env.LTMS_CACHE; process.on('exit', () => r(c, { recursive: true, force: true })); }

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = process.env.LTMS_CLI || join(root, 'dist', 'cli.js');
const FIX = join(here, 'fixtures');
const SKILL = process.env.LTMS_SKILL || join(root, 'skills', 'ltms', 'SKILL.md');   // LTMS_SKILL: another build's SKILL.md
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const MINOR = VERSION.split('.').slice(0, 2).join('.');

function ltms(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000, ...opts });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'ltms-skill-'));
const rm = (d) => rmSync(d, { recursive: true, force: true });
const text = () => readFileSync(SKILL, 'utf8');
/** The frontmatter's key: value lines, and the body. */
function frontmatter(t) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
  assert.ok(m, 'SKILL.md opens with a frontmatter between --- lines');
  const keys = {};
  for (const l of m[1].split('\n')) { const k = /^([a-z-]+): (.*)$/.exec(l); assert.ok(k, `a frontmatter line that is not key: value: ${l}`); keys[k[1]] = k[2]; }
  return { keys, body: t.slice(m[0].length) };
}
/** The skill's sh blocks, each a list of lines. */
const shBlocks = (t) => [...t.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].split('\n').filter((l) => l.trim()));
/** The part of the body under a ## heading that starts with `head`. */
const sectionOf = (t, head) => { const s = t.indexOf(`\n## ${head}`); assert.ok(s >= 0, head); const e = t.indexOf('\n## ', s + 1); return t.slice(s, e < 0 ? undefined : e); };

test('ltms skill prints skills/ltms/SKILL.md byte for byte (exit 0), and on stderr the line that installs it, with npx -y and the minor version', () => {
  const r = ltms(['skill']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, text());
  const want = `mkdir -p ~/.claude/skills/ltms && npx -y long-term-memory-structure@${MINOR} skill > ~/.claude/skills/ltms/SKILL.md.tmp && mv ~/.claude/skills/ltms/SKILL.md.tmp ~/.claude/skills/ltms/SKILL.md`;
  const env = { ...process.env }; delete env.CLAUDE_CONFIG_DIR;
  assert.equal(ltms(['skill'], { env }).err, `ltms skill: to install it for Claude Code: ${want}\n`);
  // the README gives the same line (one rule, two copies that must not disagree)
  assert.ok(readFileSync(join(root, 'README.md'), 'utf8').includes(`\n${want}\n`), 'the README\'s install line is not the one ltms skill prints');
  for (const h of ['--help', '-h']) { const x = ltms(['skill', h], { env }); assert.equal(x.code, 0); assert.ok(x.out.includes(want), h); }
  assert.equal(ltms(['skill', '-v']).out, `${VERSION}\n`);
  for (const a of ['--frob', 'extra']) { const x = ltms(['skill', a]); assert.deepEqual([x.code, x.out], [2, ''], a); assert.match(x.err, /^ltms skill: .*skill takes no arguments/); }
});

test('the install line runs as printed in sh, under the default directory and under a CLAUDE_CONFIG_DIR with a space, a quote or a leading dash: SKILL.md written whole, no temporary file left; a failed npx leaves the old copy', () => {
  const dir = tmp();
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    // a stub npx: prints the skill as the package would, or fails when STUB_FAIL is set
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\n[ -n "$STUB_FAIL" ] && { echo partial; exit 1; }\n[ "$1" = -y ] && [ "$2" = "long-term-memory-structure@${MINOR}" ] && [ "$3" = skill ] || { echo "stub npx: unexpected $*" >&2; exit 3; }\nexec "${process.execPath}" "${CLI}" skill 2>/dev/null\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    const home = join(dir, 'home'); mkdirSync(home);
    for (const config of [null, join(dir, 'it\'s a dir'), '-cfg']) {
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
      if (config === null) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = config;
      const line = /: (mkdir .*)$/m.exec(ltms(['skill'], { env, cwd: dir }).err)[1];
      const r = spawnSync('sh', ['-c', line], { encoding: 'utf8', env, cwd: dir });
      assert.equal(r.status, 0, `${config}: ${line}: ${r.stderr}`);
      const target = config === null ? join(home, '.claude', 'skills', 'ltms') : join(config.startsWith('/') ? config : join(dir, config), 'skills', 'ltms');
      assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), text(), String(config));
      assert.deepEqual(readdirSync(target), ['SKILL.md'], String(config));
      // npx fails: the && stops before mv, and the copy installed before is whole
      const f = spawnSync('sh', ['-c', line], { encoding: 'utf8', env: { ...env, STUB_FAIL: '1' }, cwd: dir });
      assert.notEqual(f.status, 0);
      assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), text(), `${config}: the old copy after a failed npx`);
    }
  } finally { rm(dir); }
});

test('SKILL.md: its frontmatter (name the folder\'s, a description within the Agent Skills limit, with no angle bracket, naming the package; allowed-tools the four commands that only read, in both spellings, never pin), and every version it pins is the package\'s minor', () => {
  const t = text(), { keys } = frontmatter(t);
  assert.deepEqual(Object.keys(keys), ['name', 'description', 'allowed-tools']);
  assert.equal(keys.name, 'ltms');
  assert.equal(keys.name, dirname(SKILL).split(/[\\/]/).pop());
  assert.ok(keys.description.length >= 1 && keys.description.length <= 1024, `${keys.description.length} characters`);
  assert.ok(!/[<>]/.test(keys.description), 'an angle bracket shows as &lt; or &gt; in Claude Code\'s skill listing');
  assert.ok(!/^["']/.test(keys.description) && !/: /.test(keys.description), 'a description YAML would read as other than one plain string');
  assert.match(keys.description, /long-term-memory-structure/);
  const tools = keys['allowed-tools'].split(/\s+(?=Bash\()/);
  const want = [];
  for (const run of [`npx -y long-term-memory-structure@${MINOR}`, 'ltms']) for (const c of ['index', 'skeleton', 'search', 'stats']) want.push(`Bash(${run} ${c} *)`);
  assert.deepEqual(tools.sort(), want.sort());
  const pins = [...t.matchAll(/long-term-memory-structure@([0-9.]+)/g)].map((m) => m[1]);
  assert.ok(pins.length >= 6, `${pins.length} pinned commands`);
  assert.deepEqual([...new Set(pins)], [MINOR], 'a version pinned that is not the package\'s minor');
  assert.ok(!/npx (?:-y )?ltms\b/.test(t.replace(/Never `npx ltms`/, '')), 'the skill tells an agent to run npx ltms');
});

/** A project folder for the skill's commands: two fixtures under session-like names, and the address the skill reads. */
function project() {
  const dir = tmp(), p = join(dir, 'projects', '-home-me-app');
  mkdirSync(p, { recursive: true });
  copyFileSync(join(FIX, 'compacted.jsonl'), join(p, '15b86237-de8b-48fc-ab76-d3bc7812047b.jsonl'));
  copyFileSync(join(FIX, 'demo.jsonl'), join(p, '22222222-2222-4222-8222-222222222222.jsonl'));
  return { dir, p, path: join(p, '15b86237-de8b-48fc-ab76-d3bc7812047b.jsonl') };
}

test('SKILL.md: every command in its sh blocks runs as written, on a project folder (exit 0, the output it describes)', () => {
  const { dir, p, path } = project();
  try {
    const blocks = shBlocks(text());
    assert.deepEqual(blocks.map((b) => b.length), [1, 1, 1, 1], 'one command in each of the four blocks');
    const run = (line) => {
      const cmd = line.replaceAll(`npx -y long-term-memory-structure@${MINOR}`, `"${process.execPath}" "${CLI}"`)
        .replaceAll('~/.claude/projects/<project>', `'${p}'`).replaceAll('<path> 186', `'${path}' 10`).replaceAll('<path>', `'${path}'`);
      assert.ok(!/[<>]/.test(cmd.replace(/=>/g, '')), `a placeholder left in: ${cmd.slice(0, 120)}`);
      const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: dir });
      assert.equal(r.status, 0, `${line.slice(0, 100)}: ${r.stderr}`);
      return r.stdout;
    };
    const [index, skeleton, search, read] = blocks.map((b) => run(b[0]));
    assert.match(index.split('\n')[0], /^\{"k":"coverage","files":/);
    assert.equal(index.split('\n').filter((l) => l.startsWith('{"k":"session"')).length, 2);
    assert.match(skeleton, /^\{"k":"turn","a":"15b86237:L1"/);
    assert.match(search.split('\n')[0], /^\{"k":"coverage","query":\["migration","rollback"\]/);
    // the reader, on the compaction summary (line 10 of the copy): its type, the length of its text, and the text
    const summary = JSON.parse(readFileSync(path, 'utf8').split('\n')[9]).message.content;
    assert.equal(read, `[user, ${summary.length} characters, from 0]\n${summary.slice(0, 4000)}\n`);
  } finally { rm(dir); }
});

test('SKILL.md\'s reader: for each kind of record, the type, the length of its text and a window of it, the text read here without the reader\'s code; the next window from where the last ended', () => {
  const { dir, path } = project();
  try {
    const reader = shBlocks(text())[3][0].replace(/ <path> 186 0 4000$/, '');
    assert.match(reader, /^node -e '[^']+'$/);
    const records = readFileSync(path, 'utf8').split('\n').filter((l) => l).map((l) => JSON.parse(l));
    const textOf = (r) => {
      const c = r.message?.content;
      if (c === undefined) return JSON.stringify(r);
      if (typeof c === 'string') return c;
      return c.map((b) => (typeof b === 'string' ? b : b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : b.type === 'tool_use' ? JSON.stringify(b.input)
        : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join('\n') : JSON.stringify(b.content ?? '')) : '')).join('\n');
    };
    const kinds = new Set();
    records.forEach((r, i) => {
      const t = textOf(r);
      const out = spawnSync('sh', ['-c', `${reader} '${path}' ${i + 1} 0 50`], { encoding: 'utf8' }).stdout;
      assert.equal(out, `[${r.type}, ${t.length} characters, from 0]\n${t.slice(0, 50)}\n`, `line ${i + 1}`);
      kinds.add(r.type + (r.subtype ? `:${r.subtype}` : '') + (Array.isArray(r.message?.content) ? `:${r.message.content[0]?.type}` : ''));
    });
    assert.ok(['user', 'assistant:tool_use', 'user:tool_result', 'system:compact_boundary'].every((k) => kinds.has(k)), [...kinds].join(' '));
    // a tool result whose content is an object (not a string, not an array): its JSON, not a TypeError (V-A13)
    const odd = join(dir, 'odd.jsonl');
    writeFileSync(odd, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: { a: 1 } }] } }) + '\n');
    assert.equal(spawnSync('sh', ['-c', `${reader} '${odd}' 1 0 50`], { encoding: 'utf8' }).stdout, '[user, 7 characters, from 0]\n{"a":1}\n');
    const long = records.findIndex((r) => textOf(r).length > 30);
    const t = textOf(records[long]);
    const two = spawnSync('sh', ['-c', `${reader} '${path}' ${long + 1} 20 10`], { encoding: 'utf8' }).stdout;
    assert.equal(two, `[${records[long].type}, ${t.length} characters, from 20]\n${t.slice(20, 30)}\n`);
  } finally { rm(dir); }
});

test('SKILL.md: every field it names in its sections on index, skeleton and search is a field of that command\'s help', () => {
  const t = text();
  const spans = (s) => [...s.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
  for (const [head, help] of [['1. List the sessions', ltms(['index', '--help']).out], ['2. One session', ltms(['--help']).out], ['3. Search', ltms(['search', '--help']).out]]) {
    const named = spans(sectionOf(t, head)).filter((w) => !['ltms', 'index', 'skeleton', 'search', 'next'].includes(w) || help.includes(`  ${w} `));
    assert.ok(named.length >= 4, head);
    for (const w of named) assert.match(help, new RegExp(`(^|[\\s,(])${w}([\\s,)]|$)`, 'm'), `${head}: '${w}' is not in the command's help`);
  }
});
