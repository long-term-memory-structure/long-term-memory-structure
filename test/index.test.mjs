// Tests for ltms index (0.2.0) and its library function indexTranscript, run against the built dist/ (build first).
//
// The session line's fields are recomputed here from the fixtures' raw lines, without the parser: the timestamps (C2's
// rule), and the compactions and the last reply along a plain reading of the live path (the last last-prompt's leaf, or
// the last record written; a leaf with children extended to its last-written descendant; up through parentUuid and
// across logicalParentUuid). That reading leaves out the parser's other repairs; the fixtures made for them are listed
// with their answers read by hand. turns, calls, failures and the prompts are held to ltms stats and ltms skeleton,
// whose own fields cli.test.mjs recomputes from raw records. The walk's rules are tested on folders built here.
//
// LTMS_CLI=<path to a cli.js> runs the command's tests against another build, LTMS_LIB=<path to an index.js> the library's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// ltms runs below with the cache off (LTMS_CACHE unset), and any sieve in a directory of this file's own, removed at exit
{ const { mkdtempSync: m, rmSync: r } = await import('node:fs'); const { tmpdir: d } = await import('node:os'); const c = m((await import('node:path')).join(d(), 'ltms-test-cache-')); process.env.XDG_CACHE_HOME = c; delete process.env.LTMS_CACHE; process.on('exit', () => r(c, { recursive: true, force: true })); }

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = process.env.LTMS_CLI || join(root, 'dist', 'cli.js');
const FIX = join(here, 'fixtures');
const lib = await import(pathToFileURL(process.env.LTMS_LIB || join(root, 'dist', 'index.js')).href);   // LTMS_LIB: another build's index.js

function ltms(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000, ...opts });
  if (r.error) throw r.error;
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));   // --help prints text
  return { code: r.status, out: r.stdout, err: r.stderr, lines };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'ltms-index-'));
const rm = (d) => rmSync(d, { recursive: true, force: true });
const prefixOf = (f) => { const n = basename(f); return n.startsWith('agent-') ? `agent-${n.slice(6, 14)}` : n.slice(0, 8); };
const uuidN = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A session of typed prompts, each answered by one assistant record (a string reply: one text block); record j is
 *  stamped ts plus j seconds (no timestamps when ts is null). `extra(k)` gives records to append after turn k. */
function session(turns, ts, { extra = () => [], sid = 'ffffffff-0000-4000-8000-000000000000' } = {}) {
  const recs = [];
  let parent = null;
  const stamp = () => (ts ? { timestamp: new Date(Date.parse(ts) + 1000 * (recs.length + 1)).toISOString() } : {});
  turns.forEach(([prompt, reply], k) => {
    const u = uuidN(recs.length + 1);
    recs.push({ type: 'user', uuid: u, parentUuid: parent, sessionId: sid, promptSource: 'typed', ...stamp(), message: { role: 'user', content: prompt } });
    const a = uuidN(recs.length + 1);
    recs.push({ type: 'assistant', uuid: a, parentUuid: u, sessionId: sid, requestId: `req_${recs.length + 1}`, ...stamp(), message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
    parent = a;
    for (const r of extra(k, parent)) { recs.push({ sessionId: sid, ...stamp(), ...r }); if (typeof r.uuid === 'string') parent = r.uuid; }
  });
  recs.push({ type: 'last-prompt', leafUuid: parent });
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

// ---- the independent reading ------------------------------------------------------------------------------------

/** first, last, compactions and lastReply of a transcript's text, read without the parser (see the file's header). */
function independent(text, prefix) {
  const recs = [];
  text.split('\n').forEach((l, i) => { if (!l.trim()) return; try { const r = JSON.parse(l); if (r && typeof r === 'object' && !Array.isArray(r)) recs.push({ r, line: i + 1 }); } catch { /* not a record */ } });
  const nodes = new Map(), firsts = [];
  for (const x of recs) {
    if (typeof x.r.uuid === 'string' && 'parentUuid' in x.r) { if (nodes.has(x.r.uuid)) continue; nodes.set(x.r.uuid, x); }
    firsts.push(x);
  }
  const ts = firsts.map((x) => x.r.timestamp).filter((t) => typeof t === 'string' && t !== '');
  const first = ts.length ? ts.reduce((a, b) => (b < a ? b : a)) : null, last = ts.length ? ts.reduce((a, b) => (b > a ? b : a)) : null;
  const lp = [...recs].reverse().find((x) => x.r.type === 'last-prompt');
  let leaf = lp && nodes.get(lp.r.leafUuid) ? nodes.get(lp.r.leafUuid) : [...nodes.values()].at(-1);
  if (leaf) {
    const kids = new Map();
    for (const x of nodes.values()) { const p = x.r.parentUuid; if (p != null) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(x); } }
    let lastD = null; const st = [...(kids.get(leaf.r.uuid) ?? [])], seen = new Set();
    while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); if (!lastD || x.line > lastD.line) lastD = x; st.push(...(kids.get(x.r.uuid) ?? [])); }
    if (lastD) leaf = lastD;
  }
  const path = [], onPath = new Set();
  for (let n = leaf; n && !onPath.has(n);) {
    onPath.add(n); path.push(n);
    const p = n.r.parentUuid;
    n = p == null ? (typeof n.r.logicalParentUuid === 'string' ? nodes.get(n.r.logicalParentUuid) : undefined) : nodes.get(p);
  }
  path.reverse();
  const A = (x) => `${prefix}:L${x.line}`;
  const isBoundary = (r) => r.type === 'system' && r.subtype === 'compact_boundary';
  const isPrompt = (r) => r.type === 'user' && r.isMeta !== true && r.isCompactSummary !== true && !('toolUseResult' in r)
    && !(Array.isArray(r.message?.content) && r.message.content[0]?.type === 'tool_result');
  const compactions = [];
  path.forEach((x, i) => {
    if (!isBoundary(x.r)) return;
    let summary = null;
    for (let j = i + 1; j < path.length; j++) {
      if (path[j].r.isCompactSummary === true) { summary = A(path[j]); break; }
      if (isPrompt(path[j].r) || isBoundary(path[j].r)) break;
    }
    compactions.push({ boundary: A(x), summary });
  });
  const isReply = (r) => r.type === 'assistant' && r.isApiErrorMessage !== true && (typeof r.message?.content === 'string' ? r.message.content !== ''
    : Array.isArray(r.message?.content) && r.message.content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text !== ''));
  const lr = [...path].reverse().find((x) => isReply(x.r));
  return { first, last, compactions, lastReply: lr ? A(lr) : null };
}

/** The fixtures made for the parser's other repairs, where the plain reading differs from the live path the parser
 *  documents: each with the field it differs in, and the answer read by hand (README, What it reads). */
const REPAIRED = {
  'library-detached-first.jsonl': { compactions: [{ boundary: 'library-:L3', summary: 'library-:L4' }, { boundary: 'library-:L9', summary: 'library-:L10' }] },   // a detached compaction, joined
  'library-detached.jsonl': { compactions: [{ boundary: 'library-:L3', summary: 'library-:L4' }] },   // the same, alone
  'library-forest.jsonl': { lastReply: 'library-:L15' },   // the last last-prompt names no record: the one before it names L15's branch
  'cycle.jsonl': { lastReply: null },   // the path stops at the record that names itself as its parent; the cycle below is warned
  'retried.jsonl': { lastReply: 'retried.:L6' },   // the retry after a late-written API error, joined
};

test('every session line of the fixtures: first, last, compactions and lastReply recomputed from the raw lines; turns, calls and failures equal to stats; the prompts equal to skeleton', () => {
  const r = ltms(['index', '--max', '0', FIX]);
  assert.equal(r.code, 0, r.err);
  const lines = r.lines.slice(1);
  assert.ok(lines.length >= 80, `${lines.length} session lines`);
  const repaired = [];
  for (const l of lines) {
    const name = relative(FIX, l.path), text = readFileSync(l.path, 'utf8');
    const want = { ...independent(text, prefixOf(l.path)), ...(REPAIRED[name] ?? {}) };
    const iso = (v) => (v === null ? null : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) ? v : '(withheld)');
    assert.deepEqual({ first: l.first, last: l.last, compactions: l.compactions, lastReply: l.lastReply },
      { first: iso(want.first), last: iso(want.last), compactions: want.compactions, lastReply: want.lastReply }, name);
    if (REPAIRED[name]) repaired.push(name);
    const stats = ltms(['stats', l.path]).lines[0];
    assert.deepEqual([l.turns, l.calls, l.failures], [stats.turns, stats.calls, stats.failures], `${name}: stats`);
    const turns = ltms(['skeleton', l.path]).lines.filter((x) => x.k === 'turn');
    assert.deepEqual([l.firstPrompt, l.lastPrompt], [turns[0].a, turns[turns.length - 1].a], `${name}: skeleton`);
    assert.equal(l.p, prefixOf(l.path));
  }
  // the hand-read answers are each used, so none of them stands for a fixture that no longer exists
  assert.deepEqual(repaired.sort(), Object.keys(REPAIRED).sort());
  // the plain reading's rules are not idle: compactions on several shapes, and replies, are read from it
  const reads = lines.map((l) => independent(readFileSync(l.path, 'utf8'), prefixOf(l.path)));
  assert.ok(reads.filter((x) => x.compactions.length).length >= 8 && reads.filter((x) => x.lastReply).length >= 60);
});

test('the library: indexTranscript of the text equals that of the Transcript; without a prefix the addresses are L<n>; a transcript with no turn gives 0 and null prompts', () => {
  const text = readFileSync(join(FIX, 'compacted.jsonl'), 'utf8');
  const a = lib.indexTranscript(text), b = lib.indexTranscript(lib.parseTranscript(text));
  assert.deepEqual(a, b);
  assert.deepEqual(a.compactions, [{ boundary: 'L9', summary: 'L10' }]);
  assert.deepEqual([a.firstPrompt, a.lastPrompt, a.lastReply], ['L1', 'L11', 'L14']);
  assert.deepEqual(lib.indexTranscript(text, { prefix: 'p' }).compactions, [{ boundary: 'p:L9', summary: 'p:L10' }]);
  const none = lib.indexTranscript(readFileSync(join(FIX, 'no-turns.jsonl'), 'utf8'));
  assert.deepEqual([none.turns, none.calls, none.failures, none.firstPrompt, none.lastPrompt], [0, 0, 0, null, null]);
  const empty = lib.indexTranscript('');
  assert.deepEqual(empty, { first: null, last: null, turns: 0, calls: 0, failures: 0, compactions: [], firstPrompt: null, lastPrompt: null, lastReply: null });
});

test('the library: compactions lists every boundary on the live path, joined or not: the three review fixtures the parser does not join', () => {
  for (const f of ['pb-shape1-after.jsonl', 'pb2-head-after.jsonl', 'pb2-shape1-late.jsonl']) {
    const text = readFileSync(join(FIX, 'review', f), 'utf8');
    const t = lib.parseTranscript(text);
    assert.equal(lib.repairedLivePath(t).compactions.length, 0, `${f}: the parser joins it now; pick another unjoined fixture`);
    assert.deepEqual(lib.indexTranscript(t).compactions, [{ boundary: 'L3', summary: 'L4' }], f);
  }
});

test('the library: a summary two records after its boundary is found; a boundary with a prompt or nothing after it has summary null', () => {
  const B = (uuid, parent) => ({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: parent, compactMetadata: { trigger: 'manual', preTokens: 100 } });
  const S = (uuid, parent) => ({ type: 'user', uuid, parentUuid: parent, isCompactSummary: true, message: { role: 'user', content: 'the summary' } });
  const M = (uuid, parent) => ({ type: 'system', subtype: 'local_command', uuid, parentUuid: parent, content: 'x' });
  const P = (uuid, parent, text) => ({ type: 'user', uuid, parentUuid: parent, promptSource: 'typed', message: { role: 'user', content: text } });
  const R = (uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent, requestId: `req_${uuid}`, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
  const doc = (...rs) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const u = uuidN;
  // the summary after a system record: found
  let x = lib.indexTranscript(doc(P(u(1), null, 'one'), R(u(2), u(1)), B(u(3), u(2)), M(u(4), u(3)), S(u(5), u(4)), P(u(6), u(5), 'two'), R(u(7), u(6)), { type: 'last-prompt', leafUuid: u(7) }));
  assert.deepEqual(x.compactions, [{ boundary: 'L3', summary: 'L5' }]);
  // a prompt before any summary: null
  x = lib.indexTranscript(doc(P(u(1), null, 'one'), R(u(2), u(1)), B(u(3), u(2)), P(u(4), u(3), 'two'), R(u(5), u(4)), { type: 'last-prompt', leafUuid: u(5) }));
  assert.deepEqual(x.compactions, [{ boundary: 'L3', summary: null }]);
  // the boundary last: null
  x = lib.indexTranscript(doc(P(u(1), null, 'one'), R(u(2), u(1)), B(u(3), u(2)), { type: 'last-prompt', leafUuid: u(3) }));
  assert.deepEqual(x.compactions, [{ boundary: 'L3', summary: null }]);
  // a summary after the next turn's prompt is not this boundary's: null
  x = lib.indexTranscript(doc(P(u(1), null, 'one'), R(u(2), u(1)), B(u(3), u(2)), P(u(4), u(3), 'two'), S(u(5), u(4)), R(u(6), u(5)), { type: 'last-prompt', leafUuid: u(6) }));
  assert.deepEqual(x.compactions, [{ boundary: 'L3', summary: null }]);
});

test('the library: lastReply is the last assistant record with a non-empty text block, an API error message and an empty text passed over; a string content is a reply', () => {
  const u = uuidN;
  const P = (uuid, parent) => ({ type: 'user', uuid, parentUuid: parent, promptSource: 'typed', message: { role: 'user', content: 'go' } });
  const A = (uuid, parent, content, extra = {}) => ({ type: 'assistant', uuid, parentUuid: parent, requestId: `req_${uuid}`, message: { role: 'assistant', content }, ...extra });
  const doc = (...rs) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const lr = (...rs) => lib.indexTranscript(doc(...rs, { type: 'last-prompt', leafUuid: rs.at(-1).uuid })).lastReply;
  assert.equal(lr(P(u(1), null), A(u(2), u(1), [{ type: 'text', text: 'reply' }]), A(u(3), u(2), [{ type: 'text', text: 'API Error' }], { isApiErrorMessage: true })), 'L2');
  assert.equal(lr(P(u(1), null), A(u(2), u(1), [{ type: 'text', text: 'reply' }]), A(u(3), u(2), [{ type: 'text', text: '' }])), 'L2');
  assert.equal(lr(P(u(1), null), A(u(2), u(1), [{ type: 'text', text: 'reply' }]), A(u(3), u(2), [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])), 'L2');
  assert.equal(lr(P(u(1), null), A(u(2), u(1), 'a string reply')), 'L2');
  assert.equal(lr(P(u(1), null), A(u(2), u(1), [{ type: 'thinking', thinking: 'only thought' }])), null);
});

test('C2 through index: a first record whose timestamp is empty does not make first empty; a file with only empty timestamps has first and last null', () => {
  const dir = tmp();
  try {
    const f = join(dir, 's.jsonl');
    const lines = session([['go', 'ok']], '2026-04-01T10:00:00.000Z').split('\n');
    const r0 = JSON.parse(lines[0]); r0.timestamp = ''; lines[0] = JSON.stringify(r0);
    writeFileSync(f, lines.join('\n'));
    let l = ltms(['index', f]).lines[1];
    assert.deepEqual([l.first, l.last], ['2026-04-01T10:00:02.000Z', '2026-04-01T10:00:02.000Z']);
    writeFileSync(f, session([['go', 'ok']], null).split('\n').map((x) => { if (!x) return x; const r = JSON.parse(x); if (r.uuid) r.timestamp = ''; return JSON.stringify(r); }).join('\n'));
    l = ltms(['index', f]).lines[1];
    assert.deepEqual([l.first, l.last], [null, null]);
  } finally { rm(dir); }
});

test('a timestamp that is not an ISO 8601 time prints (withheld), never as written (it could hold text), and its session sorts with the undated', () => {
  const dir = tmp();
  try {
    const W = 'zqxtimetext';
    writeFileSync(join(dir, 'a.jsonl'), session([['go', 'ok']], '2026-03-03T00:00:00.000Z'));
    writeFileSync(join(dir, 'b.jsonl'), session([['go', 'ok']], null).split('\n').map((x) => { if (!x) return x; const r = JSON.parse(x); if (r.uuid) r.timestamp = `${W} at noon`; return JSON.stringify(r); }).join('\n'));
    const r = ltms(['index', dir]);
    assert.equal(r.code, 0, r.err);
    assert.ok(!(r.out + r.err).includes(W));
    assert.deepEqual(r.lines.slice(1).map((l) => [basename(l.path), l.first, l.last]), [['a.jsonl', '2026-03-03T00:00:01.000Z', '2026-03-03T00:00:02.000Z'], ['b.jsonl', '(withheld)', '(withheld)']]);
    // the library returns the string as the transcript holds it: the check is the command's
    assert.equal(lib.indexTranscript(readFileSync(join(dir, 'b.jsonl'), 'utf8')).first, `${W} at noon`);
  } finally { rm(dir); }
});

// ---- the walk ---------------------------------------------------------------------------------------------------

const S1 = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222', U3 = '33333333-3333-4333-8333-333333333333', S4 = '44444444-4444-4444-8444-444444444444';
/** A project folder in Claude Code's layout, with every kind of file the walk tells apart. */
function project() {
  const dir = tmp(), p = join(dir, 'proj');
  const put = (rel, text) => { mkdirSync(dirname(join(p, rel)), { recursive: true }); writeFileSync(join(p, rel), text); };
  const s = (ts) => session([['go', 'ok']], ts);
  put(`${S1}.jsonl`, session([['one', 'ok'], ['two', 'ok']], '2026-03-02T00:00:00.000Z'));
  put(`${S1}/subagents/agent-aaaa11112222.jsonl`, s('2026-03-02T00:01:00.000Z'));
  put(`${S1}/subagents/agent-aaaa11112222.meta.json`, '{}');
  put(`${S1}/subagents/workflows/wf_x/journal.jsonl`, '{"type":"launched"}\n');
  put(`${S1}/subagents/workflows/wf_x/agent-bbbb33334444.jsonl`, s('2026-03-02T00:02:00.000Z'));
  put(`${S1}/tool-results/spill.jsonl`, s('2026-03-02T00:03:00.000Z'));
  put(`${S1}.orphaned-1772409600000-ab12.jsonl`, s('2026-03-01T00:00:00.000Z'));
  put(`${S2}.jsonl`, s('2026-03-03T00:00:00.000Z'));
  put(`${S2}.superseded-0123456789ab.jsonl`, s('2026-03-03T00:00:00.000Z'));
  put(`${U3}/x.jsonl`, s('2026-03-04T00:00:00.000Z'));
  put(`other/${S4}.jsonl`, s('2026-03-05T00:00:00.000Z'));
  put('pins/PINS.log', '');
  symlinkSync(join(p, 'other'), join(p, 'link-to-other'));
  put(`pins/-proj/${S2}.jsonl`, s('2026-03-03T00:00:00.000Z'));
  return { dir, p };
}

test('the walk: a session\'s own directory, set-aside copies and a pin directory are counted and not read; the identity read = found - failed - sessionParts - setAside; agents per session', () => {
  const { dir, p } = project();
  try {
    const r = ltms(['index', p]);
    assert.equal(r.code, 0, r.err);
    const [c, ...lines] = r.lines;
    assert.deepEqual(lines.map((l) => [relative(p, l.path), l.agents]), [[`other/${S4}.jsonl`, 0], [`${S2}.jsonl`, 0], [`${S1}.jsonl`, 2]]);
    assert.deepEqual(c.files, { given: 1, found: 10, read: 3, failed: 0, notConversation: 0, sessionParts: 5, setAside: 2, symlinks: 1 });
    assert.equal(c.files.read, c.files.found - c.files.failed - c.files.sessionParts - c.files.setAside);
    assert.deepEqual([c.pinStores, c.sessions], [1, 3]);
    assert.match(r.err, new RegExp(`ltms index: notice: '${join(p, 'pins').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' holds PINS\\.log`));
    assert.match(r.err, /ltms index: 3 sessions in 10 files \(3 read, 0 failed; 5 in sessions' own directories and 2 set aside, not read\); 3 shown\.\n$/);
    // the pin directory given: its sessions listed (its PINS.log is the directory given's own)
    assert.deepEqual(ltms(['index', join(p, 'pins')]).lines.slice(1).map((l) => relative(p, l.path)), [`pins/-proj/${S2}.jsonl`]);
    // a session's subagents directory given: its agent transcripts listed, by their agent- prefix
    assert.deepEqual(ltms(['index', join(p, S1, 'subagents')]).lines.slice(1).map((l) => l.p).sort(), ['agent-aaaa1111', 'agent-bbbb3333']);
  } finally { rm(dir); }
});

test('the walk: a file named is read whatever its name (a set-aside copy too), and its agents are null: its directory was not given', () => {
  const { dir, p } = project();
  try {
    const r = ltms(['index', join(p, `${S1}.jsonl`), join(p, `${S1}.orphaned-1772409600000-ab12.jsonl`)]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.lines.slice(1).map((l) => [basename(l.path), l.agents]), [[`${S1}.jsonl`, null], [`${S1}.orphaned-1772409600000-ab12.jsonl`, null]]);
    // named and found under a directory given: one line, and its directory was listed, so agents is counted
    const both = ltms(['index', p, join(p, `${S1}.jsonl`)]);
    assert.deepEqual(both.lines.slice(1).filter((l) => basename(l.path) === `${S1}.jsonl`).map((l) => l.agents), [2]);
  } finally { rm(dir); }
});

test('the walk: a directory given twice, or under another one given, counts its files once; a session\'s subagents directory given with its project is read, and those files are no longer counted as not read', () => {
  const { dir, p } = project();
  try {
    const once = ltms(['index', p]).lines[0];
    for (const args of [[p, p], [p, join(p, 'other')], [join(p, 'other'), p]]) {
      const c = ltms(['index', ...args]).lines[0];
      assert.deepEqual([c.files.found, c.files.read, c.files.sessionParts, c.files.setAside, c.files.symlinks, c.sessions], [once.files.found, once.files.read, once.files.sessionParts, once.files.setAside, once.files.symlinks, once.sessions], args.join(' '));
    }
    // a directory whose only .jsonl lie in a session's own directory holds files: no "holds no .jsonl file" warning
    const only = join(dir, 'only');
    mkdirSync(join(only, U3), { recursive: true });
    writeFileSync(join(only, U3, 'x.jsonl'), session([['go', 'ok']], null));
    const o = ltms(['index', only]);
    assert.deepEqual([o.code, o.lines[0].files.sessionParts, o.lines[0].sessions], [0, 1, 0]);
    assert.doesNotMatch(o.err, /holds no \.jsonl file/);
    assert.match(ltms(['index', join(dir, 'missing-none')]).err, /cannot read/);
    const sub = ltms(['index', p, join(p, S1, 'subagents')]).lines[0];
    // the 3 files under subagents/ are read now (2 agent transcripts listed, the journal a notConversation): the parts
    // left are the spill and the UUID directory's file; found is unchanged, and still splits with no overlap
    assert.deepEqual([sub.files.found, sub.files.read, sub.files.sessionParts, sub.files.setAside, sub.files.notConversation, sub.sessions], [10, 6, 2, 2, 1, 5]);
    assert.equal(sub.files.read, sub.files.found - sub.files.failed - sub.files.sessionParts - sub.files.setAside);
  } finally { rm(dir); }
});

test('the walk: under a session\'s own directory, a directory that cannot be listed makes that session\'s agents null and is a failure; a link to a session directory is counted, not followed, and its agents null', { skip: process.getuid?.() === 0 ? 'running as root, which can list any directory' : false }, () => {
  const { dir, p } = project();
  const locked = join(p, S1, 'subagents', 'workflows');
  try {
    chmodSync(locked, 0o000);
    const r = ltms(['index', p]);
    assert.equal(r.code, 1);
    assert.equal(r.lines.slice(1).find((l) => basename(l.path) === `${S1}.jsonl`).agents, null);
    assert.equal(r.lines[0].files.failed, 1);
    chmodSync(locked, 0o700);
    const linked = join(dir, 'linked');
    mkdirSync(linked);
    cpSync(join(p, `${S2}.jsonl`), join(linked, `${S2}.jsonl`));
    symlinkSync(join(p, S1), join(linked, S2));
    const l = ltms(['index', linked]);
    assert.deepEqual([l.lines[0].files.symlinks, l.lines[1].agents], [1, null]);
  } finally { chmodSync(locked, 0o700); rm(dir); }
});

test('the walk: a name that is not UTF-8 in a session\'s own directory is counted there, not failed', () => {
  const { dir, p } = project();
  try {
    const bad = Buffer.concat([Buffer.from(join(p, S1, 'subagents') + '/agent-'), Buffer.from([0xff, 0xfe]), Buffer.from('.jsonl')]);
    writeFileSync(bad, session([['go', 'ok']], null));
    const r = ltms(['index', p]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines[0].files.sessionParts, 6);
    assert.equal(r.lines.slice(1).find((l) => basename(l.path) === `${S1}.jsonl`).agents, 3);
  } finally { rm(dir); }
});

// ---- order and paging -------------------------------------------------------------------------------------------

/** Five sessions: started 03-02 (c), 03-03 (a), 03-01 twice (b, d: a tie, read in that order), and one undated (e). */
function orderFolder() {
  const dir = tmp();
  writeFileSync(join(dir, 'a.jsonl'), session([['a', 'ok']], '2026-03-03T00:00:00.000Z'));
  // b started on 03-01 and was active again on 03-09: by the time it started it stays among the 03-01 pair
  writeFileSync(join(dir, 'b.jsonl'), session([['b', 'ok'], ['b2', 'ok']], '2026-03-01T00:00:00.000Z', { extra: (k, parent) => (k === 1 ? [{ type: 'system', subtype: 'turn_duration', uuid: uuidN(50), parentUuid: parent, timestamp: '2026-03-09T00:00:00.000Z' }] : []) }));
  writeFileSync(join(dir, 'c.jsonl'), session([['c', 'ok']], '2026-03-02T00:00:00.000Z'));
  writeFileSync(join(dir, 'd.jsonl'), session([['d', 'ok']], '2026-03-01T00:00:00.000Z'));
  writeFileSync(join(dir, 'e.jsonl'), session([['e', 'ok']], null));
  return dir;
}

test('order: newest first by the time a session started; --oldest reverses the dated ones; undated last in both; ties in the order read', () => {
  const dir = orderFolder();
  try {
    const names = (args) => ltms(['index', ...args, dir]).lines.slice(1).map((l) => basename(l.path, '.jsonl'));
    assert.deepEqual(names([]), ['a', 'c', 'b', 'd', 'e']);
    assert.deepEqual(names(['--oldest']), ['b', 'd', 'c', 'a', 'e']);
    // started, not last active: b's last is the latest of all, and it stays among the 03-01 pair
    const b = ltms(['index', dir]).lines.slice(1).find((l) => basename(l.path) === 'b.jsonl');
    assert.deepEqual([b.first, b.last], ['2026-03-01T00:00:01.000Z', '2026-03-09T00:00:00.000Z']);
    assert.equal(ltms(['index', dir]).lines[0].shown.order, 'newest');
  } finally { rm(dir); }
});

test('paging: following next from --max 1 prints every session exactly once, in order; --max 0 prints them all; --skip past the end prints none', () => {
  const dir = orderFolder();
  try {
    const all = ltms(['index', '--max', '0', dir]).lines.slice(1).map((l) => l.path);
    assert.equal(all.length, 5);
    const seen = [];
    let r = ltms(['index', '--max', '1', dir]);
    for (let i = 0; i < 10; i++) {
      seen.push(...r.lines.slice(1).map((l) => l.path));
      const next = r.lines[0].next;
      if (next === null) { assert.equal(r.lines[0].left, 0); break; }
      const m = /^ltms index --skip (\d+) --max (\d+) (.+)$/.exec(next);
      assert.ok(m, next);
      assert.equal(m[3], dir);
      r = ltms(['index', '--skip', m[1], '--max', m[2], dir]);
    }
    assert.deepEqual(seen, all);
    const past = ltms(['index', '--skip', '9', dir]);
    assert.deepEqual([past.lines.length, past.lines[0].shown, past.lines[0].left, past.lines[0].next], [1, { skipped: 5, sessions: 0, order: 'newest' }, 0, null]);
    assert.match(past.err, /: --skip 9 passes over all 5\.\n$/);
  } finally { rm(dir); }
});

// ---- usage and messages -----------------------------------------------------------------------------------------

test('usage: an unknown option, a value missing or not a number, -, and no path are usage errors (exit 2, nothing on stdout); -h and -v work', () => {
  for (const [args, re] of [
    [['index', '--frob', FIX], /unknown option '--frob'\. The options are --max <n>, --skip <n> and --oldest/],
    [['index', '--max'], /--max needs a number after it/],
    [['index', '--skip', 'x', FIX], /--skip takes a whole number of sessions/],
    [['index', '--oldest=1', FIX], /--oldest takes no value/],
    [['index', '-'], /reading from standard input \('-'\) is not supported/],
    [['index'], /^ltms index: no path given\. Give the transcripts' folder or files/],
  ]) {
    const r = ltms(args);
    assert.deepEqual([r.code, r.out], [2, ''], args.join(' '));
    assert.match(r.err, re, args.join(' '));
  }
  for (const h of ['-h', '--help']) { const r = ltms(['index', h]); assert.equal(r.code, 0); assert.match(r.out, /^ltms index <path>\.\.\./); }
  assert.equal(ltms(['index', '-v']).out, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version + '\n');
});

test('no path: the message gives the command with this directory\'s project folder; with a relative CLAUDE_CONFIG_DIR that starts with -, the commands search and index give put -- before it, ls too (0.1.2 known limit 1, the part these two share)', () => {
  const dir = tmp();
  try {
    const cfg = '-cfg', name = dir.replace(/[^A-Za-z0-9]/g, '-');
    mkdirSync(join(dir, cfg, 'projects', name), { recursive: true });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
    const ix = ltms(['index'], { cwd: dir, env });
    assert.match(ix.err, new RegExp(`this directory's project folder is '-cfg/projects'/${name}: ltms index -- '-cfg/projects'/${name}$`, 'm'));
    const se = ltms(['search', 'word'], { cwd: dir, env });
    assert.match(se.err, new RegExp(`ltms search -- 'word' '-cfg/projects'/${name}$`, 'm'));
    // the command as printed runs, from that directory, in sh
    const cmd = /: (ltms index -- .*)$/m.exec(ix.err)[1];
    const sh = spawnSync('sh', ['-c', `ltms() { "${process.execPath}" "${CLI}" "$@"; }; ${cmd}`], { encoding: 'utf8', cwd: dir, env });
    assert.equal(sh.status, 0, sh.stderr);
    rmSync(join(dir, cfg, 'projects', name), { recursive: true });
    const gone = ltms(['index'], { cwd: dir, env });
    assert.match(gone.err, /which does not exist; ls -- '-cfg\/projects' lists the project folders: ltms index -- '-cfg\/projects'\/<folder>$/m);
  } finally { rm(dir); }
});

test('no content: no line of stdout or stderr holds a word planted in every text field', () => {
  const dir = tmp();
  try {
    const W = 'zqxplanted';
    const text = session([[`${W} prompt`, `${W} reply`]], '2026-05-01T00:00:00.000Z', { extra: (k, parent) => [
      { type: 'assistant', uuid: uuidN(90 + k), parentUuid: parent, requestId: 'req_t', message: { role: 'assistant', content: [{ type: 'thinking', thinking: W }, { type: 'tool_use', id: `t${k}`, name: 'Bash', input: { command: `${W} cmd` } }] } },
      { type: 'user', uuid: uuidN(95 + k), parentUuid: uuidN(90 + k), toolUseResult: { stdout: W }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: `${W} out`, is_error: true }] } },
      { type: 'system', subtype: 'compact_boundary', uuid: uuidN(97 + k), parentUuid: null, logicalParentUuid: uuidN(95 + k), content: W },
      { type: 'user', uuid: uuidN(98 + k), parentUuid: uuidN(97 + k), isCompactSummary: true, message: { role: 'user', content: `${W} summary` } },
    ] });
    writeFileSync(join(dir, 's.jsonl'), text);
    const r = ltms(['index', dir]);
    assert.equal(r.code, 0, r.err);
    assert.ok(text.split(W).length > 8);
    assert.ok(!(r.out + r.err).includes(W));
    assert.equal(r.lines[1].failures, 1);
    assert.equal(r.lines[1].compactions.length, 1);
  } finally { rm(dir); }
});

test('the printed commands (next, and the no-path message\'s) run as printed in sh, bash and fish for paths with a quote, a backslash, a trailing backslash, a space, a newline and a leading dash (one quoting rule, 0.1.2 known limit 9)', () => {
  const shells = ['sh', 'bash', 'zsh', 'fish'].filter((s) => spawnSync('sh', ['-c', `command -v ${s}`]).status === 0);
  assert.ok(shells.includes('sh') && shells.includes('bash'));
  const base = tmp();
  try {
    for (const name of ["it's", 'back\\slash', 'trail\\', 'a b', 'new\nline', '-dash', '=eq', '%self']) {
      const d = join(base, name);
      mkdirSync(d);
      writeFileSync(join(d, 'x.jsonl'), session([['x', 'ok']], '2026-03-01T00:00:00.000Z'));
      writeFileSync(join(d, 'y.jsonl'), session([['y', 'ok']], '2026-03-02T00:00:00.000Z'));
      const arg = name.startsWith('-') ? ['--', name] : [name];
      const first = ltms(['index', '--max', '1', ...arg], { cwd: base });
      assert.equal(first.code, 0, first.err);
      // search's next, printed by the same rule: red on 0.1.2 in fish for the paths that hold a backslash
      const hit = ltms(['search', '--max', '1', ...(name.startsWith('-') ? ['--'] : []), 'ok', name], { cwd: base });
      assert.equal(hit.code, 0, hit.err);
      for (const [next, want] of [[first.lines[0].next, (lines) => lines.slice(1).map((l) => basename(l.path))], [hit.lines[0].next, (lines) => lines.filter((l) => l.k === 'file').map((l) => basename(l.path))]]) {
        assert.ok(next, name);
        for (const shell of shells) {
          const def = shell === 'fish' ? `function ltms; '${process.execPath}' '${CLI}' $argv; end; ` : `ltms() { "${process.execPath}" "${CLI}" "$@"; }; `;
          const r = spawnSync(shell, ['-c', def + next], { encoding: 'utf8', cwd: base });
          assert.equal(r.status, 0, `${shell} ${JSON.stringify(name)}: ${next}: ${r.stderr}`);
          const lines = r.stdout.split('\n').filter((l) => l).map((l) => JSON.parse(l));
          assert.deepEqual(want(lines), ['x.jsonl'], `${shell} ${JSON.stringify(name)}: ${next}`);
        }
      }
    }
  } finally { rm(base); }
});

test('v2: names that differ only in bytes that are not UTF-8 count apart (links, agent transcripts), and a file reached through a linked argument counts once (counts by device and inode)', () => {
  const dir = tmp();
  try {
    const p = join(dir, 'proj'), sub = join(p, S1, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(p, `${S1}.jsonl`), session([['go', 'ok']], '2026-03-01T00:00:00.000Z'));
    for (const b of [0xff, 0xfe]) {
      writeFileSync(Buffer.concat([Buffer.from(sub + '/agent-'), Buffer.from([b]), Buffer.from('.jsonl')]), session([['go', 'ok']], null));
      symlinkSync(join(p, `${S1}.jsonl`), Buffer.concat([Buffer.from(p + '/link'), Buffer.from([b])]));
    }
    const r = ltms(['index', p]);
    assert.equal(r.code, 0, r.err);
    // the two links sit in the project folder, not in the session's own directory: its agents are the two transcripts
    assert.deepEqual([r.lines[0].files.symlinks, r.lines[0].files.sessionParts, r.lines[1].agents], [2, 2, 2]);
    assert.equal(ltms(['search', '--count', 'go', p]).lines[0].files.symlinks, 2);
    // the same folder given again through a link: the files once
    symlinkSync(p, join(dir, 'plink'));
    const twice = ltms(['index', p, join(dir, 'plink')]).lines[0];
    assert.deepEqual([twice.files.found, twice.files.read, twice.files.sessionParts, twice.files.symlinks], [3, 1, 2, 2]);
  } finally { rm(dir); }
});

test('v2: a link inside a session\'s own directory makes its agents unknown (null); a set-aside copy whose name is not UTF-8 is counted, not failed; a directory that cannot be read, reached twice, is reported and counted once', { skip: process.getuid?.() === 0 ? 'running as root' : false }, () => {
  const { dir, p } = project();
  const locked = join(dir, 'locked');
  try {
    symlinkSync(join(p, 'other'), join(p, S1, 'subagents', 'elsewhere'));
    writeFileSync(Buffer.concat([Buffer.from(join(p, S2)), Buffer.from('.orphaned-1-'), Buffer.from([0xff]), Buffer.from('.jsonl')]), session([['go', 'ok']], null));
    const r = ltms(['index', p]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.slice(1).find((l) => basename(l.path) === `${S1}.jsonl`).agents, null);
    assert.equal(r.lines[0].files.setAside, 3);
    mkdirSync(join(locked, 'in'), { recursive: true });
    chmodSync(join(locked, 'in'), 0o000);
    const f = ltms(['index', locked, locked]);
    assert.equal(f.lines[0].files.failed, 1);
    assert.equal(f.err.split('\n').filter((l) => l.includes('cannot read the directory')).length, 1);
  } finally { try { chmodSync(join(locked, 'in'), 0o700); } catch { /* not made */ } rm(dir); }
});

test('v2: a timestamp shaped like ISO 8601 that is not a time (month 13) prints (withheld) and sorts with the undated, in index and in search\'s file line', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.jsonl'), session([['go', 'ok']], '2026-03-03T00:00:00.000Z'));
    writeFileSync(join(dir, 'b.jsonl'), session([['go', 'ok']], null).split('\n').map((x) => { if (!x) return x; const r = JSON.parse(x); if (r.uuid) r.timestamp = '2026-13-01T00:00:00.000Z'; return JSON.stringify(r); }).join('\n'));
    const r = ltms(['index', dir]);
    assert.deepEqual(r.lines.slice(1).map((l) => [basename(l.path), l.first]), [['a.jsonl', '2026-03-03T00:00:01.000Z'], ['b.jsonl', '(withheld)']]);
    assert.deepEqual(ltms(['search', 'go', dir]).lines.filter((l) => l.k === 'file').map((l) => [basename(l.path), l.last]), [['a.jsonl', '2026-03-03T00:00:02.000Z'], ['b.jsonl', '(withheld)']]);
  } finally { rm(dir); }
});

test('v2 (V-A8): the pin directory notice\'s command lists the sessions pinned there; next under --oldest, followed to the end, prints every session once in that order; a directory holding only a set-aside copy or only a pin directory is not "without .jsonl"', () => {
  const { dir, p } = project();
  try {
    const r = ltms(['index', p]);
    const cmd = new RegExp(`To list the sessions pinned there, give it: (ltms index .*)$`, 'm').exec(r.err)[1];
    const sh = spawnSync('sh', ['-c', `ltms() { "${process.execPath}" "${CLI}" "$@"; }; ${cmd}`], { encoding: 'utf8' });
    assert.deepEqual(sh.stdout.split('\n').filter((l) => l.startsWith('{"k":"session"')).map((l) => basename(JSON.parse(l).path)), [`${S2}.jsonl`]);
    const all = ltms(['index', '--oldest', '--max', '0', p]).lines.slice(1).map((l) => l.path), seen = [];
    let x = ltms(['index', '--oldest', '--max', '1', p]);
    for (let i = 0; i < 10 && x.lines[0]; i++) {
      seen.push(...x.lines.slice(1).map((l) => l.path));
      if (!x.lines[0].next) break;
      assert.match(x.lines[0].next, /^ltms index --oldest --skip \d+ --max 1 /);
      const m = /--skip (\d+)/.exec(x.lines[0].next);
      x = ltms(['index', '--oldest', '--skip', m[1], '--max', '1', p]);
    }
    assert.deepEqual(seen, all);
    for (const only of ['aside', 'pinned']) {
      const d = join(dir, only);
      mkdirSync(join(d, 'store'), { recursive: true });
      if (only === 'aside') writeFileSync(join(d, `${S1}.orphaned-1-ab.jsonl`), session([['go', 'ok']], null));
      else { writeFileSync(join(d, 'store', 'PINS.log'), ''); writeFileSync(join(d, 'store', 'x.jsonl'), session([['go', 'ok']], null)); }
      assert.doesNotMatch(ltms(['index', d]).err, /holds no \.jsonl file/, only);
    }
  } finally { rm(dir); }
});

test('v2 (V-A8): a summary after a second boundary is not the first boundary\'s', () => {
  const u = uuidN;
  const B = (uuid, parent) => ({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: parent });
  const doc = [{ type: 'user', uuid: u(1), parentUuid: null, promptSource: 'typed', message: { role: 'user', content: 'go' } },
    B(u(2), u(1)), { ...B(u(3), u(2)), parentUuid: u(2), logicalParentUuid: undefined },
    { type: 'user', uuid: u(4), parentUuid: u(3), isCompactSummary: true, message: { role: 'user', content: 's' } },
    { type: 'last-prompt', leafUuid: u(4) }].map((r) => JSON.stringify(r)).join('\n') + '\n';
  assert.deepEqual(lib.indexTranscript(doc).compactions, [{ boundary: 'L2', summary: null }, { boundary: 'L3', summary: 'L4' }]);
});

test('stdout closed early (| head -1): index stops quietly, exit 0', () => {
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${CLI}" index --max 0 "${FIX}" | head -1`], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\{"k":"coverage"/);
  assert.ok(!/EPIPE|Error/.test(r.stderr), r.stderr);
});
