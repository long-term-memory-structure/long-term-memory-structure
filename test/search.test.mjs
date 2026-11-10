// Tests for the search library (src/search.ts), run against the built dist/search.js (build first).
//
// The fixtures are synthetic, written by test/make-fixtures.mjs ("the search fixtures"), with invented text: a planted
// zqk* word marks where a term must be found, or must not be. Every expected value comes from how the fixture was
// built: lines, offsets and counts are written out by hand beside each assertion, and each offset is also checked
// against the raw record read with JSON.parse alone. Two instruments stand beside the hand-written answers: a reference
// of DESIGN v2 section 3.3 written here with whole-string operations (no offsets, no prefilter, no fast path), and the
// turns skeleton prints (the CLI, spawned). Every character outside ASCII, and every backslash of a JSON escape, is
// built from code points, never typed.
//
// Section 12 tests the command, `ltms search` (stage B2), spawned as a user runs it, on folders of synthetic sessions
// written by the tests themselves (session() there), with a planted zqc* word where a hit must be.
//
// LTMS_DIST=<a dist directory> runs the same tests against another build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, chmodSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DIST = process.env.LTMS_DIST || join(root, 'dist');
const SEARCH_URL = pathToFileURL(join(DIST, 'search.js')).href;
const S = await import(SEARCH_URL);
const P = await import(pathToFileURL(join(DIST, 'parser.js')).href);
const CLI = join(DIST, 'cli.js');
const fixture = (name) => join(here, 'fixtures', name);
const read = (name) => readFileSync(fixture(name), 'utf8');
const cp = (...c) => String.fromCodePoint(...c);
const BSL = String.fromCharCode(92), NL = String.fromCharCode(10), TAB = String.fromCharCode(9);
const MC = ['message', 'content'];

const query = (text, opts = {}) => S.parseSearchQuery(text, opts);
const find = (name, text, { mode, kinds, prefix, segmenter } = {}) =>
  S.searchTranscript(read(name), query(text, { mode, segmenter }), { kinds, prefix });
const lineOf = (a) => Number(a.slice(a.lastIndexOf('L') + 1));
/** A result's hits, compact: [ta, [[line, kind, field, at, w], ...]] per turn. */
const compact = (r) => r.turns.map((h) => [h.ta, h.entries.map((e) => [lineOf(e.a), e.kind, e.field, e.at, e.w])]);
/** A fixture's line, read with JSON.parse alone. */
const rawLine = (name, line) => JSON.parse(read(name).split('\n')[line - 1]);
const valueAt = (rec, path) => path.reduce((v, k) => (v === undefined || v === null ? undefined : v[k === '(withheld)' ? Object.keys(v).find((x) => !/^[\w.:+-]{1,64}$/.test(x)) : k]), rec);
/** The values at a key path, where a (withheld) step stands for any key there: a key below a tool's parameter, or
 *  one that fails the label rule, is not printed, so the path cannot name it. */
const valuesAt = (rec, path) => path.reduce((vs, k) => vs.flatMap((v) => (v === null || typeof v !== 'object' ? [] : k === '(withheld)' ? Object.values(v) : [v[k]])), [rec]);
/** Checks every expected hit's `at` against the raw field: the planted word `word` (of the query) starts there. */
function atsAreThePlantedWord(name, expected, words) {
  for (const [, entries] of expected) for (const [line, , field, at, w] of entries) {
    const vs = valuesAt(rawLine(name, line), field).filter((v) => typeof v === 'string');
    assert.ok(vs.length, `${name} L${line} ${JSON.stringify(field)} is not a string`);
    const word = words[w[0]];
    if (/^[a-z]+$/.test(word)) assert.ok(vs.some((v) => v.indexOf(word) === at), `${name} L${line}: the word ${word} is not at ${at}`);
  }
}

// ---- 1. What each kind reads, and what nothing reads (search-kinds.jsonl) ------------------------------------------
// The fixture's lines (make-fixtures.mjs gives each): L1 a SessionStart hook attachment before the first prompt;
// L2 prompt (T001); L3 thinking; L4 reply; L5 call (with wire inputs); L6 result (with toolUseResult); L7 Stop hook
// summary; L8 isMeta; L9 attachment; L10 redacted thinking; L11 API error; L12 prompt with an image (T002); L13 call;
// L14 spilled result; L15 call with a key that fails the label rule; L16 result quoting the spill marker; L17 compaction
// boundary; L18 summary; L19 queued prompt; L20-L21 a rewound branch; L22 prompt (T003); L23 reply; L24 last-prompt;
// L25 queue-operation; L26 not JSON; L27 a replay of L4.
const K = 'search-kinds.jsonl';
const kindsTable = [
  ['zqkinput', undefined, [['T001', [[2, 'input', MC, 9, [0]]]]]],
  ['zqkthinking', undefined, [['T001', [[3, 'thinking', [...MC, 0, 'thinking'], 0, [0]]]]]],
  ['zqkreply', undefined, [['T001', [[4, 'reply', [...MC, 0, 'text'], 0, [0]]]]]],
  ['zqkcall', undefined, [['T001', [[5, 'call', [...MC, 0, 'input', 'command'], 9, [0]]]]]],
  ['zqkdesc', undefined, [['T001', [[5, 'call', [...MC, 0, 'input', 'description'], 15, [0]]]]]],
  ['zqkresult', undefined, [['T001', [[6, 'result', [...MC, 0, 'content'], 0, [0]]]]]],
  ['zqksystem', undefined, [['T001', [[7, 'system', ['hookInfos', 0, '(withheld)'], 17, [0]]]]]],   // a key below the record's own
  ['zqkapierror', undefined, [['T001', [[11, 'system', [...MC, 0, 'text'], 11, [0]]]]]],
  ['zqkimage', undefined, [['T002', [[12, 'input', [...MC, 0, 'text'], 12, [0]]]]]],
  ['zqkspill', undefined, [['T002', [[14, 'result', [...MC, 0, 'content'], 130, [0]]]]]],
  ['zqkkey', undefined, [['T002', [[15, 'call', [...MC, 0, 'input', '(withheld)'], 0, [0]]]]]],
  ['zqkquote', undefined, [['T002', [[16, 'result', [...MC, 0, 'content'], 56, [0]]]]]],
  ['compacted', undefined, [['T002', [[17, 'system', ['content'], 13, [0]]]]]],
  ['zqksummary', undefined, [['T002', [[18, 'summary', MC, 0, [0]]]]]],
  ['zqkqueued', undefined, [['T002', [[19, 'input', ['attachment', 'prompt', 0, 'text'], 0, [0]]]]]],
  ['zqkthird', undefined, [['T003', [[22, 'input', MC, 8, [0]], [23, 'reply', [...MC, 0, 'text'], 4, [0]]]]]],
  // two terms between a prompt and its reply: ANDed over the turn
  ['zqkleft zqkright', undefined, [['T003', [[22, 'input', MC, 24, [0]], [23, 'reply', [...MC, 0, 'text'], 33, [1]]]]]],
  ['zqkinput zqkresult', undefined, [['T001', [[2, 'input', MC, 9, [0]], [6, 'result', [...MC, 0, 'content'], 0, [1]]]]]],
  // two terms in two turns, and a phrase across two records: no turn holds them
  ['zqkinput zqkthird', undefined, []],
  // a word inside another is not a word (input is the end of zqkinput); --substring is the mode that finds it
  ['input', undefined, []],
  ['"zqkleft zqkright"', undefined, []],
  // the default leaves out meta and attachment; naming them, or all, brings them in
  ['zqkhook', undefined, []], ['zqkmeta', undefined, []], ['zqkattach', undefined, []],
  ['zqkhook', S.SEARCH_KINDS, [['T001', [[1, 'attachment', ['attachment', 'content'], 0, [0]]]]]],
  ['zqkmeta', S.SEARCH_KINDS, [['T001', [[8, 'meta', MC, 0, [0]]]]]],
  ['zqkattach', S.SEARCH_KINDS, [['T001', [[9, 'attachment', ['attachment', 'content', 0, '(withheld)'], 0, [0]]]]]],   // below its own keys
  ['zqkmeta', ['meta'], [['T001', [[8, 'meta', MC, 0, [0]]]]]],
  ['zqkinput', ['meta'], []],
];
// never searched, in any kind: wire inputs, toolUseResult, redacted thinking, image data, a rewound branch, side records,
// an unreadable line
const neverFound = ['zqkwire', 'zqktur', 'zqkredacted', 'zqkbase64', 'zqkrewound', 'zqkqueueop', 'zqkbad'];

test('kinds: every kind of text is found where it was written, with its key path and offset, and only there', () => {
  for (const [text, kinds, expected] of kindsTable) {
    assert.deepEqual(compact(find(K, text, { kinds })), expected, `query ${text}${kinds ? ' kinds ' + kinds.join(',') : ''}`);
    atsAreThePlantedWord(K, expected, query(text).terms.map((t) => t.text));
  }
});

test('kinds: what is never searched (wire inputs, toolUseResult, redacted thinking, image data, a rewound branch, side records, an unreadable line)', () => {
  for (const word of neverFound) for (const kinds of [undefined, S.SEARCH_KINDS]) {
    assert.deepEqual(compact(find(K, word, { kinds })), [], `${word} was found${kinds ? ' with every kind' : ''}`);
    assert.deepEqual(compact(find(K, word, { kinds, mode: 'substring' })), [], `${word} was found by --substring${kinds ? ' with every kind' : ''}`);
  }
});

test('kinds: the counts of search-kinds.jsonl, by default, with every kind and with input alone, and the invariant', () => {
  // 27 lines: 26 records (L26 is not JSON), of which L24-L25 are side records and L27 a replay; 23 envelope records,
  // L20-L21 off the path; 21 in turns: T001 L1-L11, T002 L12-L19, T003 L22-L23. By default L1 (attachment), L8 (meta)
  // and L9 (attachment) hold only text of kinds left out; L10 (redacted thinking only) holds no text and is searched.
  const notSearched = { offPath: 2, toolUseResult: 3, wireInputs: 1, redactedThinking: 1, sidecars: 2, images: 1, spilled: 1, replays: 1,
    beforeFirstTurn: 0, unreadableLines: 1, kindsOff: 3 };
  const r = find(K, 'zqkthird');
  assert.deepEqual(r.counts, {
    parsed: 26, turns: 3, searched: 18, notSearched,
    hits: { turns: 1, records: 2, byKind: { input: 1, summary: 0, reply: 1, thinking: 0, call: 0, result: 0, system: 0 } }, gapScripts: {},
  });
  const all = find(K, 'zqkthird', { kinds: S.SEARCH_KINDS });
  assert.deepEqual([all.counts.searched, all.counts.notSearched.kindsOff], [21, 0]);
  assert.deepEqual(Object.keys(all.counts.hits.byKind), [...S.SEARCH_KINDS]);
  // input alone: L2, L12, L19 (the queued prompt) and L22 hold input text; L10 holds none: 5 searched, 16 kindsOff
  const input = find(K, 'zqkthird', { kinds: ['input'] });
  assert.deepEqual([input.counts.searched, input.counts.notSearched.kindsOff], [5, 16]);
  assert.deepEqual(input.counts.hits, { turns: 1, records: 1, byKind: { input: 1 } });
  for (const x of [r, all, input]) {
    const c = x.counts, n = c.notSearched;
    assert.equal(c.searched + n.offPath + n.replays + n.beforeFirstTurn + n.sidecars + n.kindsOff, c.parsed);
  }
  assert.equal(r.last, '2026-09-01T09:00:30.000Z');   // the queue-operation's time: the latest in the file
  assert.equal(r.fileKind, 'transcript');
});

test('kinds: a system record\'s envelope keys and an attachment record\'s envelope are never read (cwd, branch, version, session id)', () => {
  // every record of the fixture carries cwd /work/demo-project, gitBranch main, version 2.0.0 and the session id in its
  // envelope; no system record (L7, L17) and no attachment object (L1, L9, L19) holds any of them
  const envelope = ['demo-project', 'main', '2.0.0', 'f1f1f1f1-2a2a-4b3b-8c4c-5d5d5d5d5d5d', 'external', 'cli'];
  for (const word of envelope) for (const kinds of [['system'], ['attachment'], ['system', 'attachment']]) {
    assert.deepEqual(compact(find(K, word, { kinds })), [], `${word} in ${kinds.join(',')}`);
    // --substring finds main inside the attachment's own "remaining"; the other values occur in no field but the envelope
    if (word !== 'main') assert.deepEqual(compact(find(K, word, { kinds, mode: 'substring' })), [], `${word} in ${kinds.join(',')}, --substring`);
  }
  // what a system record does hold besides its envelope is read (a nested command: zqksystem in the table above), but
  // not its subtype and level, which are names from a fixed list (the repair round, decision c)
  assert.deepEqual(compact(find(K, 'stop_hook_summary', { kinds: ['system'] })), []);
  assert.deepEqual(rawLine(K, 7).subtype, 'stop_hook_summary');
});

test('kinds: a spilled result is one whose text begins with the marker after leading white space; one that quotes it mid-text is not', () => {
  const v14 = valueAt(rawLine(K, 14), [...MC, 0, 'content']), v16 = valueAt(rawLine(K, 16), [...MC, 0, 'content']);
  assert.ok(v14.startsWith(NL + '<persisted-output>') && v16.indexOf('<persisted-output>') > 0);
  assert.equal(find(K, 'zqkspill').counts.notSearched.spilled, 1);
});

// ---- 2. A turn's records are skeleton's ---------------------------------------------------------------------------

test('turns: a parallel call whose call and result records are off the path is searched in its turn (parallel.jsonl)', () => {
  // L1 prompt; L2 and L3 the two calls of one response; L4 the second call's result (written first) and L3 are off the
  // path, which runs L1 L2 L5 L6. Skeleton gives both calls to T001.
  assert.deepEqual(compact(find('parallel.jsonl', 'second')), [['T001', [[4, 'result', [...MC, 0, 'content'], 13, [0]]]]]);
  assert.deepEqual(compact(find('parallel.jsonl', 'two.txt')), [['T001', [[3, 'call', [...MC, 0, 'input', 'file_path'], 19, [0]]]]]);
  const c = find('parallel.jsonl', 'second').counts;
  assert.deepEqual([c.parsed, c.searched, c.notSearched.offPath, c.notSearched.sidecars], [7, 6, 0, 1]);
});

test('turns: a call given to an earlier turn takes its records from the next turn\'s path (request-two-turns.jsonl)', () => {
  // L1 prompt (T001); L2 call one; L3 the queued prompt (T002); L4 call two, of L2's response; L5 and L6 the results; L7
  // the reply. Skeleton gives both calls to T001, so L4, L5 and L6 are T001's, and T002 holds L3 and L7.
  assert.deepEqual(compact(find('request-two-turns.jsonl', 'second')), [['T001', [[6, 'result', [...MC, 0, 'content'], 13, [0]]]]]);
  assert.deepEqual(compact(find('request-two-turns.jsonl', 'demo-two')), [['T001', [[4, 'call', [...MC, 0, 'input', 'command'], 5, [0]]]]]);
  assert.deepEqual(compact(find('request-two-turns.jsonl', 'queued')), [['T002', [[3, 'input', MC, 2, [0]]]]]);
  assert.deepEqual(compact(find('request-two-turns.jsonl', 'ran')), [['T002', [[7, 'reply', [...MC, 0, 'text'], 21, [0]]]]]);
  assert.deepEqual(compact(find('request-two-turns.jsonl', 'second queued')), []);
  assert.deepEqual(compact(find('request-two-turns.jsonl', 'first second')),
    [['T001', [[5, 'result', [...MC, 0, 'content'], 13, [0]], [6, 'result', [...MC, 0, 'content'], 13, [1]]]]]);
  // byKind counts turns: one turn, though two of its records hold results with a term
  assert.deepEqual(find('request-two-turns.jsonl', 'first second').counts.hits,
    { turns: 1, records: 2, byKind: { input: 0, summary: 0, reply: 0, thinking: 0, call: 0, result: 1, system: 0 } });
});

test('turns: records before the first prompt are T001\'s; in a file with no input turn they are counted, and nothing matches', () => {
  assert.deepEqual(compact(find(K, 'zqkhook', { kinds: ['attachment'] })), [['T001', [[1, 'attachment', ['attachment', 'content'], 0, [0]]]]]);
  const r = find('search-noturn.jsonl', 'zqknoturn', { kinds: S.SEARCH_KINDS });
  assert.deepEqual(r.turns, []);
  assert.deepEqual([r.counts.parsed, r.counts.turns, r.counts.searched, r.counts.notSearched.beforeFirstTurn, r.counts.notSearched.offPath], [3, 0, 0, 3, 0]);
});

/** Every .jsonl under test/fixtures, the review set included. */
const allFixtures = (() => {
  const walk = (d) => readdirSync(d).sort().flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : n.endsWith('.jsonl') ? [p] : []; });
  return walk(join(here, 'fixtures'));
})();
/** From skeleton's own output (the CLI, spawned) and the parser's repaired path: the turn number of each line, by the
 *  design's rule (a prompt is its turn's; then the call and result lines skeleton gives a turn; then each path line not
 *  taken goes to the turn of the prompt before it, or to T001). */
function skeletonOwners(file) {
  const sk = spawnSync(process.execPath, [CLI, 'skeleton', file], { encoding: 'utf8', timeout: 20000 });
  const lines = sk.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const num = (ta) => Number(ta.slice(ta.lastIndexOf(':T') + 2));
  const line = (a) => Number(a.slice(a.lastIndexOf(':L') + 2));
  const owner = new Map(), ch = new Map(), prompts = new Map();
  for (const l of lines) if (l.k === 'turn') { owner.set(line(l.a), num(l.ta)); prompts.set(line(l.a), num(l.ta)); ch.set(num(l.ta), l.ch); }
  for (const l of lines) if (l.k === 'call') {
    if (!owner.has(line(l.a))) owner.set(line(l.a), num(l.ta));
    if (l.r && !owner.has(line(l.r))) owner.set(line(l.r), num(l.ta));
  }
  if (prompts.size) {
    const t = P.parseTranscript(readFileSync(file, 'utf8'));
    let cur = 1;
    for (const n of P.repairedLivePath(t).path) {
      const L = t.positions[n.index].line;
      if (prompts.has(L)) { cur = prompts.get(L); continue; }
      if (!owner.has(L)) owner.set(L, cur);
    }
  }
  return { owner, ch };
}

test('turns: on every fixture, every entry sits in the turn skeleton gives its line, and every turn\'s ch is skeleton\'s', () => {
  let entries = 0, files = 0;
  for (const file of allFixtures) {
    const { owner, ch } = skeletonOwners(file);
    // the split of the envelope records: in turns (the reconstruction's lines), before the first turn (a file with no
    // turn: the distinct nodes of its path), off the path (the rest)
    const t0 = P.parseTranscript(readFileSync(file, 'utf8')), c = S.searchTranscript(t0, query('x')).counts;
    const before = owner.size ? 0 : new Set(P.repairedLivePath(t0).path).size;
    assert.deepEqual([c.notSearched.beforeFirstTurn, c.notSearched.offPath, c.searched + c.notSearched.kindsOff], [before, t0.nodes.size - owner.size - before, owner.size], file);
    if (!owner.size) continue;
    files++;
    const t = P.parseTranscript(readFileSync(file, 'utf8'));
    for (const letter of ['e', 'a', 'o', 't', 'i', 'n', 's', 'r', '1', '0']) {
      const r = S.searchTranscript(t, query(letter, { mode: 'substring' }), { kinds: S.SEARCH_KINDS });
      for (const h of r.turns) {
        const k = Number(h.ta.slice(1));
        assert.equal(h.ch, ch.get(k), `${file} ${h.ta}: ch`);
        for (const e of h.entries) { entries++; assert.equal(owner.get(lineOf(e.a)), k, `${file}: L${lineOf(e.a)} found in ${h.ta}`); }
      }
    }
  }
  assert.ok(files >= 70 && entries > 2000, `only ${files} files and ${entries} entries were checked`);
});

test('turns: a path that passes one record twice (a crafted bridge) counts it once, in a file with no input turn', () => {
  // L1 an earlier root (off the path); L3 an orphan (its parent is in no file), whose child L2 was written before it and
  // L4 after; the head is L4. The path climbs L4 L3, then bridges to L2, the record written just before the orphan, and
  // climbs L2 L3 again: L3 L2 L3 L4. No record opens a turn (no prompt): 3 distinct records before the first turn.
  const env = { isSidechain: false, userType: 'external', cwd: '/w', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  const u = (k) => `cc000000-0000-4000-8000-00000000000${k}`;
  const reply = (k, parent, text) => JSON.stringify({ parentUuid: parent, ...env, type: 'assistant', message: { id: `m${k}`, role: 'assistant', content: [{ type: 'text', text }] }, requestId: `r${k}`, uuid: u(k), timestamp: `2026-08-01T00:00:0${k}.000Z` });
  const text = [reply(1, null, 'an invented earlier root'), reply(2, u(3), 'invented, written before its parent'),
    JSON.stringify({ parentUuid: u(9), ...env, type: 'user', message: { role: 'user', content: 'an invented harness note' }, isMeta: true, uuid: u(3), timestamp: '2026-08-01T00:00:03.000Z' }),
    reply(4, u(3), 'invented, the head'), JSON.stringify({ type: 'last-prompt', leafUuid: u(4) })].join(NL) + NL;
  const t = P.parseTranscript(text), path = P.repairedLivePath(t).path;
  assert.deepEqual(path.map((n) => t.positions[n.index].line), [3, 2, 3, 4]);
  const c = S.searchTranscript(t, query('invented'), { kinds: S.SEARCH_KINDS }).counts;
  assert.deepEqual([c.parsed, c.turns, c.notSearched.beforeFirstTurn, c.notSearched.offPath, c.notSearched.sidecars, c.searched], [5, 0, 3, 1, 1, 0]);
});

// ---- 3. The invariant, on every fixture ------------------------------------------------------------------------------

test('invariant: on every fixture, records parsed = searched + offPath + replays + beforeFirstTurn + sidecars + kindsOff, each counted apart', () => {
  for (const file of allFixtures) {
    const text = readFileSync(file, 'utf8');
    // counted here with JSON.parse alone: records, side records (no uuid and parentUuid), replays (a uuid seen before),
    // and lines that are not a JSON object
    let parsed = 0, sidecars = 0, replays = 0, unreadable = 0;
    const seen = new Set();
    for (const l of text.split('\n')) {
      if (l.trim() === '') continue;
      let o;
      try { o = JSON.parse(l); } catch { unreadable++; continue; }
      if (typeof o !== 'object' || o === null || Array.isArray(o)) { unreadable++; continue; }
      parsed++;
      if (!(typeof o.uuid === 'string' && 'parentUuid' in o)) { sidecars++; continue; }
      if (seen.has(o.uuid)) replays++; else seen.add(o.uuid);
    }
    for (const kinds of [undefined, S.SEARCH_KINDS, ['input']]) {
      const c = S.searchTranscript(text, query('zqk'), { kinds }).counts, n = c.notSearched;
      const name = `${file.slice(here.length)}${kinds ? ' ' + kinds.length + ' kinds' : ''}`;
      assert.deepEqual([c.parsed, n.sidecars, n.replays, n.unreadableLines], [parsed, sidecars, replays, unreadable], name);
      assert.equal(c.searched + n.offPath + n.beforeFirstTurn + n.kindsOff, parsed - sidecars - replays, name);
      assert.equal(c.searched + n.offPath + n.replays + n.beforeFirstTurn + n.sidecars + n.kindsOff, c.parsed, name);
    }
  }
});

// ---- 4. JSON escapes (search-escapes.jsonl) -----------------------------------------------------------------------
// The results, each L(odd), as written in the record: L3 {"text":"done\nzqkglued: failed"} with a backslash and an n;
// L5 'name: ' and the four backslash-u escapes of a Hebrew word; L7 a surrogate pair, then a lone surrogate; L9 two
// invalid escapes and a backslash-t; L11 a Windows path; L13 phrases in each form and an escaped backslash before an n.
const E = 'search-escapes.jsonl';
const R = [...MC, 0, 'content'];
const SHALOM = cp(0x5e9, 0x5dc, 0x5d5, 0x5dd);
const escapesTable = [
  ['zqkglued', undefined, [['T001', [[3, 'result', R, 15, [0]]]]]],       // decoded; at the z after the escape
  [SHALOM, undefined, [['T001', [[5, 'result', R, 6, [0]]]]]],              // decoded; at its first escape
  ['zqkpair', undefined, [['T001', [[7, 'result', R, 17, [0]]]]]],          // after a joined surrogate pair
  ['zqklone', undefined, [['T001', [[7, 'result', R, 35, [0]]]]]],          // after a lone surrogate, kept
  ['zqkinvalid', undefined, []], ['zqkshort', undefined, []],                // an invalid escape stays as written
  ['zqktab', undefined, [['T001', [[9, 'result', R, 39, [0]]]]]],
  ['new', undefined, [['T001', [[11, 'result', R, 3, [0]]]]]],             // the written form reads C:\new right
  ['ew', undefined, [['T001', [[11, 'result', R, 4, [0]]]]]],              // the decoded form makes a new line of it
  ['zqkpath', undefined, [['T001', [[11, 'result', R, 7, [0]]]]]],
  ['"zqkone zqktwo"', undefined, [['T001', [[13, 'result', R, 0, [0]]]]]],  // a phrase in the decoded form
  ['"zqkone nzqktwo"', undefined, [['T001', [[13, 'result', R, 0, [0]]]]]], // a phrase in the written form
  ['"nzqkaa zqkbb zqkcc"', undefined, []],                                  // only the two forms together hold it
  ['nzqkaa zqkcc', undefined, [['T001', [[13, 'result', R, 21, [0, 1]]]]]], // two words, one in each form
  ['zqkliteral', undefined, []],                                            // an escaped backslash, then a plain n
  ['zqkliteral', 'substring', [['T001', [[13, 'result', R, 48, [0]]]]]],
  ['zqkglued', 'substring', [['T001', [[3, 'result', R, 15, [0]]]]]],
];

test('escapes: a field is searched as written and decoded, escape by escape; a word in either form, a phrase within one', () => {
  for (const [text, mode, expected] of escapesTable) assert.deepEqual(compact(find(E, text, { mode })), expected, `${mode ?? 'words'} ${text}`);
  // the offsets above, read off the raw records
  const v = (line) => valueAt(rawLine(E, line), R);
  assert.equal(v(3).indexOf('zqkglued'), 15);
  assert.equal(v(5).indexOf(BSL + 'u05e9'), 6);
  assert.deepEqual([v(7).indexOf('zqkpair'), v(7).indexOf('zqklone'), v(9).indexOf('zqktab'), v(11).indexOf('new'), v(11).indexOf('zqkpath')], [17, 35, 39, 3, 7]);
  assert.deepEqual([v(13).indexOf('nzqkaa'), v(13).indexOf('zqkliteral')], [21, 48]);
});

// ---- 5. Scripts and normalization (search-scripts.jsonl) -----------------------------------------------------------
// Turn k's reply is at line 2k; the strings are listed in make-fixtures.mjs in this order.
const SC = 'search-scripts.jsonl';
const HE = { house: cp(0x5d5, 0x5d4, 0x5d1, 0x5d9, 0x5ea), bayit: cp(0x5d1, 0x5d9, 0x5ea), fromcity: cp(0x5de, 0x5d4, 0x5e2, 0x5d9, 0x5e8),
  im: cp(0x5d9, 0x5dd), shalomb: cp(0x5d1, 0x5e9, 0x5dc, 0x5d5, 0x5dd), pointed: cp(0x5d5, 0x5b0, 0x5d4, 0x5b7, 0x5d1, 0x5b7, 0x5bc, 0x5d9, 0x5b4, 0x5ea) };
const AR = { kitab: cp(0x643, 0x62a, 0x627, 0x628), alkitab: cp(0x627, 0x644, 0x643, 0x62a, 0x627, 0x628), walkitab: cp(0x648, 0x627, 0x644, 0x643, 0x62a, 0x627, 0x628),
  mi: cp(0x645, 0x6cc), mikhaham: cp(0x645, 0x6cc, 0x62e, 0x648, 0x627, 0x647, 0x645) };
const ZH = { beijing: cp(0x5317, 0x4eac), daxue: cp(0x5927, 0x5b66), kaihui: cp(0x5f00, 0x4f1a) };
const JA = { tokyo: cp(0x6771, 0x4eac), coffee: cp(0x30b3, 0x30fc, 0x30d2, 0x30fc) };
const TH = { phasa: cp(0xe20, 0xe32, 0xe29, 0xe32), thai: cp(0xe44, 0xe17, 0xe22), maimi: cp(0xe44, 0xe21, 0xe48, 0xe21, 0xe35), kan: cp(0xe01, 0xe32, 0xe23),
  run: cp(0xe20, 0xe32, 0xe29, 0xe32, 0xe44, 0xe17, 0xe22, 0xe44, 0xe21, 0xe48, 0xe21, 0xe35, 0xe01, 0xe32, 0xe23, 0xe40, 0xe27, 0xe49, 0xe19, 0xe27, 0xe23, 0xe23, 0xe04) };
const EL = { odos: cp(0x3bf, 0x3b4, 0x3bf, 0x3c2), ODOS: cp(0x39f, 0x394, 0x39f, 0x3a3), kai: cp(0x3ba, 0x3b1, 0x3b9), alpha: cp(0x3b1) };
const KO = { hakgyo: cp(0xd559, 0xad50), hak: cp(0xd559), gyo: cp(0xad50) };
// [query, mode, [[turn, at], ...]]: each turn's reply holds the string; at is the match's place in it
const scriptsTable = [
  [HE.bayit, 'words', []], [HE.bayit, 'substring', [[1, 7], [3, 4]]],       // inside the prefixed word; in the pointed one, past the marks
  [HE.house, 'words', [[1, 5], [3, 0]]], [HE.pointed, 'words', [[1, 5], [3, 0]]], [HE.fromcity, 'words', [[1, 11]]],
  ['ltms', 'words', [[2, 1]]], ['api', 'words', [[2, 7]]], ['node', 'words', [[2, 11], [11, 17]]], [HE.im, 'words', [[2, 15]]],
  [HE.shalomb, 'words', [[3, 11]]],
  [AR.kitab, 'words', [[4, 8]]], [AR.walkitab, 'words', [[4, 0]]], [AR.alkitab, 'words', []], [AR.alkitab, 'substring', [[4, 1]]],
  [ZH.beijing, 'words', [[5, 5]]], [ZH.beijing + ZH.daxue, 'words', [[5, 5]]], [ZH.kaihui, 'words', [[5, 9]]], [ZH.daxue, 'words', [[5, 7], [6, 2]]],
  [JA.tokyo, 'words', [[6, 0]]], [JA.coffee, 'words', [[6, 5]]],
  [TH.phasa, 'words', [[7, 0]]], [TH.thai, 'words', [[7, 4]]], [TH.maimi, 'words', [[7, 7]]], [TH.kan, 'words', [[7, 12]]],
  [EL.odos, 'words', [[8, 0]]], [EL.ODOS, 'words', [[8, 0]]], [EL.kai, 'words', [[8, 5]]], [EL.alpha, 'words', [[8, 14]]],
  ['zqkbar', 'words', [[9, 7]]], ['zqkfoo', 'words', [[9, 0]]], ['zqkfoozqkbar', 'substring', []], ['"zqkfoo zqkbar"', 'substring', [[9, 0]]],
  ['zqkwide', 'words', [[10, 0]]], ['zqkfind', 'words', [[10, 8]]], ['zqkafter', 'words', [[10, 22]]], ['find', 'substring', [[10, 11]]], ['ind', 'substring', [[10, 11]]],
  ['node:sqlite', 'words', [[11, 17]]], ['sqlite', 'words', [[11, 22]]], ['2.1.314', 'words', [[11, 29]]], ['314', 'words', [[11, 33]]],
  ['Query', 'words', []], ['snake_case_name', 'words', [[11, 37]]], ['C++', 'words', [[11, 53]]],
  [KO.hakgyo, 'words', [[12, 0]]], [KO.hak, 'words', [[12, 3]]], [KO.gyo, 'substring', [[12, 1]]],   // the jamo word composes; a syllable inside one
  [AR.mikhaham, 'words', [[13, 0]]], [AR.mi, 'words', []], [AR.mi, 'substring', [[13, 0]]],          // a zero-width non-joiner joins
  ['cooperate', 'words', [[14, 0]]], ['coop', 'substring', [[14, 0]]],                               // a soft hyphen joins
];

test('scripts: prefixes, a prefix letter glued to Latin, points, al- and tatweel, CJK and Thai, final sigma, a zero-width space, full width, ligatures, code tokens, jamo', () => {
  for (const [text, mode, expected] of scriptsTable) {
    const r = find(SC, text, { mode });
    const got = r.turns.map((h) => { assert.equal(h.entries.length, 1, `${text}: one entry per turn`); return [Number(h.ta.slice(1)), h.entries[0].at]; });
    assert.deepEqual(got, expected, `${mode} ${text}`);
    for (const h of r.turns) assert.deepEqual([lineOf(h.entries[0].a), h.entries[0].kind, h.entries[0].field], [2 * Number(h.ta.slice(1)), 'reply', [...MC, 0, 'text']]);
  }
});

test('scripts: gapScripts counts the letters of each gap script the query holds, in the searched text, before normalization', () => {
  // by construction: Hebrew 10 + 4 + 10 (the points are marks, not letters); Arabic 7 + 4 + 7 (tatweel is Common, the
  // non-joiner is not a letter); Han 11 + 5; Thai 23 code points less 3 marks; Hangul 2 syllables and 3 jamo;
  // Katakana 2 (the long-vowel mark is Common)
  const cases = [[HE.bayit, { Hebrew: 24 }], [AR.kitab, { Arabic: 18 }], [ZH.beijing, { Han: 16 }], [TH.phasa, { Thai: 20 }], [KO.hakgyo, { Hangul: 5 }],
    [JA.coffee, { Katakana: 2 }], [HE.bayit + ' ' + ZH.beijing, { Hebrew: 24, Han: 16 }], ['ltms', {}]];
  for (const [text, gap] of cases) assert.deepEqual(find(SC, text).counts.gapScripts, gap, text);
  // letters that exist only as backslash-u escapes are counted in the decoded form (search-escapes.jsonl, L5: 4)
  assert.deepEqual(find(E, SHALOM).counts.gapScripts, { Hebrew: 4 });
  // the same counts, read off the raw replies with a regex alone
  const replies = read(SC).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.type === 'assistant').map((o) => o.message.content[0].text).join(' ');
  const letters = (script) => (replies.match(new RegExp(`(?=\\p{L})\\p{Script=${script}}`, 'gu')) ?? []).length;
  assert.deepEqual(['Hebrew', 'Arabic', 'Han', 'Thai', 'Hangul', 'Katakana'].map(letters), [24, 18, 16, 20, 5, 2]);
});

test('tokens: tokenizeForSearch gives each token and the offset of its first character in the raw string', () => {
  const tok = (s, o) => S.tokenizeForSearch(s, o).map((t) => [t.token, t.at]);
  assert.deepEqual(tok("The user's file doesn't"), [['the', 0], ['user', 4], ['s', 9], ['file', 11], ['doesn', 16], ['t', 22]]);
  assert.deepEqual(tok(cp(0x5d1) + 'ltms'), [[cp(0x5d1), 0], ['ltms', 1]]);                                // a script boundary
  assert.deepEqual(tok('v2 a1' + cp(0x5d1)), [['v2', 0], ['a1' + cp(0x5d1), 3]]);                         // no boundary at a digit
  assert.deepEqual(tok(EL.ODOS + '.' + cp(0x39a, 0x391, 0x399)), [[cp(0x3bf, 0x3b4, 0x3bf, 0x3c3), 0], [EL.kai, 5]]);
  assert.deepEqual(tok('foo' + cp(0x200b) + 'bar'), [['foo', 0], ['bar', 4]]);                             // U+200B is a break
  assert.deepEqual(tok('foo' + cp(0x200d) + 'bar'), [['foobar', 0]]);                                      // other format characters join
  assert.deepEqual(tok(cp(0xff26, 0xff35, 0xff2c, 0xff2c) + ' ' + cp(0xfb01) + 'le'), [['full', 0], ['file', 5]]);
  assert.deepEqual(tok('x ' + cp(0xbd)), [['x', 0], ['1', 2], ['2', 2]]);                                 // one character, two tokens
  assert.deepEqual(tok(cp(0x130) + 'stanbul stra' + cp(0xdf) + 'e STRASSE'), [['istanbul', 0], ['stra' + cp(0xdf) + 'e', 9], ['strasse', 16]]);
  assert.deepEqual(tok('a' + cp(0x301) + 'b ' + cp(0x301) + 'c'), [['ab', 0], ['c', 5]]);                // marks go; offsets stay raw
  assert.deepEqual(tok(cp(0x1112, 0x1161, 0x11a8) + ' ' + cp(0x1d419, 0x1d410, 0x1d40a) + ' x'), [[KO.hak, 0], ['zqk', 4], ['x', 11]]);
  assert.deepEqual(tok(cp(0x643, 0x640, 0x62a, 0x640, 0x627, 0x628)), [[AR.kitab, 0]]);                   // tatweel removed
  assert.deepEqual(tok('node:sqlite C++'), [['node', 0], ['sqlite', 5], ['c', 12]]);
  assert.deepEqual(tok(cp(0x1f44d) + ' ' + cp(0x2764, 0xfe0f)), []);
  assert.deepEqual(tok(''), []);
  // Thai and Chinese: the Segmenter's dictionary words (icu); with no-dictionary, a spaceless run stays whole
  assert.deepEqual(tok(TH.phasa + TH.thai, { segmenter: 'icu' }), [[TH.phasa, 0], [TH.thai, 4]]);
  assert.deepEqual(tok(TH.phasa + TH.thai, { segmenter: 'no-dictionary' }), [[TH.phasa + TH.thai, 0]]);
  assert.deepEqual(tok(ZH.beijing + ZH.daxue, { segmenter: 'icu' }), [[ZH.beijing, 0], [ZH.daxue, 2]]);
  // a spaceless run that is not NFC is segmented on its NFC text, and each token's offset maps back into the raw run
  const nfc = cp(0x6771, 0x4eac, 0x5927, 0x5b66, 0x3067, 0x30b3, 0x30fc, 0x30d2, 0x30fc, 0x3092, 0x98f2, 0x307f, 0x307e, 0x3057, 0x305f), nfd = nfc.normalize('NFD');
  assert.notEqual(nfd, nfc);
  const a = S.tokenizeForSearch(nfc, { segmenter: 'icu' }), b = S.tokenizeForSearch(nfd, { segmenter: 'icu' });
  assert.deepEqual(b.map((t) => t.token), a.map((t) => t.token));
  assert.deepEqual(b.map((t) => t.at), a.map((t) => nfc.slice(0, t.at).normalize('NFD').length));
  // ICU itself splits the NFD form of this one otherwise ("database" in two): the Segmenter must read the NFC text
  const db = cp(0x30c7, 0x30fc, 0x30bf, 0x30d9, 0x30fc, 0x30b9, 0x306b, 0x63a5, 0x7d9a), dbd = db.normalize('NFD');
  assert.notDeepEqual([...refSegmenter.segment(dbd)].length, [...refSegmenter.segment(db)].length);
  assert.deepEqual(S.tokenizeForSearch(dbd, { segmenter: 'icu' }).map((t) => t.token), S.tokenizeForSearch(db, { segmenter: 'icu' }).map((t) => t.token));
  // a run that is not NFC, where the word boundary falls inside a grapheme cluster (a leading jamo, then a syllable): the
  // pieces are the Segmenter's words of the NFC text, as the reference reads them
  const mixed = cp(0xe33) + 'a' + cp(0x301, 0x1100, 0xd55c, 0xe33);
  assert.notEqual(mixed, mixed.normalize('NFC'));
  assert.deepEqual(S.tokenizeForSearch(mixed, { segmenter: 'icu' }).map((t) => t.token), refTokens(mixed));
});

test('normalizeForSearch: --substring\'s reading, every run of anything but letters and digits one space, no Segmenter, no script split', () => {
  assert.equal(S.normalizeForSearch('  Caf' + cp(0xe9) + ', ' + cp(0xfb01) + 'le! '), 'cafe file');
  assert.equal(S.normalizeForSearch(EL.ODOS + '.x'), cp(0x3bf, 0x3b4, 0x3bf, 0x3c3) + ' x');
  assert.equal(S.normalizeForSearch('foo' + cp(0x200b) + 'bar'), 'foo bar');
  assert.equal(S.normalizeForSearch(cp(0x5d1) + 'ltms'), cp(0x5d1) + 'ltms');
  assert.equal(S.normalizeForSearch(TH.phasa + TH.thai), TH.phasa + TH.thai);
  assert.equal(S.normalizeForSearch('C++'), 'c');
  assert.deepEqual([S.normalizeForSearch(''), S.normalizeForSearch('!!! ' + cp(0x1f44d))], ['', '']);
});

// ---- 6. The query ------------------------------------------------------------------------------------------------------

test('query: words ANDed, phrases in straight or curly quotes, a word of several tokens a phrase, terms that read as nothing dropped', () => {
  const terms = (s, o) => S.parseSearchQuery(s, o).terms.map((t) => [t.text, t.quoted, t.tokens, t.phrase]);
  assert.deepEqual(terms('foo bar'), [['foo', false, ['foo'], false], ['bar', false, ['bar'], false]]);
  assert.deepEqual(terms('"node test" node:sqlite'), [['node test', true, ['node', 'test'], true], ['node:sqlite', false, ['node', 'sqlite'], true]]);
  assert.deepEqual(terms(cp(0x201c) + 'a b' + cp(0x201d) + ' c'), [['a b', true, ['a', 'b'], true], ['c', false, ['c'], false]]);
  assert.deepEqual(terms('"foo"bar'), [['foo', true, ['foo'], true], ['bar', false, ['bar'], false]]);
  // a quote inside a word is part of it: a Hebrew gershayim typed as a straight quote opens no phrase
  const rashi = cp(0x5e8, 0x5e9) + '"' + cp(0x5d9);
  assert.deepEqual(terms(rashi), [[rashi, false, [cp(0x5e8, 0x5e9), cp(0x5d9)], true]]);
  assert.deepEqual(terms('a"b c"'), [['a"b', false, ['a', 'b'], true], ['c"', false, ['c'], false]]);
  assert.deepEqual(terms('a' + TAB + 'b' + cp(0x3000) + 'c'), [['a', false, ['a'], false], ['b', false, ['b'], false], ['c', false, ['c'], false]]);
  const q1 = S.parseSearchQuery('++ foo -- ' + cp(0x1f44d));
  assert.deepEqual([q1.terms.map((t) => t.text), q1.dropped, q1.unbalanced, q1.mode], [['foo'], ['++', '--', cp(0x1f44d)], false, 'words']);
  assert.deepEqual(S.parseSearchQuery('++ !!').terms, []);
});

test('query: an unbalanced quote runs to the end of the query, and says so; a curly open needs a curly close', () => {
  const u = (s) => { const q = S.parseSearchQuery(s); return [q.terms.map((t) => [t.text, t.tokens]), q.unbalanced]; };
  assert.deepEqual(u('x "open phrase'), [[['x', ['x']], ['open phrase', ['open', 'phrase']]], true]);
  assert.deepEqual(u(cp(0x201c) + 'a b"'), [[['a b"', ['a', 'b']]], true]);
  assert.deepEqual(u('x "y"'), [[['x', ['x']], ['y', ['y']]], false]);
});

test('query: --substring terms are normalized and trimmed, a term left empty is dropped; gapScripts and the segmenter are the query\'s', () => {
  const q = S.parseSearchQuery('cat "foo  bar" C++ ++', { mode: 'substring' });
  assert.deepEqual([q.terms.map((t) => [t.text, t.tokens, t.phrase]), q.dropped, q.mode], [[['cat', ['cat'], false], ['foo  bar', ['foo bar'], true], ['C++', ['c'], false]], ['++'], 'substring']);
  const g = S.parseSearchQuery(HE.bayit + ' ltms ' + ZH.beijing);
  assert.deepEqual([g.terms.map((t) => t.gapScripts), g.gapScripts], [[['Hebrew'], [], ['Han']], ['Hebrew', 'Han']]);
  assert.deepEqual(S.parseSearchQuery(TH.phasa + TH.thai, { segmenter: 'no-dictionary' }).terms.map((t) => [t.tokens, t.phrase]), [[[TH.phasa + TH.thai], false]]);
  assert.deepEqual(S.parseSearchQuery(TH.phasa + TH.thai, { segmenter: 'icu' }).terms.map((t) => [t.tokens, t.phrase]), [[[TH.phasa, TH.thai], true]]);
  assert.equal(S.parseSearchQuery('x').segmenter, S.checkSearchSupport().segmenter);
});

test('query: --substring finds a term inside a word ("cat" in "concatenate"), terms ANDed per turn, at the match itself', () => {
  assert.deepEqual(compact(find(K, 'input', { mode: 'substring' })), [['T001', [[2, 'input', MC, 12, [0]]]]]);
  assert.deepEqual(compact(find(K, 'zqkre', { mode: 'substring' })), [['T001', [[4, 'reply', [...MC, 0, 'text'], 0, [0]], [6, 'result', [...MC, 0, 'content'], 0, [0]]]]]);
  assert.deepEqual(compact(find(K, 'ird zqkrig', { mode: 'substring' })), [['T003', [[22, 'input', MC, 13, [0]], [23, 'reply', [...MC, 0, 'text'], 9, [0, 1]]]]]);
  assert.deepEqual(compact(find(K, 'zqkinput zqkthird', { mode: 'substring' })), []);
});

/** A transcript of one prompt and one assistant record holding `blocks`, written here (invented text). */
function mini(blocks, prompt = '.') {
  const env = { isSidechain: false, userType: 'external', cwd: '/w', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  return [
    JSON.stringify({ parentUuid: null, ...env, type: 'user', message: { role: 'user', content: prompt }, uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', promptSource: 'typed' }),
    JSON.stringify({ parentUuid: 'u1', ...env, type: 'assistant', message: { id: 'm', role: 'assistant', content: blocks }, requestId: 'r', uuid: 'u2', timestamp: '2026-08-01T00:00:01.000Z' }),
  ].join(NL) + NL;
}

test('first match: in a field that is not ASCII, the entry\'s at is the earliest match of any term, whatever line each is on', () => {
  const text = cp(0xe9) + ' first zqkaa' + NL + 'second zqkbb';   // zqkaa at 8 on line 1, zqkbb at 21 on line 2
  for (const q of ['zqkaa zqkbb', 'zqkbb zqkaa']) {
    const r = S.searchTranscript(mini([{ type: 'text', text }]), query(q));
    assert.deepEqual(r.turns.map((h) => h.entries.map((e) => [e.at, e.w])), [[[8, [0, 1]]]], q);
  }
  assert.deepEqual([text.indexOf('zqkaa'), text.indexOf('zqkbb')], [8, 21]);
});

test('escapes: a backslash-u escape with upper-case hex digits is decoded too', () => {
  const text = 'x ' + BSL + 'u05E9' + BSL + 'u05DC' + BSL + 'u05D5' + BSL + 'u05DD' + ' y';
  const r = S.searchTranscript(mini([{ type: 'text', text }]), query(SHALOM));
  assert.deepEqual(r.turns.map((h) => h.entries.map((e) => [lineOf(e.a), e.kind, e.at])), [[[2, 'reply', 2]]]);
});

test('images: an image object met inside a searched value is counted and not read', () => {
  const blocks = [{ type: 'tool_use', id: 'toolu_x', name: 'Paint', input: { picture: { type: 'image', source: { type: 'base64', data: 'zqkimgdata' } }, note: 'zqknote' } }];
  const r = S.searchTranscript(mini(blocks), query('zqkimgdata'));
  assert.deepEqual([r.turns, r.counts.notSearched.images], [[], 1]);
  assert.deepEqual(S.searchTranscript(mini(blocks), query('zqknote')).turns.map((h) => h.entries.map((e) => e.field)), [[[...MC, 0, 'input', 'note']]]);
});

// ---- 7. Entries ----------------------------------------------------------------------------------------------------------

test('entries: one per record and kind, by line, then kind; each names the first field of its kind holding a term (search-entries.jsonl)', () => {
  // L1 prompt; L2 one record holding thinking (block 0), a reply (block 1) and a call (block 2); L3 a result of two text
  // blocks, the first holding zqkother, the second zqkmulti
  const N = 'search-entries.jsonl';
  assert.deepEqual(compact(find(N, 'zqkmulti')), [['T001', [
    [1, 'input', MC, 0, [0]], [2, 'reply', [...MC, 1, 'text'], 4, [0]], [2, 'thinking', [...MC, 0, 'thinking'], 0, [0]],
    [2, 'call', [...MC, 2, 'input', 'command'], 5, [0]], [3, 'result', [...MC, 0, 'content', 1, 'text'], 23, [0]]]]]);
  assert.deepEqual(compact(find(N, 'zqkother zqkmulti')), [['T001', [
    [1, 'input', MC, 0, [1]], [2, 'reply', [...MC, 1, 'text'], 4, [1]], [2, 'thinking', [...MC, 0, 'thinking'], 0, [1]],
    [2, 'call', [...MC, 2, 'input', 'command'], 5, [1]], [3, 'result', [...MC, 0, 'content', 0, 'text'], 22, [0, 1]]]]]);
  assert.deepEqual(find(N, 'zqkmulti').counts.hits, { turns: 1, records: 3, byKind: { input: 1, summary: 0, reply: 1, thinking: 1, call: 1, result: 1, system: 0 } });
  // w ascends whatever the order the terms were met in: here zqkother (term 1) is met in block 0, before zqkmulti
  assert.deepEqual(compact(find(N, 'zqkmulti zqkother')).map(([, es]) => es.at(-1)), [[3, 'result', [...MC, 0, 'content', 0, 'text'], 22, [0, 1]]]);
  assert.deepEqual([valueAt(rawLine(N, 3), [...MC, 0, 'content', 1, 'text']).indexOf('zqkmulti'), valueAt(rawLine(N, 3), [...MC, 0, 'content', 0, 'text']).indexOf('zqkother')], [23, 22]);
});

test('entries: the channel, by skeleton\'s label rule (labels.jsonl: a peer, and a free-text origin kind withheld)', () => {
  assert.deepEqual(find('labels.jsonl', 'relayed').turns.map((h) => [h.ta, h.ch]), [['T002', 'peer']]);
  assert.deepEqual(find('labels.jsonl', 'origin').turns.map((h) => [h.ta, h.ch]), [['T003', '(withheld)']]);
});

test('options: the address prefix; a Transcript gives what its text gives; a query with no terms matches nothing', () => {
  const r = find(K, 'zqkthird', { prefix: 'search-k' });
  assert.deepEqual(r.turns.map((h) => [h.ta, h.entries.map((e) => e.a)]), [['search-k:T003', ['search-k:L22', 'search-k:L23']]]);
  assert.deepEqual(find(K, 'zqkthird').turns.map((h) => [h.ta, h.entries.map((e) => e.a)]), [['T003', ['L22', 'L23']]]);
  for (const name of [K, E, 'demo.jsonl', 'compacted.jsonl']) {
    const qy = query('the');
    assert.deepEqual(S.searchTranscript(P.parseTranscript(read(name)), qy, { kinds: S.SEARCH_KINDS }), S.searchTranscript(read(name), qy, { kinds: S.SEARCH_KINDS }), name);
  }
  const none = S.searchTranscript(read(K), query('++'));
  assert.deepEqual([none.turns, none.counts.searched, none.counts.hits.turns], [[], 18, 0]);
  assert.deepEqual([S.searchTranscript(read('journal.jsonl'), query('x')).fileKind, S.searchTranscript(read('empty.jsonl'), query('x')).fileKind,
    S.searchTranscript(read('types-only.jsonl'), query('x')).fileKind], ['journal', 'empty', 'unknown']);
});

// ---- 8. The scouts' 120 known queries (search-cases.jsonl) ---------------------------------------------------------
// Each query against its own string (turn k's reply, line 2k), in words mode and in --substring. h: the reply holds it;
// m: it does not; d: the query reads as nothing (dropped). Read off by hand from DESIGN v2 section 3.3, and checked
// against the reference below: words miss 27 of 120 and --substring 9 (3 of each are emoji, which read as nothing).
// The edges seat measured 30 and 10 on v1's normalization in v2's order; v2's final sigma (the Greek query typed with a
// medial sigma) and its decoding of every escape (beta, and the Hebrew word after a backslash-n) are the 3 words and
// the 1 substring query it gains.
const CASES = [
  ['english', ['user', "user's", "doesn't", 'doesn', 'exist', 'U.S.', 'US', 're-run', 'rerun', 'run', '3.5', 'v3.5', 'mirror'], 'hhhhhhmhmhmhh', 'hhhhhhhhmhhhh'],
  ['hebrew-prefixes', [cp(0x5e2, 0x5d9, 0x5e8), cp(0x5d4, 0x5e2, 0x5d9, 0x5e8), cp(0x5de, 0x5d4, 0x5e2, 0x5d9, 0x5e8), cp(0x5d1, 0x5d9, 0x5ea), cp(0x5d4, 0x5d1, 0x5d9, 0x5ea), cp(0x5d5, 0x5d4, 0x5d1, 0x5d9, 0x5ea), cp(0x5e9, 0x5dc, 0x5d5, 0x5dd), cp(0x5d1, 0x5e9, 0x5dc, 0x5d5, 0x5dd)], 'mmhmmhmh', 'hhhhhhhh'],
  ['hebrew-pointed', [cp(0x5d5, 0x5d4, 0x5d1, 0x5d9, 0x5ea), cp(0x5d1, 0x5e9, 0x5dc, 0x5d5, 0x5dd), cp(0x5d1, 0x5d9, 0x5ea), cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)], 'hhmm', 'hhhh'],
  ['hebrew-maqaf-geresh', [cp(0x5d1, 0x5d9, 0x5ea), cp(0x5d4, 0x5db, 0x5e0, 0x5e1, 0x5ea), cp(0x5db, 0x5e0, 0x5e1, 0x5ea), cp(0x5e8, 0x5f3), cp(0x5e8) + "'", cp(0x5e8, 0x5e9, 0x5f4, 0x5d9), cp(0x5e8, 0x5e9) + '"' + cp(0x5d9), cp(0x5e8, 0x5e9, 0x5d9), cp(0x5d9, 0x5d4, 0x5d5, 0x5d3, 0x5d4)], 'hhmhhhhmh', 'hhhhhhhmh'],
  ['arabic-al', [cp(0x645, 0x62f, 0x631, 0x633, 0x629), cp(0x627, 0x644, 0x645, 0x62f, 0x631, 0x633, 0x629), cp(0x643, 0x62a, 0x627, 0x628), cp(0x627, 0x644, 0x643, 0x62a, 0x627, 0x628), cp(0x648, 0x627, 0x644, 0x643, 0x62a, 0x627, 0x628), cp(0x628, 0x64a, 0x62a), cp(0x627, 0x644, 0x628, 0x64a, 0x62a)], 'mhmmhmm', 'hhhhhhh'],
  ['arabic-marks-tatweel-forms', [cp(0x627, 0x644, 0x643, 0x62a, 0x627, 0x628), cp(0x643, 0x62a, 0x627, 0x628)], 'hh', 'hh'],
  ['chinese', [cp(0x5317, 0x4eac), cp(0x5927, 0x5b66), cp(0x5317, 0x4eac, 0x5927, 0x5b66), cp(0x5f00, 0x4f1a), cp(0x4f1a, 0x8bae), cp(0x4e0b, 0x5348)], 'hhhhhh', 'hhhhhh'],
  ['japanese', [cp(0x6771, 0x4eac), cp(0x5927, 0x5b66), cp(0x6771, 0x4eac, 0x5927, 0x5b66), cp(0x30b3, 0x30fc, 0x30d2, 0x30fc), cp(0x6771, 0x4eac, 0x90fd), cp(0x4f4f, 0x3093, 0x3067), cp(0x4f4f, 0x3080)], 'hhhhhhm', 'hhhhhhm'],
  ['thai', [cp(0xe20, 0xe32, 0xe29, 0xe32), cp(0xe44, 0xe17, 0xe22), cp(0xe20, 0xe32, 0xe29, 0xe32, 0xe44, 0xe17, 0xe22), cp(0xe04, 0xe33), cp(0xe23, 0xe30, 0xe2b, 0xe27, 0xe48, 0xe32, 0xe07)], 'hhhhh', 'hhhhh'],
  ['korean', [cp(0xd559, 0xad50), cp(0xd559, 0xad50, 0xc5d0, 0xc11c), cp(0xce5c, 0xad6c), cp(0xce5c, 0xad6c, 0xb97c)], 'mhmh', 'hhhh'],
  ['emoji', ['job', 'glued', cp(0x1f44d), cp(0x1f642), cp(0x2764)], 'hhddd', 'hhddd'],
  ['code', ['parseQueryString', 'parsequerystring', 'Query', 'snake_case_name', 'case', 'kebab-case-name', 'kebab', '/usr/local/bin', 'bin', '--force', 'force', '2.1.314', '314', '9f86d081', 'user.name@example.com', 'example', 'example.com', 'node:sqlite', 'sqlite', 'file.test.mjs', 'test', 'C++', 'S24.E'], 'hhmhhhhhhhhhhhhhhhhhhhh', 'hhhhhhhhhhhhhhhhhhhhhhh'],
  ['fold', ['caf' + cp(0xe9), 'cafe', 'Caf' + cp(0xe9), 'istanbul', cp(0x130) + 'stanbul', 'strasse', 'stra' + cp(0xdf) + 'e', 'file', 'full', 'FULL', '123'], 'hhhhhhhhhhh', 'hhhhhhhhhhh'],
  ['fold-sharp-s-a', ['strasse', 'STRASSE', 'stra' + cp(0xdf) + 'e'], 'mmh', 'mmh'],
  ['fold-sharp-s-b', ['stra' + cp(0xdf) + 'e', 'strasse'], 'mh', 'mh'],
  ['fold-greek-sigma', [cp(0x3bf, 0x3b4, 0x3bf, 0x3c2), cp(0x3bf, 0x3b4, 0x3bf, 0x3c3), cp(0x39f, 0x394, 0x39f, 0x3a3)], 'hhh', 'hhh'],
  ['escaped-json', ['alpha', 'beta', 'gamma', 'Users', 'delta'], 'hhhhh', 'hhhhh'],
  ['escaped-json-hebrew', [cp(0x5e9, 0x5d9, 0x5e9, 0x5d9), cp(0x5dc, 0x5d9, 0x5dc), cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)], 'hhh', 'hhh'],
];

/** What one query gives against its own case's string, by the library. */
function outcome(t, k, text, mode) {
  const q = S.parseSearchQuery(text, { mode });
  if (!q.terms.length) return 'd';
  const r = S.searchTranscript(t, q, { kinds: ['reply'] });
  return r.turns.some((h) => h.ta === `T${String(k).padStart(3, '0')}` && h.entries.some((e) => lineOf(e.a) === 2 * k)) ? 'h' : 'm';
}

test('the 120 known queries: each one\'s result, words mode 27 not found and --substring 9, of which 3 each read as nothing', () => {
  const t = P.parseTranscript(read('search-cases.jsonl'));
  assert.equal(P.turnsOf(t, P.repairedLivePath(t).path).length, CASES.length);
  let n = 0;
  const not = { words: 0, substring: 0 }, dropped = { words: 0, substring: 0 };
  CASES.forEach(([id, qs, words, substring], i) => {
    assert.equal(qs.length, words.length, id);
    for (const [mode, want] of [['words', words], ['substring', substring]]) {
      const got = qs.map((q) => outcome(t, i + 1, q, mode)).join('');
      assert.equal(got, want, `${id}, ${mode}: ${qs.map((q, j) => (got[j] !== want[j] ? q : '')).filter(Boolean).join(', ')}`);
      for (const c of got) { if (c !== 'h') not[mode]++; if (c === 'd') dropped[mode]++; }
    }
    n += qs.length;
  });
  assert.deepEqual([n, not, dropped], [120, { words: 27, substring: 9 }, { words: 3, substring: 3 }]);
});

// ---- 9. The reference, and the properties ----------------------------------------------------------------------------
// DESIGN v2 section 3.3 written again, with whole-string operations only. Its Script values come from a list of 12
// scripts; a letter of any other script throws, so the inputs below stay inside that list.
const REF_SCRIPTS = ['Latin', 'Hebrew', 'Arabic', 'Greek', 'Cyrillic', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Common', 'Inherited']
  .map((s) => [s, new RegExp(`^\\p{Script=${s}}$`, 'u')]);
const refScript = (ch) => { for (const [s, r] of REF_SCRIPTS) if (r.test(ch)) return s; throw new Error(`the reference has no Script value for U+${ch.codePointAt(0).toString(16)}`); };
const REF_SPACELESS = /(?=\p{L})[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const refSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const refNorm = (p) => p.normalize('NFKD').toLowerCase().split(cp(0x3c2)).join(cp(0x3c3)).split(cp(0x200b)).join(' ')
  .replace(new RegExp('[\\p{M}\\p{Cf}' + cp(0x640) + ']', 'gu'), '').normalize('NFC');
const refCut = (tok) => {
  const chars = [...tok], out = [];
  let cur = '';
  chars.forEach((b, i) => {
    const a = chars[i - 1];
    if (i && /\p{L}/u.test(a) && /\p{L}/u.test(b)) {
      const sa = refScript(a), sb = refScript(b);
      if (sa !== sb && !['Common', 'Inherited'].includes(sa) && !['Common', 'Inherited'].includes(sb)) { out.push(cur); cur = ''; }
    }
    cur += b;
  });
  if (cur) out.push(cur);
  return out;
};
const refTokens = (s) => (s.match(/[\p{L}\p{M}\p{N}\p{Cf}]+/gu) ?? [])
  .flatMap((run) => (REF_SPACELESS.test(run) ? [...refSegmenter.segment(run.normalize('NFC'))].map((x) => x.segment) : [run]))
  .flatMap((piece) => refNorm(piece).match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(refCut);
const refSubstring = (s) => (s.match(/[\p{L}\p{M}\p{N}\p{Cf}]+/gu) ?? []).flatMap((run) => refNorm(run).match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');

const POOL = ['a', 'Z', 'b', 'e', '1', ' ', '.', '-', '_', "'", cp(0x301), cp(0x3a3), cp(0x3c3), cp(0x3c2), cp(0x200b), cp(0x200d), cp(0xad), cp(0x640),
  cp(0xfb01), cp(0xff21), cp(0xff11), cp(0x130), cp(0xdf), cp(0x5d1), cp(0x5bc), cp(0x5b8), cp(0x5d9), cp(0x627), cp(0x644), cp(0x64e), cp(0xd55c),
  cp(0xae00), cp(0x1100), cp(0x1161), cp(0x11a8), cp(0xe20), cp(0xe32), cp(0xe48), cp(0xe33), cp(0x5317), cp(0x4eac), cp(0x3067), cp(0x30b3),
  cp(0x30fc), cp(0x304b), cp(0x3099), cp(0x1d400), cp(0x1f44d), cp(0xfe0f), cp(0x2122), cp(0xbd), cp(0x2160), cp(0x416), BSL];
/** Seeded strings from POOL: the same on every run. */
const hasSurrogate = (x) => { for (let i = 0; i < x.length; i++) { const c = x.charCodeAt(i); if (c >= 0xd800 && c <= 0xdfff) return true; } return false; };
function* randomStrings(n, seed, maxLen = 12, pool = POOL) {
  let s = seed;
  const rnd = (k) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % k; };
  for (let i = 0; i < n; i++) { let x = ''; const len = 1 + rnd(maxLen); for (let k = 0; k < len; k++) x += pool[rnd(pool.length)]; yield x; }
}

test('reference: the library\'s tokens and --substring text equal the reference on the case strings, the queries and 6,000 seeded strings', () => {
  const strings = [...CASES.flatMap(([, qs]) => qs), ...read('search-cases.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((o) => o.type === 'assistant').map((o) => o.message.content[0].text), ...randomStrings(6000, 12345)];
  for (const s of strings) {
    assert.deepEqual(S.tokenizeForSearch(s, { segmenter: 'icu' }).map((t) => t.token), refTokens(s), JSON.stringify(s));
    assert.equal(S.normalizeForSearch(s), refSubstring(s), JSON.stringify(s));
  }
});

test('offsets: at every token offset, the reference reads the same tokens after it and before it (a character NFKD splits may end one and start the next)', () => {
  const pool = POOL.filter((c) => !REF_SPACELESS.test(c));   // the Segmenter reads a whole run, so a slice would change it
  let checked = 0, split = 0;
  for (const s of randomStrings(3000, 777, 14, pool)) {
    const toks = S.tokenizeForSearch(s);
    for (const o of [...new Set(toks.map((t) => t.at))]) {
      checked++;
      const after = refTokens(s.slice(o)), before = refTokens(s.slice(0, o));
      const libAfter = toks.filter((t) => t.at >= o).map((t) => t.token), libBefore = toks.filter((t) => t.at < o).map((t) => t.token);
      const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
      if (same(after, libAfter) && same(before, libBefore)) continue;
      // U+00BD gives 1, a fraction slash and 2: the 1 ends the token before, the 2 starts this one, both at its offset
      split++;
      assert.ok(after.length === libAfter.length + 1 && same(after.slice(1), libAfter) && libBefore.at(-1).endsWith(after[0]), `after ${o} in ${JSON.stringify(s)}`);
      assert.ok(before.length === libBefore.length && same(before.slice(0, -1), libBefore.slice(0, -1)) && libBefore.at(-1).startsWith(before.at(-1)), `before ${o} in ${JSON.stringify(s)}`);
      assert.equal(s.codePointAt(o), 0xbd, `a token shares its first character with the one before, at ${o} in ${JSON.stringify(s)}, and it is not U+00BD`);
    }
  }
  assert.ok(checked - split > 8000, `${checked} offsets checked, ${split} of them at U+00BD`);
});

test('offsets: a --substring match\'s at is where the match begins, or the character whose expansion it begins inside', () => {
  const env = { isSidechain: false, userType: 'external', cwd: '/w', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  const transcript = (text) => [
    JSON.stringify({ parentUuid: null, ...env, type: 'user', message: { role: 'user', content: '.' }, uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', promptSource: 'typed' }),
    JSON.stringify({ parentUuid: 'u1', ...env, type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text }] }, requestId: 'r', uuid: 'u2', timestamp: '2026-08-01T00:00:01.000Z' }),
  ].join(NL) + NL;
  let checked = 0, seed = 99;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (const s of randomStrings(2000, 4242, 14, POOL.filter((c) => c !== BSL))) {
    const T = S.normalizeForSearch(s);
    if (T.length < 2) continue;
    const a = rnd(T.length), piece = T.slice(a, Math.min(T.length, a + 1 + rnd(4))).trim();
    if (!piece || hasSurrogate(piece) || piece !== piece.normalize('NFC')) continue;   // a random cut can halve a pair
    const q = S.parseSearchQuery('"' + piece + '"', { mode: 'substring' });
    if (!q.terms.length || q.terms[0].tokens[0] !== piece) continue;
    checked++;
    const e = S.searchTranscript(transcript(s), q, { kinds: ['reply'] }).turns[0]?.entries[0];
    assert.ok(e, `${JSON.stringify(piece)} not found in ${JSON.stringify(s)}`);
    const F = S.normalizeForSearch(s.slice(e.at)), grow = Math.max(1, S.normalizeForSearch(String.fromCodePoint(s.codePointAt(e.at))).length);
    const head = piece.split(' ')[0];
    assert.ok([...Array(grow).keys()].some((k) => F.slice(k).startsWith(head)), `${JSON.stringify(piece)} at ${e.at} in ${JSON.stringify(s)}`);
  }
  assert.ok(checked > 1000, `only ${checked} matches checked`);
});

test('lines: in a field that is not ASCII, the first match found by reading only some lines is the first match in the whole field', () => {
  // brute force, with no lines: words, the whole field's tokens scanned for the phrase; --substring, the smallest raw
  // offset from which the field's reading holds the term at its start (or inside the expansion of that character)
  const env = { isSidechain: false, userType: 'external', cwd: '/w', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  const transcript = (text) => [
    JSON.stringify({ parentUuid: null, ...env, type: 'user', message: { role: 'user', content: '.' }, uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', promptSource: 'typed' }),
    JSON.stringify({ parentUuid: 'u1', ...env, type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text }] }, requestId: 'r', uuid: 'u2', timestamp: '2026-08-01T00:00:01.000Z' }),
  ].join(NL) + NL;
  const pool = ['ab', 'abc', 'b', 'ca', ' ', ' ', NL, NL, NL + NL, '.', '-', cp(0xe9), 'e' + cp(0x301), cp(0x5d1), cp(0x5d1, 0x5d9), cp(0xfb01), cp(0x3a3), cp(0x200b), cp(0xbd), '1'];
  let seed = 31337, words = 0, subs = 0;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (let n = 0; n < 2500; n++) {
    let s = cp(0xe9);                                            // never ASCII: the line reading is the one tested
    for (let k = 1 + rnd(25); k > 0; k--) s += pool[rnd(pool.length)];
    const toks = S.tokenizeForSearch(s);
    if (toks.length) {                                           // a phrase of 1 to 3 of the field's own tokens
      const a = rnd(toks.length), len = 1 + rnd(3);
      const phrase = toks.slice(a, a + len).map((t) => t.token);
      const want = (() => { outer: for (let i = 0; i + phrase.length <= toks.length; i++) { for (let q = 0; q < phrase.length; q++) if (toks[i + q].token !== phrase[q]) continue outer; return toks[i].at; } return -1; })();
      const r = S.searchTranscript(transcript(s), S.parseSearchQuery('"' + phrase.join(' ') + '"'), { kinds: ['reply'] });
      assert.equal(r.turns[0]?.entries[0].at ?? -1, want, `words ${JSON.stringify(phrase)} in ${JSON.stringify(s)}`);
      words++;
    }
    const T = S.normalizeForSearch(s);
    if (T.length > 1) {                                          // a piece of the field's own reading
      const a = rnd(T.length), piece = T.slice(a, a + 1 + rnd(7)).trim();
      if (!piece || hasSurrogate(piece) || piece !== piece.normalize('NFC')) continue;
      const q = S.parseSearchQuery('"' + piece + '"', { mode: 'substring' });
      if (!q.terms.length || q.terms[0].tokens[0] !== piece) continue;
      // a match begins at a character that reads as something itself: a mark, a format character or a separator reads
      // as nothing, so a slice that begins with one only seems to begin the match
      let want = -1;
      for (let p = 0; p < s.length && want < 0; p++) {
        const c = s.charCodeAt(p);
        if (c >= 0xdc00 && c <= 0xdfff) continue;
        const grow = S.normalizeForSearch(String.fromCodePoint(s.codePointAt(p))).length, F = grow ? S.normalizeForSearch(s.slice(p)) : '';
        for (let k = 0; k < grow && want < 0; k++) if (F.slice(k).startsWith(piece)) want = p;
      }
      const r = S.searchTranscript(transcript(s), q, { kinds: ['reply'] });
      assert.equal(r.turns[0]?.entries[0].at ?? -1, want, `substring ${JSON.stringify(piece)} in ${JSON.stringify(s)}`);
      subs++;
    }
  }
  assert.ok(words > 2000 && subs > 1000, `${words} phrases and ${subs} substrings checked`);
});

// ---- 10. The runtime: the Segmenter check, and what is missing ---------------------------------------------------------

/** Runs code in a child Node, after `before` (which can take Intl away, or break it), and returns what it prints. */
function child(before, code) {
  const src = `${before}\nconst S = await import(${JSON.stringify(SEARCH_URL)});\n${code}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('support: icu only when the Segmenter splits the known Thai and Chinese strings; no-dictionary without it, or when it does not split', () => {
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
  const splits = [...seg.segment(TH.phasa + TH.thai)].length === 2 && [...seg.segment(ZH.beijing + ZH.daxue)].length === 2;
  assert.deepEqual(S.checkSearchSupport(), { ok: true, segmenter: splits ? 'icu' : 'no-dictionary', missing: null });
  const print = 'process.stdout.write(JSON.stringify(S.checkSearchSupport()));';
  assert.deepEqual(child('delete Intl.Segmenter;', print), { ok: true, segmenter: 'no-dictionary', missing: null });
  assert.deepEqual(child('Intl.Segmenter = class { segment(s) { return [{ segment: s, index: 0, isWordLike: true }][Symbol.iterator](); } };', print),
    { ok: true, segmenter: 'no-dictionary', missing: null });
  // one that splits the Thai string but leaves the Chinese one whole, or the reverse: no-dictionary
  const thaiOnly = `const T = ${JSON.stringify(TH.phasa + TH.thai)}; Intl.Segmenter = class { segment(s) { return (s === T ? [{ segment: s.slice(0, 4), index: 0 }, { segment: s.slice(4), index: 4 }] : [{ segment: s, index: 0 }])[Symbol.iterator](); } };`;
  const chineseOnly = `const C = ${JSON.stringify(ZH.beijing + ZH.daxue)}; Intl.Segmenter = class { segment(s) { return (s === C ? [{ segment: s.slice(0, 2), index: 0 }, { segment: s.slice(2), index: 2 }] : [{ segment: s, index: 0 }])[Symbol.iterator](); } };`;
  assert.deepEqual(child(thaiOnly, print), { ok: true, segmenter: 'no-dictionary', missing: null });
  assert.deepEqual(child(chineseOnly, print), { ok: true, segmenter: 'no-dictionary', missing: null });
  // with no dictionary, a spaceless run stays whole, in the query and in the text alike
  assert.deepEqual(child('delete Intl.Segmenter;', `process.stdout.write(JSON.stringify(S.tokenizeForSearch(${JSON.stringify(TH.phasa + TH.thai)}).map((t) => t.token)));`), [TH.phasa + TH.thai]);
});

test('support: without Intl, Unicode property escapes or a working normalize, the check says which, and the module still loads', () => {
  const print = 'process.stdout.write(JSON.stringify(S.checkSearchSupport()));';
  assert.deepEqual(child('delete globalThis.Intl;', print), { ok: false, segmenter: null, missing: 'Intl' });
  const noProperty = 'const R = RegExp; globalThis.RegExp = new Proxy(R, { construct(t, a) { if (String(a[0]).includes(String.fromCharCode(92) + "p{")) throw new SyntaxError("no property escapes"); return new R(...a); } });';
  assert.deepEqual(child(noProperty, print), { ok: false, segmenter: null, missing: 'unicode property escapes' });
  assert.deepEqual(child('String.prototype.normalize = function () { return String(this); };', print), { ok: false, segmenter: null, missing: 'String.prototype.normalize' });
});

test('no-dictionary: a dictionary word inside a spaceless run is not found, the whole run is', () => {
  const nd = (text) => compact(find(SC, text, { segmenter: 'no-dictionary' })).map(([ta, es]) => [ta, es.map((e) => e[3])]);
  assert.deepEqual(nd(TH.phasa), []);
  assert.deepEqual(nd(TH.run), [['T007', [0]]]);
  assert.deepEqual(nd('zqkfind'), [['T010', [8]]]);
});

// ---- 11. The source -------------------------------------------------------------------------------------------------------

test('source: search.ts holds ASCII only and no typed backslash-u escape, imports no Node module, and neither does its build', () => {
  const src = readFileSync(join(root, 'src', 'search.ts'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(src), 'a character outside ASCII in src/search.ts');
  assert.ok(!src.includes(BSL + 'u'), 'a typed backslash-u in src/search.ts');
  for (const text of [src, readFileSync(join(DIST, 'search.js'), 'utf8')]) {
    const imports = [...text.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(imports)], ['./parser.js']);
    assert.ok(!/\brequire\(|\bprocess\.|\bBuffer\b/.test(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')), 'a Node API in search');
  }
});

// ---- 12. The command: ltms search (stage B2) ---------------------------------------------------------------------------
// Spawned as a user runs it. Every expected value comes from how its folder is built here: session() writes typed
// prompts and replies, record j stamped j seconds after the session's time, with the planted word zqcword where a hit
// must be; or from search-kinds.jsonl, whose counts section 1 derived by hand. The library stands beside the command only
// where the command must pass its results on unchanged: the hit lines, and the coverage's sums.

/** ltms, spawned; stdout read as JSON lines. `node` holds flags for Node itself (a heap size, a preload). */
function ltms(args, { cwd, env, node = [] } = {}) {
  const r = spawnSync(process.execPath, [...node, CLI, ...args], { encoding: 'utf8', timeout: 60000, cwd, env: env ?? process.env, maxBuffer: 1 << 26 });
  if (r.error) throw r.error;
  return withLines({ code: r.status, out: r.stdout, err: r.stderr });
}
/** `lines`: stdout read as JSON lines, when asked for (a help text is not JSON). */
const withLines = (r) => Object.defineProperty(r, 'lines', { get: () => r.out.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) });
/** A command line the output gave (the coverage's next, a message's command), run by bash with ltms as this build. */
function runCommandLine(line, opts = {}) {
  const r = spawnSync('bash', ['-c', `ltms() { ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"; }; ${line}`], { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 26, ...opts });
  return withLines({ code: r.status, out: r.stdout, err: r.stderr });
}
const tmp = () => mkdtempSync(join(tmpdir(), 'ltms-search-'));
const rm = (...dirs) => { for (const d of dirs) if (d) rmSync(d, { recursive: true, force: true }); };
/** A path as the command writes it into a command line: bare when it holds only letters, digits and _ . / : , + % @ = -
 *  (and does not start with -), else in single quotes. */
const sh = (p) => (/^[A-Za-z0-9_.\/:,+%@=-]+$/.test(p) && !p.startsWith('-') ? p : `'${p.split("'").join("'\\''")}'`);
const SEG = S.checkSearchSupport().segmenter;
const DEFAULT_KINDS = ['input', 'summary', 'reply', 'thinking', 'call', 'result', 'system'];
const uuidN = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A session of typed prompts, each answered by one reply: turns = [[prompt, reply], ...]. Record j (1-based, in file
 *  order) carries the time `ts` plus j seconds, or no timestamp when ts is null; a last-prompt record ends the file. */
function session(turns, ts) {
  const recs = [];
  let parent = null;
  const stamp = () => (ts ? { timestamp: new Date(Date.parse(ts) + 1000 * (recs.length + 1)).toISOString() } : {});
  for (const [prompt, reply] of turns) {
    const u = uuidN(recs.length + 1);
    recs.push({ type: 'user', uuid: u, parentUuid: parent, promptSource: 'typed', ...stamp(), message: { role: 'user', content: prompt } });
    const a = uuidN(recs.length + 1);
    recs.push({ type: 'assistant', uuid: a, parentUuid: u, requestId: `req_${recs.length + 1}`, ...stamp(), message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
    parent = a;
  }
  recs.push({ type: 'last-prompt', leafUuid: parent });
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
const W = 'zqcword', X = 'nothing to find here';
/** Five sessions: the planted word in a (stamped 03-03, its one reply), c (03-02, its second prompt), b (03-01, its first
 *  prompt and its third reply) and d (no timestamps, its prompt); none in e (03-04, the newest). */
function orderFolder() {
  const dir = tmp();
  writeFileSync(join(dir, 'b.jsonl'), session([[`${W} one`, X], [X, X], [X, `three ${W}`]], '2026-03-01T00:00:00.000Z'));
  writeFileSync(join(dir, 'a.jsonl'), session([[X, `a ${W}`]], '2026-03-03T00:00:00.000Z'));
  writeFileSync(join(dir, 'c.jsonl'), session([[X, X], [`c ${W}`, X]], '2026-03-02T00:00:00.000Z'));
  writeFileSync(join(dir, 'd.jsonl'), session([[`d ${W}`, X]], null));
  writeFileSync(join(dir, 'e.jsonl'), session([[X, X]], '2026-03-04T00:00:00.000Z'));
  return dir;
}
const IN = ['message', 'content'], OUT = ['message', 'content', 0, 'text'];
/** orderFolder's file and hit lines, by file: a session's last record is 2 * its turns seconds past its time. */
const orderExpected = (dir) => ({
  a: [{ k: 'file', p: 'a.jsonl', path: join(dir, 'a.jsonl'), last: '2026-03-03T00:00:02.000Z' }, [{ ta: 'a.jsonl:T001', ch: 'typed', at: [{ a: 'a.jsonl:L2', kind: 'reply', field: OUT, at: 2, w: [0] }] }]],
  c: [{ k: 'file', p: 'c.jsonl', path: join(dir, 'c.jsonl'), last: '2026-03-02T00:00:04.000Z' }, [{ ta: 'c.jsonl:T002', ch: 'typed', at: [{ a: 'c.jsonl:L3', kind: 'input', field: IN, at: 2, w: [0] }] }]],
  b: [{ k: 'file', p: 'b.jsonl', path: join(dir, 'b.jsonl'), last: '2026-03-01T00:00:06.000Z' }, [
    { ta: 'b.jsonl:T001', ch: 'typed', at: [{ a: 'b.jsonl:L1', kind: 'input', field: IN, at: 0, w: [0] }] },
    { ta: 'b.jsonl:T003', ch: 'typed', at: [{ a: 'b.jsonl:L6', kind: 'reply', field: OUT, at: 6, w: [0] }] }]],
  d: [{ k: 'file', p: 'd.jsonl', path: join(dir, 'd.jsonl'), last: null }, [{ ta: 'd.jsonl:T001', ch: 'typed', at: [{ a: 'd.jsonl:L1', kind: 'input', field: IN, at: 2, w: [0] }] }]],
});
/** The file and hit lines of the files in `order`, numbered f = 1, 2, ... as printed, after the first `skip` turns
 *  are passed over, cut after `max` turns; a file with no turn printed gets no line. */
function linesFor(exp, order, max = Infinity, skip = 0) {
  const out = [];
  let shown = 0, passed = 0, f = 0;
  for (const name of order) {
    if (shown >= max) break;
    const [file, hits] = exp[name];
    let printed = false;
    for (const h of hits) {
      if (shown >= max) break;
      if (passed < skip) { passed++; continue; }
      if (!printed) { out.push({ ...file, f: ++f }); printed = true; }
      out.push({ k: 'hit', f, ...h }); shown++;
    }
  }
  return out;
}
const closing = (r) => r.err.trimEnd().split('\n').pop();
const README = () => readFileSync(join(root, 'README.md'), 'utf8');

test('command: the coverage line first, then each file with a hit, newest first (no timestamp last), with its turns in path order; --oldest turns the files around', () => {
  const dir = orderFolder();
  try {
    const exp = orderExpected(dir);
    const r = ltms(['search', W, dir]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines[0].k, 'coverage');
    assert.deepEqual(r.lines.slice(1), linesFor(exp, ['a', 'c', 'b', 'd']));
    assert.equal(r.out, r.lines.map((l) => JSON.stringify(l) + '\n').join(''), 'stdout is whole JSON lines, each ending in a new line');
    const o = ltms(['search', '--oldest', W, dir]);
    assert.deepEqual(o.lines.slice(1), linesFor(exp, ['b', 'c', 'a', 'd']));
    assert.deepEqual([r.lines[0].shown, o.lines[0].shown], [{ skipped: 0, turns: 5, order: 'newest' }, { skipped: 0, turns: 5, order: 'oldest' }]);
    // the keys, in the design's order
    assert.deepEqual(Object.keys(r.lines[0]), ['k', 'query', 'mode', 'kinds', 'kindsOff', 'files', 'turns', 'records', 'notSearched', 'hits', 'shown', 'left', 'next', 'segmenter', 'ms']);
    assert.deepEqual(Object.keys(r.lines[1]), ['k', 'f', 'p', 'path', 'last']);
    assert.deepEqual(Object.keys(r.lines[2]), ['k', 'f', 'ta', 'ch', 'at']);
    assert.deepEqual(Object.keys(r.lines[2].at[0]), ['a', 'kind', 'field', 'at', 'w']);
  } finally { rm(dir); }
});

test('command: the coverage line of a known folder, field by field', () => {
  const dir = orderFolder();
  try {
    const c = ltms(['search', W, dir]).lines[0];
    assert.ok(Number.isInteger(c.ms) && c.ms >= 0, `ms ${c.ms}`);
    // 5 sessions; 8 turns of 2 records each; one last-prompt record (a side record) per file; 5 turns hold the word,
    // 3 of them in a prompt and 2 in a reply
    assert.deepEqual({ ...c, ms: 0 }, {
      k: 'coverage', query: [W], mode: 'words', kinds: DEFAULT_KINDS, kindsOff: ['meta', 'attachment'],
      files: { given: 1, found: 5, read: 5, failed: 0, notConversation: 0, symlinks: 0 },
      turns: 8, records: 16,
      notSearched: { offPath: 0, toolUseResult: 0, wireInputs: 0, redactedThinking: 0, sidecars: 5, images: 0, spilled: 0, replays: 0, beforeFirstTurn: 0, unreadableLines: 0, kindsOff: 0 },
      hits: { files: 4, turns: 5, records: 5, byKind: { input: 3, summary: 0, reply: 2, thinking: 0, call: 0, result: 0, system: 0 } },
      shown: { skipped: 0, turns: 5, order: 'newest' }, left: 0, next: null, segmenter: SEG, ms: 0,
    });
    // search-kinds.jsonl: the counts section 1 derived by hand, now through the command, with its file line's time
    const k = ltms(['search', 'zqkthird', fixture(K)]).lines;
    assert.deepEqual({ ...k[0], ms: 0 }, {
      k: 'coverage', query: ['zqkthird'], mode: 'words', kinds: DEFAULT_KINDS, kindsOff: ['meta', 'attachment'],
      files: { given: 1, found: 1, read: 1, failed: 0, notConversation: 0, symlinks: 0 },
      turns: 3, records: 18,
      notSearched: { offPath: 2, toolUseResult: 3, wireInputs: 1, redactedThinking: 1, sidecars: 2, images: 1, spilled: 1, replays: 1, beforeFirstTurn: 0, unreadableLines: 1, kindsOff: 3 },
      hits: { files: 1, turns: 1, records: 2, byKind: { input: 1, summary: 0, reply: 1, thinking: 0, call: 0, result: 0, system: 0 } },
      shown: { skipped: 0, turns: 1, order: 'newest' }, left: 0, next: null, segmenter: SEG, ms: 0,
    });
    assert.deepEqual(k[1], { k: 'file', f: 1, p: 'search-k', path: fixture(K), last: '2026-09-01T09:00:30.000Z' });
    assert.deepEqual(k[2], { k: 'hit', f: 1, ta: 'search-k:T003', ch: 'typed', at: [{ a: 'search-k:L22', kind: 'input', field: IN, at: 8, w: [0] }, { a: 'search-k:L23', kind: 'reply', field: OUT, at: 4, w: [0] }] });
    const all = ltms(['search', '--kind', 'all', 'zqkthird', fixture(K)]).lines[0];
    assert.deepEqual([all.kinds, all.kindsOff, all.records, all.notSearched.kindsOff], [[...S.SEARCH_KINDS], [], 21, 0]);
    const input = ltms(['search', '--kind', 'input', 'zqkthird', fixture(K)]).lines[0];
    assert.deepEqual([input.records, input.notSearched.kindsOff, input.hits], [5, 16, { files: 1, turns: 1, records: 1, byKind: { input: 1 } }]);
  } finally { rm(dir); }
});

test('command: --max caps the turns printed (a file whose turns are all cut gets no line), --max 0 prints every one, --count the coverage alone; left and next say what was not printed, and next prints the next ones', () => {
  const dir = orderFolder();
  try {
    const exp = orderExpected(dir), order = ['a', 'c', 'b', 'd'], all = linesFor(exp, order);
    // [args, the --max in force, as next repeats it]
    for (const [args, max] of [[['--max', '2'], 2], [['--max=3'], 3], [['--max', '1', '--max', '4'], 4], [['--max', '0'], 0], [[], 20]]) {
      const r = ltms(['search', ...args, W, dir]);
      const want = linesFor(exp, order, max || Infinity), shown = want.filter((l) => l.k === 'hit').length;
      assert.deepEqual(r.lines.slice(1), want, args.join(' '));
      assert.deepEqual([r.lines[0].shown.turns, r.lines[0].left], [shown, 5 - shown], args.join(' '));
      if (shown === 5) { assert.equal(r.lines[0].next, null, args.join(' ')); continue; }
      // the repair round (decision d): next passes over the turns printed, and keeps --max
      assert.equal(r.lines[0].next, `ltms search --skip ${shown} --max ${max} '${W}' ${sh(dir)}`, args.join(' '));
      assert.deepEqual(runCommandLine(r.lines[0].next).lines.slice(1), linesFor(exp, order, max, shown), args.join(' '));
    }
    const n = ltms(['search', '--count', W, dir]);
    assert.equal(n.lines.length, 1);
    assert.deepEqual([n.lines[0].shown.turns, n.lines[0].left, n.lines[0].hits.turns], [0, 5, 5]);
    assert.equal(n.lines[0].next, `ltms search --skip 0 --max 20 '${W}' ${sh(dir)}`);
    assert.deepEqual(runCommandLine(n.lines[0].next).lines.slice(1), all);
    // next keeps the options that change what is found or its order, and drops --count
    const k = ltms(['search', '--count', '--oldest', '--substring', '--kind', 'reply,input', W, dir]).lines[0];
    assert.equal(k.next, `ltms search --substring --kind input,reply --oldest --skip 0 --max 20 '${W}' ${sh(dir)}`);
    assert.deepEqual(runCommandLine(k.next).lines.slice(1), linesFor(exp, ['b', 'c', 'a', 'd']));
    // a query that starts with '-' is given after --, and next does the same
    const d = ltms(['search', '--max', '1', '--', `-${W}`, dir]).lines[0];
    assert.equal(d.next, `ltms search --skip 1 --max 1 -- '-${W}' ${sh(dir)}`);
    assert.deepEqual(runCommandLine(d.next).lines.slice(1), linesFor(exp, order, 1, 1));
  } finally { rm(dir); }
});

test('command: ONE closing line, last on stderr, with the totals; "as reported above" when something failed; at 0 turns, the ways to find more and the command', () => {
  const dir = orderFolder(), lone = tmp();
  try {
    writeFileSync(join(lone, 'empty.jsonl'), '');
    const cases = [
      // the repair round (search 16): the matching turns, and the files that hold them out of the files found
      [[W, dir], 0, 'ltms search: 5 matching turns in 4 of 5 files (5 read, 0 failed); 5 shown.'],
      [['--max', '2', W, dir], 0, 'ltms search: 5 matching turns in 4 of 5 files (5 read, 0 failed); 2 shown, 3 left: --skip 2 shows the next 2.'],
      [['--count', W, dir], 0, 'ltms search: 5 matching turns in 4 of 5 files (5 read, 0 failed); 0 shown (--count prints the coverage line only).'],
      [[W, join(dir, 'a.jsonl')], 0, 'ltms search: 1 matching turn in 1 of 1 file (1 read, 0 failed); 1 shown.'],
      [[W, dir, join(dir, 'missing.jsonl')], 1, 'ltms search: 5 matching turns in 4 of 6 files (5 read, 1 failed, as reported above); 5 shown.'],
      [['zqcnone', dir], 0, `ltms search: 0 matching turns in 5 files (5 read, 0 failed); 0 shown. To find more, try --kind all (meta and attachment were not searched) or --substring (each term inside longer words too): ltms search --substring 'zqcnone' ${sh(dir)}`],
      [['--kind', 'input,reply', 'zqcnone', dir], 0, `ltms search: 0 matching turns in 5 files (5 read, 0 failed); 0 shown. To find more, try --kind all (summary, thinking, call, result, system, meta and attachment were not searched) or --substring (each term inside longer words too): ltms search --substring --kind input,reply 'zqcnone' ${sh(dir)}`],
      [['zqcnone zqcword', '--kind', 'all', dir], 0, `ltms search: 0 matching turns in 5 files (5 read, 0 failed); 0 shown. To find more, try fewer words or --substring (each term inside longer words too): ltms search --substring --kind all 'zqcnone zqcword' ${sh(dir)}`],
      [['--substring', 'zqcnone', dir], 0, `ltms search: 0 matching turns in 5 files (5 read, 0 failed); 0 shown. To find more, try --kind all (meta and attachment were not searched): ltms search --substring --kind all 'zqcnone' ${sh(dir)}`],
      [['--substring', '--kind=all', 'zqcnone zqcword', dir], 0, 'ltms search: 0 matching turns in 5 files (5 read, 0 failed); 0 shown. To find more, try fewer words.'],
      [['--substring', '--kind=all', 'zqcnone', dir], 0, 'ltms search: 0 matching turns in 5 files (5 read, 0 failed); 0 shown.'],
      // no turn was searched at all: nothing to widen
      [[W, lone], 0, 'ltms search: 0 matching turns in 1 file (1 read, 0 failed); 0 shown.'],
    ];
    for (const [args, code, line] of cases) {
      const r = ltms(['search', ...args]);
      assert.equal(r.code, code, args.join(' '));
      assert.equal(closing(r), line, args.join(' '));
      assert.equal(r.err.split('\n').filter((l) => /^ltms search: \d+ matching turns? in (?:\d+ of )?\d+ files? \(/.test(l)).length, 1, args.join(' '));
      assert.doesNotMatch(r.err, /files done/);
    }
    // the command a closing line gives runs, and finds what it says it may
    const widened = closing(ltms(['search', '--kind', 'input', 'zqcwo', dir]));
    assert.match(widened, /: ltms search --substring --kind input 'zqcwo' /);
    const ran = runCommandLine(widened.slice(widened.indexOf(': ltms search ') + 2));
    assert.equal(ran.code, 0, ran.err);
    assert.equal(ran.lines[0].hits.turns, 3);   // c, b and d hold the word in a prompt
  } finally { rm(dir, lone); }
});

test('command: usage errors exit 2 with nothing on stdout, each one echoing the input and giving the fix', () => {
  const dir = orderFolder();
  try {
    const kinds = 'input, summary, reply, thinking, call, result, system, meta, attachment, or all';
    const cases = [
      [['--kind'], `ltms search: --kind needs a list of kinds after it: ${kinds} (e.g. --kind input,reply).`],
      [['--kind', 'prompts', W, dir], `ltms search: unknown kind 'prompts'. The kinds are ${kinds}.`],
      [['--kind=input,user', W, dir], `ltms search: unknown kind 'user' in --kind 'input,user'. The kinds are ${kinds}.`],
      [['--kind=', W, dir], `ltms search: --kind '' names no kind. The kinds are ${kinds}.`],
      [['--kind', ' , ', W, dir], `ltms search: --kind ' , ' names no kind. The kinds are ${kinds}.`],
      [['--max'], 'ltms search: --max needs a number after it: the turns to print (0 prints every one).'],
      [['--max', '-1', W, dir], "ltms search: --max takes a whole number of turns to print (0 prints every one); '-1' is not one."],
      [['--max=2.5', W, dir], "ltms search: --max takes a whole number of turns to print (0 prints every one); '2.5' is not one."],
      [['--max=', W, dir], "ltms search: --max takes a whole number of turns to print (0 prints every one); '' is not one."],
      [['--count=yes', W, dir], "ltms search: --count takes no value; '--count=yes' gives it one."],
      [['--substring=1', W, dir], "ltms search: --substring takes no value; '--substring=1' gives it one."],
      [['--oldest=yes', W, dir], "ltms search: --oldest takes no value; '--oldest=yes' gives it one."],
      [['--frobnicate', W, dir], "ltms search: unknown option '--frobnicate'. The options are --kind <list>, --substring, --max <n>, --skip <n>, --count and --oldest; put -- before a query or a path that starts with '-'."],
      [['-', dir], "ltms search: reading from standard input ('-') is not supported. Give the transcripts' folder or files after the query, e.g. ltms search 'compaction summary' ~/.claude/projects/<project>"],
      [['--', '...', dir], `ltms search: the query '...' has no word to search: it has no letter or digit. Give words, e.g. ltms search 'compaction summary' ${sh(dir)}`],
      [['--', '-> ...', dir], `ltms search: the query '-> ...' has no word to search: none of its terms has a letter or digit. Give words, e.g. ltms search 'compaction summary' ${sh(dir)}`],
      [['', dir], `ltms search: the query '' has no word to search: it is empty. Give words, e.g. ltms search 'compaction summary' ${sh(dir)}`],
      // the misorder: the query names an existing path that looks like one, or a path argument is missing and looks like
      // a word (run in `dir`, where none of the words exists)
      [[join(dir, 'a.jsonl')], `ltms search: the query comes first, as one quoted argument, then the paths. Read as the query: '${join(dir, 'a.jsonl')}', which is an existing path; as paths: none. For example: ltms search '<query>' ${sh(join(dir, 'a.jsonl'))}`],
      [[dir, W], `ltms search: the query comes first, as one quoted argument, then the paths. Read as the query: '${dir}', which is an existing path; as paths: '${W}' (no such file or directory). If the query is '${W}': ltms search '${W}' ${sh(dir)}`],
      [['a.jsonl', W], `ltms search: the query comes first, as one quoted argument, then the paths. Read as the query: 'a.jsonl', which is an existing path; as paths: '${W}' (no such file or directory). If the query is '${W}': ltms search '${W}' a.jsonl`],
      [['exports', 'map', dir], `ltms search: the query comes first, as one quoted argument, then the paths. Read as the query: 'exports'; as paths: 'map' (no such file or directory), '${dir}'. If the query is 'exports map': ltms search 'exports map' ${sh(dir)}`],
    ];
    for (const [args, message] of cases) {
      const r = ltms(['search', ...args], { cwd: dir });
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.out, '', args.join(' '));
      assert.equal(r.err, message + '\n', args.join(' '));
    }
    // a query that names an existing path WITHOUT looking like one is a query: this package's own folder holds test/
    const t = ltms(['search', 'test', dir], { cwd: root });
    assert.equal(t.code, 0, t.err);
    assert.deepEqual(t.lines[0].query, ['test']);
    // and the misorder's command runs
    const m = ltms(['search', 'exports', 'map', dir], { cwd: dir }).err.trimEnd();
    assert.equal(runCommandLine(m.slice(m.lastIndexOf(': ltms search ') + 2), { cwd: dir }).code, 0);
  } finally { rm(dir); }
});

test("command: no path: the next command with this directory's project folder (under ~/.claude/projects, or $CLAUDE_CONFIG_DIR), when it exists; a name over 200 characters is cut and hashed", () => {
  const home = tmp(), cwd = tmp(), config = tmp();
  try {
    const name = cwd.replace(/[^A-Za-z0-9]/g, '-');   // Claude Code's rule, one UTF-16 unit at a time
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    let r = ltms(['search', W], { cwd, env });
    assert.deepEqual([r.code, r.out], [2, '']);
    assert.equal(r.err, `ltms search: no path given. Give the transcripts' folder or files after the query. This directory's project folder would be ~/.claude/projects/${name}, which does not exist; ls ~/.claude/projects lists the project folders: ltms search '${W}' ~/.claude/projects/<folder>\n`);
    assert.equal(ltms(['search'], { cwd, env }).err, "ltms search: no query given. The query comes first, as one quoted argument, then the transcripts' folder or files: ltms search 'compaction summary' ~/.claude/projects/<project>\n");
    // the folder exists: its command, which runs
    mkdirSync(join(home, '.claude', 'projects', name), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', name, 's.jsonl'), session([[`${W} here`, X]], '2026-03-05T00:00:00.000Z'));
    r = ltms(['search', W], { cwd, env });
    const command = `ltms search '${W}' ~/.claude/projects/${name}`;
    assert.equal(r.err, `ltms search: no path given. Give the transcripts' folder or files after the query; this directory's project folder is ~/.claude/projects/${name}: ${command}\n`);
    const ran = runCommandLine(command, { cwd, env });
    assert.equal(ran.code, 0, ran.err);
    assert.equal(ran.lines[0].hits.turns, 1);
    assert.equal(ltms(['search'], { cwd, env }).err, `ltms search: no query given. The query comes first, as one quoted argument, then the transcripts' folder or files: ltms search 'compaction summary' ~/.claude/projects/${name}\n`);
    // $CLAUDE_CONFIG_DIR, when set, holds the projects
    mkdirSync(join(config, 'projects', name), { recursive: true });
    r = ltms(['search', W], { cwd, env: { ...env, CLAUDE_CONFIG_DIR: config } });
    const folder = `${sh(join(config, 'projects'))}/${name}`;
    assert.equal(r.err, `ltms search: no path given. Give the transcripts' folder or files after the query; this directory's project folder is ${folder}: ltms search '${W}' ${folder}\n`);
    // a directory whose folder name is exactly 200 characters long is not cut; one of 201 is
    const at200 = join(cwd, 'd'.repeat(200 - name.length - 1)), long = join(cwd, 'd'.repeat(201 - name.length - 1));
    mkdirSync(at200);
    mkdirSync(long);
    assert.deepEqual([at200.replace(/[^A-Za-z0-9]/g, '-').length, long.replace(/[^A-Za-z0-9]/g, '-').length], [200, 201]);
    r = ltms(['search', W], { cwd: at200, env });
    assert.match(r.err, /This directory's project folder would be ~\/\.claude\/projects\/-.{199}, which does not exist;/);
    r = ltms(['search', W], { cwd: long, env });
    assert.equal(r.err, `ltms search: no path given. Give the transcripts' folder or files after the query. This directory's path is longer than 200 characters, so Claude Code cuts its folder's name and adds a hash: find the folder with ls ~/.claude/projects, then run ltms search '${W}' ~/.claude/projects/<folder>\n`);
  } finally { rm(home, cwd, config); }
});

test('command: the walk: a symbolic link named is followed, links met under a directory are counted and not followed; each file once, by its real path; the paths found in UTF-16 code unit order', () => {
  const base = tmp();
  try {
    const A = join(base, 'A'), B = join(base, 'B'), out = join(base, 'out');
    for (const d of [join(A, 'abc'), B, join(out, 'sub')]) mkdirSync(d, { recursive: true });
    // sorted by UTF-16 code units: Z (0x5a) before a (0x61); abc.jsonl before abc/x.jsonl ('.' 0x2e before '/' 0x2f);
    // z (0x7a) before e with an acute accent (0xe9)
    const sorted = ['Z.jsonl', 'abc.jsonl', join('abc', 'x.jsonl'), 'abd.jsonl', 'z.jsonl', `${cp(0xe9)}.jsonl`];
    for (const n of [...sorted].reverse()) writeFileSync(join(A, n), session([[`${W} ${n.length}`, X]], null));
    writeFileSync(join(A, 'notes.txt'), session([[W, X]], null));   // not *.jsonl: not read
    assert.equal(spawnSync('mkfifo', [join(A, 'pipe.jsonl')]).status, 0);   // not a regular file: not read (it would block)
    writeFileSync(join(B, 'm.jsonl'), session([[W, X]], null));
    writeFileSync(join(out, 'o.jsonl'), session([[W, X]], null));
    writeFileSync(join(out, 'sub', 's.jsonl'), session([[W, X]], null));
    symlinkSync(join(out, 'o.jsonl'), join(A, 'link.jsonl'));   // met under a directory: counted, not followed
    symlinkSync(join(out, 'sub'), join(A, 'linkdir'));          // the same
    symlinkSync(B, join(base, 'Blink'));                         // named: followed
    // no timestamps, so the files keep the walk's order: the arguments in order, each directory's paths sorted
    const r = ltms(['search', W, join(base, 'Blink'), A]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.lines.filter((l) => l.k === 'file').map((l) => l.path), [join(base, 'Blink', 'm.jsonl'), ...sorted.map((n) => join(A, n))]);
    assert.deepEqual(r.lines[0].files, { given: 2, found: 7, read: 7, failed: 0, notConversation: 0, symlinks: 2 });
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      'ltms search: warning: 2 symbolic links were met under the directories given and not followed (files.symlinks); 1 entry named .jsonl under the directories given is not a regular file, such as a pipe or a socket, and was not read.',
      'ltms search: 7 matching turns in 7 of 7 files (7 read, 0 failed); 7 shown.',
    ]);
    // each file once, by its real path: named twice, named through a link, and found under its directory
    symlinkSync(join(B, 'm.jsonl'), join(base, 'mlink.jsonl'));
    const d = ltms(['search', W, join(B, 'm.jsonl'), join(B, 'm.jsonl'), join(base, 'mlink.jsonl'), B]);
    assert.deepEqual(d.lines[0].files, { given: 4, found: 1, read: 1, failed: 0, notConversation: 0, symlinks: 0 });
    assert.deepEqual(d.lines.slice(1).map((l) => [l.k, l.path ?? l.ta]), [['file', join(B, 'm.jsonl')], ['hit', 'm.jsonl:T001']]);
  } finally { rm(base); }
});

test('command: a directory that cannot be read is reported and counted as failed (exit 1), and the rest is searched; a directory with no .jsonl file says so', (t) => {
  if (process.getuid?.() === 0) { t.skip('running as root, which can read any directory'); return; }
  const base = tmp(), locked = join(base, 'locked'), empty = join(base, 'nothing');
  try {
    mkdirSync(locked);
    mkdirSync(empty);
    writeFileSync(join(base, 'ok.jsonl'), session([[W, X]], null));
    writeFileSync(join(locked, 'hidden.jsonl'), session([[W, X]], null));
    writeFileSync(join(empty, 'readme.txt'), 'no transcript here');
    chmodSync(locked, 0o000);
    const r = ltms(['search', W, base, empty]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      `ltms search: cannot read the directory '${locked}': permission denied, so the files under it are not searched. Check its permissions with: ls -ld '${locked}'`,
      `ltms search: warning: '${empty}' holds no .jsonl file at any depth, so nothing in it is searched. Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.`,
      'ltms search: 1 matching turn in 1 of 2 files (1 read, 1 failed, as reported above); 1 shown.',
    ]);
    assert.deepEqual(r.lines[0].files, { given: 2, found: 2, read: 1, failed: 1, notConversation: 0, symlinks: 0 });
    assert.deepEqual(r.lines.filter((l) => l.k === 'file').map((l) => l.path), [join(base, 'ok.jsonl')]);
  } finally { chmodSync(locked, 0o700); rm(base); }
});

test('command: a file over a tenth of the heap limit is skipped and counted as failed, with the NODE_OPTIONS command, which reads it; a file at the limit is read', () => {
  // a small heap, so the limit is small (a real session at a tenth of the heap limit was measured to fit from an old space
  // of 32 MiB up: NOTES-B2 section 3)
  const node = ['--max-old-space-size=64'];
  const heap = Number(spawnSync(process.execPath, [...node, '-e', "process.stdout.write(String(require('node:v8').getHeapStatistics().heap_size_limit))"], { encoding: 'utf8' }).stdout);
  const limit = Math.floor(heap / 10);
  assert.ok(limit > 1e6 && limit < 1e8, `limit ${limit}`);
  const dir = tmp();
  try {
    const text = read(K), at = join(dir, 'at.jsonl'), over = join(dir, 'over.jsonl');
    writeFileSync(at, text + ' '.repeat(limit - Buffer.byteLength(text) - 1) + '\n');   // a line of blanks pads it
    const fd = openSync(over, 'w');
    ftruncateSync(fd, limit + 1);                                                          // sparse: NUL bytes, unwritten
    closeSync(fd);
    assert.deepEqual([statSync(at).size, statSync(over).size], [limit, limit + 1]);
    const r = ltms(['search', 'zqkthird', at, over], { node });
    const sep = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const need = Math.ceil(((limit + 1) * 10) / 2 ** 30) * 1024;
    assert.equal(r.code, 1);
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      `ltms search: warning: '${at}': 1 line could not be read as a JSON object of at most 1,000 levels (first: line 26) and was skipped.`,   // search-kinds' own L26
      `ltms search: '${over}' is ${sep(limit + 1)} bytes, over the ${sep(limit)} this Node can search in one file (a tenth of its memory limit: reading it could run out of memory, which would stop the whole search and lose every hit), so it is skipped. To search it, give Node more memory: NODE_OPTIONS=--max-old-space-size=${need} ltms search 'zqkthird' ${sh(over)}`,
      'ltms search: 1 matching turn in 1 of 2 files (1 read, 1 failed, as reported above); 1 shown.',
    ]);
    assert.deepEqual(r.lines[0].files, { given: 2, found: 2, read: 1, failed: 1, notConversation: 0, symlinks: 0 });
    assert.deepEqual(r.lines.filter((l) => l.k === 'hit').map((l) => l.ta), ['at.jsonl:T003']);
    // with the memory the message names, the file is read (NUL bytes only: one line that is not JSON, and no records)
    const more = ltms(['search', 'zqkthird', over], { env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${need}` } });
    assert.equal(more.code, 0, more.err);
    assert.deepEqual(more.lines[0].files, { given: 1, found: 1, read: 1, failed: 0, notConversation: 1, symlinks: 0 });
  } finally { rm(dir); }
});

test("command: under a walk, the files with nothing to search are counted in ONE summary line; named, each keeps skeleton's warning; no address-prefix warning", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'samepref-1.jsonl'), session([[W, X]], '2026-03-01T00:00:00.000Z'));
    writeFileSync(join(dir, 'samepref-2.jsonl'), session([[X, W]], '2026-03-02T00:00:00.000Z') + '{not json\n');   // line 4
    writeFileSync(join(dir, 'journal.jsonl'), '{"type":"launched"}\n{"type":"started"}\n{"type":"result"}\n');
    writeFileSync(join(dir, 'empty.jsonl'), '');
    writeFileSync(join(dir, 'other.jsonl'), '{"type":"summary","summary":"invented","leafUuid":"x"}\n');
    writeFileSync(join(dir, 'noturn.jsonl'), JSON.stringify({ type: 'assistant', uuid: uuidN(1), parentUuid: null, requestId: 'r', message: { role: 'assistant', content: [{ type: 'text', text: X }] } }) + '\n');
    const r = ltms(['search', W, dir]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      `ltms search: warning: of the 6 files read under the directories given, 1 is a workflow journal, 1 is empty, 1 has no conversation records and 1 has no turn on its live path, so nothing in them is searched (files.notConversation); 1 file read under the directories given has warnings of its own: '${join(dir, 'samepref-2.jsonl')}' (lines that could not be read): name it on the command line to see its warnings: ltms search '${W}' ${sh(join(dir, 'samepref-2.jsonl'))}`,
      'ltms search: 2 matching turns in 2 of 6 files (6 read, 0 failed); 2 shown.',
    ]);
    assert.equal(r.lines[0].files.notConversation, 4);
    // two files with one address prefix: told apart by f (newest first), with no warning
    assert.deepEqual(r.lines.filter((l) => l.k === 'file').map((l) => [l.f, l.p, l.path]), [[1, 'samepref', join(dir, 'samepref-2.jsonl')], [2, 'samepref', join(dir, 'samepref-1.jsonl')]]);
    assert.deepEqual(r.lines.filter((l) => l.k === 'hit').map((l) => [l.f, l.ta]), [[1, 'samepref:T001'], [2, 'samepref:T001']]);
    // named on the command line: each keeps skeleton's per-file warning, worded for search
    const named = ['journal.jsonl', 'empty.jsonl', 'other.jsonl', 'noturn.jsonl', 'samepref-2.jsonl'].map((n) => join(dir, n));
    assert.deepEqual(ltms(['search', W, ...named]).err.split('\n').filter((l) => l), [
      `ltms search: warning: '${named[0]}' is a workflow journal (launched, started and result records only), not a conversation, so nothing in it is searched.`,
      `ltms search: warning: '${named[1]}' holds no records, so nothing in it is searched.`,
      `ltms search: warning: '${named[2]}' has no conversation records (no record carries both uuid and parentUuid; record types found: summary), so nothing in it is searched. Conversation transcripts are the <session>.jsonl files in ~/.claude/projects/<project>/ and the agent-<id>.jsonl files under <session>/subagents/.`,
      `ltms search: warning: '${named[3]}' has conversation records but no turn on its live path, so nothing in it is searched.`,
      `ltms search: warning: '${named[4]}': 1 line could not be read as a JSON object of at most 1,000 levels (first: line 4) and was skipped.`,
      'ltms search: 1 matching turn in 1 of 5 files (5 read, 0 failed); 1 shown.',
    ]);
  } finally { rm(dir); }
});

test('command: exit status 0 when every file was read (with hits or without), 1 when one could not be, 2 on a usage error', () => {
  const dir = orderFolder();
  try {
    assert.equal(ltms(['search', W, dir]).code, 0);
    assert.equal(ltms(['search', 'zqcnone', dir]).code, 0);
    const missing = join(dir, 'gone.jsonl');
    const r = ltms(['search', W, missing, dir]);
    assert.equal(r.code, 1);
    assert.ok(r.err.startsWith(`ltms search: cannot read '${missing}': no such file or directory. Check the path. Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.\n`), r.err);
    assert.equal(r.lines[0].hits.turns, 5);   // the other files are searched
    // a missing path that holds a / is a path, reported as missing (exit 1), not taken for a word of the query
    const gone = join(dir, 'no-such-folder');
    const g = ltms(['search', W, gone, dir]);
    assert.equal(g.code, 1);
    assert.ok(g.err.startsWith(`ltms search: cannot read '${gone}': no such file or directory.`), g.err);
    assert.equal(ltms(['search', '--max', 'x', W, dir]).code, 2);
  } finally { rm(dir); }
});

test("command: no line of stdout or stderr holds text of a prompt, reply, tool input or result: a planted word appears only as the query's own term", () => {
  const planted = [...new Set(read(K).match(/zqk[a-z0-9]+/g))];
  assert.ok(planted.length >= 25, `${planted.length} planted words`);
  for (const w of planted) for (const opts of [[], ['--kind', 'all', '--substring', '--max', '0']]) {
    const r = ltms(['search', ...opts, w, fixture(K)]);
    const name = `${w}${opts.length ? ' ' + opts.join(' ') : ''}`;
    for (const v of planted) if (v !== w && !w.includes(v)) assert.ok(!r.out.includes(v) && !r.err.includes(v), `searching ${name}: ${v} reached the output`);
    assert.deepEqual(r.lines[0].query, [w], name);
    // the query's own word: in the coverage's query and next only, and on stderr only inside a quoted echo of the query
    const rest = JSON.stringify({ ...r.lines[0], query: null, next: null }) + r.lines.slice(1).map((l) => JSON.stringify(l)).join('');
    assert.ok(!rest.includes(w), `${name}: the word in a field other than query and next`);
    assert.ok(!r.err.split(`'${w}'`).join('').includes(w), `${name}: the word on stderr outside an echo of the query`);
  }
  // a timestamp that is not one (free text in a crafted record) is withheld, and the file sorts last
  const dir = tmp();
  try {
    const crafted = session([[W, X]], null).replace('"promptSource":"typed",', '"promptSource":"typed","timestamp":"zqcsecret free text",');
    writeFileSync(join(dir, 'crafted.jsonl'), crafted);
    // a time Date.parse reads, but not ISO 8601 (and later than the plain file's): withheld, and sorted last too
    writeFileSync(join(dir, 'dated.jsonl'), session([[W, X]], null).replace('"promptSource":"typed",', '"promptSource":"typed","timestamp":"Mon, 01 Mar 2027 00:00:00 GMT",'));
    writeFileSync(join(dir, 'plain.jsonl'), session([[W, X]], '2026-03-01T00:00:00.000Z'));
    const r = ltms(['search', W, dir]);
    assert.deepEqual(r.lines.filter((l) => l.k === 'file').map((l) => [l.path, l.last]), [[join(dir, 'plain.jsonl'), '2026-03-01T00:00:02.000Z'], [join(dir, 'crafted.jsonl'), '(withheld)'], [join(dir, 'dated.jsonl'), '(withheld)']]);
    assert.ok(!(r.out + r.err).includes('zqcsecret'));
  } finally { rm(dir); }
});

test('command: every string an output line carries is a fixed word, a label, an address, a key path, a timestamp, or the input (the query, the paths)', () => {
  // every fixture, every kind, --substring 'e': nearly every record holding text is a hit
  const r = ltms(['search', '--kind', 'all', '--substring', '--max', '0', 'e', join(here, 'fixtures')]);
  assert.equal(r.code, 0, r.err);
  const label = /^[\w.:+-]{1,64}$/, fileOf = new Map();
  const prefixOf = (path) => { const n = path.slice(path.lastIndexOf('/') + 1); return n.startsWith('agent-') ? `agent-${n.slice(6, 14)}` : n.slice(0, 8); };
  let hits = 0, entries = 0;
  for (const l of r.lines) {
    if (l.k === 'coverage') {
      assert.deepEqual([l.query, l.mode, l.segmenter, l.shown.order], [['e'], 'substring', SEG, 'newest']);
      for (const k of [...l.kinds, ...l.kindsOff, ...Object.keys(l.hits.byKind)]) assert.ok(S.SEARCH_KINDS.includes(k), k);
      continue;
    }
    if (l.k === 'file') {
      assert.ok(l.path.startsWith(join(here, 'fixtures') + '/') && l.path.endsWith('.jsonl'), l.path);
      assert.equal(l.p, prefixOf(l.path));
      assert.ok(l.last === null || l.last === '(withheld)' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(l.last), l.last);
      fileOf.set(l.f, l);
      continue;
    }
    assert.equal(l.k, 'hit');
    hits++;
    const p = fileOf.get(l.f).p;
    assert.match(l.ta, new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:T\\d{3,}$`));
    assert.ok(l.ch === '(withheld)' || label.test(l.ch), l.ch);
    for (const e of l.at) {
      entries++;
      assert.ok(e.a.startsWith(`${p}:L`) && /^\d+$/.test(e.a.slice(p.length + 2)), e.a);
      assert.ok(S.SEARCH_KINDS.includes(e.kind), e.kind);
      for (const key of e.field) assert.ok(Number.isInteger(key) || key === '(withheld)' || label.test(key), String(key));
      assert.ok(Number.isInteger(e.at) && e.at >= 0 && e.w.every(Number.isInteger));
    }
  }
  assert.ok(hits > 100 && entries > 300, `${hits} hits, ${entries} entries`);
});

const HELP_005 = read('help-0.0.5.txt');   // `ltms --help` as 0.0.5 printed it (its build, run once; 9,026 bytes)
test("help: ltms --help is 0.0.5's, with search's, index's, pin's and skill's usage lines and paragraphs more (each pointing to its own --help, after the stats fields in that order), pin's two sentences (DESIGN 4.5), the sentence on reading with search's and index's walks, the index named apart from skeleton (0.2.0), and nothing else changed", () => {
  const h = ltms(['--help']).out;
  const usageLine = '  ltms search <query> <path>...   the turns that hold every word of the query\n';
  const start = h.indexOf('search finds the turns'), stop = h.indexOf('\n\n', start) + 2;
  assert.ok(start > 0 && h.includes(usageLine));
  const paragraph = h.slice(start, stop);
  assert.match(paragraph.replace(/\s+/g, ' '), /ltms search --help gives its whole part/);
  // 0.2.0: index's usage line and paragraph, right after search's
  const indexUsageLine = '  ltms index <path>...            one JSON line per session, newest first\n';
  const indexStart = h.indexOf('index lists the sessions in the transcripts named'), indexStop = h.indexOf('\n\n', indexStart) + 2;
  assert.ok(indexStart > 0 && h.includes(indexUsageLine));
  const indexParagraph = h.slice(indexStart, indexStop);
  assert.match(indexParagraph.replace(/\s+/g, ' '), /ltms index --help gives its whole part/);
  // the merge: pin's usage line and paragraph, and the two sentences pin changed (as printed now, and as 0.0.5 printed them)
  const pinUsageLine = '  ltms pin <path>... --to <dir>   copies the cleanup does not delete, and a log\n';
  const pinStart = h.indexOf('pin keeps copies of the transcripts'), pinStop = h.indexOf('\n\n', pinStart) + 2;
  assert.ok(pinStart > 0 && h.includes(pinUsageLine));
  const pinParagraph = h.slice(pinStart, pinStop);
  assert.match(pinParagraph.replace(/\s+/g, ' '), /ltms pin --help has its forms and output/);
  // 0.2.0: skill's usage line and paragraph, right after pin's
  const skillUsageLine = '  ltms skill                      the skill that teaches an agent to use ltms\n';
  const skillStart = h.indexOf('skill prints SKILL.md'), skillStop = h.indexOf('\n\n', skillStart) + 2;
  assert.ok(skillStart > 0 && h.includes(skillUsageLine));
  const skillParagraph = h.slice(skillStart, skillStop);
  assert.match(skillParagraph.replace(/\s+/g, ' '), /ltms skill --help says how to install it/);
  // 0.2.0: the index is index's list of sessions; the per-turn lines are skeleton's (the sentence as printed now, and
  // as 0.0.5 printed it)
  const appends = ['Claude Code appends to it (it can rewrite one only in rare cases, and pin\nkeeps both versions). ltms index lists the sessions, one line each, and\nltms skeleton prints one line per turn and per tool call of a session, each\nwith the line of the file where it is written, so what compaction took out of\nthe context can be found and read again (for line 22: sed -n 22p <file>).\n',
    'Claude Code only appends to it. ltms prints an index of the transcript,\none line per turn and per tool call, each with the line of the file where it\nis written, so what compaction took out of the context can be found and read\nagain (for line 22: sed -n 22p <file>).\n'];
  // the repair round (merge 1), then 0.2.0: the sentence on reading names search's and index's walks, and skill's file
  const reads = ["ltms reads only the files it is given (search and index: also the .jsonl\nfiles under the directories they are given, index not those in a session's\nown directory, set-aside copies or pin directories; pin: the files under the\npaths it is given; skill: its own SKILL.md and package.json), writes only to\nstdout and stderr, except pin, which writes only into its --to directory, and\nuses no network.\n",
    'ltms reads only the files it is given, writes only to stdout and stderr,\nand uses no network.\n'];
  assert.ok(h.includes(appends[0]) && h.includes(reads[0]));
  // the repair round (merge 11), then 0.2.0: search's paragraph right after the stats fields, then index's, pin's and skill's
  assert.ok(h.slice(0, start).endsWith('  hopsOver2     chains of more than 2 hops\n\n'), "search's paragraph does not follow the stats fields");
  assert.deepEqual([indexStart, pinStart, skillStart], [stop, indexStop, pinStop], 'the paragraphs are not search, index, pin and skill, in that order');
  assert.equal(h.replace(usageLine, '').replace(indexUsageLine, '').replace(skillUsageLine, '').replace(paragraph, '').replace(indexParagraph, '')
    .replace(pinUsageLine, '').replace(pinParagraph, '').replace(skillParagraph, '').replace(...appends).replace(...reads)
    // 0.2.0: index tells files with one prefix apart by their path, so the sentence names skeleton and stats
    .replace('that get the same prefix cannot be told apart in one run of skeleton or stats\n(a warning names them): give them to separate runs.\n', 'that get the same prefix cannot be told apart in one run (a warning names\nthem): give them to separate runs.\n'), HELP_005);
  for (const args of [['skeleton', '--help'], ['stats', '-h'], ['help']]) assert.equal(ltms(args).out, h, args.join(' '));
  // the usage errors print the usage with every command in it
  for (const l of [usageLine, indexUsageLine, pinUsageLine, skillUsageLine]) assert.ok(ltms([]).err.includes(l), l);
  assert.match(ltms(['skelton']).err, /^ltms: unknown command 'skelton'\. The commands are index, skeleton, stats, search, pin and skill\.\n/);
});

/** The keys search prints, read from its output: the top-level keys of each kind of line, and the nested ones. */
function searchKeys() {
  const top = new Set(), nested = new Set();
  const hebrew = cp(0x5d1, 0x5d9, 0x5ea);
  for (const r of [ltms(['search', 'zqkthird', fixture(K)]), ltms(['search', hebrew, fixture(SC)])]) {
    for (const l of r.lines) {
      for (const [k, v] of Object.entries(l)) {
        top.add(k);
        if (k === 'at') for (const e of v) for (const x of Object.keys(e)) nested.add(x);
        else if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'gapScripts') for (const x of Object.keys(v)) if (k !== 'byKind') nested.add(x);
      }
    }
  }
  for (const k of top) nested.delete(k);
  return { top: [...top], nested: [...nested] };
}

test("help: ltms search --help prints search's whole part, in the order the operator seat gave, and describes every field search prints", () => {
  const h = ltms(['search', '--help']);
  assert.deepEqual([h.code, h.err], [0, '']);
  for (const args of [['search', '-h'], ['search', W, '--help'], ['search', '--kind', 'all', '-h', 'x']]) assert.equal(ltms(args).out, h.out, args.join(' '));
  // --version and -v after search print the version, as after skeleton and stats
  const version = JSON.parse(readFileSync(join(DIST, '..', 'package.json'), 'utf8')).version;
  for (const flag of ['--version', '-v']) assert.deepEqual([ltms(['search', flag]).out, ltms(['search', W, flag]).code], [`${version}\n`, 0], flag);
  // review o29's order: the query as one quoted argument; the project folder; the coverage line first; reading a hit
  // with the window command; --kind and --substring; what is folded; how long a scan takes
  const marks = ['as ONE quoted argument', 'and 0-9 written as -', 'The first line printed is the coverage', "node -e 'const [p,l,f,a]", '--kind <list>', '--substring     find', 'What is folded', 'Time, measured'];
  const at = marks.map((m) => h.out.indexOf(m));
  assert.deepEqual(marks.filter((_, i) => at[i] < 0), []);
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  const { top, nested } = searchKeys();
  assert.ok(top.length >= 20 && nested.length >= 20, `${top.length} keys, ${nested.length} nested`);
  for (const k of top) assert.match(h.out, new RegExp(`^ {2}${k} +\\S`, 'm'), `the help has no line for ${k}`);
  for (const k of nested) assert.match(h.out, new RegExp(`\\b${k}\\b`), `the help does not name ${k}`);
  assert.equal(h.out.split('\n').filter((l) => l.length > 80 && !l.includes("node -e '")).length, 0, 'a line of the help is over 80 columns');
});

test('help and README: the window command prints the match, from the path, the line of a, field and at', () => {
  const e = ltms(['search', 'zqkthird', fixture(K)]).lines[2].at[1];   // L23, the reply, at 4
  const line = Number(e.a.slice(e.a.lastIndexOf(':L') + 2));
  for (const [where, text] of [['--help', ltms(['search', '--help']).out], ['README', README()]]) {
    const cmd = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith("node -e 'const [p,l,f,a]"));
    assert.ok(cmd, `${where} has no window command`);
    const program = cmd.slice("node -e '".length, cmd.indexOf("'", "node -e '".length));
    const r = spawnSync(process.execPath, ['-e', program, fixture(K), String(line), JSON.stringify(e.field), String(e.at)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const v = rawLine(K, line).message.content[0].text;
    assert.equal(r.stdout, v.slice(Math.max(0, e.at - 300), e.at + 300) + '\n', where);
    assert.ok(r.stdout.includes('zqkthird'), where);
  }
});

test("README: search's section, after stats: its example lines are what the command prints on demo.jsonl (ms aside), and it has a row for every field", () => {
  const readme = README();
  // the section ends at the next heading of its level or above: pin's section follows it (the repair round, merge 3)
  const stats = readme.indexOf('### `ltms stats'), start = readme.indexOf('### `ltms search <query> <path>...`');
  const end = Math.min(...['\n### ', '\n## '].map((m) => readme.indexOf(m, start + 1)).filter((i) => i > 0));
  assert.ok(stats > 0 && start > stats && end > start, 'no search section after stats');
  const section = readme.slice(start, end);
  const command = "ltms search 'npm test' test/fixtures/demo.jsonl";
  assert.ok(section.includes(command), 'the example command is not in the section');
  const printed = ltms(['search', 'npm test', 'test/fixtures/demo.jsonl'], { cwd: root });
  const noMs = (l) => l.replace(/"ms":\d+/, '"ms":0');
  const examples = section.split('\n').filter((l) => l.startsWith('{"k":'));
  assert.deepEqual(examples.map(noMs), printed.out.split('\n').filter((l) => l).map(noMs));
  assert.ok(section.includes(closing(printed)), 'the closing line is not in the section');
  const { top, nested } = searchKeys();
  for (const k of [...top, ...nested]) assert.match(section, new RegExp(`^\\| \`${k}\` \\|`, 'm'), `the README does not describe '${k}'`);
  // the whole README: every line that is search's output shape stands in this section (0.0.5's own test reads the rest)
  const shapes = readme.split('\n').filter((l) => /^\{"k":"(?:coverage","query"|file"|hit")/.test(l));
  assert.deepEqual(shapes, examples);
  // the notice it shows is the one the command prints, for the Hebrew for house on the same file
  const notice = ltms(['search', cp(0x5d1, 0x5d9, 0x5ea), 'test/fixtures/demo.jsonl'], { cwd: root }).err.split('\n').find((l) => l.startsWith('ltms search: notice: '));
  assert.ok(notice && section.split('\n').includes(notice), 'the README shows a notice the command does not print');
});

test('command: the notices: a script whose words take attached letters (the words echoed, an example, the --substring command), a spaceless script, the cost under --substring, a term left out, a quote not closed', () => {
  const he = cp(0x5d1, 0x5d9, 0x5ea), heLong = cp(0x5d5, 0x5d4, 0x5d1, 0x5d9, 0x5ea);
  const ar = cp(0x643, 0x62a, 0x627, 0x628), arLong = cp(0x648, 0x627, 0x644, 0x643, 0x62a, 0x627, 0x628);
  const ko = cp(0xd559, 0xad50), koLong = cp(0xd559, 0xad50, 0xc5d0, 0xc11c);
  const ja = cp(0x6771, 0x4eac);
  const f = fixture(SC), notices = (r) => r.err.split('\n').filter((l) => l.startsWith('ltms search: notice: '));
  let r = ltms(['search', he, f]);
  assert.deepEqual(notices(r), [`ltms search: notice: '${he}' is in the Hebrew script, whose words take letters attached before or after them, and words mode finds whole words only: for example, ${he} does not find ${heLong}. To find it inside longer words too: ltms search --substring '${he}' ${sh(f)}`]);
  assert.deepEqual(Object.keys(r.lines[0].gapScripts), ['Hebrew']);
  r = ltms(['search', `${ar} ${ko}`, f]);
  assert.deepEqual(notices(r), [`ltms search: notice: '${ar}' and '${ko}' are in the Arabic and Hangul scripts, whose words take letters attached before or after them, and words mode finds whole words only: for example, ${ar} does not find ${arLong} and ${ko} does not find ${koLong}. To find them inside longer words too: ltms search --substring '${ar} ${ko}' ${sh(f)}`]);
  assert.deepEqual(Object.keys(r.lines[0].gapScripts), ['Arabic', 'Hangul']);
  r = ltms(['search', ja, f]);
  assert.deepEqual(notices(r), [`ltms search: notice: '${ja}' is in the Han script, written without spaces between words: ${SEG === 'icu' ? "a word in the dictionary of this Node's Intl.Segmenter is found, an inflected or compound form of it may not be" : "this Node's Intl.Segmenter has no dictionary for them, so a run of such text is read as one word, and only a whole run is found"}. To find it inside any run of text: ltms search --substring '${ja}' ${sh(f)}`]);
  r = ltms(['search', '--substring', he, f]);
  assert.deepEqual(notices(r), [`ltms search: notice: --substring finds '${he}' inside longer words too, so it also finds words that only contain it (as cat finds concatenate).`]);
  r = ltms(['search', '--', '-> zqkfind', f]);
  assert.deepEqual(notices(r), ["ltms search: notice: the query's term '->' has no letter or digit, so it is left out."]);
  assert.deepEqual(r.lines[0].query, ['zqkfind']);
  r = ltms(['search', '"zqkfind', f]);
  assert.deepEqual(notices(r), ["ltms search: notice: a quote in the query '\"zqkfind' is not closed, so its phrase runs to the end of the query."]);
  r = ltms(['search', 'zqkfind', f]);
  assert.deepEqual([notices(r), 'gapScripts' in r.lines[0]], [[], false]);
  // what the clitic notices claim, on a file that holds the longer words only
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'longer.jsonl'), session([[`${heLong} ${arLong} ${koLong}`, X]], null));
    for (const w of [he, ar, ko]) {
      assert.equal(ltms(['search', w, dir]).lines[0].hits.turns, 0, `words mode finds ${w} inside a longer word`);
      assert.equal(ltms(['search', '--substring', w, dir]).lines[0].hits.turns, 1, `--substring does not find ${w}`);
    }
  } finally { rm(dir); }
});

test('command: with a Segmenter without dictionaries (taken away here), notices say spaceless runs stay whole; with no Intl at all, exit 2 with the reason, and --help still prints', () => {
  const dir = tmp();
  try {
    const noSeg = join(dir, 'no-segmenter.cjs'), noIntl = join(dir, 'no-intl.cjs');
    writeFileSync(noSeg, 'delete Intl.Segmenter;\n');
    writeFileSync(noIntl, 'delete globalThis.Intl;\n');
    let r = ltms(['search', 'zqkfind', fixture(SC)], { node: ['-r', noSeg] });
    assert.equal(r.lines[0].segmenter, 'no-dictionary');
    assert.deepEqual(r.err.split('\n').filter((l) => l.includes('notice')), ["ltms search: notice: this Node's Intl.Segmenter does not cut Chinese and Thai into words (it has no dictionary for them), so a run of Chinese, Japanese, Thai, Lao, Khmer or Myanmar text is read as one word: only a whole run is found, and --substring finds a word inside one."]);
    const th = cp(0xe20, 0xe32, 0xe29, 0xe32);
    r = ltms(['search', th, fixture(SC)], { node: ['-r', noSeg] });
    assert.deepEqual(r.err.split('\n').filter((l) => l.includes('notice')), [`ltms search: notice: '${th}' is in the Thai script, written without spaces between words: this Node's Intl.Segmenter has no dictionary for them, so a run of such text is read as one word, and only a whole run is found. To find it inside any run of text: ltms search --substring '${th}' ${sh(fixture(SC))}`]);
    r = ltms(['search', 'zqkfind', fixture(SC)], { node: ['-r', noIntl] });
    assert.deepEqual([r.code, r.out, r.err], [2, '', 'ltms search: this Node cannot run the search: it has no Intl. index, skeleton, stats, pin and skill do not need it. Node 20 or newer, built with Intl (as the builds from nodejs.org are), has it.\n']);
    assert.equal(ltms(['search', '--help'], { node: ['-r', noIntl] }).code, 0);
    assert.equal(ltms(['stats', fixture('demo.jsonl')], { node: ['-r', noIntl] }).code, 0);
  } finally { rm(dir); }
});

test("command: --kind names the kinds searched (a list, =, all; given twice, they add up), options go before or after the query, and the coverage lists the kinds searched and left out", () => {
  const f = fixture(K);
  const kindsOf = (args) => { const c = ltms(['search', ...args]).lines[0]; return [c.kinds, c.kindsOff, c.hits.turns]; };
  const off = (on) => S.SEARCH_KINDS.filter((k) => !on.includes(k));
  assert.deepEqual(kindsOf(['zqkmeta', f]), [DEFAULT_KINDS, ['meta', 'attachment'], 0]);
  assert.deepEqual(kindsOf(['--kind', 'meta', 'zqkmeta', f]), [['meta'], off(['meta']), 1]);
  assert.deepEqual(kindsOf(['zqkmeta', f, '--kind', 'meta']), [['meta'], off(['meta']), 1]);
  assert.deepEqual(kindsOf(['--kind=meta,input', 'zqkmeta', f]), [['input', 'meta'], off(['input', 'meta']), 1]);
  assert.deepEqual(kindsOf(['--kind', 'input', '--kind', 'meta', 'zqkmeta', f]), [['input', 'meta'], off(['input', 'meta']), 1]);
  assert.deepEqual(kindsOf(['--kind', ' meta , ', 'zqkmeta', f]), [['meta'], off(['meta']), 1]);
  assert.deepEqual(kindsOf(['--kind', 'all', 'zqkmeta', f]), [[...S.SEARCH_KINDS], [], 1]);
  assert.deepEqual(kindsOf(['--kind', 'reply,all', 'zqkmeta', f]), [[...S.SEARCH_KINDS], [], 1]);
  assert.deepEqual(kindsOf(['--kind', 'meta', '--', '-zqkmeta', f]), [['meta'], off(['meta']), 1]);
});

test('command: over every fixture, the coverage adds up: files counted apart, the invariant over records counted by JSON.parse, and each sum and hit line the library gives for each file', () => {
  const fixtures = join(here, 'fixtures');
  const r = ltms(['search', '--kind', 'all', '--max', '0', 'the', fixtures]);
  assert.equal(r.code, 0, r.err);
  const c = r.lines[0];
  const q = S.parseSearchQuery('the', { segmenter: SEG });
  const prefixOf = (path) => { const n = path.slice(path.lastIndexOf('/') + 1); return n.startsWith('agent-') ? `agent-${n.slice(6, 14)}` : n.slice(0, 8); };
  let objects = 0, notConversation = 0;
  const sum = { turns: 0, records: 0, hitFiles: 0, hitTurns: 0, hitRecords: 0, notSearched: {}, byKind: {} };
  const byPath = new Map();
  for (const file of allFixtures) {
    const text = readFileSync(file, 'utf8');
    for (const l of text.split('\n')) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o && typeof o === 'object' && !Array.isArray(o)) objects++; } catch { /* not a record */ } }
    const res = S.searchTranscript(text, q, { kinds: S.SEARCH_KINDS, prefix: prefixOf(file) });
    if (P.parseTranscript(text).fileKind !== 'transcript' || res.counts.turns === 0) notConversation++;
    sum.turns += res.counts.turns; sum.records += res.counts.searched;
    sum.hitTurns += res.counts.hits.turns; sum.hitRecords += res.counts.hits.records; if (res.turns.length) sum.hitFiles++;
    for (const [k, v] of Object.entries(res.counts.notSearched)) sum.notSearched[k] = (sum.notSearched[k] ?? 0) + v;
    for (const [k, v] of Object.entries(res.counts.hits.byKind)) sum.byKind[k] = (sum.byKind[k] ?? 0) + v;
    byPath.set(file, res.turns.map((h) => ({ ta: h.ta, ch: h.ch, at: h.entries })));
  }
  assert.deepEqual(c.files, { given: 1, found: allFixtures.length, read: allFixtures.length, failed: 0, notConversation, symlinks: 0 });
  assert.deepEqual([c.turns, c.records, c.notSearched, c.hits], [sum.turns, sum.records, sum.notSearched, { files: sum.hitFiles, turns: sum.hitTurns, records: sum.hitRecords, byKind: sum.byKind }]);
  const n = c.notSearched;
  assert.equal(c.records + n.offPath + n.replays + n.beforeFirstTurn + n.sidecars + n.kindsOff, objects);
  // each file's hit lines are the library's turns for it, in its order
  const got = new Map();
  let path = null;
  for (const l of r.lines.slice(1)) {
    if (l.k === 'file') { path = l.path; got.set(path, []); } else got.get(path).push({ ta: l.ta, ch: l.ch, at: l.at });
  }
  for (const [file, turns] of byPath) if (turns.length) assert.deepEqual(got.get(file), turns, file);
  assert.equal(got.size, sum.hitFiles);
  assert.ok(sum.hitFiles >= 20 && sum.hitTurns >= 30, `${sum.hitFiles} files and ${sum.hitTurns} turns compared: too few to mean anything`);
});

test('command: a reader that closes the pipe early: exit 0, and the closing line still on stderr', async () => {
  const dir = tmp();
  try {
    // 3,000 turns with the word: far more output than a pipe holds, so writing goes on after the reader has gone
    writeFileSync(join(dir, 'many.jsonl'), session(Array.from({ length: 3000 }, (_, i) => [`${W} ${i}`, X]), null));
    const child = spawn(process.execPath, [CLI, 'search', '--max', '0', W, dir]);
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.once('data', () => child.stdout.destroy());
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    assert.equal(err, 'ltms search: 3000 matching turns in 1 of 1 file (1 read, 0 failed); 3000 shown.\n');
  } finally { rm(dir); }
});

test("command: a query holding a quote is echoed quoted for the shell, and its next command runs; gapScripts adds up over the files", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'one.jsonl'), session([[`it's ${W}`, X]], '2026-03-01T00:00:00.000Z'));
    writeFileSync(join(dir, 'two.jsonl'), session([[X, `so it's here`]], '2026-03-02T00:00:00.000Z'));
    const r = ltms(['search', '--max', '1', "it's", dir]);
    assert.equal(r.lines[0].next, `ltms search --skip 1 --max 1 'it'\\''s' ${sh(dir)}`);
    const ran = runCommandLine(r.lines[0].next);
    assert.equal(ran.code, 0, ran.err);
    assert.deepEqual([ran.lines[0].query, ran.lines[0].hits.turns, ran.lines[0].shown], [["it's"], 2, { skipped: 1, turns: 1, order: 'newest' }]);
    // the Hebrew for peace (4 letters) in one file's prompt, the Hebrew for house (3) in the other's reply: 7
    writeFileSync(join(dir, 'one.jsonl'), session([[cp(0x5e9, 0x5dc, 0x5d5, 0x5dd), X]], null));
    writeFileSync(join(dir, 'two.jsonl'), session([[X, cp(0x5d1, 0x5d9, 0x5ea)]], null));
    const g = ltms(['search', cp(0x5d1, 0x5d9, 0x5ea), dir]).lines[0];
    assert.deepEqual([g.gapScripts, g.hits.turns], [{ Hebrew: 7 }, 1]);
  } finally { rm(dir); }
});

test('help and README: on a field longer than the window, the window command prints exactly 300 characters before the match and 300 from it', () => {
  const dir = tmp();
  try {
    const reply = `${'x'.repeat(1000)} ${W} ${'y'.repeat(1000)}`;
    writeFileSync(join(dir, 'long.jsonl'), session([[X, reply]], null));
    const e = ltms(['search', W, dir]).lines[2].at[0];
    assert.deepEqual([e.a, e.field, e.at], ['long.jso:L2', OUT, 1001]);
    for (const [where, text] of [['--help', ltms(['search', '--help']).out], ['README', README()]]) {
      const cmd = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith("node -e 'const [p,l,f,a]"));
      const program = cmd.slice("node -e '".length, cmd.indexOf("'", "node -e '".length));
      const r = spawnSync(process.execPath, ['-e', program, join(dir, 'long.jsonl'), '2', JSON.stringify(e.field), String(e.at)], { encoding: 'utf8' });
      assert.equal(r.stdout, reply.slice(701, 1301) + '\n', where);
    }
  } finally { rm(dir); }
});

test('command: an internal error inside search is reported by its kind and its place in search.js, never its message; the other files are searched (exit 1)', () => {
  const dir = tmp();
  try {
    // String.prototype.toLowerCase throws on one planted word: search folds a field that is not ASCII with it
    const boom = join(dir, 'boom.cjs');
    writeFileSync(boom, "const lower = String.prototype.toLowerCase;\nString.prototype.toLowerCase = function () { if (String(this).includes('zqcboom')) throw new TypeError('zqcsecret ' + String(this)); return lower.call(this); };\n");
    writeFileSync(join(dir, 'a-boom.jsonl'), session([[`zqcboom ${cp(0xe9)}`, X]], null));
    writeFileSync(join(dir, 'b-ok.jsonl'), session([[W, X]], null));
    const r = ltms(['search', W, dir], { node: ['-r', boom] });
    assert.equal(r.code, 1);
    const lines = r.err.split('\n').filter((l) => l);
    assert.match(lines[0], new RegExp(`^ltms search: '${join(dir, 'a-boom.jsonl').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}': stopped with an internal error \\(TypeError at search\\.js:\\d+\\), so nothing in it was searched\\. This is a bug in ltms; the other files are processed as usual\\.$`));
    assert.equal(lines[1], 'ltms search: 1 matching turn in 1 of 2 files (1 read, 1 failed, as reported above); 1 shown.');
    assert.deepEqual(r.lines.filter((l) => l.k === 'file').map((l) => l.path), [join(dir, 'b-ok.jsonl')]);
    assert.ok(!(r.out + r.err).includes('zqcsecret') && !(r.out + r.err).includes('zqcboom'));
  } finally { rm(dir); }
});

test('source: cli.ts holds ASCII only and no typed backslash-u escape, and imports nothing but node: built-ins, the parser, search, session (0.2.0) and pin', () => {
  const src = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(src), 'a character outside ASCII in src/cli.ts');
  assert.ok(!src.includes(BSL + 'u'), 'a typed backslash-u in src/cli.ts');
  for (const text of [src, readFileSync(CLI, 'utf8')]) {
    const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const s of specifiers) assert.ok(s.startsWith('node:') || s === './parser.js' || s === './search.js' || s === './session.js' || s === './pin.js', s);
    assert.ok(specifiers.includes('./search.js'));
  }
});

// ---- the repair round (S358): the verifier's surviving mutants, each one's test adopted ---------------------------
// Each test was the verifier's throwaway test for one mutant that the suite let live (its id in brackets): green on the
// code, red on that mutant (the repair's notes, notes-R-search, show both). Synthetic sessions, invented text.

/** A session of typed prompts, each answered by one assistant record: turns = [[prompt, reply content], ...], where a
 *  string reply is one text block. `after(k)` gives records to put after turn k's reply, each parented on the one before
 *  it; `requestIds: false` leaves the assistant records without a requestId (the parser then reads which records form
 *  one response from their parent links, and says so). Record j (1-based) is stamped ts plus j seconds. */
function sessionWith(turns, { after = () => [], requestIds = true, ts = '2026-05-01T00:00:00.000Z' } = {}) {
  const recs = [];
  let parent = null;
  const stamp = () => ({ timestamp: new Date(Date.parse(ts) + 1000 * (recs.length + 1)).toISOString() });
  turns.forEach(([prompt, reply], k) => {
    const u = uuidN(recs.length + 1);
    recs.push({ type: 'user', uuid: u, parentUuid: parent, promptSource: 'typed', ...stamp(), message: { role: 'user', content: prompt } });
    const a = uuidN(recs.length + 1);
    recs.push({ type: 'assistant', uuid: a, parentUuid: u, ...(requestIds ? { requestId: `req_${recs.length + 1}` } : {}), ...stamp(), message: { role: 'assistant', content: typeof reply === 'string' ? [{ type: 'text', text: reply }] : reply } });
    parent = a;
    for (const r of after(k)) { const id = uuidN(recs.length + 1); recs.push({ uuid: id, parentUuid: parent, ...stamp(), ...r }); parent = id; }
  });
  recs.push({ type: 'last-prompt', leafUuid: parent });
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
/** A folder holding one file, `name`, with `text`; fn(folder) runs, and the folder is removed. */
function withFile(name, text, fn) {
  const d = tmp();
  try { writeFileSync(join(d, name), text); return fn(d); } finally { rm(d); }
}

test("kinds: a system record's type value (system, an envelope key) is never searched [V02]", () => {
  withFile('s.jsonl', sessionWith([['hello there', 'ok']], { after: () => [{ type: 'system', subtype: 'turn_duration', durationMs: 5 }] }), (d) => {
    assert.equal(ltms(['search', 'system', d]).lines[0].hits.turns, 0);
  });
});

test('kinds: an attachment holding only empty strings has no text: it is counted as searched, not in kindsOff [V05]', () => {
  withFile('s.jsonl', sessionWith([['hello', 'ok']], { after: () => [{ type: 'attachment', attachment: { type: '', content: '' } }] }), (d) => {
    const c = ltms(['search', 'hello', d]).lines[0];
    assert.deepEqual([c.records, c.notSearched.kindsOff], [3, 0]);
  });
});

test('query: in --substring, a term that reads with a space (ab-cd) is a phrase [V06]', () => {
  const q = S.parseSearchQuery('zqvab-zqvcd', { mode: 'substring' });
  assert.deepEqual([q.terms[0].tokens, q.terms[0].phrase], [['zqvab zqvcd'], true]);
});

test('escapes: a word glued to a backslash-b or a backslash-f escape is found decoded [V15]', () => {
  withFile('s.jsonl', sessionWith([['q', `x${BSL}bzqvbword and y${BSL}fzqvfword`]]), (d) => {
    assert.equal(ltms(['search', 'zqvbword zqvfword', d]).lines[0].hits.turns, 1);
  });
});

test('kinds: a queued_command that is not a prompt (a task notification) is attachment text, off by default [V27]', () => {
  withFile('s.jsonl', sessionWith([['hello', 'ok']], { after: () => [{ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'zqvtask finished' } }] }), (d) => {
    assert.equal(ltms(['search', 'zqvtask', d]).lines[0].hits.turns, 0);
    assert.equal(ltms(['search', '--kind', 'attachment', 'zqvtask', d]).lines[0].hits.turns, 1);
  });
});

test('images: an image block inside a tool_result is counted in images [V32]', () => {
  const call = [{ type: 'tool_use', id: 'toolu_i1', name: 'Read', input: { file_path: '/x/y.png' } }];
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  withFile('s.jsonl', sessionWith([['zqvimg', call]], { after: () => [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_i1', content: [img, { type: 'text', text: 'an image' }] }] } }] }), (d) => {
    assert.equal(ltms(['search', 'zqvimg', d]).lines[0].notSearched.images, 1);
  });
});

test('command: next quotes a path holding a space, and runs [C01]', () => {
  const base = tmp(), d = join(base, 'has space');
  try {
    mkdirSync(d);
    writeFileSync(join(d, 's.jsonl'), sessionWith([['zqvword one', 'x'], ['zqvword two', 'x']]));
    const c = ltms(['search', '--max', '1', 'zqvword', d]).lines[0];
    assert.equal(c.next, `ltms search --skip 1 --max 1 'zqvword' '${d}'`);   // decision d: next passes over the turn shown
    assert.equal(runCommandLine(c.next).code, 0);
  } finally { rm(base); }
});

test('command: next puts -- before a path that starts with -, and runs [C02]', () => {
  const base = tmp();
  try {
    mkdirSync(join(base, '-dir'));
    writeFileSync(join(base, '-dir', 's.jsonl'), sessionWith([['zqvword one', 'x'], ['zqvword two', 'x']]));
    const c = ltms(['search', '--max', '1', '--', 'zqvword', '-dir'], { cwd: base }).lines[0];
    assert.equal(c.next, "ltms search --skip 1 --max 1 -- 'zqvword' '-dir'");   // decision d
    assert.equal(runCommandLine(c.next, { cwd: base }).code, 0);
  } finally { rm(base); }
});

test('command: the coverage ms is the time the search took (a search of 3,000 turns takes at least 1 ms) [C03]', () => {
  withFile('s.jsonl', sessionWith(Array.from({ length: 3000 }, (_, i) => [`zqvword ${i}`, 'x'])), (d) => {
    const c = ltms(['search', '--count', 'zqvword', d]).lines[0];
    assert.ok(c.ms >= 1, `ms ${c.ms}`);
  });
});

test('command: more than 10,000 hit lines are all printed (--max 0) [C04]', () => {
  withFile('s.jsonl', sessionWith(Array.from({ length: 10001 }, (_, i) => [`zqvword ${i}`, 'x'])), (d) => {
    const r = ltms(['search', '--max', '0', 'zqvword', d]);
    assert.equal(r.lines.filter((l) => l.k === 'hit').length, 10001);
  });
});

test('command: --count with no hit: no --count note, the ways to find more [C05]', () => {
  withFile('s.jsonl', sessionWith([['hello', 'ok']]), (d) => {
    const last = closing(ltms(['search', '--count', 'zqvnone', d]));
    assert.ok(last.startsWith('ltms search: 0 matching turns in 1 file (1 read, 0 failed); 0 shown. To find more'), last);   // search 16's wording
  });
});

test('command: a walked file whose responses were read from parent links counts as having warnings of its own [C06]', () => {
  withFile('s.jsonl', sessionWith([['zqvword', 'x']], { requestIds: false }), (d) => {
    assert.match(ltms(['search', 'zqvword', d]).err, /1 file read under the directories given has warnings of its own/);
  });
});

test('command: a directory given that cannot be listed: one message, not also "holds no .jsonl file" [C07]', (t) => {
  if (process.getuid?.() === 0) { t.skip('running as root, which can read any directory'); return; }
  const base = tmp(), d = join(base, 'locked');
  try {
    mkdirSync(d);
    chmodSync(d, 0o000);
    const r = ltms(['search', 'zqvword', d]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.err, /holds no \.jsonl file/);
  } finally { chmodSync(d, 0o700); rm(base); }
});

test('command: the walk summary says "2 are workflow journals" [C08]', () => {
  const d = tmp();
  try {
    for (const n of ['j1', 'j2']) writeFileSync(join(d, `${n}.jsonl`), '{"type":"launched"}\n{"type":"started"}\n{"type":"result"}\n');
    assert.match(ltms(['search', 'zqvword', d]).err, /2 are workflow journals/);
  } finally { rm(d); }
});

test("command: no path: the project folder writes a '.' of the directory's path as - [C15]", () => {
  const base = tmp(), cwd = join(base, 'my.app');
  try {
    mkdirSync(cwd);
    const env = { ...process.env, HOME: base };
    delete env.CLAUDE_CONFIG_DIR;
    const name = cwd.replace(/[^A-Za-z0-9]/g, '-');
    assert.ok(name.includes('-app') && !name.includes('.'));
    assert.match(ltms(['search', 'zqvword'], { cwd, env }).err, new RegExp(`projects/${name}, which does not exist`));
  } finally { rm(base); }
});

test('command: a missing path argument ending in .jsonl, with no /, is a path: reported missing (exit 1), not a misorder [C18]', () => {
  const d = tmp();
  try {
    const r = ltms(['search', 'zqvword', 'missing.jsonl'], { cwd: d });
    assert.equal(r.code, 1);
    assert.match(r.err, /cannot read 'missing\.jsonl': no such file or directory/);
  } finally { rm(d); }
});

test('command: under a directory, x.jsonl.bak is not read [C19]', () => {
  withFile('old.jsonl.bak', sessionWith([['zqvword', 'x']]), (d) => {
    const c = ltms(['search', 'zqvword', d]).lines[0];
    assert.deepEqual([c.files.found, c.hits.turns], [0, 0]);
  });
});

test('command: --substring with no word of a gap script prints its cost too [C31, rewritten by search 0]', () => {
  // the verifier's test pinned the silence; the repair (search 0) prints the cost for every --substring query
  withFile('s.jsonl', sessionWith([['zqvword', 'x']]), (d) => {
    assert.deepEqual(ltms(['search', '--substring', 'zqvword', d]).err.split('\n').filter((l) => l.includes('notice')), ["ltms search: notice: --substring finds 'zqvword' inside longer words too, so it also finds words that only contain it (as cat finds concatenate)."]);
  });
});

test('command: --count --max 0 prints the coverage line only [C43]', () => {
  withFile('s.jsonl', sessionWith([['zqvword', 'x']]), (d) => {
    assert.equal(ltms(['search', '--count', '--max', '0', 'zqvword', d]).lines.length, 1);
  });
});

// ---- the repair round: what a hit's field may name, and what a system record's text is ------------------------------

test("kinds: a system record's subtype and level are names from a fixed list, not text: never searched; its other strings are [search 17]", () => {
  const sys = { type: 'system', subtype: 'zqvsubtype', level: 'zqvlevel', content: 'zqvcontent of a hook' };
  withFile('s.jsonl', sessionWith([['hello', 'ok']], { after: () => [sys] }), (d) => {
    for (const w of ['zqvsubtype', 'zqvlevel']) {
      const r = ltms(['search', '--kind', 'all', w, d]);
      assert.deepEqual([r.lines[0].hits.turns, r.lines.length], [0, 1], w);
    }
    const r = ltms(['search', 'zqvcontent', d]);
    assert.deepEqual(r.lines[2].at, [{ a: 's.jsonl:L3', kind: 'system', field: ['content'], at: 0, w: [0] }]);
  });
});

test("entries: a field's key path names keys down to a tool's parameter, a system record's own keys and an attachment's own keys; a key below them prints (withheld) [search 3]", () => {
  const input = { command: 'zqvtop', rows: { patient_invented_name: 'zqvneedle record' }, list: [{ inner_key: 'zqvdeep' }] };
  // a tool's input is an object; one written as an array has no parameter names, so its items' keys are withheld
  const call = [{ type: 'tool_use', id: 'toolu_k1', name: 'mcp__db__query', input }, { type: 'tool_use', id: 'toolu_k2', name: 'mcp__db__query', input: [{ array_item_key: 'zqvarr' }] }];
  const after = () => [
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_k1', content: 'done' }, { type: 'tool_result', tool_use_id: 'toolu_k2', content: 'done' }] } },
    { type: 'system', subtype: 'informational', content: { nested_secret_key: 'zqvsysdeep' }, hookInfos: [{ command: 'zqvhook' }], note: 'zqvsystop' },
    { type: 'attachment', attachment: { type: 'hook_success', content: 'zqvattop', stdout: { deep_key: 'zqvattdeep' } } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'zqvqueued', extra: { deeper: 'zqvqdeep' } } },
  ];
  withFile('s.jsonl', sessionWith([['look', call]], { after }), (d) => {
    const fieldOf = (w) => {
      const r = ltms(['search', '--kind', 'all', w, d]);
      assert.equal(r.lines[0].hits.turns, 1, w);
      return r.lines[2].at.map((e) => [e.a, e.kind, e.field]);
    };
    const C = ['message', 'content', 0, 'input'];
    assert.deepEqual(fieldOf('zqvtop'), [['s.jsonl:L2', 'call', [...C, 'command']]]);
    assert.deepEqual(fieldOf('zqvneedle'), [['s.jsonl:L2', 'call', [...C, 'rows', '(withheld)']]]);
    assert.deepEqual(fieldOf('zqvdeep'), [['s.jsonl:L2', 'call', [...C, 'list', 0, '(withheld)']]]);
    assert.deepEqual(fieldOf('zqvarr'), [['s.jsonl:L2', 'call', ['message', 'content', 1, 'input', 0, '(withheld)']]]);
    assert.deepEqual(fieldOf('zqvsystop'), [['s.jsonl:L4', 'system', ['note']]]);
    assert.deepEqual(fieldOf('zqvsysdeep'), [['s.jsonl:L4', 'system', ['content', '(withheld)']]]);
    assert.deepEqual(fieldOf('zqvhook'), [['s.jsonl:L4', 'system', ['hookInfos', 0, '(withheld)']]]);
    assert.deepEqual(fieldOf('zqvattop'), [['s.jsonl:L5', 'attachment', ['attachment', 'content']]]);
    assert.deepEqual(fieldOf('zqvattdeep'), [['s.jsonl:L5', 'attachment', ['attachment', 'stdout', '(withheld)']]]);
    assert.deepEqual(fieldOf('zqvqueued'), [['s.jsonl:L6', 'input', ['attachment', 'prompt']]]);
    assert.deepEqual(fieldOf('zqvqdeep'), [['s.jsonl:L6', 'attachment', ['attachment', 'extra', '(withheld)']]]);
    // the library gives the same paths
    const r = S.searchTranscript(readFileSync(join(d, 's.jsonl'), 'utf8'), S.parseSearchQuery('zqvneedle'), { kinds: S.SEARCH_KINDS });
    assert.deepEqual(r.turns[0].entries[0].field, [...C, 'rows', '(withheld)']);
  });
});

test('docs/library.md: the Search paragraph names last among what the values hold from the transcript, which the library returns unchecked [search 15]', () => {
  const doc = readFileSync(join(root, 'docs', 'library.md'), 'utf8');
  const start = doc.indexOf('### Search'), paragraph = doc.slice(start, doc.indexOf('```', start)).replace(/\s+/g, ' ');
  assert.ok(start > 0, 'no Search section in docs/library.md');
  assert.match(paragraph, /`last`/, 'the Search paragraph does not name last');
  // what it names: a timestamp that is not one comes back as written
  const text = session([['zqvword', 'x']], null).replace('"promptSource":"typed",', '"promptSource":"typed","timestamp":"zqvfree text in a timestamp",');
  assert.equal(S.searchTranscript(text, S.parseSearchQuery('zqvword')).last, 'zqvfree text in a timestamp');
});

// ---- the repair round: the command's messages, the walk, --skip ---------------------------------------------------

test('command: --substring prints its cost for every query, each term echoed: it also finds words that only contain them [search 0]', () => {
  withFile('s.jsonl', sessionWith([['zqvword and concatenate', 'x']]), (d) => {
    const notices = (r) => r.err.split('\n').filter((l) => l.startsWith('ltms search: notice: '));
    assert.deepEqual(notices(ltms(['search', '--substring', 'zqvword', d])), ["ltms search: notice: --substring finds 'zqvword' inside longer words too, so it also finds words that only contain it (as cat finds concatenate)."]);
    const he = cp(0x5d1, 0x5d9, 0x5ea);
    assert.deepEqual(notices(ltms(['search', '--substring', `cat ${he}`, d])), [`ltms search: notice: --substring finds 'cat' and '${he}' inside longer words too, so it also finds words that only contain them (as cat finds concatenate).`]);
    assert.deepEqual(notices(ltms(['search', 'zqvword', d])), []);
    assert.equal(ltms(['search', '--substring', 'cat', d]).lines[0].hits.turns, 1);   // what the notice says: concatenate
  });
});

test('command: a query that also names an existing path is searched when a path argument exists, with a notice; refused when none does [search 1]', () => {
  const base = tmp();
  try {
    mkdirSync(join(base, 'notes'));
    writeFileSync(join(base, 'notes', 'plan.txt'), 'invented');
    mkdirSync(join(base, 't'));
    writeFileSync(join(base, 't', 's.jsonl'), sessionWith([['who edited notes/plan.txt today', 'x'], ['nothing', 'x']]));
    const r = ltms(['search', 'notes/plan.txt', 't'], { cwd: base });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.lines[0].query, ['notes/plan.txt']);
    assert.deepEqual(r.lines.filter((l) => l.k === 'hit').map((l) => l.ta), ['s.jsonl:T001']);
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      "ltms search: notice: the query 'notes/plan.txt' is also an existing path; it is searched for, in the paths after it. If it was meant as a path, the query comes first: ltms search '<query>' notes/plan.txt t",
      'ltms search: 1 matching turn in 1 of 1 file (1 read, 0 failed); 1 shown.',
    ]);
    // an absolute path too
    assert.equal(ltms(['search', join(base, 'notes', 'plan.txt'), join(base, 't')]).code, 0);
    // a query path that starts with -: the notice's command puts -- before it
    mkdirSync(join(base, '-notes'));
    writeFileSync(join(base, '-notes', 'plan.txt'), 'invented');
    const dash = ltms(['search', '--', '-notes/plan.txt', 't'], { cwd: base });
    assert.equal(dash.err.split('\n')[0], "ltms search: notice: the query '-notes/plan.txt' is also an existing path; it is searched for, in the paths after it. If it was meant as a path, the query comes first: ltms search -- '<query>' '-notes/plan.txt' t");
    // no path argument names an existing path: the query was left out, as before
    for (const args of [['notes/plan.txt'], ['notes/plan.txt', 'gone/dir']]) {
      const g = ltms(['search', ...args], { cwd: base });
      assert.equal(g.code, 2, args.join(' '));
      assert.match(g.err, /^ltms search: the query comes first, as one quoted argument, then the paths\. Read as the query: 'notes\/plan\.txt', which is an existing path;/, args.join(' '));
    }
  } finally { rm(base); }
});

test('command: the commands a message builds put -- before a query or a path that starts with -, and run [search 11]', () => {
  const base = tmp(), home = tmp();
  try {
    mkdirSync(join(base, '-dir'));
    writeFileSync(join(base, '-dir', 's.jsonl'), sessionWith([['zqvword -zqvdash', 'x']]));
    // the query has no word: the example names the path after --
    const noWord = ltms(['search', '--', '!!!', '-dir'], { cwd: base });
    assert.equal(noWord.err, "ltms search: the query '!!!' has no word to search: it has no letter or digit. Give words, e.g. ltms search -- 'compaction summary' '-dir'\n");
    const ran = runCommandLine(noWord.err.trimEnd().slice(noWord.err.indexOf('e.g. ') + 5), { cwd: base });
    assert.equal(ran.code, 0, ran.err);
    // the misorder: the query starts with -
    const mis = ltms(['search', '--', '-zqvq', 'zqvword', '-dir'], { cwd: base });
    assert.equal(mis.err, "ltms search: the query comes first, as one quoted argument, then the paths. Read as the query: '-zqvq'; as paths: 'zqvword' (no such file or directory), '-dir'. If the query is '-zqvq zqvword': ltms search -- '-zqvq zqvword' '-dir'\n");
    assert.equal(runCommandLine(mis.err.trimEnd().slice(mis.err.lastIndexOf(': ltms search ') + 2), { cwd: base }).code, 0);
    // the query alone starts with -: -- all the same
    mkdirSync(join(base, 't'));
    const misQ = ltms(['search', '--', '-zqvq', 'zqvword', 't'], { cwd: base });
    assert.equal(misQ.err, "ltms search: the query comes first, as one quoted argument, then the paths. Read as the query: '-zqvq'; as paths: 'zqvword' (no such file or directory), 't'. If the query is '-zqvq zqvword': ltms search -- '-zqvq zqvword' t\n");
    // no path, a query that starts with -: the project folder's command
    const name = base.replace(/[^A-Za-z0-9]/g, '-'), env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    mkdirSync(join(home, '.claude', 'projects', name), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', name, 's.jsonl'), sessionWith([['a -zqvdash here', 'x']]));
    const noPath = ltms(['search', '--', '-zqvdash'], { cwd: base, env });
    const command = `ltms search -- '-zqvdash' ~/.claude/projects/${name}`;
    assert.equal(noPath.err, `ltms search: no path given. Give the transcripts' folder or files after the query; this directory's project folder is ~/.claude/projects/${name}: ${command}\n`);
    const r = runCommandLine(command, { cwd: base, env });
    assert.deepEqual([r.code, r.lines[0].hits.turns], [0, 1], r.err);
  } finally { rm(base, home); }
});

test('command: run from a directory that no longer exists: no path is a usage error that says so (exit 2), with no stack trace [search 12]', () => {
  const base = tmp(), gone = join(base, 'gone'), home = tmp();
  try {
    mkdirSync(gone);
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    const run = (args) => spawnSync('bash', ['-c', `cd ${sh(gone)} && rmdir ${sh(gone)} && exec ${sh(process.execPath)} ${sh(CLI)} ${args}`], { encoding: 'utf8', env });
    let r = run('search zqvword');
    assert.deepEqual([r.status, r.stdout], [2, '']);
    assert.equal(r.stderr, "ltms search: no path given. Give the transcripts' folder or files after the query. The current directory no longer exists, so its project folder cannot be named; ls ~/.claude/projects lists the project folders: ltms search 'zqvword' ~/.claude/projects/<folder>\n");
    mkdirSync(gone);
    r = run('search');
    assert.deepEqual([r.status, r.stderr], [2, "ltms search: no query given. The query comes first, as one quoted argument, then the transcripts' folder or files: ltms search 'compaction summary' ~/.claude/projects/<project>\n"]);
  } finally { rm(base, home); }
});

test('command: an internal error outside any one file is reported by its kind and its place in cli.js, never its message (exit 1) [search 12]', () => {
  const dir = tmp();
  try {
    const boom = join(dir, 'boom.cjs');
    writeFileSync(boom, "const v8 = require('node:v8');\nv8.getHeapStatistics = () => { throw new RangeError('zqcsecret ' + process.argv.join(' ')); };\nrequire('node:module').syncBuiltinESMExports();\n");
    writeFileSync(join(dir, 's.jsonl'), sessionWith([['zqvword', 'x']]));
    const r = ltms(['search', 'zqvword', dir], { node: ['-r', boom] });
    assert.deepEqual([r.code, r.out], [1, '']);
    assert.match(r.err, /^ltms search: stopped with an internal error \(RangeError at cli\.js:\d+\)\. This is a bug in ltms; anything printed before it is incomplete\.\n$/);
    assert.ok(!r.err.includes('zqcsecret'));
  } finally { rm(dir); }
});

test("command: under a walk, the warning line names up to four files with warnings of their own, each with its kinds, and the command that shows them [search 2]", () => {
  const dir = tmp();
  try {
    const cycle = (text) => text + [{ type: 'user', uuid: uuidN(901), parentUuid: uuidN(902), message: { role: 'user', content: 'loop a' } }, { type: 'assistant', uuid: uuidN(902), parentUuid: uuidN(901), requestId: 'req_loop', message: { role: 'assistant', content: [{ type: 'text', text: 'loop b' }] } }].map((o) => JSON.stringify(o) + '\n').join('');
    writeFileSync(join(dir, 'a-clean.jsonl'), sessionWith([['zqvword', 'x']]));
    writeFileSync(join(dir, 'b-bad.jsonl'), sessionWith([['zqvword', 'x']]) + '{not json\n');
    writeFileSync(join(dir, 'c-cycle.jsonl'), cycle(sessionWith([['zqvword', 'x']])));
    writeFileSync(join(dir, 'd-guessed.jsonl'), sessionWith([['zqvword', 'x']], { requestIds: false }) + '{not json\n');
    const r = ltms(['search', 'zqvword', dir]);
    assert.equal(r.code, 0, r.err);
    const p = (n) => join(dir, n);
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      `ltms search: warning: 3 files read under the directories given have warnings of their own: '${p('b-bad.jsonl')}' (lines that could not be read), '${p('c-cycle.jsonl')}' (records on a parentUuid cycle) and '${p('d-guessed.jsonl')}' (lines that could not be read and responses read from parent links): name one on the command line to see its warnings: ltms search 'zqvword' ${sh(p('b-bad.jsonl'))}`,
      'ltms search: 4 matching turns in 4 of 4 files (4 read, 0 failed); 4 shown.',
    ]);
    const shown = runCommandLine(r.err.split('\n')[0].slice(r.err.indexOf(': ltms search ') + 2));
    assert.match(shown.err, /b-bad\.jsonl': 1 line could not be read/);
    // more than four: four named, and how many more
    for (const n of ['e', 'f']) writeFileSync(join(dir, `${n}-bad.jsonl`), sessionWith([['zqvword', 'x']]) + '{not json\n');
    const five = ltms(['search', 'zqvword', dir]).err.split('\n')[0];
    assert.ok(five.startsWith('ltms search: warning: 5 files read under the directories given have warnings of their own: '), five);
    assert.ok(five.includes(`'${p('e-bad.jsonl')}' (lines that could not be read) and 1 more: name one`), five);
    assert.ok(!five.includes('f-bad'), five);
  } finally { rm(dir); }
});

test('command: a file under a walked directory whose name is not UTF-8 is reported as such, with its bytes, and counted failed [search 13]', () => {
  const dir = tmp();
  try {
    // caf, then e9 (Latin-1's e acute, not UTF-8); a, a backslash, b, then ff (never UTF-8); m, 01 and 7f (a control
    // byte and DEL), then e9: each byte that is not printable ASCII, and the backslash, written as \xHH, in the order
    // Node lists names (by their bytes: libuv sorts them). A name that is not UTF-8 and not .jsonl is passed over.
    const named = (bytes, ext = '.jsonl') => Buffer.concat([Buffer.from(dir + '/'), Buffer.from(bytes), Buffer.from(ext)]);
    writeFileSync(named([0x63, 0x61, 0x66, 0xe9]), sessionWith([['zqvword', 'x']]));
    writeFileSync(named([0x61, 0x5c, 0x62, 0xff]), sessionWith([['zqvword', 'x']]));
    writeFileSync(named([0x6d, 0x01, 0x7f, 0xe9]), sessionWith([['zqvword', 'x']]));
    writeFileSync(named([0x78, 0xe9], '.txt'), 'not a transcript');
    writeFileSync(join(dir, 'ok.jsonl'), sessionWith([['zqvword', 'x']]));
    const r = ltms(['search', 'zqvword', dir]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines[0].files, { given: 1, found: 4, read: 1, failed: 3, notConversation: 0, symlinks: 0 });
    const message = (name) => `ltms search: cannot read '${dir}/${name}' (the bytes of its name that are not printable ASCII written as \\xHH): its name is not valid UTF-8, and ltms reads paths as text, so it is not searched. Give it a UTF-8 name to search it; ls -b '${dir}' shows the name.`;
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      message('a\\x5cb\\xff.jsonl'),
      message('caf\\xe9.jsonl'),
      message('m\\x01\\x7f\\xe9.jsonl'),
      'ltms search: 1 matching turn in 1 of 4 files (1 read, 3 failed, as reported above); 1 shown.',
    ]);
    // a symbolic link whose name is not UTF-8 is counted as a link, as any other
    symlinkSync(join(dir, 'ok.jsonl'), Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0x6c, 0xe9]), Buffer.from('.jsonl')]));
    assert.equal(ltms(['search', 'zqvword', dir]).lines[0].files.symlinks, 1);
    // a directory whose name is not UTF-8: the files under it are not searched
    mkdirSync(Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0x64, 0xe9])]));
    const d = ltms(['search', 'zqvword', dir]);
    assert.ok(d.err.includes(`ltms search: cannot read the directory '${dir}/d\\xe9' (the bytes of its name that are not printable ASCII written as \\xHH): its name is not valid UTF-8, and ltms reads paths as text, so the files under it are not searched.`), d.err);
    assert.deepEqual(d.lines[0].files, { given: 1, found: 5, read: 1, failed: 4, notConversation: 0, symlinks: 1 });
  } finally { rm(dir); }
});

test('command: an entry named .jsonl that is not a regular file (a pipe) is not read, and one warning says so [search 14]', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'only'));
    mkdirSync(join(dir, 'two'));
    for (const p of [join(dir, 'only', 'pipe.jsonl'), join(dir, 'two', 'a.jsonl'), join(dir, 'two', 'b.jsonl')]) assert.equal(spawnSync('mkfifo', [p]).status, 0);
    const hint = 'Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.';
    let r = ltms(['search', 'zqvword', join(dir, 'only'), join(dir, 'two')]);
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      `ltms search: warning: '${join(dir, 'only')}' holds no .jsonl file at any depth (1 entry named .jsonl there is not a regular file, such as a pipe or a socket, and was not read), so nothing in it is searched. ${hint}`,
      `ltms search: warning: '${join(dir, 'two')}' holds no .jsonl file at any depth (2 entries named .jsonl there are not regular files, such as pipes or sockets, and were not read), so nothing in it is searched. ${hint}`,
      'ltms search: 0 matching turns in 0 files (0 read, 0 failed); 0 shown.',
    ]);
    // beside a transcript, the walk's one summary line says it (the singular is the walk test's, above)
    writeFileSync(join(dir, 'two', 's.jsonl'), sessionWith([['zqvword', 'x']]));
    r = ltms(['search', 'zqvword', join(dir, 'two')]);
    assert.equal(r.err.split('\n')[0], 'ltms search: warning: 2 entries named .jsonl under the directories given are not regular files, such as pipes or sockets, and were not read.');
  } finally { rm(dir); }
});

test('command: the walk enters a directory once, by its device and inode: one that stat reports as already entered is passed over, and counted (a stubbed stat) [decision d]', () => {
  const dir = tmp();
  try {
    const A = join(dir, 'A'), loop = join(A, 'loop');
    mkdirSync(loop, { recursive: true });
    writeFileSync(join(A, 's.jsonl'), sessionWith([['zqvword', 'x']]));
    writeFileSync(join(loop, 'x.jsonl'), sessionWith([['zqvword', 'x']]));
    const stub = join(dir, 'same-inode.cjs');
    writeFileSync(stub, [
      "const fs = require('node:fs'), real = fs.statSync;",
      '// the directory LTMS_TEST_ALIAS reports the device and inode of LTMS_TEST_TARGET, as a bind mount of it would',
      '// (with LTMS_TEST_OTHER_DEVICE set, the same inode on another device: another directory)',
      '// (LTMS_TEST_ALIAS may name several directories, separated by commas)',
      'fs.statSync = function (p, o) { const s = real.apply(this, arguments); if ((process.env.LTMS_TEST_ALIAS ?? "").split(",").includes(String(p))) { const t = real.call(this, process.env.LTMS_TEST_TARGET, o); s.dev = process.env.LTMS_TEST_OTHER_DEVICE ? t.dev + 1n : t.dev; s.ino = t.ino; } return s; };',
      "require('node:module').syncBuiltinESMExports();", ''].join('\n'));
    const plain = ltms(['search', 'zqvword', A]);
    assert.deepEqual([plain.lines[0].files.found, plain.err.split('\n').filter((l) => l).length], [2, 1]);
    const r = ltms(['search', 'zqvword', A], { node: ['-r', stub], env: { ...process.env, LTMS_TEST_ALIAS: loop, LTMS_TEST_TARGET: A } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.lines.filter((l) => l.k === 'file').map((l) => l.path), [join(A, 's.jsonl')]);
    assert.deepEqual(r.err.split('\n').filter((l) => l), [
      'ltms search: warning: 1 directory met under the directories given has the same device and inode as one already read (a bind mount can do that), so it was not read again.',
      'ltms search: 1 matching turn in 1 of 1 file (1 read, 0 failed); 1 shown.',
    ]);
    // two directories met again: the plural
    mkdirSync(join(A, 'loop2'));
    writeFileSync(join(A, 'loop2', 'y.jsonl'), sessionWith([['zqvword', 'x']]));
    const two = ltms(['search', 'zqvword', A], { node: ['-r', stub], env: { ...process.env, LTMS_TEST_ALIAS: `${loop},${join(A, 'loop2')}`, LTMS_TEST_TARGET: A } });
    assert.deepEqual(two.err.split('\n').filter((l) => l)[0], 'ltms search: warning: 2 directories met under the directories given have the same device and inode as one already read (a bind mount can do that), so they were not read again.');
    assert.equal(two.lines[0].files.found, 1);
    // the same inode on another device is another directory: read
    const other = ltms(['search', 'zqvword', A], { node: ['-r', stub], env: { ...process.env, LTMS_TEST_ALIAS: loop, LTMS_TEST_TARGET: A, LTMS_TEST_OTHER_DEVICE: '1' } });
    assert.deepEqual([other.lines[0].files.found, other.err.split('\n').filter((l) => l).length], [3, 1]);
  } finally { rm(dir); }
});

test('command: the walk enters a directory once: a real bind mount of a directory inside itself, in a user namespace (Linux; skipped where unshare cannot make one) [decision d]', (t) => {
  const dir = tmp();
  try {
    const A = join(dir, 'A');
    mkdirSync(join(A, 'sub'), { recursive: true });
    writeFileSync(join(A, 's.jsonl'), sessionWith([['zqvword', 'x']]));
    const probe = spawnSync('unshare', ['-rm', 'sh', '-c', `mount --bind ${sh(A)} ${sh(join(A, 'sub'))} && test -e ${sh(join(A, 'sub', 's.jsonl'))}`], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { t.skip(`unshare -rm cannot bind-mount here: ${probe.error?.code ?? probe.stderr.trim()}`); return; }
    const r = spawnSync('unshare', ['-rm', 'sh', '-c', `mount --bind ${sh(A)} ${sh(join(A, 'sub'))} && exec ${sh(process.execPath)} ${sh(CLI)} search zqvword ${sh(A)}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n').filter((l) => l).map((l) => JSON.parse(l));
    assert.deepEqual(lines.filter((l) => l.k === 'file').map((l) => l.path), [join(A, 's.jsonl')]);
    assert.equal(lines[0].hits.turns, 1);
    assert.match(r.stderr, /^ltms search: warning: 1 directory met under the directories given has the same device and inode as one already read \(a bind mount can do that\), so it was not read again\.\n/);
  } finally { rm(dir); }
});

test('command: --skip passes over the first matching turns; shown.skipped counts them, left counts the turns after the ones shown, and next prints the next ones without the first [decision d]', () => {
  const dir = orderFolder();
  try {
    const exp = orderExpected(dir), all = linesFor(exp, ['a', 'c', 'b', 'd']);
    const hitsOf = (lines) => lines.filter((l) => l.k === 'hit').map((l) => l.ta);
    const order = ['a.jsonl:T001', 'c.jsonl:T002', 'b.jsonl:T001', 'b.jsonl:T003', 'd.jsonl:T001'];
    const cases = [
      // args, the turns shown, skipped, left, next's --skip and --max (null: no next), the closing line's end
      [['--max', '2'], order.slice(0, 2), 0, 3, [2, 2], '; 2 shown, 3 left: --skip 2 shows the next 2.'],
      [['--skip', '2', '--max', '2'], order.slice(2, 4), 2, 1, [4, 2], '; 2 shown after the first 2, 1 left: --skip 4 shows the next 1.'],
      [['--skip=4'], order.slice(4), 4, 0, null, '; 1 shown after the first 4.'],
      [['--skip', '9'], [], 5, 0, null, '; 0 shown: --skip 9 passes over all 5.'],
      [['--skip', '2', '--max', '0'], order.slice(2), 2, 0, null, '; 3 shown after the first 2.'],
      [['--count'], [], 0, 5, [0, 20], '; 0 shown (--count prints the coverage line only).'],
      [['--count', '--skip', '2', '--max', '1'], [], 2, 3, [2, 1], '; 0 shown (--count prints the coverage line only).'],
      [[], order, 0, 0, null, '; 5 shown.'],
    ];
    for (const [args, shown, skipped, left, next, end] of cases) {
      const r = ltms(['search', ...args, W, dir]);
      const c = r.lines[0], name = args.join(' ');
      assert.equal(r.code, 0, `${name}: ${r.err}`);
      assert.deepEqual(hitsOf(r.lines), shown, name);
      assert.deepEqual([c.shown, c.left], [{ skipped, turns: shown.length, order: 'newest' }, left], name);
      assert.equal(c.shown.skipped + c.shown.turns + c.left, c.hits.turns, name);
      assert.equal(c.next, next && `ltms search --skip ${next[0]} --max ${next[1]} '${W}' ${sh(dir)}`, name);
      assert.equal(closing(r), `ltms search: 5 matching turns in 4 of 5 files (5 read, 0 failed)${end}`, name);
      if (next) assert.deepEqual(hitsOf(runCommandLine(c.next).lines), order.slice(next[0], next[1] ? next[0] + next[1] : undefined), `${name}: next`);
    }
    // the file lines: a file whose turns are all passed over gets no line, and f counts from 1 in each output
    assert.deepEqual(ltms(['search', '--skip', '2', W, dir]).lines.slice(1), all.slice(4).map((l) => ({ ...l, f: l.f - 2 })));
    // usage errors, each echoing the input
    for (const [args, message] of [
      [['--skip'], 'ltms search: --skip needs a number after it: the matching turns to pass over before printing.'],
      [['--skip', '-1', W, dir], "ltms search: --skip takes a whole number of matching turns to pass over before printing; '-1' is not one."],
      [['--skip=x', W, dir], "ltms search: --skip takes a whole number of matching turns to pass over before printing; 'x' is not one."],
      [['--frobnicate', W, dir], "ltms search: unknown option '--frobnicate'. The options are --kind <list>, --substring, --max <n>, --skip <n>, --count and --oldest; put -- before a query or a path that starts with '-'."],
    ]) assert.deepEqual([ltms(['search', ...args]).code, ltms(['search', ...args]).err], [2, message + '\n'], args.join(' '));
  } finally { rm(dir); }
});

test('command: no Intl: the message says that index, skeleton, stats, pin and skill do not need it (0.2.0), and pin runs [merge 9]', () => {
  const dir = tmp();
  try {
    const noIntl = join(dir, 'no-intl.cjs');
    writeFileSync(noIntl, 'delete globalThis.Intl;\n');
    const r = ltms(['search', 'zqkfind', fixture(SC)], { node: ['-r', noIntl] });
    assert.deepEqual([r.code, r.out, r.err], [2, '', 'ltms search: this Node cannot run the search: it has no Intl. index, skeleton, stats, pin and skill do not need it. Node 20 or newer, built with Intl (as the builds from nodejs.org are), has it.\n']);
    // pin, with no Intl: a pin of one project, then its check
    const root = join(dir, 'projects'), to = join(dir, 'pins');
    mkdirSync(join(root, 'p'), { recursive: true });
    writeFileSync(join(root, 'p', 's.jsonl'), sessionWith([['zqvword', 'x']]));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'config') };
    const pinned = ltms(['pin', join(root, 'p'), '--root', root, '--to', to], { node: ['-r', noIntl], env });
    assert.equal(pinned.code, 0, pinned.err);
    assert.equal(ltms(['pin', '--check', to, '--root', root], { node: ['-r', noIntl], env }).code, 0);
  } finally { rm(dir); }
});

test('help and README: found counts each path that does not exist, which failed counts too, so that read = found - failed [search 18]', () => {
  assert.match(ltms(['search', '--help']).out.replace(/\s+/g, ' '), /found: the files named, and the \.jsonl files under the directories named, each file once; each path that does not exist; and each directory that could not be read\./);
  assert.match(README().split('\n').find((l) => l.startsWith('| `found` |')), /each path that does not exist/);
  // what they say: a missing path, with a / or ending in .jsonl, is found and failed
  const dir = orderFolder();
  try {
    const r = ltms(['search', W, join(dir, 'gone'), join(dir, 'gone.jsonl'), dir]);
    assert.deepEqual([r.code, r.lines[0].files], [1, { given: 3, found: 7, read: 5, failed: 2, notConversation: 0, symlinks: 0 }]);
  } finally { rm(dir); }
});

test('help and README: at a key of field printed (withheld), the window command prints the keys there, and with the key put in, the window; search\'s help has no broken line [search 19]', () => {
  const call = [{ type: 'tool_use', id: 'toolu_w1', name: 'mcp__db__query', input: { rows: { patient_invented_name: 'zqvneedle record' } } }];
  withFile('s.jsonl', sessionWith([['look', call]]), (d) => {
    const e = ltms(['search', 'zqvneedle', d]).lines[2].at[0];
    assert.deepEqual([e.a, e.field, e.at], ['s.jsonl:L2', ['message', 'content', 0, 'input', 'rows', '(withheld)'], 0]);
    for (const [where, text] of [['--help', ltms(['search', '--help']).out], ['README', README()]]) {
      const cmd = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith("node -e 'const [p,l,f,a]"));
      const program = cmd.slice("node -e '".length, cmd.indexOf("'", "node -e '".length));
      const run = (field) => spawnSync(process.execPath, ['-e', program, join(d, 's.jsonl'), '2', JSON.stringify(field), String(e.at)], { encoding: 'utf8' });
      assert.equal(run(e.field).stdout, 'keys here: ["patient_invented_name"]\n', where);
      assert.equal(run([...e.field.slice(0, -1), 'patient_invented_name']).stdout, 'zqvneedle record\n', where);
    }
  });
  // a line of prose that ends short inside its paragraph is a broken wrap (it was "A record can be hundreds of KB: print")
  const lines = ltms(['search', '--help']).out.split('\n');
  assert.deepEqual(lines.filter((l, i) => l && lines[i + 1] && !/^[\s-]/.test(l) && !/^[\s-]/.test(lines[i + 1]) && l.length < 60), []);
});

// ---- the last repair round (S358): the final verifier's findings ------------------------------------------------------

test("command: no path, with $CLAUDE_CONFIG_DIR holding a space: the project folder in the message is quoted, and the command it gives runs as given (final[2], adopted from config-dir-quoted.test.mjs)", () => {
  const top = tmp();
  try {
    const cwd = join(top, 'proj'), config = join(top, 'my config');
    mkdirSync(cwd);
    const name = cwd.replace(/[^A-Za-z0-9]/g, '-');   // Claude Code's rule
    mkdirSync(join(config, 'projects', name), { recursive: true });
    writeFileSync(join(config, 'projects', name, 's.jsonl'), session([[`${W} here`, X]], '2026-03-05T00:00:00.000Z'));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
    const r = ltms(['search', W], { cwd, env });
    const folder = `'${join(config, 'projects')}'/${name}`;   // the path holds a space: single-quoted, the name after it bare
    assert.equal(r.code, 2);
    assert.equal(r.err, `ltms search: no path given. Give the transcripts' folder or files after the query; this directory's project folder is ${folder}: ltms search '${W}' ${folder}\n`);
    const ran = runCommandLine(`ltms search '${W}' ${folder}`, { cwd, env });
    assert.equal(ran.code, 0, ran.err);
    assert.equal(ran.lines[0].hits.turns, 1);
  } finally { rm(top); }
});

test('help and README: at a (withheld) step, the window command lists only the keys whose value leads, along the rest of field, to a string longer than at; a key that leads elsewhere prints "not a string here" or "at is past the end of this field", never an empty line or a stack trace (final[8])', () => {
  // rows' keys lie below a tool's parameter, so field names none of them; the match is at 6 in rows.patient_invented_name
  // (e_exact is exactly 6 long: a match at 6 would start past its end)
  // f_null and p5 are null siblings (S358 last fix [8]): a step below them meets null, and must print, never throw
  const input = { rows: { a_short: 'abc', b_object: { x: 'zq' }, patient_invented_name: 'found zqvneedle here', c_long_other: 'a string longer than six', e_exact: 'sixsix', d_number: 12345678, f_null: null } };
  // two (withheld) steps: under p2, at 4 in its name; p1's strings are shorter than 4, and p3 is a string, not an object;
  // under p4, at 0 (zqxneedle), where every key holding a non-empty string below it leads there, and p3 still does not
  const nested = { rows: { p1: { name: 'zz', note: 'x' }, p2: { name: 'the zqwneedle record' }, p3: 'a string, not an object, long enough', p4: { name: 'zqxneedle starts this one' }, p5: null } };
  const calls = [[{ type: 'tool_use', id: 'toolu_w2', name: 'mcp__db__query', input }], [{ type: 'tool_use', id: 'toolu_w3', name: 'mcp__db__query', input: nested }]];
  withFile('s.jsonl', sessionWith([['look', calls[0]], ['look again', calls[1]]]), (d) => {
    const e = ltms(['search', 'zqvneedle', d]).lines[2].at[0];
    assert.deepEqual([e.a, e.field, e.at], ['s.jsonl:L2', ['message', 'content', 0, 'input', 'rows', '(withheld)'], 6]);
    const n = ltms(['search', 'zqwneedle', d]).lines[2].at[0];
    assert.deepEqual([n.a, n.field, n.at], ['s.jsonl:L4', ['message', 'content', 0, 'input', 'rows', '(withheld)', '(withheld)'], 4]);
    const x = ltms(['search', 'zqxneedle', d]).lines[2].at[0];
    assert.deepEqual([x.a, x.field, x.at], ['s.jsonl:L4', ['message', 'content', 0, 'input', 'rows', '(withheld)', '(withheld)'], 0]);
    for (const [where, text] of [['--help', ltms(['search', '--help']).out], ['README', README()]]) {
      const cmd = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith("node -e 'const [p,l,f,a]"));
      const program = cmd.slice("node -e '".length, cmd.indexOf("'", "node -e '".length));
      const run = (line, field, at) => {
        const r = spawnSync(process.execPath, ['-e', program, join(d, 's.jsonl'), String(line), JSON.stringify(field), String(at)], { encoding: 'utf8' });
        return [r.stdout, r.stderr, r.status];
      };
      const base = e.field.slice(0, -1);
      assert.deepEqual(run(2, e.field, e.at), ['keys here: ["patient_invented_name","c_long_other"]\n', '', 0], where);
      assert.deepEqual(run(2, [...base, 'patient_invented_name'], e.at), ['found zqvneedle here\n', '', 0], where);
      for (const [key, said] of [['a_short', 'at is past the end of this field'], ['e_exact', 'at is past the end of this field'], ['b_object', 'not a string here'], ['d_number', 'not a string here'], ['no_such_key', 'not a string here'], ['f_null', 'not a string here']]) {
        assert.deepEqual(run(2, [...base, key], e.at), [`${said}\n`, '', 0], `${where}: ${key}`);
      }
      assert.deepEqual(run(2, [...base, 'no_such_key', 'deeper', 0], e.at), ['not a string here\n', '', 0], `${where}: below a missing key`);
      assert.deepEqual(run(2, [...base, 'f_null', 'deeper', 0], e.at), ['not a string here\n', '', 0], `${where}: below a null`);
      // the nested hit, one step at a time
      const nb = n.field.slice(0, -2);
      assert.deepEqual(run(4, n.field, n.at), ['keys here: ["p2","p4"]\n', '', 0], where);
      assert.deepEqual(run(4, x.field, x.at), ['keys here: ["p1","p2","p4"]\n', '', 0], where);
      assert.deepEqual(run(4, [...nb, 'p2', '(withheld)'], n.at), ['keys here: ["name"]\n', '', 0], where);
      assert.deepEqual(run(4, [...nb, 'p2', 'name'], n.at), ['the zqwneedle record\n', '', 0], where);
      // a (withheld) step, then a key: p5 is null, so its step to name meets null
      assert.deepEqual(run(4, [...nb, '(withheld)', 'name'], n.at), ['keys here: ["p2","p4"]\n', '', 0], `${where}: a null sibling, then a key`);
    }
  });
});

// ---- the last narrow fix (S358, notes-F3): the checker's survivors V23, V25, V26 and V27, adopted --------------------
// Each is green on the build of final2.patch and red on its mutant (verify-f2/throwaway/f2-survivors.test.mjs).

/** The window command as `text` (the help, or the README) prints it, run by bash as pasted, on a file of one record. */
function windowRun(text, record, field, at) {
  const cmd = text.match(/node -e '[^']*'/)[0];
  const d = tmp();
  try {
    const p = join(d, 'x.jsonl');
    writeFileSync(p, JSON.stringify(record) + '\n');
    const r = spawnSync('bash', ['-c', `${cmd} '${p}' 1 '${JSON.stringify(field)}' ${at}`], { encoding: 'utf8' });
    return [r.status, r.stdout, r.stderr];
  } finally { rm(d); }
}
const WINDOW_TEXTS = () => [['--help', ltms(['search', '--help']).out], ['README', README()]];

test('help and README: the window command at two (withheld) steps, the first one\'s other key null: the keys that lead to the string, never a TypeError (S358 last fix [8], adopted from the checker\'s V23)', { skip: process.platform === 'win32' && 'needs bash' }, () => {
  for (const [where, text] of WINDOW_TEXTS()) {
    assert.deepEqual(windowRun(text, { a: { n: null, y: { q: 'x'.repeat(40) } } }, ['a', '(withheld)', '(withheld)'], 10), [0, 'keys here: ["y"]\n', ''], where);
  }
});

test('help and README: the window command at a (withheld) step whose other key is null, field going on with an index (search names indices below (withheld)): no TypeError (S358 last fix [8], adopted from the checker\'s V25)', { skip: process.platform === 'win32' && 'needs bash' }, () => {
  for (const [where, text] of WINDOW_TEXTS()) {
    assert.deepEqual(windowRun(text, { a: { n: null, y: ['x'.repeat(40)] } }, ['a', '(withheld)', 0], 10), [0, 'keys here: ["y"]\n', ''], where);
  }
});

test('help and README: each says in its prose, the command aside, what the window command prints where field leads to no string, or to one no longer than at (S358 last fix [8], adopted from the checker\'s V26 and V27)', () => {
  // the command holds both messages itself: they are looked for in the text with every node -e '...' taken out
  const prose = (s) => s.replace(/node -e '[^']*'/g, '').replace(/\s+/g, ' ');
  for (const [where, text] of WINDOW_TEXTS()) {
    const p = prose(text);
    assert.ok(p.includes('not a string here') && p.includes('at is past the end of this field'), `${where} does not say both messages in its prose`);
  }
});
