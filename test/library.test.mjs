// The library's values. Every member the parser computes (the 113 members of category `computed` in the inventory of
// phase 2's scouts: the fields of the objects parseTranscript, parseLines, livePath, repairedLivePath and turnsOf
// return) has its VALUE asserted here, on a known-answer fixture: test/fixtures/library-*.jsonl, written by
// test/make-fixtures.mjs, a few fixtures the command's tests use, and a few crafted lines built in the test.
// Every expected value is worked out by hand from the fixture as its generator builds it, with the arithmetic in a
// comment; none is copied from the parser's output. Where a value is a node, the test also checks that it is the
// transcript's own node object (t.nodes.get(uuid)), not a copy.
// A comment `asserts: Type.member ...` at the end of an assertion names the members whose value that assertion checks;
// the coverage table of the members is read off these comments.
// It imports the package's entry point, dist/index.js, by path. LTMS_CLI=<path to a cli.js> runs the same tests
// against another build (its dist/index.js), as it does for test/cli.test.mjs.
// Also here: the committed fixtures are what test/make-fixtures.mjs writes, byte for byte; and every object search's and
// pin's functions return holds only the members its declared type names (their values are asserted in
// test/search.test.mjs and test/pin.test.mjs), read through the typescript package, skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = process.env.LTMS_CLI || join(root, 'dist', 'cli.js');
const LIB = join(dirname(CLI), 'index.js');
const { parseLines, parseTranscript, livePath, repairedLivePath, turnsOf } = await import(pathToFileURL(LIB).href);

const fixturePath = (name) => join(here, 'fixtures', name);
const read = (name) => readFileSync(fixturePath(name), 'utf8');
const jsonl = (records) => records.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n';
const uuidOf = (pre, k) => `${pre}-0000-4000-8000-${String(k).padStart(12, '0')}`;
// characters built from their code points, never typed
const BS = String.fromCharCode(92), NUL = String.fromCharCode(0);
const E_ACUTE = String.fromCodePoint(0xe9), GRIN = String.fromCodePoint(0x1f600);

// the members each object of a fixed shape has, as declared; `shaped` checks an object has exactly these keys, so a
// projection of its fields below misses nothing it holds
const KEYS = {
  TreeNode: ['uuid', 'parentUuid', 'record', 'children', 'parent', 'index', 'depth', 'copies'],
  ApiRequest: ['requestId', 'messageId', 'model', 'effort', 'timestamp', 'records', 'blocks', 'usage', 'contextLoad', 'outputTokens', 'thinkingTokens'],
  Transcript: ['fileKind', 'records', 'positions', 'nodes', 'roots', 'orphans', 'sidecars', 'problems', 'requests', 'toolCalls', 'liveLeafUuid', 'stats'],
  Bridge: ['orphan', 'via', 'missingParent', 'kind'],
  Splice: ['error', 'fork', 'branch', 'kind', 'lateType'],
  Extension: ['leaf', 'to', 'records', 'kind'],
  CompactionJoin: ['boundary', 'logicalParent', 'kind', 'via', 'joinedAt', 'trigger', 'preTokens', 'postTokens', 'durationMs'],
  Turn: ['prompt', 'records', 'requests', 'toolCalls'],
  repairedLivePath: ['path', 'from', 'bridges', 'splices', 'extension', 'compactions'],
};
const shaped = (x, type) => { assert.deepEqual(Object.keys(x).sort(), [...KEYS[type]].sort(), `the keys of a ${type}`); return x; };
// a ToolCall's result members are set only when a result was recorded; the others always. So a member added to any of
// the result types fails a test here until its value is asserted too.
const CALL_ALWAYS = ['id', 'name', 'input', 'caller', 'wireInput', 'wireDiffers', 'callNode', 'isError', 'spillFileHint'], CALL_RESULT = ['resultBlock', 'resultNode', 'toolUseResult'];
const callShaped = (c) => { const k = Object.keys(c); assert.ok(CALL_ALWAYS.every((m) => k.includes(m)) && k.every((m) => CALL_ALWAYS.includes(m) || CALL_RESULT.includes(m)), `the keys of a ToolCall: ${k.join(', ')}`); return c; };
// a node by its uuid, once it is checked to be the transcript's own node object
const nid = (t, n) => { assert.equal(t.nodes.get(n.uuid), n, `not the transcript's node object: ${JSON.stringify(n?.uuid)}`); return n.uuid; };
const nids = (t, ns) => ns.map((n) => nid(t, n));
// the error message JSON.parse gives for a line: what LineProblem.message holds for reason 'json'
const parseError = (s) => { try { JSON.parse(s); } catch (e) { return e.message; } assert.fail(`${JSON.stringify(s)} parsed: no error message to compare`); };
// repairedLivePath's result, each node by its uuid, each object's keys checked
const repaired = (t) => {
  const r = shaped(repairedLivePath(t), 'repairedLivePath');
  return {
    path: nids(t, r.path), from: r.from,
    bridges: r.bridges.map((b) => shaped(b, 'Bridge')).map((b) => [nid(t, b.orphan), nid(t, b.via), b.missingParent, b.kind]),
    splices: r.splices.map((s) => shaped(s, 'Splice')).map((s) => [nid(t, s.error), nid(t, s.fork), nids(t, s.branch), s.kind, s.lateType]),
    extension: r.extension === null ? null : ((x) => [nid(t, x.leaf), nid(t, x.to), x.records, x.kind])(shaped(r.extension, 'Extension')),
    compactions: r.compactions.map((c) => shaped(c, 'CompactionJoin')).map((c) => [nid(t, c.boundary), nid(t, c.logicalParent), c.kind, c.via, nid(t, c.joinedAt), c.trigger, c.preTokens, c.postTokens, c.durationMs]),
  };
};
// a ToolCall's members, each node by its uuid, once its keys are checked
const callRow = (t) => (c) => callShaped(c) && [c.id, c.name, c.input, c.wireInput, c.wireDiffers, c.caller, nid(t, c.callNode), c.resultNode === undefined ? undefined : nid(t, c.resultNode), c.resultBlock, c.toolUseResult, c.isError, c.spillFileHint];
// turnsOf's result, each node by its uuid, each request by its key and each call by its id, once each request and
// call is checked to be the transcript's own object
const turnRows = (t, turns) => turns.map((u) => shaped(u, 'Turn')).map((u) => [nid(t, u.prompt), nids(t, u.records),
  u.requests.map((g) => { assert.ok(t.requests.includes(g), 'a request that is not one of t.requests'); return g.requestId; }),
  u.toolCalls.map((c) => { assert.ok(t.toolCalls.includes(c), 'a call that is not one of t.toolCalls'); return c.id; })]);

// ---- library-lines.jsonl: the line parser ----
// Line by line, as the generator writes it: n, offset, bytes, by hand. A line's offset is the previous line's offset
// plus its bytes plus 1 (the \n). UTF-8: e-acute (U+00E9) is 2 bytes, U+1F600 is 4; the rest is ASCII, 1 byte each.
//   1  {"type":"a","s":"<e-acute>"}     17 + 2 + 2 = 21 bytes, at 0
//   2  (blank)                           0, at 0 + 21 + 1 = 22
//   3  {"type":"b","s":"<U+1F600>"}      17 + 4 + 2 = 23, at 22 + 0 + 1 = 23
//   4  three blanks                      3, at 23 + 23 + 1 = 47
//   5  null                              4, at 47 + 3 + 1 = 51
//   6  [1,2]                             5, at 51 + 4 + 1 = 56
//   7  "x"                               3, at 56 + 5 + 1 = 62
//   8  42                                2, at 62 + 3 + 1 = 66
//   9  {"type":"c"} and a CR             12 + 1 = 13, at 66 + 2 + 1 = 69
//  10  {"type":                          8, at 69 + 13 + 1 = 83
//  11  {"s":" + 113 a + U+1F600          6 + 113 + 4 = 123, at 83 + 8 + 1 = 92 (UTF-16: 6 + 113 + 2 = 121 code units)
//  12  1,001 [ then 1,001 ]              2,002, at 92 + 123 + 1 = 216
//  13  a NUL byte, then {"type":"d"}     1 + 12 = 13, at 216 + 2002 + 1 = 2219
//  14  {"type":"e"}                      12, at 2219 + 13 + 1 = 2233; the file is 2233 + 12 + 1 = 2,246 bytes
// ("{"type":"a","s":"" is 17 characters: { 1, "type" 6, : 1, "a" 3, , 1, "s" 3, : 1, " 1.)
const LINES = [[1, 0, 21], [2, 22, 0], [3, 23, 23], [4, 47, 3], [5, 51, 4], [6, 56, 5], [7, 62, 3], [8, 66, 2], [9, 69, 13],
  [10, 83, 8], [11, 92, 123], [12, 216, 2002], [13, 2219, 13], [14, 2233, 12]];
const L11 = `{"s":"${'a'.repeat(113)}${GRIN}`, L13 = `${NUL}{"type":"d"}`;
// the records: lines 1, 3, 9 and 14 parse as objects (line 9's CR is white space to JSON.parse); line 13 too, with repairNul
const REC = { a: { type: 'a', s: E_ACUTE }, b: { type: 'b', s: GRIN }, c: { type: 'c' }, d: { type: 'd' }, e: { type: 'e' } };
const POS = { 1: { line: 1, offset: 0, bytes: 21 }, 3: { line: 3, offset: 23, bytes: 23 }, 9: { line: 9, offset: 69, bytes: 13 }, 13: { line: 13, offset: 2219, bytes: 13 }, 14: { line: 14, offset: 2233, bytes: 12 } };
// the problems. sample: the line's first 120 UTF-16 code units as a JSON string. Line 11's 120th unit is the first
// half of U+1F600 (6 + 113 = 119 units come before it), which JSON.stringify writes as the escape \ud83d. Line 12's
// first 120 units are 120 brackets. not-object's message is `top-level ` and typeof: null's typeof is 'object'.
const problem = (line, offset, bytes, reason, message, sample, hasNul = false) => ({ line, offset, bytes, reason, message, sample, hasNul });
const PROBLEMS = [
  problem(5, 51, 4, 'not-object', 'top-level object', '"null"'),
  problem(6, 56, 5, 'not-object', 'top-level array', '"[1,2]"'),
  problem(7, 62, 3, 'not-object', 'top-level string', `"${BS}"x${BS}""`),
  problem(8, 66, 2, 'not-object', 'top-level number', '"42"'),
  problem(10, 83, 8, 'json', parseError('{"type":'), `"{${BS}"type${BS}":"`),
  problem(11, 92, 123, 'json', parseError(L11), `"{${BS}"s${BS}":${BS}"${'a'.repeat(113)}${BS}ud83d"`),
  problem(12, 216, 2002, 'too-deep', 'nested deeper than 1000 levels', `"${'['.repeat(120)}"`),
  problem(13, 2219, 13, 'json', parseError(L13), `"${BS}u0000{${BS}"type${BS}":${BS}"d${BS}"}"`, true),
];
// with repairNul, line 13 (the only line holding a NUL byte) is parsed again without it and recovered, reported as repaired
const PROBLEMS_REPAIRED = PROBLEMS.map((p) => (p.line === 13 ? { ...p, message: 'REPAIRED: NUL bytes stripped, record recovered' } : p));
// the census of a file with no envelope record: only byType holds anything
const EMPTY_CENSUS = { byBlockType: {}, byToolName: {}, byAttachmentType: {}, bySystemSubtype: {}, versions: {}, sessionIds: [], isSidechain: null, agentIds: [],
  branchPoints: 0, inputTurns: 0, toolResultRecords: 0, firstTimestamp: null, lastTimestamp: null, totalContextLoad: 0, totalOutputTokens: 0,
  replayedCopies: 0, replayedDiffering: 0, requestKeyGuessed: 0 };

test('library-lines.jsonl: the hand-counted offsets are the file\'s, read from its bytes without the parser', () => {
  const bytes = readFileSync(fixturePath('library-lines.jsonl'));
  const starts = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) starts.push(i + 1);
  assert.equal(bytes.length, 2246);
  assert.equal(starts.length - 1, 14);
  assert.deepEqual(LINES.map(([n]) => [n, starts[n - 1], starts[n] - starts[n - 1] - 1]), LINES);
});

test('parseLines: the records, positions, problems and line count of every line shape (library-lines.jsonl)', () => {
  const text = read('library-lines.jsonl');
  // 14 lines; 2 and 4 are blank, so lines = 12. Without repairNul: 4 records (lines 1, 3, 9, 14) and 8 problems
  // (5, 6, 7, 8, 10, 11, 12, 13): 4 + 8 = 12
  assert.deepEqual(parseLines(text), { records: [REC.a, REC.b, REC.c, REC.e], positions: [POS[1], POS[3], POS[9], POS[14]], problems: PROBLEMS, lines: 12 }); // asserts: parseLines().records parseLines().positions parseLines().problems parseLines().lines RecordPosition.* LineProblem.*
  // with repairNul: line 13's record recovered (5 records), and its problem says so (still 8 problems)
  assert.deepEqual(parseLines(text, { repairNul: true }), { records: [REC.a, REC.b, REC.c, REC.d, REC.e], positions: [POS[1], POS[3], POS[9], POS[13], POS[14]], problems: PROBLEMS_REPAIRED, lines: 12 }); // asserts: parseLines().records parseLines().positions parseLines().problems parseLines().lines RecordPosition.* LineProblem.*
});

test('LineProblem: the parser\'s own messages for a line of NUL bytes and blanks, and for one nested too deep once its NUL bytes are stripped (crafted lines)', () => {
  // two NUL bytes and a blank: not blank to trim() (a NUL is not white space), so a line; with repairNul, white space
  // once the NULs are stripped: 3 bytes at 0, sample '' by rule
  const padding = parseLines(`${NUL}${NUL} \n`, { repairNul: true });
  assert.deepEqual(padding, { records: [], positions: [], lines: 1, problems: [problem(1, 0, 3, 'empty-after-strip', 'line was NUL padding only', '', true)] }); // asserts: parseLines().records parseLines().positions parseLines().problems parseLines().lines LineProblem.*
  // {"a":"x\<NUL>\","b": then 1,001 [ and 1,001 ] and }: with the NUL, the first backslash escapes it and the second
  // the quote, so the string runs on and hides the brackets (depth 1); without it, the string ends at the quote and
  // the brackets are 1,002 levels deep. 7 + 1 + 1 + 1 + 6 + 1001 + 1001 + 1 = 2,019 bytes
  const raw = `{"a":"x${BS}${NUL}${BS}","b":${'['.repeat(1001)}${']'.repeat(1001)}}`;
  const deep = parseLines(raw + '\n', { repairNul: true });
  assert.deepEqual(deep.problems.map((p) => [p.line, p.offset, p.bytes, p.reason, p.message, p.hasNul]), [[1, 0, 2019, 'too-deep', 'nested deeper than 1000 levels once its NUL bytes are stripped', true]]); // asserts: LineProblem.message LineProblem.bytes
});

test('parseTranscript: a file of line shapes and no envelope record (library-lines.jsonl)', () => {
  const text = read('library-lines.jsonl');
  const t = shaped(parseTranscript(text), 'Transcript');
  assert.deepEqual([t.records, t.positions, t.problems], [[REC.a, REC.b, REC.c, REC.e], [POS[1], POS[3], POS[9], POS[14]], PROBLEMS]); // asserts: Transcript.records Transcript.positions Transcript.problems RecordPosition.* LineProblem.*
  // unparseable = the 8 problems, none a repair; byType: a, b, c, e once each
  assert.deepEqual(t.stats, { lines: 12, parsed: 4, unparseable: 8, byType: { a: 1, b: 1, c: 1, e: 1 }, ...EMPTY_CENSUS }); // asserts: Transcript.stats TranscriptStats.*
  // no record has the envelope: every record is a sidecar, the same objects, and there is no tree, request, call or head
  assert.deepEqual([t.fileKind, t.nodes.size, t.roots, t.orphans, t.requests, t.toolCalls, t.liveLeafUuid], ['unknown', 0, [], [], [], [], null]); // asserts: Transcript.fileKind Transcript.liveLeafUuid Transcript.roots Transcript.orphans Transcript.requests Transcript.toolCalls
  assert.ok(t.sidecars.length === 4 && t.sidecars.every((r, i) => r === t.records[i])); // asserts: Transcript.sidecars
  // with repairNul: 5 records; the repair is a problem but not unparseable (8 - 1 = 7); d counted
  const r = parseTranscript(text, { repairNul: true });
  assert.deepEqual([r.records, r.positions, r.problems], [[REC.a, REC.b, REC.c, REC.d, REC.e], [POS[1], POS[3], POS[9], POS[13], POS[14]], PROBLEMS_REPAIRED]); // asserts: Transcript.records Transcript.positions Transcript.problems RecordPosition.* LineProblem.*
  assert.deepEqual(r.stats, { lines: 12, parsed: 5, unparseable: 7, byType: { a: 1, b: 1, c: 1, d: 1, e: 1 }, ...EMPTY_CENSUS }); // asserts: Transcript.stats TranscriptStats.*
});

test('Transcript.fileKind: transcript, journal, empty and unknown', () => {
  // transcript: at least one envelope record. journal: no envelope record, and every type launched, started or result.
  // empty: no record parsed (an empty file; a file of bad lines only). unknown: anything else, a journal's type beside
  // another type included.
  const kinds = [
    parseTranscript(read('library-forest.jsonl')).fileKind,
    parseTranscript(read('journal-launched.jsonl')).fileKind,
    parseTranscript(read('empty.jsonl')).fileKind,
    parseTranscript('not json\n[1]\n').fileKind,
    parseTranscript(read('types-only.jsonl')).fileKind,
    parseTranscript('{"type":"result"}\n{"type":"note"}\n').fileKind,
  ];
  assert.deepEqual(kinds, ['transcript', 'journal', 'empty', 'empty', 'unknown', 'unknown']); // asserts: Transcript.fileKind
});

// ---- library-forest.jsonl: the tree and the census ----
const S1 = 'f1f1f1f1-1111-4111-8111-111111111111', S2 = 'f1f1f1f1-2222-4222-8222-222222222222', S3 = 'f1f1f1f1-3333-4333-8333-333333333333';
const F = (k) => uuidOf('f1000000', k);
const F_MISSING = uuidOf('f1999999', 999);

test('the tree: every node\'s uuid, parent, children, index, depth and copies, and the roots, orphans and sidecars (library-forest.jsonl)', () => {
  const t = parseTranscript(read('library-forest.jsonl'));
  // the file's 27 lines, read here with JSON.parse and no parser: records holds every one, in order (replays included)
  const lines = read('library-forest.jsonl').split('\n').slice(0, -1).map((l) => JSON.parse(l));
  assert.deepEqual(t.records, lines); // asserts: Transcript.records
  assert.deepEqual(t.positions.map((p) => p.line), lines.map((_, i) => i + 1)); // asserts: Transcript.positions RecordPosition.line
  // the nodes, in the order first written: lines 1-15, then 18-21 (16, 17 and 27 are replays of 4, 2 and 3). The uuid
  // of the record on line k ends in k; its index is k - 1 (no blank line). Children in file order: 6 has two (7,
  // rewound, and 9, typed again). Depth counts links from the root (1) or the orphan (18); 20 and 21 name each other,
  // so no walk from a root reaches them and their depth stays 0. Copies: 2 for each of the three replayed uuids.
  //       uuid   parentUuid  parent  children        index depth copies
  const expected = [
    [F(1), null, null, [F(2)], 0, 0, 1],
    [F(2), F(1), F(1), [F(3)], 1, 1, 2],
    [F(3), F(2), F(2), [F(4)], 2, 2, 2],
    [F(4), F(3), F(3), [F(5)], 3, 3, 2],
    [F(5), F(4), F(4), [F(6)], 4, 4, 1],
    [F(6), F(5), F(5), [F(7), F(9)], 5, 5, 1],
    [F(7), F(6), F(6), [F(8)], 6, 6, 1],
    [F(8), F(7), F(7), [], 7, 7, 1],
    [F(9), F(6), F(6), [F(10)], 8, 6, 1],
    [F(10), F(9), F(9), [F(11)], 9, 7, 1],
    [F(11), F(10), F(10), [F(12)], 10, 8, 1],
    [F(12), F(11), F(11), [F(13)], 11, 9, 1],
    [F(13), F(12), F(12), [F(14)], 12, 10, 1],
    [F(14), F(13), F(13), [F(15)], 13, 11, 1],
    [F(15), F(14), F(14), [], 14, 12, 1],
    [F(18), F_MISSING, null, [F(19)], 17, 0, 1],
    [F(19), F(18), F(18), [], 18, 1, 1],
    [F(20), F(21), F(21), [F(21)], 19, 0, 1],
    [F(21), F(20), F(20), [F(20)], 20, 0, 1],
  ];
  assert.deepEqual([...t.nodes.keys()], expected.map((row) => row[0])); // asserts: Transcript.nodes
  assert.deepEqual([...t.nodes.values()].map((n) => shaped(n, 'TreeNode')).map((n) => [n.uuid, n.parentUuid, n.parent === null ? null : nid(t, n.parent), nids(t, n.children), n.index, n.depth, n.copies]), expected); // asserts: TreeNode.uuid TreeNode.parentUuid TreeNode.parent TreeNode.children TreeNode.index TreeNode.depth TreeNode.copies Transcript.nodes
  // a node's record is the FIRST record with its uuid: the same object as records[index] (for 2, line 2, not line 17)
  for (const n of t.nodes.values()) assert.equal(n.record, t.records[n.index], `${n.uuid}: record is not t.records[${n.index}]`); // asserts: TreeNode.record
  assert.notEqual(t.nodes.get(F(2)).record, t.records[16]); // asserts: TreeNode.record
  // roots: parentUuid null (1); orphans: a parent in no file (18). Sidecars, the records without the envelope, in file
  // order: lines 22-26 (ai-title, three last-prompt, the record with no type), the same objects as records[21..25]
  // (line 27, a replay, has the envelope)
  assert.deepEqual([nids(t, t.roots), nids(t, t.orphans)], [[F(1)], [F(18)]]); // asserts: Transcript.roots Transcript.orphans
  assert.deepEqual(t.sidecars, lines.slice(21, 26)); // asserts: Transcript.sidecars
  assert.ok(t.sidecars.every((r, i) => r === t.records[21 + i])); // asserts: Transcript.sidecars
});

test('the census: every count of TranscriptStats over first copies (library-forest.jsonl)', () => {
  const t = parseTranscript(read('library-forest.jsonl'));
  // lines and parsed: 27 lines, no blank or bad one. Over first copies (lines 16, 17 and 27, the replays, left out):
  // byType: user 1, 4, 7, 9, 11, 12, 14, 18 = 8; assistant 2, 3, 8, 10, 13, 15, 19, 20, 21 = 9; attachment 5; system 6;
  //   ai-title 22; last-prompt 23, 24, 25; line 26 has no type, so it is not counted
  // byBlockType: a string content is one text block. user text 1, 7, 9, 11, 12, 14, 18 (7) + assistant text 8, 10,
  //   13, 15, 19, 20, 21 (7) = 14; thinking 2; tool_use 3; tool_result 4. byToolName: Bash (3)
  // versions: the 19 nodes all wrote 2.1.300 but 15 (''), so 18; the replay's 2.1.319 is not counted
  // sessionIds in the order first seen: S1 (1), S2 (14), S3 (22, a sidecar); agentIds: 13, 15 (not the replay's)
  // isSidechain: every boolean is false (the replay's true is not counted). branchPoints: 6 only
  // inputTurns, on every branch: typed 1, 7, 9, 18; task 12; peer 14 = 6 (11 is harness:meta). toolResultRecords: 4
  // first and last timestamp, as strings, over string timestamps: 08:59:00 (18; the replay's 08:58 is not counted)
  //   and 09:10:00 (19, though 20, written after it, says 09:00:42; 21's timestamp is the number 99, not a string)
  // the one usage: msg_f1_01 on 2 and 3, charged once: input 10, output 5. Replays: 16 and 27 (as written) and 17
  // (keys added): 3 copies, 1 differing. Every assistant record has a requestId: requestKeyGuessed 0.
  assert.deepEqual(t.stats, { // asserts: Transcript.stats TranscriptStats.*
    lines: 27, parsed: 27, unparseable: 0,
    byType: { user: 8, assistant: 9, attachment: 1, system: 1, 'ai-title': 1, 'last-prompt': 3 },
    byBlockType: { text: 14, thinking: 1, tool_use: 1, tool_result: 1 },
    byToolName: { Bash: 1 }, byAttachmentType: { hook_success: 1 }, bySystemSubtype: { turn_duration: 1 },
    versions: { '2.1.300': 18 }, sessionIds: [S1, S2, S3], isSidechain: false, agentIds: ['agent-f1-a', 'agent-f1-b'],
    branchPoints: 1, inputTurns: 6, toolResultRecords: 1,
    firstTimestamp: '2026-08-02T08:59:00.000Z', lastTimestamp: '2026-08-02T09:10:00.000Z',
    totalContextLoad: 10, totalOutputTokens: 5, replayedCopies: 3, replayedDiffering: 1, requestKeyGuessed: 0,
  });
});

test('the census: isSidechain true and mixed, and the values a crafted file can put in it (crafted records)', () => {
  const env = { userType: 'external', cwd: '/w', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  const rec = (k, extra) => ({ parentUuid: k === 1 ? null : uuidOf('f7000000', k - 1), ...env, type: 'user', promptSource: 'typed', message: { role: 'user', content: 'go' }, uuid: uuidOf('f7000000', k), ...extra });
  // one record, isSidechain true: true. Two, true and false: 'mixed'.
  assert.equal(parseTranscript(jsonl([rec(1, { isSidechain: true, version: '2.1.319' })])).stats.isSidechain, true); // asserts: TranscriptStats.isSidechain
  assert.equal(parseTranscript(jsonl([rec(1, { isSidechain: true }), rec(2, { isSidechain: false })])).stats.isSidechain, 'mixed'); // asserts: TranscriptStats.isSidechain
  // a sessionId that is the number 7 is kept as written; an agentId '' and a version 0 are not counted. A prompt
  // record without the envelope (no uuid) is not a node, and still an input turn to the census: 2 input turns.
  const s = parseTranscript(jsonl([rec(1, { isSidechain: false, sessionId: 7, agentId: '', version: 0 }),
    { type: 'user', promptSource: 'typed', message: { role: 'user', content: 'go' } }])).stats;
  assert.deepEqual([s.sessionIds, s.agentIds, s.versions, s.inputTurns], [[7], [], {}, 2]); // asserts: TranscriptStats.sessionIds TranscriptStats.agentIds TranscriptStats.versions TranscriptStats.inputTurns
});

test('the head pointer and livePath: leafUuid, last-leaf and none (library-forest.jsonl, compacted-nopointer.jsonl, journal-launched.jsonl, crafted)', () => {
  const t = parseTranscript(read('library-forest.jsonl'));
  // three last-prompt records: 10, then 15, then the number 7, which is not a string: the head is 15
  assert.equal(t.liveLeafUuid, F(15)); // asserts: Transcript.liveLeafUuid
  // 15 is a node: up its parent links to the root, through the second child of 6 (9, typed again)
  const live = livePath(t);
  assert.deepEqual([Object.keys(live).sort(), nids(t, live.path), live.from], [['from', 'path'], [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15].map(F), 'leafUuid']); // asserts: livePath().path livePath().from
  // no last-prompt record: the head is the last-written node with no children (line 14's reply), and the walk up
  // stops at the compaction boundary, a root (line 9, uuid ...20): boundary, summary (21), prompt 9, call 10, result 11, reply 12
  const np = parseTranscript(read('compacted-nopointer.jsonl'));
  const npPath = livePath(np);
  assert.deepEqual([np.liveLeafUuid, nids(np, npPath.path), npPath.from], [null, [20, 21, 9, 10, 11, 12].map((k) => uuidOf('de000000', k)), 'last-leaf']); // asserts: Transcript.liveLeafUuid livePath().path livePath().from
  // no node at all (a workflow journal): no head
  const j = parseTranscript(read('journal-launched.jsonl'));
  assert.deepEqual([livePath(j).path, livePath(j).from], [[], 'none']); // asserts: livePath().path livePath().from
  // the last string leafUuid names no node: it is still the head pointer, and livePath takes the last-written leaf
  const env = { isSidechain: false, userType: 'external', cwd: '/w', version: '2.1.319', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  const P = uuidOf('f8000000', 1), A = uuidOf('f8000000', 2);
  const gone = parseTranscript(jsonl([
    { parentUuid: null, ...env, type: 'user', promptSource: 'typed', message: { role: 'user', content: 'go' }, uuid: P },
    { parentUuid: P, ...env, type: 'assistant', requestId: 'q', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, uuid: A },
    { type: 'last-prompt', leafUuid: A, sessionId: 's' },
    { type: 'last-prompt', leafUuid: 'a uuid in no record', sessionId: 's' },
  ]));
  assert.deepEqual([gone.liveLeafUuid, nids(gone, livePath(gone).path), livePath(gone).from], ['a uuid in no record', [P, A], 'last-leaf']); // asserts: Transcript.liveLeafUuid livePath().path livePath().from
  // every node has a child (two records naming each other) and no pointer: no head
  const cyc = parseTranscript(jsonl([
    { parentUuid: A, ...env, type: 'user', promptSource: 'typed', message: { role: 'user', content: 'go' }, uuid: P },
    { parentUuid: P, ...env, type: 'assistant', requestId: 'q', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, uuid: A },
  ]));
  assert.deepEqual(livePath(cyc), { path: [], from: 'none' }); // asserts: livePath().*
});

// ---- library-requests.jsonl: requests, calls and turns ----
const R = (k) => uuidOf('f2000000', k);
const at2 = (ss) => `2026-08-03T10:00:${ss}Z`;
const USAGE = {
  a: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 40, output_tokens_details: { thinking_tokens: 15 } },
  b: { input_tokens: 7, cache_read_input_tokens: 500, output_tokens: 60 },
  c: { input_tokens: 3, cache_creation_input_tokens: 40, output_tokens: 9 },
  d: { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 30 },
  e: { input_tokens: 1, cache_read_input_tokens: 1100, output_tokens: 8 },
};
const BLOCK = {
  call1: { type: 'tool_use', id: 'toolu_f2_01', name: 'Bash', input: { command: 'make demo' }, caller: { type: 'direct' } },
  thinking: { type: 'thinking', thinking: 'An invented thought.', signature: 'invented-signature' },
  call2: { type: 'tool_use', id: 'toolu_f2_02', name: 'Bash', input: { command: 'make demo' }, caller: { type: 'direct' } },
  call3: { type: 'tool_use', id: 'toolu_f2_03', name: 'Read', input: { file_path: '/work/demo-project/notes.txt', limit: 20 } },
  reply3: { type: 'text', text: 'The invented demo builds now.' },
  call4: { type: 'tool_use', id: 'toolu_f2_04', name: 'Read', input: { file_path: '/work/demo-project/one.txt' } },
  call5: { type: 'tool_use', id: 'toolu_f2_05', name: 'Read', input: { file_path: '/work/demo-project/two.txt' } },
  reply5: { type: 'text', text: 'The first invented file is missing; the second was read.' },
};

test('ApiRequest: every field of each response, and the totals (library-requests.jsonl)', () => {
  const t = parseTranscript(read('library-requests.jsonl'));
  // contextLoad = input + cache_creation + cache_read of each record charged; a message id is charged once.
  //   req_f2_01: lines 2 and 3 share msg_f2_01, so one usage: 100 + 20 + 300 = 420; output 40; thinking 15
  //   req_f2_02 (line 5): 7 + 0 + 500 = 507; 60; 0
  //   msg:msg_f2_03 (line 9, no requestId: keyed by its message id): 3 + 40 + 0 = 43; 9; 0
  //   req_f2_04: lines 11 and 12 share msg_f2_04: 2 + 0 + 1000 = 1002; 30; 0
  //   req_f2_05 (line 15): 1 + 0 + 1100 = 1101; 8; 0
  // records: req_f2_01's line 2 has apiBlockIndex 1 and line 3 has 0, so line 3 first; its messageId, model, effort
  // and timestamp are the first-WRITTEN record's (line 2: 10:00:02, where line 3 says 10:00:03). The others have no
  // apiBlockIndex, so file order. effort: only req_f2_01's records carry one.
  const rows = t.requests.map((g) => shaped(g, 'ApiRequest')).map((g) => [g.requestId, g.messageId, g.model, g.effort, g.timestamp, g.records.map((r) => r.uuid), g.blocks, g.usage, g.contextLoad, g.outputTokens, g.thinkingTokens]);
  assert.deepEqual(rows, [ // asserts: Transcript.requests ApiRequest.requestId ApiRequest.messageId ApiRequest.model ApiRequest.effort ApiRequest.timestamp ApiRequest.records ApiRequest.blocks ApiRequest.usage ApiRequest.contextLoad ApiRequest.outputTokens ApiRequest.thinkingTokens
    ['req_f2_01', 'msg_f2_01', 'claude-demo-model', 'high', at2('02.000'), [R(3), R(2)], [BLOCK.thinking, BLOCK.call1], USAGE.a, 420, 40, 15],
    ['req_f2_02', 'msg_f2_02', 'claude-demo-model', undefined, at2('05.000'), [R(5)], [BLOCK.call2, BLOCK.call3], USAGE.b, 507, 60, 0],
    ['msg:msg_f2_03', 'msg_f2_03', 'claude-demo-model', undefined, at2('09.000'), [R(9)], [BLOCK.reply3], USAGE.c, 43, 9, 0],
    ['req_f2_04', 'msg_f2_04', 'claude-demo-model', undefined, at2('11.000'), [R(11), R(12)], [BLOCK.call4, BLOCK.call5], USAGE.d, 1002, 30, 0],
    ['req_f2_05', 'msg_f2_05', 'claude-demo-model', undefined, at2('14.000'), [R(15)], [BLOCK.reply5], USAGE.e, 1101, 8, 0],
  ]);
  // records are the file's own record objects; usage is the charged record's own object (line 2's, not line 3's)
  assert.ok(t.requests[0].records[0] === t.records[2] && t.requests[0].records[1] === t.records[1]); // asserts: ApiRequest.records
  assert.ok(t.requests[0].usage === t.records[1].message.usage && t.requests[3].usage === t.records[10].message.usage); // asserts: ApiRequest.usage
  // totals: 420 + 507 + 43 + 1002 + 1101 = 3073; 40 + 60 + 9 + 30 + 8 = 147. Results: lines 4, 6, 7, 8, 13, 14 = 6.
  const s = t.stats;
  assert.deepEqual([s.totalContextLoad, s.totalOutputTokens, s.requestKeyGuessed, s.toolResultRecords, s.inputTurns], [3073, 147, 0, 6, 2]); // asserts: TranscriptStats.totalContextLoad TranscriptStats.totalOutputTokens TranscriptStats.requestKeyGuessed TranscriptStats.toolResultRecords TranscriptStats.inputTurns
});

const K = (k) => uuidOf('f3000000', k);
const at3 = (ss) => `2026-08-04T11:00:${ss}.000Z`;

test('ApiRequest: the grouping keys and the charging, on crafted shapes (library-request-keys.jsonl)', () => {
  const t = parseTranscript(read('library-request-keys.jsonl'));
  const text = (s) => ({ type: 'text', text: s });
  // req_e: line 2 (msg_e1, apiBlockIndex 1) and line 3 (msg_e2, apiBlockIndex 0) have their own message ids, so both
  //   are charged: 1 + (4 + 8) = 13; 2 + 16 = 18; 0 + 32 = 32; usage is the last charged (line 3's). messageId,
  //   model, effort and timestamp are line 2's (written first), though line 3 comes first in records.
  // req_f (line 4): its message id msg_e1 was charged in req_e, so nothing is charged: 0, 0, 0, usage undefined
  // req_g: lines 5 and 6 have no message id, so each is charged: 3 + 3 = 6; 1 + 1 = 2; usage is line 6's
  // uuid:<7>: line 7 has neither key, and line 8 hangs off it with neither key, so one group, keyed by 7's uuid
  // line:8: the record on line 9 has neither key and no uuid: keyed by its 0-based position in records, 8; it has no
  //   timestamp, model or effort
  // msg:msg_j: line 10's requestId is '' (not used), so its message id keys it
  // requestKeyGuessed: lines 7, 8 and 9 = 3. Totals: 13 + 6 = 19; 18 + 2 = 20.
  const rows = t.requests.map((g) => shaped(g, 'ApiRequest')).map((g) => [g.requestId, g.messageId, g.model, g.effort, g.timestamp, g.records.map((r) => t.records.indexOf(r)), g.blocks, g.usage, g.contextLoad, g.outputTokens, g.thinkingTokens]);
  assert.deepEqual(rows, [ // asserts: ApiRequest.requestId ApiRequest.messageId ApiRequest.model ApiRequest.effort ApiRequest.timestamp ApiRequest.records ApiRequest.blocks ApiRequest.usage ApiRequest.contextLoad ApiRequest.outputTokens ApiRequest.thinkingTokens
    ['req_e', 'msg_e1', 'model-e1', 'low', at3('01'), [2, 1], [text('the first block, written second'), text('the second block, written first')], { input_tokens: 4, cache_read_input_tokens: 8, output_tokens: 16, output_tokens_details: { thinking_tokens: 32 } }, 13, 18, 32],
    ['req_f', 'msg_e1', 'model-e1', undefined, at3('03'), [3], [text('a response whose message id was charged already')], undefined, 0, 0, 0],
    ['req_g', undefined, 'model-g', undefined, at3('04'), [4, 5], [text('a record with no message id'), text('another record with no message id')], { input_tokens: 3, output_tokens: 1 }, 6, 2, 0],
    [`uuid:${K(7)}`, undefined, undefined, undefined, at3('06'), [6, 7], [text('a record with neither key'), text('its child, with neither key either')], undefined, 0, 0, 0],
    ['line:8', undefined, undefined, undefined, undefined, [8], [text('an assistant record without the envelope')], undefined, 0, 0, 0],
    ['msg:msg_j', 'msg_j', 'model-j', undefined, at3('09'), [9], [text('a record whose requestId is empty')], undefined, 0, 0, 0],
    ['req_t', 'msg_t', 'model-t', undefined, at3('10'), [10], [{ type: 'tool_use', id: 'toolu_dup', name: 'Bash', input: { command: 'make one' } },
      { type: 'tool_use', id: 'toolu_dup', name: 'Bash', input: { command: 'make two' } }, { type: 'tool_use', id: 42, name: 'Read', input: { file_path: '/work/demo-project/n.txt' } }], undefined, 0, 0, 0],
  ]);
  assert.ok(t.requests[0].usage === t.records[2].message.usage && t.requests[2].usage === t.records[5].message.usage); // asserts: ApiRequest.usage
  assert.deepEqual([t.stats.requestKeyGuessed, t.stats.totalContextLoad, t.stats.totalOutputTokens], [3, 19, 20]); // asserts: TranscriptStats.requestKeyGuessed TranscriptStats.totalContextLoad TranscriptStats.totalOutputTokens
});

test('ApiRequest: a token count written as a string is added as JavaScript adds it, as the doc says (crafted record)', () => {
  // input_tokens '7', cache_read_input_tokens 500: ('7' || 0) + (undefined || 0) + 500 = '70' + 500 = '70500', and the
  // request's 0 + '70500' = '070500'; the total's 0 + '070500' = '0070500'. output_tokens 3 is a number: 3.
  const t = parseTranscript(jsonl([{ parentUuid: null, isSidechain: false, sessionId: 's', uuid: uuidOf('f9000000', 1), type: 'assistant', requestId: 'q',
    message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: '7', cache_read_input_tokens: 500, output_tokens: 3 } } }]));
  assert.deepEqual([t.requests[0].contextLoad, t.requests[0].outputTokens, t.stats.totalContextLoad, t.stats.totalOutputTokens], ['070500', 3, '0070500', 3]); // asserts: ApiRequest.contextLoad TranscriptStats.totalContextLoad
});

test('ToolCall: every field of each call: wire inputs, caller, results in both recordings, errors (library-requests.jsonl)', () => {
  const t = parseTranscript(read('library-requests.jsonl'));
  const hint = (id) => `<session>/tool-results/${id}.txt`;
  // toolu_f2_01 (line 2): no wireToolInputs on its record, so no wireInput and wireDiffers false. Its result (line 4)
  //   has no is_error, but its toolUseResult is a string (the error form): isError true.
  // toolu_f2_02 and _03 (line 5, one record, block order): wireToolInputs has both. 02's wire command holds the
  //   `cd /work/demo-project && ` the harness stripped: differs. 03's wire input has the same keys and values in
  //   another order: does not differ. caller: on 01's and 02's blocks, the object { type: 'direct' }; not on 03's.
  // 03 has two result records: line 6 (with toolUseResult) and line 8 (without). The later one is resultNode and
  //   resultBlock; the earlier one's toolUseResult stays. 02's result is line 7.
  // toolu_f2_04 (line 11): result line 14, is_error true, toolUseResult an object: isError true by is_error alone.
  // toolu_f2_05 (line 12, off the live path): result line 13.
  assert.deepEqual(t.toolCalls.map(callRow(t)), [ // asserts: Transcript.toolCalls ToolCall.id ToolCall.name ToolCall.input ToolCall.wireInput ToolCall.wireDiffers ToolCall.caller ToolCall.callNode ToolCall.resultNode ToolCall.resultBlock ToolCall.toolUseResult ToolCall.isError ToolCall.spillFileHint
    ['toolu_f2_01', 'Bash', { command: 'make demo' }, undefined, false, { type: 'direct' }, R(2), R(4),
      { type: 'tool_result', tool_use_id: 'toolu_f2_01', content: 'Exit code 2\nan invented failure' }, 'Error: Exit code 2\nan invented failure', true, hint('toolu_f2_01')],
    ['toolu_f2_02', 'Bash', { command: 'make demo' }, { command: 'cd /work/demo-project && make demo' }, true, { type: 'direct' }, R(5), R(7),
      { type: 'tool_result', tool_use_id: 'toolu_f2_02', content: 'invented build output', is_error: false }, { stdout: 'invented build output', stderr: '', interrupted: false, isImage: false }, false, hint('toolu_f2_02')],
    ['toolu_f2_03', 'Read', { file_path: '/work/demo-project/notes.txt', limit: 20 }, { limit: 20, file_path: '/work/demo-project/notes.txt' }, false, undefined, R(5), R(8),
      { type: 'tool_result', tool_use_id: 'toolu_f2_03', content: 'invented notes, recorded again' }, { type: 'text', file: { filePath: '/work/demo-project/notes.txt', numLines: 1 } }, false, hint('toolu_f2_03')],
    ['toolu_f2_04', 'Read', { file_path: '/work/demo-project/one.txt' }, undefined, false, undefined, R(11), R(14),
      { type: 'tool_result', tool_use_id: 'toolu_f2_04', content: 'File does not exist.', is_error: true }, { invented: 'an invented structured error' }, true, hint('toolu_f2_04')],
    ['toolu_f2_05', 'Read', { file_path: '/work/demo-project/two.txt' }, undefined, false, undefined, R(12), R(13),
      { type: 'tool_result', tool_use_id: 'toolu_f2_05', content: 'the invented second file' }, { type: 'text' }, false, hint('toolu_f2_05')],
  ]);
  // the values are the file's own objects: the block's input, the record's wire copy, the result block, toolUseResult
  const [c1, c2, c3] = t.toolCalls;
  assert.ok(c2.input === t.records[4].message.content[0].input && c2.wireInput === t.records[4].wireToolInputs.toolu_f2_02); // asserts: ToolCall.input ToolCall.wireInput
  assert.ok(c3.resultBlock === t.records[7].message.content[0] && c3.toolUseResult === t.records[5].toolUseResult && c1.caller === t.records[1].message.content[0].caller); // asserts: ToolCall.resultBlock ToolCall.toolUseResult ToolCall.caller
});

test('ToolCall: a repeated id, an id that is not a string, and a result in a record without the envelope (library-request-keys.jsonl)', () => {
  const t = parseTranscript(read('library-request-keys.jsonl'));
  // line 11 holds three calls: toolu_dup twice (the later block is kept: `make two`) and the number 42. toolu_dup's
  // result is on line 12, a record with no uuid: resultBlock and toolUseResult are set, resultNode is undefined.
  // 42 has no result, and its spillFileHint is '' (its id is not a string).
  assert.deepEqual(t.toolCalls.map(callRow(t)), [ // asserts: ToolCall.id ToolCall.callNode ToolCall.input ToolCall.resultNode ToolCall.resultBlock ToolCall.toolUseResult ToolCall.isError ToolCall.spillFileHint
    ['toolu_dup', 'Bash', { command: 'make two' }, undefined, false, undefined, K(11), undefined,
      { type: 'tool_result', tool_use_id: 'toolu_dup', content: 'invented output of make two' }, { stdout: 'invented output of make two', stderr: '' }, false, '<session>/tool-results/toolu_dup.txt'],
    [42, 'Read', { file_path: '/work/demo-project/n.txt' }, undefined, false, undefined, K(11), undefined, undefined, undefined, false, ''],
  ]);
  // the census counts the result record without the envelope (line 12): 1 result record; 1 input turn (line 1)
  assert.deepEqual([t.stats.toolResultRecords, t.stats.inputTurns], [1, 1]); // asserts: TranscriptStats.toolResultRecords TranscriptStats.inputTurns
});

test('ToolCall: a tool_use block with no id and no name gives id and name undefined, as declared (crafted records)', () => {
  // the declarations say string | undefined for both: the parser copies the block's id and name as written, and this
  // block has neither. Its spillFileHint is '' (the id is not a string), and byToolName does not count a missing name.
  const env = { isSidechain: false, userType: 'external', cwd: '/w', version: '2.1.319', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  const P = uuidOf('fd000000', 1), A = uuidOf('fd000000', 2);
  const t = parseTranscript(jsonl([
    { parentUuid: null, ...env, type: 'user', promptSource: 'typed', message: { role: 'user', content: 'go' }, uuid: P },
    { parentUuid: P, ...env, type: 'assistant', requestId: 'q', message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', input: { command: 'make demo' } }] }, uuid: A },
  ]));
  assert.deepEqual(t.toolCalls.map(callRow(t)), [[undefined, undefined, { command: 'make demo' }, undefined, false, undefined, A, undefined, undefined, undefined, false, '']]); // asserts: ToolCall.id ToolCall.name ToolCall.spillFileHint
  assert.ok('id' in t.toolCalls[0] && 'name' in t.toolCalls[0], 'the keys id and name are present, their values undefined');
  assert.deepEqual([t.stats.byToolName, t.stats.byBlockType], [{}, { text: 1, tool_use: 1 }]); // asserts: TranscriptStats.byToolName TranscriptStats.byBlockType
});

// ---- the live path, repaired ----
test('repairedLivePath: no repair to make (library-forest.jsonl) and no head (journal-launched.jsonl)', () => {
  // the forest: the head (15) has no children; the path starts at a root with no logical parent; 6's other branch (7, 8)
  // was written before 9 and stamped before it too (09:00:20 and :21 against :30), a rewind, so nothing is spliced
  const t = parseTranscript(read('library-forest.jsonl'));
  assert.deepEqual(repaired(t), { path: [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15].map(F), from: 'leafUuid', bridges: [], splices: [], extension: null, compactions: [] }); // asserts: repairedLivePath().path repairedLivePath().from repairedLivePath().bridges repairedLivePath().splices repairedLivePath().extension repairedLivePath().compactions
  const j = parseTranscript(read('journal-launched.jsonl'));
  assert.deepEqual(repaired(j), { path: [], from: 'none', bridges: [], splices: [], extension: null, compactions: [] }); // asserts: repairedLivePath().path repairedLivePath().from repairedLivePath().extension
});

test('repairedLivePath: a stale head extended (stale-head.jsonl)', () => {
  // stale-head.jsonl (make-fixtures.mjs): prompt 1, the last-prompt pointer to it, then call 2, result 3, call 4,
  // result 5, reply 6, each below the last. The pointer names 1, which has children: extended to the last-written
  // node below it (6); 5 nodes below 1, each counted once.
  const t = parseTranscript(read('stale-head.jsonl'));
  const u = (k) => uuidOf('df000000', k);
  assert.deepEqual(repaired(t), { path: [1, 2, 3, 4, 5, 6].map(u), from: 'leafUuid', bridges: [], splices: [], extension: [u(1), u(6), 5, 'stale-head'], compactions: [] }); // asserts: repairedLivePath().path repairedLivePath().extension Extension.leaf Extension.to Extension.records Extension.kind
});

test('repairedLivePath: a late-written API error spliced (retried3.jsonl)', () => {
  // retried3.jsonl: prompt 1, call 2, result 3 (the tip), then calls and results 4 to 9 below it; the api_error (uuid
  // ...30, stamped 10:00:05) is written after them but parented to 3, and the reply 10 (the head) hangs off it. The
  // branch 4-9 was all written before the error and runs past its time (4 is stamped 10:00:08): inserted after it.
  const t = parseTranscript(read('retried3.jsonl'));
  const u = (k) => uuidOf('e0000000', k);
  assert.deepEqual(repaired(t), { path: [1, 2, 3, 30, 4, 5, 6, 7, 8, 9, 10].map(u), from: 'leafUuid', bridges: [], extension: null, compactions: [], // asserts: repairedLivePath().path repairedLivePath().splices Splice.error Splice.fork Splice.branch Splice.kind Splice.lateType
    splices: [[u(30), u(3), [4, 5, 6, 7, 8, 9].map(u), 'late-write', 'system:api_error']] });
});

/** Where the orphans stand on a path, by a forward scan: each one's first place AFTER the place of the one before it,
 *  or -1 where it has none (the next is then searched after the last place found). A repaired path can hold a node
 *  twice (0.1.0's fuzz: 2,174 of 40,000 random transcripts), so a node's first place on the whole path (indexOf from
 *  its start) can stand before an earlier orphan's place though the node stands after it too; and two orphans never
 *  share one place. */
const orphanPlaces = (path, orphans) => {
  let from = 0;
  return orphans.map((o) => { const p = path.indexOf(o, from); if (p >= 0) from = p + 1; return p; });
};
// the bridges' orphans stand on the returned path in the order the list gives them: path order, the earliest first
const bridgesInPathOrder = (r) => {
  const at = orphanPlaces(r.path, r.bridges.map((b) => b.orphan));
  assert.ok(at.every((p) => p >= 0), `the bridges' orphans stand at ${JSON.stringify(at)} on the path, each searched after the place of the one before (-1: none there): not in path order`);
};

test('bridgesInPathOrder, the helper: where its forward scan finds each orphan, and its verdict, on a path that holds a node twice, in order and out of order (crafted paths)', () => {
  // Known by construction. The path A X B X C holds X twice, at places 1 and 3; A X B holds it once, at 1. Each
  // orphan's place is its first place after the place of the orphan before it:
  //   [B, X]: B at 2, then X at 3: in order (X's first place on the whole path, 1, stands before B's)
  //   [X, B]: X at 1, B at 2: in order.          [A, C]: A at 0, C at 4: in order
  //   [C, X]: C at 4, and X at no place after it: not in order (X stands at 1 and 3, both before C)
  //   [X, X]: one X at each of its places, 1 and 3: in order; on A X B, the second X has no place after the first's:
  //   not in order (two bridges never share a place)
  const [A, X, B, C] = ['A', 'X', 'B', 'C'].map((uuid) => ({ uuid }));
  const twice = [A, X, B, X, C], once = [A, X, B];
  const verdict = (path, orphans) => {
    try { bridgesInPathOrder({ path, bridges: orphans.map((orphan) => ({ orphan })) }); return 'in order'; }
    catch (e) { if (e instanceof assert.AssertionError) return e.message; throw e; }
  };
  const out = (at) => `the bridges' orphans stand at ${JSON.stringify(at)} on the path, each searched after the place of the one before (-1: none there): not in path order`;
  const cases = [[twice, [B, X]], [twice, [X, B]], [twice, [A, C]], [twice, [C, X]], [twice, [X, X]], [once, [X, X]]];
  assert.deepEqual(cases.map(([path, orphans]) => [orphanPlaces(path, orphans), verdict(path, orphans)]), [
    [[2, 3], 'in order'], [[1, 2], 'in order'], [[0, 4], 'in order'], [[4, -1], out([4, -1])], [[1, 3], 'in order'], [[1, -1], out([1, -1])],
  ]);
});

test('repairedLivePath: two bridges, in path order (the earliest first), one passing over a node already on the path (library-bridges.jsonl)', () => {
  // the head 4 hangs off 5, whose parent ...998 is in no file: livePath is [5, 4]. The bridge from 5 takes the node
  // written just before it that is not on the path: 4 is (it is the head), so 3. 3's parent ...999 is in no file
  // either: the bridge from 3 takes 2. The walk meets 5 first; the list is in path order, so 3's bridge comes first
  // (3 stands third on the path, 5 fourth).
  const t = parseTranscript(read('library-bridges.jsonl'));
  const B = (k) => uuidOf('f4000000', k);
  assert.deepEqual(repaired(t), { path: [1, 2, 3, 5, 4].map(B), from: 'leafUuid', splices: [], extension: null, compactions: [], // asserts: repairedLivePath().path repairedLivePath().bridges Bridge.orphan Bridge.via Bridge.missingParent Bridge.kind
    bridges: [[B(3), B(2), uuidOf('f4999999', 999), 'file-order'], [B(5), B(3), uuidOf('f4999999', 998), 'file-order']] });
  bridgesInPathOrder(repairedLivePath(t));
});

test('repairedLivePath: three bridges and a compaction between them, the bridges in path order, which is neither the order the walk meets them in nor their file order, nor their vias\' (crafted records)', () => {
  // File order (k = the line): 1 P, the first prompt (a root); 2 V2, a reply whose parent is 8 (written before its
  // parent); 3 O2, a reply whose parent ...2 is in no file; 4 A, a reply to 1; 5 O1, a reply whose parent ...1 is in no
  // file; 6 L, a reply to 5; 7 K, a compaction boundary (a root) whose logical parent is 6; 8 S, its summary; 9 V3, a
  // reply to 3; 10 O3, a reply whose parent ...3 is in no file; 11 H, a reply to 10, the head.
  // The walk: livePath is [10, 11]. 10 is an orphan: the node written just before it, 9, is not on the path, so
  // bridge 10 -> 9, and the path climbs 9, 3. 3 is an orphan: 2 is free, so bridge 3 -> 2, and it climbs 2, 8, 7. 7 is a
  // boundary whose logical parent 6 was written before it, is not on the path and has no child: joined at 6, which
  // climbs 6, 5. 5 is an orphan: 4 is free, so bridge 5 -> 4, and it climbs 4, 1. 1 is a root: the walk ends.
  // The path: 1 4 5 6 7 8 2 3 9 10 11. No node has two children: no splice; 7 is on the path: nothing detached.
  // The bridges in path order: 5 (third on the path), 3 (eighth), 10 (tenth). The walk met them as 10, 3, 5; their
  // orphans' file order is 3, 5, 10; their vias' (4, 2, 9) is 3, 5, 10 too: each of those orders differs from path
  // order, and a list built by one of them (or reversed at each push) fails here.
  const env = { isSidechain: false, userType: 'external', cwd: '/w', version: '2.1.319', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  const K = (k) => uuidOf('e7000000', k), M = (k) => uuidOf('e7999999', k);
  const at = (k) => `2026-08-07T09:00:${String(k).padStart(2, '0')}.000Z`;
  const reply = (k, parent) => ({ parentUuid: parent, ...env, type: 'assistant', requestId: `req_e7_${k}`, message: { id: `msg_e7_${k}`, type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: `An invented reply, ${k}.` }], stop_reason: 'end_turn' }, uuid: K(k), timestamp: at(k) });
  const t = parseTranscript(jsonl([
    { parentUuid: null, ...env, type: 'user', promptSource: 'typed', message: { role: 'user', content: 'Start the invented work.' }, uuid: K(1), timestamp: at(1) },
    reply(2, K(8)),
    reply(3, M(2)),
    reply(4, K(1)),
    reply(5, M(1)),
    reply(6, K(5)),
    { parentUuid: null, logicalParentUuid: K(6), ...env, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 7000 }, uuid: K(7), timestamp: at(7) },
    { parentUuid: K(7), ...env, type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary.' }, uuid: K(8), timestamp: at(8) },
    reply(9, K(3)),
    reply(10, M(3)),
    reply(11, K(10)),
    { type: 'last-prompt', lastPrompt: 'Start the invented work.', leafUuid: K(11), sessionId: 's' },
  ]));
  assert.deepEqual(repaired(t), { path: [1, 4, 5, 6, 7, 8, 2, 3, 9, 10, 11].map(K), from: 'leafUuid', splices: [], extension: null, // asserts: repairedLivePath().bridges Bridge.orphan Bridge.via Bridge.missingParent
    bridges: [[K(5), K(4), M(1), 'file-order'], [K(3), K(2), M(2), 'file-order'], [K(10), K(9), M(3), 'file-order']],
    compactions: [[K(7), K(6), 'compaction', 'logical-parent', K(6), 'manual', 7000, null, null]] });
  bridgesInPathOrder(repairedLivePath(t));
});

test('repairedLivePath: compactions joined by each shape: logical-parent, preserved-head and detached (compacted.jsonl, library-preserved.jsonl, library-detached.jsonl)', () => {
  // compacted.jsonl: the boundary (...20, a root) names 8, the last record before it, written before it and not on
  // the path, with no child: joined at 8. compactMetadata: trigger 'manual', preTokens 12000, no postTokens or durationMs.
  const c = parseTranscript(read('compacted.jsonl'));
  const u = (k) => uuidOf('dd000000', k);
  assert.deepEqual(repaired(c), { path: [1, 2, 3, 4, 5, 6, 7, 8, 20, 21, 9, 10, 11, 12].map(u), from: 'leafUuid', bridges: [], splices: [], extension: null, // asserts: repairedLivePath().path repairedLivePath().compactions CompactionJoin.boundary CompactionJoin.logicalParent CompactionJoin.kind CompactionJoin.via CompactionJoin.joinedAt CompactionJoin.trigger CompactionJoin.preTokens CompactionJoin.postTokens CompactionJoin.durationMs
    compactions: [[u(20), u(8), 'compaction', 'logical-parent', u(8), 'manual', 12000, null, null]] });
  // library-preserved.jsonl: the boundary (5) names 7, the kept tail, written after it and already on the path; the
  // preserved head 3 was written before it: joined at 3's last-written descendant before the boundary, 4. All four
  // compactMetadata values: auto, 150000, 30000, 45000.
  const p = parseTranscript(read('library-preserved.jsonl'));
  const C = (k) => uuidOf('f5000000', k);
  assert.deepEqual(repaired(p), { path: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(C), from: 'leafUuid', bridges: [], splices: [], extension: null, // asserts: repairedLivePath().compactions CompactionJoin.boundary CompactionJoin.logicalParent CompactionJoin.kind CompactionJoin.via CompactionJoin.joinedAt CompactionJoin.trigger CompactionJoin.preTokens CompactionJoin.postTokens CompactionJoin.durationMs
    compactions: [[C(5), C(7), 'compaction', 'preserved-head', C(4), 'auto', 150000, 30000, 45000]] });
  // library-detached.jsonl: livePath is 1, 2, 5 (the /compact command, 14:00:02), 6, 7, 8. The boundary 3 (14:00:05)
  // and its summary 4 are off it; 3's logical parent 2 is on it. They go before the first path record after 2 stamped
  // at or after 14:00:05: 5 is not (:02), 6 is (:06). So after 5, which is joinedAt. No compactMetadata: four nulls.
  const d = parseTranscript(read('library-detached.jsonl'));
  const D = (k) => uuidOf('f6000000', k);
  assert.deepEqual(repaired(d), { path: [1, 2, 5, 3, 4, 6, 7, 8].map(D), from: 'leafUuid', bridges: [], splices: [], extension: null, // asserts: repairedLivePath().compactions CompactionJoin.via CompactionJoin.joinedAt CompactionJoin.trigger CompactionJoin.preTokens CompactionJoin.postTokens CompactionJoin.durationMs
    compactions: [[D(3), D(2), 'compaction', 'detached', D(5), null, null, null, null]] });
});

test('repairedLivePath: two compactions, the earliest first: two joined by the walk, and a detached one placed before a walked one (library-compacted-twice.jsonl, library-detached-first.jsonl)', () => {
  // library-compacted-twice.jsonl: livePath is 7 (the second boundary), 8, 9, 10. The walk joins 7 at 6 (the last
  // record before it), then 3 (the first boundary) at 2: it meets the later boundary first, and lists the earlier first.
  const w = parseTranscript(read('library-compacted-twice.jsonl'));
  const G = (k) => uuidOf('fb000000', k);
  assert.deepEqual(repaired(w), { path: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(G), from: 'leafUuid', bridges: [], splices: [], extension: null, // asserts: repairedLivePath().path repairedLivePath().compactions CompactionJoin.*
    compactions: [[G(3), G(2), 'compaction', 'logical-parent', G(2), 'manual', 1000, null, null], [G(7), G(6), 'compaction', 'logical-parent', G(6), 'auto', 2000, 500, 3000]] });
  // library-detached-first.jsonl: livePath is 9 (the second boundary), 10, 11, 12; the walk joins 9 at 8, which climbs
  // through 7, 6 (Compacted), 5 (/compact, 16:00:02) and 2 to 1. Then the detached boundary 3 (16:00:05) and its summary
  // 4 go before the first path record after 2 stamped at or after 16:00:05: 6 (:06), so after 5. Found second, listed first.
  const d = parseTranscript(read('library-detached-first.jsonl'));
  const H = (k) => uuidOf('fc000000', k);
  assert.deepEqual(repaired(d), { path: [1, 2, 5, 3, 4, 6, 7, 8, 9, 10, 11, 12].map(H), from: 'leafUuid', bridges: [], splices: [], extension: null, // asserts: repairedLivePath().path repairedLivePath().compactions CompactionJoin.*
    compactions: [[H(3), H(2), 'compaction', 'detached', H(5), 'manual', 4000, null, null], [H(9), H(8), 'compaction', 'logical-parent', H(8), 'auto', 6000, null, null]] });
});

// ---- turns ----
test('turnsOf: each turn\'s prompt, records, requests and calls, a call off the path included (library-requests.jsonl)', () => {
  const t = parseTranscript(read('library-requests.jsonl'));
  // the live path: 1 to 11, then 14 and 15 (12 and 13, the second parallel call and its result, are off it).
  // Turn 1: prompt 1; records 2-9; requests in the order met: req_f2_01 (2, 3), req_f2_02 (5), msg:msg_f2_03 (9);
  //   calls 01 (2), 02 and 03 (5, block order). Turn 2: prompt 10; records 11, 14, 15; req_f2_04 (11), req_f2_05 (15);
  //   calls: req_f2_04's two, 05 included though its record (12) is off the path.
  const rows = [['toolu_f2_01', 'toolu_f2_02', 'toolu_f2_03'], ['toolu_f2_04', 'toolu_f2_05']];
  assert.deepEqual(turnRows(t, turnsOf(t, repairedLivePath(t).path)), [ // asserts: Turn.prompt Turn.records Turn.requests Turn.toolCalls
    [R(1), [2, 3, 4, 5, 6, 7, 8, 9].map(R), ['req_f2_01', 'req_f2_02', 'msg:msg_f2_03'], rows[0]],
    [R(10), [11, 14, 15].map(R), ['req_f2_04', 'req_f2_05'], rows[1]],
  ]);
});

test('turnsOf: four channels opening turns, and the path before the first prompt in no turn (library-forest.jsonl, compacted.jsonl, crafted)', () => {
  // the forest's path: 1 (typed) 2-6; 9 (typed) 10, 11 (harness:meta, a record); 12 (task) 13; 14 (peer) 15
  const t = parseTranscript(read('library-forest.jsonl'));
  const forest = [[F(1), [2, 3, 4, 5, 6].map(F), ['req_f1_01'], ['toolu_f1_01']], [F(9), [F(10), F(11)], ['req_f1_03'], []], [F(12), [F(13)], ['req_f1_04'], []], [F(14), [F(15)], ['req_f1_05'], []]];
  assert.deepEqual(turnRows(t, turnsOf(t)), forest); // asserts: Turn.prompt Turn.records Turn.requests Turn.toolCalls
  // compacted.jsonl: turnsOf(t) alone walks livePath, which starts at the boundary (...20); the boundary and the
  // summary come before the first prompt (9), so they are in no turn: one turn. With the repaired path, two.
  const c = parseTranscript(read('compacted.jsonl'));
  const u = (k) => uuidOf('dd000000', k);
  assert.deepEqual(turnRows(c, turnsOf(c)), [[u(9), [10, 11, 12].map(u), ['req_toolu_cp_04', 'req_dd000000_12'], ['toolu_cp_04']]]); // asserts: Turn.prompt Turn.records Turn.requests Turn.toolCalls
  assert.deepEqual(turnsOf(c, repairedLivePath(c).path).map((turn) => [nid(c, turn.prompt), turn.records.length]), [[u(1), 9], [u(9), 3]]); // asserts: Turn.prompt Turn.records
  // two prompts in a row: the first turn has no record
  const env = { isSidechain: false, userType: 'external', cwd: '/w', version: '2.1.319', gitBranch: 'main', entrypoint: 'cli', sessionId: 's' };
  const P1 = uuidOf('fa000000', 1), P2 = uuidOf('fa000000', 2);
  const two = parseTranscript(jsonl([
    { parentUuid: null, ...env, type: 'user', promptSource: 'typed', message: { role: 'user', content: 'one' }, uuid: P1 },
    { parentUuid: P1, ...env, type: 'user', promptSource: 'typed', message: { role: 'user', content: 'two' }, uuid: P2 },
  ]));
  assert.deepEqual(turnRows(two, turnsOf(two)), [[P1, [], [], []], [P2, [], [], []]]); // asserts: Turn.records Turn.requests Turn.toolCalls
});

test('the unparseable count leaves out a json problem whose message holds REPAIRED, as the doc says: a line that is only that word (crafted lines)', () => {
  // the premise: JSON.parse's message for the line REPAIRED quotes the line (V8 on Node 20.20.2, 22.23.3 and 26.12.1)
  assert.match(parseError('REPAIRED'), /REPAIRED/, 'JSON.parse no longer quotes the line in its message: this test\'s premise is gone');
  // two bad lines (REPAIRED, not json) and a record: 2 problems, of which only `not json` is counted
  const t = parseTranscript('REPAIRED\nnot json\n{"type":"x"}\n');
  assert.deepEqual([t.problems.map((p) => [p.line, p.reason]), t.stats.lines, t.stats.parsed, t.stats.unparseable], [[[1, 'json'], [2, 'json']], 3, 1, 1]); // asserts: TranscriptStats.unparseable
});

// ---- search's and pin's results: no member that is not declared ----
let ts = null, noTs = false;
try { ts = createRequire(import.meta.url)('typescript'); }
catch (e) { noTs = `the typescript package cannot be imported (${e?.code ?? e?.name}): npm install installs it, as a devDependency`; }

/** The declared types of the built entry points (strict, so | null and | undefined are kept), and a walk of a value
 *  against a type that lists every key the type does not declare. A union is resolved by its object member, or by the
 *  `k` its members carry as a literal; an index signature admits any key; arrays are walked element by element. */
function declaredTypes(files) {
  const program = ts.createProgram(files, { noEmit: true, strict: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  const exported = new Map();
  for (const f of files) {
    const mod = checker.getSymbolAtLocation(program.getSourceFile(f));
    assert.ok(mod, `${f} is not a module the typescript package reads`);
    for (const s of checker.getExportsOfModule(mod)) exported.set(s.name, s);
  }
  /** What a function resolves to: its return type, awaited. */
  const returns = (name) => {
    const s = exported.get(name);
    assert.ok(s, `${name} is not exported by ${files.join(' or ')}`);
    const sig = checker.getSignaturesOfType(checker.getTypeOfSymbol(s), ts.SignatureKind.Call)[0];
    return checker.getAwaitedType(checker.getReturnTypeOfSignature(sig));
  };
  const extra = (value, type, path, out = [], seen = new Set()) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return out;
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return out;
    seen.add(value);
    if (type.isUnion()) {
      const objects = type.types.filter((u) => (u.flags & ts.TypeFlags.Object) !== 0);
      const byK = (u) => { const k = u.getProperty('k'), kt = k && checker.getTypeOfSymbol(k); return kt?.isStringLiteral() && kt.value === value.k; };
      const pick = objects.length === 1 ? objects[0] : objects.find(byK);
      if (!pick) { out.push({ member: `${checker.typeToString(type)}, by its keys ${JSON.stringify(Object.keys(value))}`, at: path }); return out; }
      type = pick;
    }
    if (Array.isArray(value)) {
      const element = type.getNumberIndexType();
      if (!element) out.push({ member: `an array where ${checker.typeToString(type)} is declared`, at: path });
      else value.forEach((x, i) => extra(x, element, `${path}[${i}]`, out, seen));
      return out;
    }
    const members = new Map(checker.getPropertiesOfType(type).map((p) => [p.name, checker.getTypeOfSymbol(p)]));
    const index = type.getStringIndexType();
    for (const [key, x] of Object.entries(value)) {
      const t = members.get(key) ?? index;
      if (!t) out.push({ member: `${checker.typeToString(type)}.${key}`, at: `${path}.${key}` });
      else extra(x, t, `${path}.${key}`, out, seen);
    }
    return out;
  };
  return { returns, extra };
}

test('search\'s and pin\'s results: every object holds only the members its declared type names, so a member added in code fails here until it is declared (and so documented)', { skip: noTs }, async () => {
  const dir = dirname(LIB);
  const lib = await import(pathToFileURL(LIB).href), pin = await import(pathToFileURL(join(dir, 'pin.js')).href);
  const { returns, extra } = declaredTypes([join(dir, 'index.d.ts'), join(dir, 'pin.d.ts')]);
  const found = [], seen = new Map();
  const check = (fn, value) => { seen.set(fn, (seen.get(fn) ?? 0) + 1); found.push(...extra(value, returns(fn), fn)); return value; };
  // search: 'the' is in 4 turns of demo.jsonl and in 3 of search-kinds.jsonl, in 8 of its 9 kinds
  check('parseSearchQuery', lib.parseSearchQuery('the "make demo" "unbalanced'));
  const q = check('parseSearchQuery', lib.parseSearchQuery('the'));
  check('tokenizeForSearch', lib.tokenizeForSearch('the invented demo'));
  check('checkSearchSupport', lib.checkSearchSupport());
  for (const f of ['demo.jsonl', 'search-kinds.jsonl']) {
    const r = check('searchTranscript', lib.searchTranscript(read(f), q, { prefix: 'p', kinds: lib.SEARCH_KINDS }));
    assert.ok(r.turns.some((h) => h.entries.length > 0), `${f} gave no hit: the check would see no SearchTurnHit or SearchEntry`);
  }
  // pin: a refusal, two pins (new, then grown), a check, and a busy lock, in a temporary tree
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ltms-library-')));
  try {
    const config = join(tmp, 'claude'), root = join(config, 'projects'), to = join(tmp, 'pins'), project = join(root, '-w');
    const session = join(project, '0b0b0b0b-0000-4000-8000-000000000001.jsonl');
    mkdirSync(project, { recursive: true });
    writeFileSync(session, '{"type":"x","text":"an invented line"}\n');
    assert.equal(check('pinPaths', await pin.pinPaths([], { to, configDir: config })).k, 'refused');
    assert.equal(check('pinPaths', await pin.pinPaths([root], { to, configDir: config })).k, 'pinned');
    appendFileSync(session, '{"type":"y","text":"another invented line"}\n');
    const grown = check('pinPaths', await pin.pinPaths([root], { to, configDir: config }));
    assert.deepEqual([grown.k, grown.coverage.files.grown], ['pinned', 1]);
    assert.equal(check('checkPin', await pin.checkPin(to)).k, 'checked');
    // a lock held by a live process on this host (the one that started this test), as test/pin.test.mjs plants it
    writeFileSync(join(to, '.ltms-pin.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), started: '2026-11-08T10:00:00.000Z' }), { mode: 0o600 });
    assert.equal(check('pinPaths', await pin.pinPaths([root], { to, configDir: config, lockWaitMs: 50 })).k, 'busy');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  assert.deepEqual(Object.fromEntries(seen), { parseSearchQuery: 2, tokenizeForSearch: 1, checkSearchSupport: 1, searchTranscript: 2, pinPaths: 4, checkPin: 1 });
  // one line per undeclared member, with the first place it was seen and how many more
  // (Map.groupBy is not in Node 20)
  const byMember = new Map();
  for (const f of found) byMember.set(f.member, [...(byMember.get(f.member) ?? []), f.at]);
  const lines = [...byMember].map(([member, at]) => `${member} (at ${at[0]}${at.length > 1 ? `, and ${at.length - 1} more` : ''})`);
  assert.deepEqual(lines, [], 'members the code returns that the declarations do not name: declare each (src/search.ts, src/pin.ts), give it a row in docs/library.md, and assert its value');
});

// ---- the fixtures: what test/make-fixtures.mjs writes ----
let generated;
/** The generator run once into a temporary directory: the name and bytes of each file it writes. */
function generate() {
  generated ??= (() => {
    const out = mkdtempSync(join(tmpdir(), 'ltms-fixtures-'));
    try {
      const r = spawnSync(process.execPath, [join(here, 'make-fixtures.mjs'), out], { encoding: 'utf8', timeout: 60000 });
      assert.equal(r.status, 0, `node test/make-fixtures.mjs ${out} exited ${r.status ?? r.error?.code}: ${r.stderr}`);
      return new Map(readdirSync(out).sort().map((f) => [f, readFileSync(join(out, f))]));
    } finally { rmSync(out, { recursive: true, force: true }); }
  })();
  return generated;
}

test('the fixtures: every file test/make-fixtures.mjs writes is, byte for byte, the one in test/fixtures', () => {
  // the expected values here are worked out from each fixture as its generator builds it, so the two must not drift
  const made = generate();
  assert.ok(made.size >= 44, `the generator wrote ${made.size} files`);
  const differ = [...made].filter(([f, bytes]) => { try { return !bytes.equals(readFileSync(fixturePath(f))); } catch { return true; } }).map(([f]) => f);
  assert.deepEqual(differ, [], 'generated fixtures that differ from test/fixtures, or are not there: run node test/make-fixtures.mjs test/fixtures, or correct the generator');
});

test('the fixtures: test/make-fixtures.mjs\'s header names every fixture it writes, by its name or its family (library-*)', () => {
  const src = readFileSync(join(here, 'make-fixtures.mjs'), 'utf8');
  const header = src.slice(0, src.search(/^import /m));
  // a file is named by its name up to the first dot (lexer.expected.json is lexer's), or by its family: library-*
  const named = (f) => {
    const base = f.slice(0, f.indexOf('.'));
    if (new RegExp(`(^|[\\s(,;])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s),;.]|$)`).test(header)) return true;
    const family = /^([a-z]+)-/.exec(base)?.[1];
    return family !== undefined && header.includes(`${family}-*`);
  };
  assert.deepEqual([...generate().keys()].filter((f) => !named(f)), [], 'fixtures the header comment of test/make-fixtures.mjs does not name');
});

// ---- edges no fixture reached: today's behaviour, pinned (their rows in docs/library.md say it) ----
test('the census: a key written as null is not counted, in each census map, as a missing one is not (crafted records)', () => {
  // bump() returns at undefined and null alike; a key that is not a string (the number 7) counts under NOT_A_STRING.
  // byType: assistant, system, attachment once each, 7 once; the record whose type is null, not at all.
  // byBlockType: the block whose type is null is not counted; tool_use once. byToolName: its name is null: {}.
  const t = parseTranscript(jsonl([
    { type: null, note: 'a record whose type is null' },
    { parentUuid: null, uuid: uuidOf('fe000000', 1), sessionId: 's', type: 'assistant', requestId: 'q', message: { id: 'm', role: 'assistant', content: [{ type: null }, { type: 'tool_use', id: 'toolu_fe', name: null, input: {} }] } },
    { parentUuid: uuidOf('fe000000', 1), uuid: uuidOf('fe000000', 2), sessionId: 's', type: 'system', subtype: null },
    { parentUuid: uuidOf('fe000000', 2), uuid: uuidOf('fe000000', 3), sessionId: 's', type: 'attachment', attachment: { type: null } },
    { type: 7, note: 'a record whose type is a number' },
  ]));
  const s = t.stats;
  assert.deepEqual([s.byType, s.byBlockType, s.byToolName, s.bySystemSubtype, s.byAttachmentType],
    [{ assistant: 1, system: 1, attachment: 1, '(not a string)': 1 }, { tool_use: 1 }, {}, {}, {}]); // asserts: TranscriptStats.byType TranscriptStats.byBlockType TranscriptStats.byToolName TranscriptStats.bySystemSubtype TranscriptStats.byAttachmentType
});

test('CompactionJoin: a compactMetadata value of 0 or \'\' is kept as written; only a missing or null one is null (library-preserved.jsonl, edited)', () => {
  // library-preserved.jsonl's boundary writes trigger auto, preTokens 150000, postTokens 30000 and durationMs 45000
  // (the test above); written as '', 0, 0 and 0 instead, each is kept (the code reads them with ??, not ||)
  const written = '"trigger":"auto","preTokens":150000,"postTokens":30000,"durationMs":45000';
  const text = read('library-preserved.jsonl');
  assert.equal(text.split(written).length, 2, 'library-preserved.jsonl no longer writes the four values once: this test needs another way in');
  const zero = repairedLivePath(parseTranscript(text.replace(written, '"trigger":"","preTokens":0,"postTokens":0,"durationMs":0'))).compactions;
  assert.deepEqual(zero.map((c) => [c.trigger, c.preTokens, c.postTokens, c.durationMs]), [['', 0, 0, 0]]); // asserts: CompactionJoin.trigger CompactionJoin.preTokens CompactionJoin.postTokens CompactionJoin.durationMs
  const nulls = repairedLivePath(parseTranscript(text.replace(written, '"trigger":null,"preTokens":null,"postTokens":null,"durationMs":null'))).compactions;
  assert.deepEqual(nulls.map((c) => [c.trigger, c.preTokens, c.postTokens, c.durationMs]), [[null, null, null, null]]); // asserts: CompactionJoin.trigger CompactionJoin.preTokens CompactionJoin.postTokens CompactionJoin.durationMs
  // a detached join reads them in its own place: library-detached-first.jsonl's detached boundary (3) writes manual and
  // 4000, its walked one (9) auto and 6000 (the test above); the detached one's written as '', 0, 0 and 0 instead
  const first = read('library-detached-first.jsonl'), detached = '"compactMetadata":{"trigger":"manual","preTokens":4000}';
  assert.equal(first.split(detached).length, 2, 'library-detached-first.jsonl no longer writes manual and 4000 once: this test needs another way in');
  const d = repairedLivePath(parseTranscript(first.replace(detached, '"compactMetadata":{"trigger":"","preTokens":0,"postTokens":0,"durationMs":0}'))).compactions;
  assert.deepEqual(d.map((c) => [c.via, c.trigger, c.preTokens, c.postTokens, c.durationMs]), [['detached', '', 0, 0, 0], ['logical-parent', 'auto', 6000, null, null]]); // asserts: CompactionJoin.trigger CompactionJoin.preTokens CompactionJoin.postTokens CompactionJoin.durationMs
});

test('TranscriptStats.firstTimestamp: an empty-string timestamp is read in file order, as the row says (crafted records)', () => {
  // the rule in parseTranscript: a first timestamp that is unset OR EMPTY is replaced by the next string; otherwise a
  // smaller one replaces it. So an empty one replaces anything before it and is replaced by the next string after it.
  // The last timestamp is the largest string, '' only when every one is '' (nothing is smaller than '').
  const T1 = '2026-08-05T10:00:01.000Z', T2 = '2026-08-05T10:00:02.000Z';
  const stamps = (...ts) => { const s = parseTranscript(jsonl(ts.map((timestamp) => ({ type: 'x', timestamp })))).stats; return [s.firstTimestamp, s.lastTimestamp]; };
  assert.deepEqual([stamps('', T1), stamps(T1, ''), stamps(T1, '', T2), stamps(''), stamps(T2, T1)],
    [[T1, T1], ['', T1], [T2, T2], ['', ''], [T1, T2]]); // asserts: TranscriptStats.firstTimestamp TranscriptStats.lastTimestamp
});
