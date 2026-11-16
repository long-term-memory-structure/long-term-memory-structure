// Tests for ltms records (0.3.0), run against the built dist/cli.js (build first). Every record's address is recomputed
// here by another route (the file's bytes split and hashed in this file), every fixture of the package must balance,
// and a synthetic transcript holds one record of each kind of the draft's section 13, its texts planted with markers
// that must never reach the output (D2: content by address).
//
// LTMS_DIST=<a dist directory> runs the same tests against another build (a mutation check).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync, writeSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DIST = process.env.LTMS_DIST || join(root, 'dist');
const CLI = join(DIST, 'cli.js');
const run = (...args) => spawnSync(process.execPath, [CLI, 'records', ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
const lines = (s) => s.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const prefixOf = (f) => { const n = basename(f); return n.startsWith('agent-') ? `agent-${n.slice(6, 14)}` : n.slice(0, 8); };
const tmp = () => mkdtempSync(join(tmpdir(), 'ltms-records-'));

/** The lines of a file by this file's own route: every newline-terminated line, and a last one without a newline. */
function spansOf(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { out.push([start, i]); start = i + 1; }
  if (start < buf.length) out.push([start, buf.length]);
  return out;
}
/** Every record's address against the file's bytes, recomputed here; the header's counts; the ids and the order. */
function checkAgainstBytes(file, outText) {
  const buf = readFileSync(file);
  const [header, ...recs] = lines(outText);
  const spans = spansOf(buf);
  const terminated = buf.length && buf[buf.length - 1] !== 10 ? spans.length - 1 : spans.length;
  assert.equal(header.format, 'ltms-records/0', file);
  assert.equal(header.kind, 'header', file);
  assert.deepEqual([header.source.bytes, header.source.lines, header.source.last_line_unterminated], [buf.length, terminated, terminated !== spans.length], file);
  assert.equal(header.content, 'by-address', file);
  assert.equal(recs.length, spans.length, `${file}: one record per line`);
  const pre = prefixOf(file);
  recs.forEach((r, i) => {
    const [a, b] = spans[i];
    assert.equal(r.id, `${pre}:L${i + 1}`, file);
    assert.equal(r.order, i + 1, file);
    assert.deepEqual(r.src, { kind: 'line', line: i + 1, offset: a, bytes: b - a, sha256: createHash('sha256').update(buf.subarray(a, b)).digest('hex') }, `${file}:L${i + 1}`);
  });
  return { header, recs };
}

test('records: every fixture of the package balances, and every record\'s address reads back from the file\'s bytes', () => {
  const dirs = [join(here, 'fixtures'), join(here, 'shapes-fixtures')];
  let files = 0, records = 0;
  for (const d of dirs) for (const n of readdirSync(d).filter((x) => x.endsWith('.jsonl')).sort()) {
    const f = join(d, n);
    const r = run(f);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    const { recs } = checkAgainstBytes(f, r.stdout);
    assert.match(r.stderr, new RegExp(`^ltms records: '${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}': ${recs.length} lines? read`), f);
    files++; records += recs.length;
  }
  assert.ok(files >= 40 && records > 500, `${files} files, ${records} records`);
});

// one record of every kind of section 13, its texts planted with markers that must not reach the output
const MARK = (k) => `zqtext${k}zq`;
function synthetic(dir) {
  const L = [];
  const env = (uuid, parentUuid, extra) => ({ uuid, parentUuid, sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', version: '2.1.300', isSidechain: false, ...extra });
  L.push({ type: 'permission-mode', permissionMode: MARK('pm') });                                                                  // 1 other (sidecar)
  L.push(env('u1', null, { type: 'user', message: { role: 'user', content: MARK('prompt') }, promptSource: 'typed' }));               // 2 input, root
  L.push(env('u2', 'u1', { type: 'assistant', requestId: 'req_1', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: MARK('think') }] } }));  // 3 thinking
  L.push(env('u3', 'u2', { type: 'assistant', requestId: 'req_1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: MARK('reply') }] } }));          // 4 reply
  L.push(env('u4', 'u3', { type: 'assistant', requestId: 'req_1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: MARK('cmd') } }] } }));  // 5 tool call
  L.push(env('u5', 'u4', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: MARK('out') }] }, toolUseResult: { stdout: MARK('stdout') } }));  // 6 tool result
  L.push(env('u6', 'u5', { type: 'user', message: { role: 'user', content: MARK('meta') }, isMeta: true }));                         // 7 system (harness:meta)
  L.push(env('u7', 'u6', { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: MARK('queued') } }));  // 8 input (queued prompt)
  L.push(env('u8', 'u7', { type: 'attachment', attachment: { type: 'hook_success', content: MARK('hook') } }));                      // 9 context
  L.push(env('u9', 'u8', { type: 'system', subtype: 'stop_hook_summary', content: MARK('sys') }));                                    // 10 system
  L.push(env('u10', 'u9', { type: 'system', subtype: 'compact_boundary', content: MARK('boundary'), logicalParentUuid: 'u9' }));     // 11 compaction
  L.push(env('u11', 'u10', { type: 'user', message: { role: 'user', content: MARK('summary') }, isCompactSummary: true }));          // 12 summary
  L.push(env('u12', 'u11', { type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: MARK('apierr') }] } }));  // 13 system
  L.push(env('u13', 'u12', { type: 'assistant', requestId: 'req_2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: MARK('two1') }, { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: MARK('path') } }] } }));  // 14 reply, kinds
  L.push(env('u14', 'nowhere', { type: 'user', message: { role: 'user', content: MARK('orphan') }, promptSource: 'typed' }));        // 15 input, parent not in the file
  L.push(env('u3', 'u2', { type: 'assistant', requestId: 'req_1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: MARK('reply') }] } }));          // 16 reply, a replay of line 4
  L.push(env('u15', 'u16', { type: 'user', message: { role: 'user', content: MARK('child') }, promptSource: 'typed' }));            // 17 input, its parent written after it
  L.push(env('u16', 'u14', { type: 'user', message: { role: 'user', content: MARK('late') }, promptSource: 'typed' }));             // 18 input
  L.push({ type: 'last-prompt', leafUuid: 'u16', sessionId: 's1' });                                                                 // 19 marker
  L.push({ type: 'ai-title', aiTitle: MARK('title'), sessionId: 's1' });                                                             // 20 other
  const text = L.map((x) => JSON.stringify(x)).join('\n') + '\n' + '   \n' + `{"type":"user","message":"${MARK('torn')}` + '\n' + '[1,2,3]\n' + `{"type":"user","uuid":"u17","parentUuid":"u16","message":{"content":"${MARK('crlf')}"},"promptSource":"typed"}\r\n` + `{"type":"ai-title","aiTitle":"${MARK('last')}"}`;
  //  21 blank · 22 malformed (not JSON) · 23 malformed (not an object) · 24 input, CRLF · 25 context (a queued command
  //  of another mode) · 26 other, a byte that is not UTF-8 in its text (its sha256 is of the bytes) · 27 other, no newline
  const cut = text.lastIndexOf('\n') + 1;
  const queued = JSON.stringify(env('u18', 'u17', { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'bash', prompt: MARK('bash') } })) + '\n';
  const notUtf8 = Buffer.concat([Buffer.from('{"type":"ai-title","aiTitle":"' + MARK('ff')), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]);
  const f = join(dir, '12345678-aaaa-4bbb-8ccc-123456789012.jsonl');
  writeFileSync(f, Buffer.concat([Buffer.from(text.slice(0, cut)), Buffer.from(queued), notUtf8, Buffer.from(text.slice(cut))]));
  return f;
}

test('records: the kinds of section 13, the parents, the replay, the group, and no text', () => {
  const d = tmp(), f = synthetic(d);
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const { header, recs } = checkAgainstBytes(f, r.stdout);
  const want = ['other', 'input', 'thinking', 'reply', 'tool call', 'tool result', 'system', 'input', 'context', 'system', 'compaction', 'summary', 'system', 'reply', 'input', 'reply', 'input', 'input', 'marker', 'other', 'blank', 'malformed', 'malformed', 'input', 'context', 'other', 'other'];
  assert.deepEqual(recs.map((x) => x.kind), want);
  assert.deepEqual(recs[13].kinds, ['reply', 'tool call']);
  const P = '12345678';
  assert.deepEqual(recs.map((x) => [x.parent, x.parent_by]), [
    [null, 'none'], [null, 'supplied'], [`${P}:L2`, 'supplied'], [`${P}:L3`, 'supplied'], [`${P}:L4`, 'supplied'], [`${P}:L5`, 'supplied'], [`${P}:L6`, 'supplied'],
    [`${P}:L7`, 'supplied'], [`${P}:L8`, 'supplied'], [`${P}:L9`, 'supplied'], [`${P}:L10`, 'supplied'], [`${P}:L11`, 'supplied'], [`${P}:L12`, 'supplied'], [`${P}:L13`, 'supplied'],
    [null, 'supplied'], [`${P}:L3`, 'supplied'], [`${P}:L18`, 'supplied'], [`${P}:L15`, 'supplied'], [null, 'none'], [null, 'none'], [null, 'none'], [null, 'none'], [null, 'none'], [`${P}:L18`, 'supplied'], [`${P}:L24`, 'supplied'], [null, 'none'], [null, 'none'],
  ]);
  assert.equal(recs[14].supplier.parent, 'nowhere', 'a parent not in the file shows in supplier.parent');
  assert.equal(recs[1].supplier.parent, null, 'a root');
  assert.equal(recs[15].dup_of, `${P}:L4`, 'a replay names the first record with its uuid');
  assert.equal(recs.filter((x) => x.dup_of).length, 1);
  assert.deepEqual([recs[2].group, recs[3].group, recs[4].group, recs[13].group], ['req_1', 'req_1', 'req_1', 'req_2']);
  assert.deepEqual([recs[9].supplier.subtype, recs[8].supplier.subtype, recs[7].supplier.subtype, recs[24].supplier.subtype], ['stop_hook_summary', 'hook_success', 'queued_command', 'queued_command']);
  assert.deepEqual(recs[1].time, { as_written: '2026-01-01T00:00:00.000Z', utc: '2026-01-01T00:00:00.000Z', kind: 'stamped' });
  assert.deepEqual(header.supplier, { name: 'claude-code', versions: ['2.1.300'] });
  assert.equal(header.source.last_line_unterminated, true);
  assert.equal(recs[23].src.bytes, readFileSync(f).subarray(recs[23].src.offset).indexOf(10), 'a CRLF line\'s length counts its carriage return');
  // no text: not one planted marker, anywhere in the output
  assert.doesNotMatch(r.stdout, /zqtext/, 'a text of the transcript in the records');
  assert.doesNotMatch(r.stderr, /zqtext/);
  // the balance line
  assert.match(r.stderr, /: 27 lines read \(the last without a newline\), 27 records written \(6 input, 3 reply, 1 thinking, 1 tool call, 1 tool result, 3 system, 2 context, 1 summary, 1 compaction, 1 marker, 4 other, 1 blank, 2 malformed\); 1 repeating an earlier record's uuid; parents: 17 in the file, 1 root, 1 not in this file, 8 outside the tree; links: 3 in the file, 0 not in this file\.$/m);
  rmSync(d, { recursive: true });
});

test('records: an empty file is a header and no record; a file of one line with no newline is one record', () => {
  const d = tmp();
  const e = join(d, 'empty.jsonl'); writeFileSync(e, '');
  let r = run(e);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r.stdout).length, 1);
  assert.deepEqual([lines(r.stdout)[0].source.lines, lines(r.stdout)[0].source.last_line_unterminated], [0, false]);
  assert.match(r.stderr, /: 0 lines read, 0 records written; /);
  const one = join(d, 'one.jsonl'); writeFileSync(one, '{"type":"x"}');
  r = run(one);
  assert.equal(r.status, 0, r.stderr);
  checkAgainstBytes(one, r.stdout);
  assert.match(r.stderr, /: 1 line read \(the last without a newline\), 1 record written \(1 other\); /);
  rmSync(d, { recursive: true });
});

test('records: usage errors exit 2 and name the fix; a file that cannot be read exits 1; --help is its whole part', () => {
  const d = tmp();
  for (const [args, re] of [[[], /give one transcript \(none was given\)/], [['a.jsonl', 'b.jsonl'], /give one transcript \(2 were given\)/], [[d], /is a directory; records reads one transcript\. For a folder: mkdir -p records; \( .* for f in /], [['-'], /reading from standard input/], [['--frobnicate', 'x.jsonl'], /unknown option '--frobnicate'/]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
    assert.doesNotMatch(r.stderr, /> "\$f\.records|\.claude\/projects\/[^ ]*\.records/, 'never advises writing beside the transcripts');
  }
  const r = run(join(d, 'missing.jsonl'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read .*missing\.jsonl': no such file or directory/);
  const h = run('--help');
  assert.equal(h.status, 0);
  for (const w of ['ltms-records/0', 'last_line_unterminated', 'parent_by', 'dup_of', 'by-address', 'compaction', 'context', 'malformed', 'Exit status']) assert.ok(h.stdout.includes(w), w);
  assert.match(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' '), /ltms records --help gives its whole part/);
  rmSync(d, { recursive: true });
});

test('records: the same bytes give the same records, but the time read', () => {
  const d = tmp(), f = synthetic(d);
  const strip = (s) => s.replace(/"read_at":"[^"]*"/, '"read_at":""');
  assert.equal(strip(run(f).stdout), strip(run(f).stdout));
  rmSync(d, { recursive: true });
});

// ---- S375: the file is read in pieces, twice (once for its links and versions, once for its records), never whole ----

/** The first line of a file, read alone (a records file can be large). */
function firstLineOf(file) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(64 << 10); const n = readSync(fd, b, 0, b.length, 0); const s = b.subarray(0, n).toString('utf8'); return JSON.parse(s.slice(0, s.indexOf('\n'))); }
  finally { closeSync(fd); }
}
/** Runs records on a file with its stdout written to a file beside it: [status, stderr, the output's path]. */
function runToFile(file, nodeArgs = []) {
  const outPath = file + '.records';
  const fd = openSync(outPath, 'w');
  try {
    const r = spawnSync(process.execPath, [...nodeArgs, CLI, 'records', file], { encoding: 'utf8', stdio: ['ignore', fd, 'pipe'], timeout: 600000 });
    return [r.status, r.stderr, outPath, r.signal];
  } finally { closeSync(fd); }
}

test('records (S375): a transcript is read in pieces, never whole: 64 MB of records under a heap of 40 MB (it once held the file and every line parsed: 3.6 GiB for 1 GB)', () => {
  const d = tmp(), f = join(d, 'big.jsonl');
  const demo = readFileSync(join(here, 'fixtures', 'demo.jsonl'));
  const copies = Math.ceil((64 << 20) / demo.length);
  const fd = openSync(f, 'w');
  for (let i = 0; i < copies; i++) writeSync(fd, demo);
  closeSync(fd);
  const [status, stderr, out, signal] = runToFile(f, ['--max-old-space-size=40']);
  assert.equal(status, 0, `status ${status}, signal ${signal}: ${stderr.slice(0, 400)}`);
  const n = copies * 37;
  assert.match(stderr, new RegExp(`: ${n} lines read, ${n} records written `));
  const h = firstLineOf(out);
  assert.deepEqual([h.source.bytes, h.source.lines, h.source.last_line_unterminated], [copies * demo.length, n, false]);
  rmSync(d, { recursive: true });
});

test('records (S375): a FIFO is refused at once (records reads a file twice), never waited on', { skip: process.platform === 'win32' && 'no mkfifo' }, (t) => {
  const d = tmp(), f = join(d, 'pipe.jsonl');
  const m = spawnSync('mkfifo', [f]);
  if (m.status !== 0) { t.skip('mkfifo is not available here'); rmSync(d, { recursive: true }); return; }
  const r = spawnSync(process.execPath, [CLI, 'records', f], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2, `status ${r.status}, signal ${r.signal}: ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /is not a regular file/);
  assert.match(r.stderr, /cat .* > /, 'the fix: copy it to a file');
  rmSync(d, { recursive: true });
});

test('records (S375): the module gives the same records from chunks of any size, and refuses two reads that differ', async () => {
  const R = await import(pathToFileURL(join(DIST, 'records.js')).href);
  assert.equal(typeof R.writeRecords, 'function', 'records.js exports writeRecords(read, size, options, write, chunkBytes)');
  const d = tmp(), f = synthetic(d), bytes = readFileSync(f);
  const o = { prefix: '12345678', path: f, readAt: '2026-01-01T00:00:00.000Z', converterVersion: '0.0.0' };
  const readerOf = (passes) => { let pass = -1; return (buf, pos) => { if (pos === 0) pass++; const src = passes[Math.min(pass, passes.length - 1)]; return src.copy(buf, 0, pos, Math.min(pos + buf.length, src.length)); }; };
  const runWith = (chunk, passes = [bytes], size = bytes.length) => { let text = ''; const r = R.writeRecords(readerOf(passes), size, o, (s) => { text += s; }, chunk); return { text, r }; };
  const want = runWith(1 << 20);
  assert.equal(want.r.changed, null);
  assert.equal(want.text, run(f).stdout.replace(/^.*\n/, (h) => JSON.stringify({ ...JSON.parse(h), source: { ...JSON.parse(h).source, path: f, read_at: o.readAt }, converter: { name: 'ltms', version: '0.0.0' } }) + '\n'), 'the module writes what the command prints');
  for (const chunk of [1, 2, 3, 5, 7, 64, 4096]) assert.equal(runWith(chunk).text, want.text, `chunks of ${chunk} bytes`);
  // a byte changed between the two reads: refused
  const flipped = Buffer.from(bytes); flipped[100] ^= 1;
  assert.match(String(runWith(7, [bytes, flipped]).r.changed), /changed between the two reads/);
  // the file shorter at the second read than at the first: refused
  assert.match(String(runWith(1 << 20, [bytes, bytes.subarray(0, bytes.length - 10)]).r.changed), /shrank/);
  // the file grown since it was opened: only the bytes it had then are read, twice, and nothing is refused (at small
  // chunks too: a chunk of 1 MiB is cut to the file's size, so only a small one can read past it)
  const grown = Buffer.concat([bytes, Buffer.from('{"type":"late"}\n')]);
  for (const chunk of [7, 1 << 20]) {
    const g = runWith(chunk, [grown, grown], bytes.length);
    assert.equal(g.r.changed, null, `chunks of ${chunk}`);
    assert.equal(g.text, want.text, `chunks of ${chunk}`);
  }
  rmSync(d, { recursive: true });
});

test('records (S375): a transcript of more than 2 GiB is converted (readFileSync refused it), in bounded memory',
  { skip: !process.env.LTMS_HEAVY && 'set LTMS_HEAVY=1 to run: it writes a file of about 2.2 GB and its records' }, () => {
  const d = tmp(), f = join(d, 'huge.jsonl');
  const demo = readFileSync(join(here, 'fixtures', 'demo.jsonl'));
  const copies = Math.ceil((2.05 * 1024 ** 3) / demo.length);
  const fd = openSync(f, 'w');
  for (let i = 0; i < copies; i++) writeSync(fd, demo);
  closeSync(fd);
  const [status, stderr, out, signal] = runToFile(f, ['--max-old-space-size=64']);
  assert.equal(status, 0, `status ${status}, signal ${signal}: ${stderr.slice(0, 400)}`);
  const n = copies * 37;
  assert.match(stderr, new RegExp(`: ${n} lines read, ${n} records written `));
  assert.equal(firstLineOf(out).source.bytes, copies * demo.length);
  rmSync(d, { recursive: true });
});

test('records (S375): a line too long for this Node to read as a string stops the command with its line and length, not as a bug',
  { skip: !process.env.LTMS_HEAVY && 'set LTMS_HEAVY=1 to run: it writes a line of about 600 MB and needs about 2 GB of memory' }, () => {
  const d = tmp(), f = join(d, 'long.jsonl');
  const fd = openSync(f, 'w');
  writeSync(fd, '{"type":"user","message":"');
  const piece = Buffer.alloc(1 << 20, 0x61);
  for (let i = 0; i < 600; i++) writeSync(fd, piece);
  writeSync(fd, '"}\n{"type":"x"}\n');
  closeSync(fd);
  const [status, stderr] = runToFile(f);
  assert.equal(status, 1, stderr);
  assert.match(stderr, /line 1 is \d+ bytes, longer than this Node can read as a string/);
  assert.doesNotMatch(stderr, /a bug in ltms/);
  rmSync(d, { recursive: true });
});

test('records (S375): through the command, a file that changes between its two reads exits 1, and stderr says the records are not a view of it', () => {
  const d = tmp(), f = synthetic(d);
  // a module loaded before the command: it flips one byte of the second read's first piece, as a file rewritten in
  // place between the two reads would read
  const flip = join(d, 'flip.mjs');
  writeFileSync(flip, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const readSync = fs.readSync; let starts = 0;',
    'fs.readSync = (fd, buf, off, len, pos) => { if (pos === 0) starts++; const n = readSync(fd, buf, off, len, pos); if (starts === 2 && pos === 0 && n > 100) buf[off + 100] ^= 1; return n; };',
    'syncBuiltinESMExports();',
  ].join('\n'));
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(flip).href, CLI, 'records', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 1, `status ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /the file changed between the two reads \(its first \d+ bytes differ\), so the records written are not a view of it\. Run it again\./);
  rmSync(d, { recursive: true });
});

test('records (S375): what a record says as the file wrote it prints only when it passes the label rule, else (withheld), as every command prints a label (README, Privacy)', () => {
  const d = tmp(), f = join(d, 'abcdefgh-odd.jsonl');
  const odd = (k) => `zq odd ${k} with spaces / and a slash`;
  const long = 'u'.repeat(65);
  const L = [
    { type: odd('type'), uuid: 'v1', parentUuid: null, version: odd('version'), timestamp: odd('time') },
    { type: 'system', subtype: odd('subtype'), uuid: long, parentUuid: odd('parent'), version: '2.1.300', timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'assistant', uuid: 'v3', parentUuid: 'v1', requestId: odd('group'), message: { content: [{ type: 'text', text: 'x' }] } },
    { type: 'attachment', uuid: 'v4', parentUuid: 'v3', attachment: { type: odd('attachment') } },
    { type: 'user', uuid: 'v5', parentUuid: long, message: { content: 'y' }, promptSource: 'typed' },
  ];
  writeFileSync(f, L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /zq odd|u{65}/, 'a value that fails the label rule, printed as written');
  const [h, ...recs] = lines(r.stdout);
  assert.deepEqual(h.supplier.versions, ['2.1.300', '(withheld)']);
  assert.deepEqual([recs[0].supplier.type, recs[0].supplier.version, recs[0].time.as_written, recs[0].time.utc], ['(withheld)', '(withheld)', '(withheld)', undefined]);
  assert.deepEqual([recs[1].supplier.subtype, recs[1].supplier.id, recs[1].supplier.parent], ['(withheld)', '(withheld)', '(withheld)']);
  assert.deepEqual([recs[2].group, recs[3].supplier.subtype], ['(withheld)', '(withheld)']);
  // links are made from the values as written, and print as addresses
  assert.equal(recs[2].parent, 'abcdefgh:L1');
  assert.equal(recs[4].parent, 'abcdefgh:L2', 'a parent whose uuid is withheld is still found, by its address');
  assert.equal(recs[4].supplier.parent, '(withheld)');
  rmSync(d, { recursive: true });
});

test("records (S375): the label rule in dist/records.js is dist/cli.js's", () => {
  const rule = (f) => /^const LABEL = (\/.+\/[a-z]*);$/m.exec(readFileSync(join(DIST, f), 'utf8'))?.[1];
  assert.ok(rule('cli.js'), 'dist/cli.js has a LABEL');
  assert.equal(rule('records.js'), rule('cli.js'));
});

test("records (S375): README: its section's example lines are what the command prints (the header's path and read_at aside), its stderr line too, and it names every field and every kind", async () => {
  const R = await import(pathToFileURL(join(DIST, 'records.js')).href);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('### `ltms records');
  assert.ok(start >= 0, 'the README has no section on records');
  const section = readme.slice(start, Math.min(...['\n### ', '\n## '].map((m) => readme.indexOf(m, start + 1)).filter((i) => i > 0)));
  const r = spawnSync(process.execPath, [CLI, 'records', 'test/fixtures/demo.jsonl'], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 0, r.stderr);
  const norm = (l) => { const o = JSON.parse(l); if (o.kind === 'header') { o.source.path = '(path)'; o.source.read_at = '(time)'; } return JSON.stringify(o); };
  const printed = new Set(r.stdout.split('\n').filter(Boolean).map(norm));
  const examples = section.split('\n').filter((l) => l.startsWith('{"format":') || l.startsWith('{"id":'));
  assert.ok(examples.length >= 4, `only ${examples.length} example lines in the section`);
  for (const l of examples) assert.ok(printed.has(norm(l)), `the README shows a line records does not print: ${l}`);
  assert.ok(section.includes(r.stderr.trim()), `the README's stderr line is not what records prints: ${r.stderr.trim()}`);
  assert.match(section, new RegExp(`It writes ${r.stdout.split('\n').filter(Boolean).length} lines, the header and ${r.stdout.split('\n').filter(Boolean).length - 1} records`));
  // every key the command prints, over the demo and the synthetic file of every kind: a top-level key has its own row
  // in the table; a key below one is named in that key's row
  const d = tmp(), f = synthetic(d);
  const keys = new Map();
  const walk = (o, top) => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) { const t = top ?? k; if (!keys.has(t)) keys.set(t, new Set()); if (top) keys.get(t).add(k); walk(v, t); } };
  for (const text of [r.stdout, run(f).stdout]) for (const l of text.split('\n').filter(Boolean)) walk(JSON.parse(l), null);
  const rowOf = (k) => section.split('\n').find((l) => l.startsWith(`| \`${k}\` |`));
  for (const [top, below] of keys) {
    const row = rowOf(top);
    assert.ok(row, `the README's section on records has no row for '${top}'`);
    for (const k of below) assert.ok(row.includes(`\`${k}\``), `the README's row for '${top}' does not name '${k}'`);
  }
  for (const k of R.RECORD_KINDS) assert.ok(section.includes(`\`${k}\``), `the README's section on records does not name the kind '${k}'`);
  rmSync(d, { recursive: true });
});

test('records (S375): the header lists versions equal as numbers but spelled apart by their text, so the order of the records does not change the header (the shapes S4 defect, found in records by G1\'s check)', () => {
  const d = tmp();
  const rec = (v, u) => JSON.stringify({ type: 'user', uuid: u, parentUuid: null, version: v, message: { content: 'x' }, promptSource: 'typed' });
  const a = join(d, 'aaaaaaaa-1.jsonl'), b = join(d, 'aaaaaaaa-2.jsonl');
  writeFileSync(a, [rec('01.2.3', 'u1'), rec('1.2.3', 'u2'), rec('0.9.9', 'u3')].join('\n') + '\n');
  writeFileSync(b, [rec('1.2.3', 'u2'), rec('01.2.3', 'u1'), rec('0.9.9', 'u3')].join('\n') + '\n');
  const versions = (f) => lines(run(f).stdout)[0].supplier.versions;
  assert.deepEqual(versions(a), ['0.9.9', '01.2.3', '1.2.3']);
  assert.deepEqual(versions(b), versions(a));
  rmSync(d, { recursive: true });
});

// ---- S375, the read of records (wf_2663d245-6d9): R1, R7–R11, O8, O11, O13, O16 ----

/** A module, loaded with --import before the command, that runs `body` with fs and the call count in scope. */
function importModule(dir, name, body) {
  const f = join(dir, name);
  writeFileSync(f, ["import fs from 'node:fs';", "import { syncBuiltinESMExports } from 'node:module';", body, 'syncBuiltinESMExports();'].join('\n'));
  return pathToFileURL(f).href;
}

test('records (S375, R1 O11): a value that is not a string prints (withheld), never dropped; a parentUuid that is neither a string nor null names a parent not in this file; a uuid is kept without the envelope too', () => {
  const d = tmp(), f = join(d, 'bbbbbbbb-types.jsonl');
  const L = [
    { type: 5, uuid: 'w1', parentUuid: null, version: 7, timestamp: 12345 },
    { type: 'user', uuid: 'w2', parentUuid: 42, message: { content: 'x' }, promptSource: 'typed' },
    { type: 'system', subtype: { a: 1 }, uuid: 'w3', parentUuid: 'w2' },
    { type: 'ai-title', uuid: 'w4' },
    { type: 'attachment', uuid: 'w5', parentUuid: 'w3', attachment: { type: 9 } },
    { type: 'assistant', uuid: 'w6', parentUuid: 'w3', requestId: 77, message: { id: 'msg_1', content: [{ type: 'text', text: 't' }] } },
  ];
  writeFileSync(f, L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const [, ...recs] = lines(r.stdout);
  assert.deepEqual([recs[0].supplier.type, recs[0].supplier.version, recs[0].time], ['(withheld)', '(withheld)', { as_written: '(withheld)', kind: 'stamped' }]);
  assert.deepEqual([recs[1].parent, recs[1].parent_by, recs[1].supplier.parent], [null, 'supplied', '(withheld)']);
  assert.equal(recs[2].supplier.subtype, '(withheld)');
  assert.deepEqual([recs[3].supplier.id, recs[3].parent_by], ['w4', 'none']);
  assert.equal(recs[4].supplier.subtype, '(withheld)');
  assert.equal(recs[5].group, 'msg_1', 'a requestId that is not a string: the message id groups, as the parser reads a response');
  assert.match(r.stderr, /parents: 3 in the file, 1 root, 1 not in this file, 1 outside the tree; links: 0 in the file, 0 not in this file\./);
  rmSync(d, { recursive: true });
});

test('records (S375, O13 R8): utc only for a stamp that is a real instant (ISO 8601 with its zone, lower case allowed), the instant even when as_written is withheld', () => {
  const d = tmp(), f = join(d, 'cccccccc-time.jsonl');
  const stamps = [
    ['2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z'],
    ['2026-01-01t10:00:00z', '2026-01-01T10:00:00.000Z'],
    ['2026-01-01T10:00:00+02:00', '2026-01-01T08:00:00.000Z'],
    ['2026-01-01T10:00:00-0130', '2026-01-01T11:30:00.000Z'],
    ['2026-02-30T00:00:00Z', undefined],
    ['2026-13-01T00:00:00Z', undefined],
    ['2026-01-01T24:00:00Z', undefined],
    ['2026-01-01T10:00:00', undefined],
    ['2026-01-01T10:00:00.' + '1'.repeat(60) + 'Z', '2026-01-01T10:00:00.111Z'],
  ];
  writeFileSync(f, stamps.map(([t], i) => JSON.stringify({ type: 'user', uuid: `t${i}`, parentUuid: null, timestamp: t, message: { content: 'x' }, promptSource: 'typed' })).join('\n') + '\n');
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const [, ...recs] = lines(r.stdout);
  stamps.forEach(([t, utc], i) => {
    assert.equal(recs[i].time.utc, utc, t);
    assert.equal(recs[i].time.as_written, t.length > 64 ? '(withheld)' : t, t);
  });
  rmSync(d, { recursive: true });
});

test('records (S375, R9 R8): redacted_thinking is thinking; a uuid carried three times links to its first carrier, from children written before and after its replays; a message id groups where there is no requestId', () => {
  const d = tmp(), f = join(d, 'dddddddd-carriers.jsonl');
  const a = (uuid, parentUuid, content, extra = {}) => ({ type: 'assistant', uuid, parentUuid, message: { id: 'm_x', content }, ...extra });
  const L = [
    { type: 'user', uuid: 'p1', parentUuid: null, message: { content: 'q' }, promptSource: 'typed' },
    a('x1', 'p1', [{ type: 'redacted_thinking', data: 'zz' }], { requestId: 'r1' }),
    a('x2', 'x1', [{ type: 'redacted_thinking', data: 'zz' }, { type: 'thinking', thinking: 'y' }], { requestId: 'r1' }),
    { type: 'user', uuid: 'c1', parentUuid: 'x2', message: { content: 'q2' }, promptSource: 'typed' },
    a('x2', 'x1', [{ type: 'thinking', thinking: 'y' }], { requestId: 'r1' }),
    a('x2', 'x1', [{ type: 'thinking', thinking: 'y' }], { requestId: 'r1' }),
    { type: 'user', uuid: 'c2', parentUuid: 'x2', message: { content: 'q3' }, promptSource: 'typed' },
    a('x3', 'c2', [{ type: 'text', text: 'r' }]),
  ];
  writeFileSync(f, L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const [, ...recs] = lines(r.stdout);
  assert.deepEqual([recs[1].kind, recs[2].kind, recs[2].kinds], ['thinking', 'thinking', ['thinking', 'thinking']]);
  assert.deepEqual([recs[4].dup_of, recs[5].dup_of], ['dddddddd:L3', 'dddddddd:L3']);
  assert.deepEqual([recs[3].parent, recs[6].parent], ['dddddddd:L3', 'dddddddd:L3']);
  assert.equal(recs[7].group, 'm_x');
  rmSync(d, { recursive: true });
});

test('records (S375, R10): the command\'s own balance check: a splitter that loses a line makes it exit 1 and say the count does not balance', () => {
  const d = tmp(), f = synthetic(d);
  // the second search for a newline from the start of a piece (the splitter passes 0; the output's own count of
  // newlines passes none) is the second read's first: there, the first newline is skipped
  const mod = importModule(d, 'skip.mjs', [
    'const indexOf = Buffer.prototype.indexOf; let starts = 0;',
    'Buffer.prototype.indexOf = function (v, from, ...rest) { if (v === 10 && from === 0 && ++starts === 2) { const i = indexOf.call(this, v, 0); return i < 0 ? i : indexOf.call(this, v, i + 1); } return indexOf.call(this, v, from, ...rest); };',
  ].join('\n'));
  const r = spawnSync(process.execPath, ['--import', mod, CLI, 'records', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 1, r.stderr);
  // with where to report it: package.json's bugs.url (S375's known issue k17)
  const url = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).bugs?.url;
  assert.ok(r.stderr.includes(` THE COUNT DOES NOT BALANCE: a bug in ltms (report it at ${url}; an issue there is public).`), r.stderr);
  rmSync(d, { recursive: true });
});

test('records (S375, R11): the header lists versions in version order; read_at is UTC; path is the argument resolved; -- ends the options', () => {
  const d = tmp();
  const f = join(d, 'eeeeeeee-v.jsonl'), dash = join(d, '-x.jsonl');
  const rec = (v, u) => JSON.stringify({ type: 'user', uuid: u, parentUuid: null, version: v, message: { content: 'x' }, promptSource: 'typed' });
  writeFileSync(f, [rec('10.0.0', 'a'), rec('2.1.300', 'b'), rec('2.1.99', 'c')].join('\n') + '\n');
  writeFileSync(dash, rec('2.1.300', 'd') + '\n');
  const r = spawnSync(process.execPath, [CLI, 'records', basename(f)], { encoding: 'utf8', cwd: d });
  assert.equal(r.status, 0, r.stderr);
  const h = lines(r.stdout)[0];
  assert.deepEqual(h.supplier.versions, ['2.1.99', '2.1.300', '10.0.0']);
  assert.match(h.source.read_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(h.source.path, f);
  const r2 = spawnSync(process.execPath, [CLI, 'records', '--', '-x.jsonl'], { encoding: 'utf8', cwd: d });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(lines(r2.stdout)[0].source.path, dash);
  rmSync(d, { recursive: true });
});

/** The peak resident memory of `ltms records <file>`, from a module that reports it as the process exits. */
function peakKiB(dir, file) {
  const mod = importModule(dir, 'peak.mjs', "process.on('exit', () => process.stderr.write('PEAK ' + process.resourceUsage().maxRSS + '\\n'));");
  const outPath = file + '.records', fd = openSync(outPath, 'w');
  try {
    // a heap held small (old space 16 MB, semi-space 1 MB) is warm at both sizes, so only memory that grows with the file
    // shows: with the heap at 40 MB its warming up read as growth (S375: 16 MB vs 96 MB differed by 55 MiB on code that
    // stays flat at 96, 192 MB)
    const r = spawnSync(process.execPath, ['--max-old-space-size=16', '--max-semi-space-size=1', '--import', mod, CLI, 'records', file], { encoding: 'utf8', stdio: ['ignore', fd, 'pipe'], timeout: 600000 });
    assert.equal(r.status, 0, r.stderr.slice(0, 400));
    return Number(/PEAK (\d+)/.exec(r.stderr)?.[1]);
  } finally { closeSync(fd); rmSync(outPath, { force: true }); }
}

test('records (S375, R7): the peak resident memory does not grow with the file: 16 MB and 96 MB give peaks within 16 MiB of each other under a small heap (the heap limit alone could not see a file held whole in a Buffer: that grows by the file, 81 MiB here)', () => {
  const d = tmp();
  const demo = readFileSync(join(here, 'fixtures', 'demo.jsonl'));
  const make = (name, mb) => { const f = join(d, name), fd = openSync(f, 'w'); for (let i = 0, n = Math.ceil((mb << 20) / demo.length); i < n; i++) writeSync(fd, demo); closeSync(fd); return f; };
  const small = peakKiB(d, make('small.jsonl', 16)), big = peakKiB(d, make('big.jsonl', 96));
  assert.ok(big - small < 16 * 1024, `peak ${small} KiB for 16 MB, ${big} KiB for 96 MB: it grew by ${big - small} KiB`);
  rmSync(d, { recursive: true });
});

test('records (S375, O16): a file that holds more than the size it had when it was opened (a file under /proc, or one that grew) is said on stderr; the records are of its first bytes', { skip: process.platform !== 'linux' && '/proc is Linux\'s' }, () => {
  const r = run('/proc/version');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r.stdout)[0].source.bytes, 0);
  assert.match(r.stderr, /warning: '\/proc\/version' holds more than the 0 bytes it had when it was opened .*the records are of its first 0 bytes/);
});

test('records (S375, O8): a path that names another file by the end (renamed over between the reads) is said on stderr; the records are of the file as opened', () => {
  const d = tmp(), f = synthetic(d), other = join(d, 'other.jsonl');
  writeFileSync(other, '{"type":"x"}\n');
  const mod = importModule(d, 'swap.mjs', [
    'const readSync = fs.readSync; let starts = 0;',
    `fs.readSync = (fd, buf, off, len, pos) => { if (pos === 0 && ++starts === 2) fs.renameSync(${JSON.stringify(other)}, ${JSON.stringify(f)}); return readSync(fd, buf, off, len, pos); };`,
  ].join('\n'));
  const r = spawnSync(process.execPath, ['--import', mod, CLI, 'records', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r.stdout).length, 28, 'the 27 records of the file as opened, and the header');
  assert.match(r.stderr, /warning: .* now names another file than the one read/);
  rmSync(d, { recursive: true });
});

test('records (S375 O2, S376): the folder loop is one in the README, the help and the folder messages; run as written by bash, zsh and sh, it keeps the records of a run that succeeds, names on stderr the run that fails and each entry named .jsonl that is not a regular file, ends with status 1 after a failure and never calls exit, and over an empty folder does nothing and ends with 0', (t) => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const pick = (text) => text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('mkdir -p records;'));
  const d = tmp();
  const fromReadme = pick(readme), fromHelp = pick(run('--help').stdout);
  assert.ok(fromReadme, 'the README has the loop');
  assert.equal(fromHelp, fromReadme, 'the help gives the README\'s loop');
  assert.equal(pick(run(d).stderr.replace(/^.*For a folder: /s, '')), fromReadme.replace('<folder>', `'${d}'`), 'the directory message gives it, for the folder given');
  assert.equal(pick(run().stderr.replace(/^.*For a folder: /s, '')), fromReadme, 'the message for no path gives it');
  // pasted into an interactive shell, exit would close the terminal: the status is the last command's
  assert.doesNotMatch(fromReadme, /\bexit\b/, 'the loop calls exit');
  const asRoot = process.getuid?.() === 0;
  const folder = join(d, 'in'), empty = join(d, 'empty');
  mkdirSync(folder); mkdirSync(empty);
  writeFileSync(join(folder, 'aaaaaaaa-ok.jsonl'), '{"type":"x"}\n');
  writeFileSync(join(folder, 'bbbbbbbb-no.jsonl'), '{"type":"x"}\n');
  spawnSync('chmod', ['000', join(folder, 'bbbbbbbb-no.jsonl')]);
  const fifo = spawnSync('mkfifo', [join(folder, 'cccccccc-fifo.jsonl')]).status === 0;
  mkdirSync(join(folder, 'dddddddd-dir.jsonl'));
  // each shell as it starts with no startup file of the user's (zsh -f; no BASH_ENV or ENV)
  const env = { ...process.env }; delete env.BASH_ENV; delete env.ENV;
  const shells = [['bash', []], ['zsh', ['-f']], ['sh', []]];
  let ran = 0;
  for (const [sh, flags] of shells) {
    if (spawnSync(sh, [...flags, '-c', 'true']).status !== 0) { t.diagnostic(`${sh} is not here: the loop is not run by it`); continue; }
    ran++;
    for (const src of [folder, empty]) {
      const work = join(d, `${sh}-${basename(src)}`);
      mkdirSync(work);
      const script = `ltms() { "${process.execPath}" "${CLI}" "$@"; }; ` + fromReadme.replace('<folder>', `'${src}'`);
      const r = spawnSync(sh, [...flags, '-c', script], { cwd: work, encoding: 'utf8', env, timeout: 60000 });
      const what = `${sh} over ${basename(src)}: status ${r.status}, stderr ${JSON.stringify(r.stderr)}`;
      assert.doesNotMatch(r.stderr, /no matches found|no match/, what);
      if (src === empty) {
        assert.equal(r.status, 0, what);
        assert.equal(r.stderr, '', what);
        assert.deepEqual(readdirSync(join(work, 'records')), [], what);
        continue;
      }
      // the run that fails: named, its records not kept, and the status 1 (as root, a file without read permission is read)
      assert.equal(r.status, asRoot ? 0 : 1, what);
      if (!asRoot) assert.ok(r.stderr.includes(`failed: ${folder}/bbbbbbbb-no.jsonl\n`), what);
      for (const n of [...(fifo ? ['cccccccc-fifo.jsonl'] : []), 'dddddddd-dir.jsonl']) assert.ok(r.stderr.includes(`skipped, not a regular file: ${folder}/${n}\n`), what);
      assert.deepEqual(readdirSync(join(work, 'records')).sort(), asRoot ? ['aaaaaaaa-ok.records.jsonl', 'bbbbbbbb-no.records.jsonl'] : ['aaaaaaaa-ok.records.jsonl'], what);
      assert.equal(lines(readFileSync(join(work, 'records', 'aaaaaaaa-ok.records.jsonl'), 'utf8')).length, 2, 'the records of the run that succeeded, whole');
    }
  }
  assert.ok(ran > 0, 'no shell ran the loop');
  spawnSync('chmod', ['600', join(folder, 'bbbbbbbb-no.jsonl')]);
  rmSync(d, { recursive: true });
});

test('records (S375, O3, his word 22:43): the links the file supplies, as addresses by the first carrier, null when not in the file, and as written under supplier by the label rule: leaf, logical_parent, calls (in block order), session', () => {
  const d = tmp(), f = join(d, 'ffffffff-links.jsonl');
  const env = (uuid, parentUuid, extra) => ({ uuid, parentUuid, sessionId: 's-1', ...extra });
  const L = [
    env('a1', null, { type: 'user', message: { content: 'q' }, promptSource: 'typed' }),                                                        // 1
    env('a2', 'a1', { type: 'assistant', requestId: 'r1', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }, { type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }] } }),  // 2
    env('a3', 'a2', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'x' }, { type: 'tool_result', tool_use_id: 'tu_1', content: 'y' }, { type: 'tool_result', tool_use_id: 'tu_gone', content: 'z' }] }, toolUseResult: {} }),  // 3
    env('a4', null, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'a3' }),                                                   // 4
    env('a5', 'a4', { type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'not-here' }),                                            // 5
    env('a6', 'a5', { type: 'assistant', requestId: 'r2', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } }),  // 6: a tool_use id carried again
    { type: 'last-prompt', leafUuid: 'a3', sessionId: 's-1' },                                                                                  // 7
    { type: 'last-prompt', leafUuid: 'nowhere', sessionId: 'zq odd session' },                                                                  // 8
    env('a9', 'a6', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 7, content: 'w' }, { type: 'tool_result', tool_use_id: 'zq odd call id', content: 'v' }] }, toolUseResult: {} }),  // 9
  ];
  writeFileSync(f, L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const [, ...recs] = lines(r.stdout);
  const P = 'ffffffff';
  assert.deepEqual([recs[2].calls, recs[2].supplier.calls], [[`${P}:L2`, `${P}:L2`, null], ['tu_2', 'tu_1', 'tu_gone']]);
  assert.deepEqual([recs[3].logical_parent, recs[3].supplier.logical_parent], [`${P}:L3`, 'a3']);
  assert.deepEqual([recs[4].logical_parent, recs[4].supplier.logical_parent], [null, 'not-here']);
  assert.deepEqual([recs[6].leaf, recs[6].supplier.leaf], [`${P}:L3`, 'a3']);
  assert.deepEqual([recs[7].leaf, recs[7].supplier.leaf, recs[7].supplier.session], [null, 'nowhere', '(withheld)']);
  assert.deepEqual([recs[8].calls, recs[8].supplier.calls], [[null, null], ['(withheld)', '(withheld)']]);
  assert.equal(recs[0].supplier.session, 's-1');
  assert.equal(recs[0].calls, undefined, 'no links where the file supplies none');
  assert.doesNotMatch(r.stdout, /zq odd/);
  assert.match(r.stderr, /; links: 4 in the file, 5 not in this file\./);
  rmSync(d, { recursive: true });
});

test('records (S375, O1 O7): a write to stdout that fails (a reader gone before the end, a full disk) stops the reading at once and exits 1, one line saying how many lines were written, and no balance line; a file still gets the balance line', { skip: process.platform === 'win32' && 'no FIFOs on win32' }, () => {
  const d = tmp();
  const demo = readFileSync(join(here, 'fixtures', 'demo.jsonl'));
  const f = join(d, 'gggggggg-big.jsonl'), fd0 = openSync(f, 'w');
  for (let i = 0; i < 80; i++) writeSync(fd0, demo); // about 2 MB: two pieces a read
  closeSync(fd0);
  const size = readFileSync(f).length;
  // the bytes read, counted by a module loaded before the command
  const mod = importModule(d, 'count.mjs', "const readSync = fs.readSync; let n = 0; fs.readSync = (...a) => { const r = readSync(...a); n += r; return r; }; process.on('exit', () => process.stderr.write('READ ' + n + '\\n'));");
  const runTo = (fd) => { try { const r = spawnSync(process.execPath, ['--import', mod, CLI, 'records', f], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 120000 }); if (r.error) throw r.error; return r; } finally { closeSync(fd); } };
  // the write end of a FIFO whose read end is closed: the first write fails with EPIPE (S375's shapes U9 test made it so)
  const fifo = join(d, 'out.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const rd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK), wr = openSync(fifo, constants.O_WRONLY);
  closeSync(rd);
  const a = runTo(wr);
  assert.equal(a.status, 1, a.stderr);
  assert.match(a.stderr, /^ltms records: '.*gggggggg-big\.jsonl': the records were cut: writing them to stdout failed \(EPIPE: the reader stopped before the end\) after 0 of their lines were written; the second read stopped there, so they are not a view of it\.$/m);
  assert.doesNotMatch(a.stderr, /records written/, 'no balance line claims what was not written');
  assert.ok(Number(/READ (\d+)/.exec(a.stderr)?.[1]) < 2 * size, `the reading stopped at the failed write: ${/READ (\d+)/.exec(a.stderr)?.[1]} bytes read of a file of ${size}, read twice whole ${2 * size}`);
  if (existsSync('/dev/full')) {
    const b = runTo(openSync('/dev/full', 'w'));
    assert.equal(b.status, 1, b.stderr);
    assert.match(b.stderr, /the records were cut: writing them to stdout failed \(ENOSPC: the disk is full\) after 0 of their lines were written/);
  }
  const out = join(d, 'out.records');
  const c = runTo(openSync(out, 'w'));
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, / records written /);
  assert.equal(readFileSync(out, 'utf8').split('\n').length - 1, 1 + 80 * 37);
  rmSync(d, { recursive: true });
});

test('records (S376, R2 O4): the check the README and --help give, run as they give it on a transcript still being written (its last line half written, then finished, then followed by more): the bytes the header names balance the records', { skip: process.platform === 'win32' && 'head -c and wc -l' }, () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const readme = flat(readFileSync(join(root, 'README.md'), 'utf8')), help = flat(run('--help').stdout);
  const LIVE = 'head -c <bytes> <file> | wc -l';
  assert.ok(readme.includes(`for a file still being written, count only the bytes the header names: \`${LIVE}\``), 'the README gives the check for a file still being written');
  assert.ok(help.includes(`for a file still being written, count only the bytes the header names: ${LIVE}`), 'records --help gives the check for a file still being written');
  const d = tmp(), f = join(d, 'live.jsonl'), demo = readFileSync(join(here, 'fixtures', 'demo.jsonl'));
  writeFileSync(f, demo.subarray(0, demo.lastIndexOf(10, demo.length - 2) + 91));   // 36 lines and 90 bytes of the 37th
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const [h, ...recs] = lines(r.stdout);
  assert.equal(h.source.last_line_unterminated, true);
  writeFileSync(f, Buffer.concat([demo, demo.subarray(0, demo.indexOf(10) + 1)]));          // the writer finished it, and wrote one more
  const count = (cmd) => Number(spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }).stdout.trim()) + (h.source.last_line_unterminated ? 1 : 0);
  assert.notEqual(count(`wc -l < '${f}'`), recs.length, 'the plain wc -l check, on the file as it is now, does not balance: the case the live form is for');
  assert.equal(count(LIVE.replace('<bytes>', String(h.source.bytes)).replace('<file>', `'${f}'`)), recs.length, 'the live form balances');
  rmSync(d, { recursive: true });
});

test('records (S376, LT): leaf and logical_parent are the address of the first record that carries the id as its uuid, with a parentUuid or without one (a sidecar), as the draft says; the links count follows; parent and dup_of still go by the records with the envelope', () => {
  const d = tmp(), f = join(d, 'llllllll-carriers.jsonl');
  const L = [
    { type: 'user', uuid: 'r1', parentUuid: null, message: { content: 'q' }, promptSource: 'typed' },     // 1
    { type: 'ai-title', uuid: 'side-1', aiTitle: 't' },                                                   // 2 side-1, carried by a sidecar alone
    { type: 'last-prompt', leafUuid: 'side-1' },                                                          // 3 leaf: L2
    { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'side-1' },  // 4 logical_parent: L2
    { type: 'ai-title', uuid: 'r2', aiTitle: 't' },                                                       // 5 r2, by a sidecar first
    { type: 'user', uuid: 'r2', parentUuid: 'r1', message: { content: 'q' }, promptSource: 'typed' },    // 6 then with the envelope
    { type: 'last-prompt', leafUuid: 'r2' },                                                              // 7 leaf: L5, the first carrier
    { type: 'user', uuid: 'c1', parentUuid: 'r2', message: { content: 'q' }, promptSource: 'typed' },    // 8 parent: L6, the envelope's
    { type: 'user', uuid: 'r1', parentUuid: null, message: { content: 'q' }, promptSource: 'typed' },     // 9 dup_of: L1
    { type: 'ai-title', uuid: 'r1', aiTitle: 't' },                                                       // 10 a sidecar after the envelope's
    { type: 'last-prompt', leafUuid: 'r1' },                                                              // 11 leaf: L1
    { type: 'user', uuid: 'c2', parentUuid: 'side-1', message: { content: 'q' }, promptSource: 'typed' }, // 12 parent: none with the envelope
    { type: 'last-prompt', leafUuid: 'gone' },                                                            // 13 leaf: null
  ];
  writeFileSync(f, L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const [, ...recs] = lines(r.stdout);
  const P = 'llllllll';
  assert.deepEqual([recs[2].leaf, recs[3].logical_parent, recs[6].leaf, recs[10].leaf, recs[12].leaf], [`${P}:L2`, `${P}:L2`, `${P}:L5`, `${P}:L1`, null]);
  assert.deepEqual([recs[7].parent, recs[8].dup_of, recs[11].parent, recs[11].supplier.parent], [`${P}:L6`, `${P}:L1`, null, 'side-1']);
  assert.match(r.stderr, /; links: 4 in the file, 1 not in this file\.$/m);
  rmSync(d, { recursive: true });
});

test('records (S376, O11): a parentUuid on a record whose uuid is not a string, or that has none, is printed as on any record: parent, the address of the record it names or null, parent_by "supplied", and supplier.parent by the label rule; records --help and Privacy give the label rule as 1 to 64 characters', () => {
  const d = tmp(), f = join(d, 'kkkkkkkk-nouuid.jsonl');
  const L = [
    { type: 'user', uuid: 'a1', parentUuid: null, message: { content: 'q' }, promptSource: 'typed' },                // 1 a root
    { type: 'user', parentUuid: 'a1', message: { content: 'q' } },                                                 // 2 no uuid: its parent is L1
    { type: 'user', uuid: 12345, parentUuid: 'a1', message: { content: 'q' } },                                    // 3 a uuid that is a number
    { type: 'user', parentUuid: 'nowhere', message: { content: 'q' } },                                            // 4 a parent not in the file
    { type: 'user', parentUuid: null, message: { content: 'q' } },                                                 // 5 a root without a uuid
    { type: 'user', uuid: ['zq'], parentUuid: 'zq odd parent / with a slash', message: { content: 'q' } },         // 6 a parent that fails the rule
    { type: 'user', parentUuid: 7, message: { content: 'q' } },                                                    // 7 a parentUuid that is a number
    { type: 'ai-title', uuid: 'a9', aiTitle: 't' },                                                                // 8 no parentUuid: outside the tree
  ];
  writeFileSync(f, L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const [, ...recs] = lines(r.stdout);
  const P = 'kkkkkkkk';
  assert.deepEqual(recs.map((x) => [x.parent, x.parent_by, x.supplier?.parent]), [
    [null, 'supplied', null], [`${P}:L1`, 'supplied', 'a1'], [`${P}:L1`, 'supplied', 'a1'], [null, 'supplied', 'nowhere'],
    [null, 'supplied', null], [null, 'supplied', '(withheld)'], [null, 'supplied', '(withheld)'], [null, 'none', undefined],
  ]);
  assert.deepEqual([recs[1].supplier.id, recs[2].supplier.id, recs[5].supplier.id], [undefined, '(withheld)', '(withheld)']);
  assert.doesNotMatch(r.stdout, /zq/);
  assert.match(r.stderr, /; parents: 2 in the file, 2 roots, 3 not in this file, 1 outside the tree; /);
  // the label rule's length, as the code holds it, in the words records --help and the README's Privacy give
  const [, lo, hi] = /\{(\d+),(\d+)\}/.exec(/^const LABEL = (\/.+\/[a-z]*);$/m.exec(readFileSync(join(DIST, 'records.js'), 'utf8'))[1]);
  const flat = (s) => s.replace(/\s+/g, ' ');
  assert.ok(flat(run('--help').stdout).includes(`the label rule (${lo} to ${hi} ASCII letters, digits and . _ : + -)`), `records --help gives the label rule as ${lo} to ${hi} characters`);
  const privacy = readFileSync(join(root, 'README.md'), 'utf8').split('\n## Privacy')[1].split('\n## ')[0];
  assert.ok(privacy.includes(`looks like one: ${lo} to ${hi} ASCII letters, digits and`), `the README's Privacy gives the label rule as ${lo} to ${hi} characters`);
  rmSync(d, { recursive: true });
});

/** The balance line's form, as the README's section on records and records --help give it (the line that starts
 *  "ltms records: '<file>': "), as a regular expression: [ ] around what is printed only sometimes, <n> a count, <file>
 *  the path, <url> an address, and "<n> <kind>, ..." the kinds with their counts. null when the text gives none. */
function balanceForm(text, kinds) {
  const form = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith("ltms records: '<file>': "));
  if (form === undefined) return null;
  const kind = `(?:${kinds.join('|')})`;
  const tokens = { '[': '(?:', ']': ')?', '<n> <kind>, ...': `\\d+ ${kind}(?:, \\d+ ${kind})*`, '<n>': '\\d+', '<file>': '.+?', '<url>': '\\S+' };
  let re = '';
  for (let i = 0; i < form.length;) {
    const t = Object.keys(tokens).find((k) => form.startsWith(k, i));
    if (t) { re += tokens[t]; i += t.length; } else { re += form[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  return { form, re: new RegExp(`^${re}$`) };
}

test('records (S376, O15): the README and --help give the balance line in full, every form it takes; a path is printed with its control characters escaped, so it never splits a line of stderr', async (t) => {
  const R = await import(pathToFileURL(join(DIST, 'records.js')).href);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('### `ltms records');
  const section = readme.slice(start, readme.indexOf('\n### ', start + 1));
  const fromReadme = balanceForm(section, R.RECORD_KINDS), fromHelp = balanceForm(run('--help').stdout, R.RECORD_KINDS);
  assert.ok(fromReadme, 'the README\'s section on records gives no form of the balance line (a line that starts "ltms records: \'<file>\': ")');
  assert.ok(fromHelp, 'records --help gives no form of the balance line');
  assert.equal(fromHelp.form, fromReadme.form, 'the help gives the README\'s form');
  // every form: many lines and records, one, none; a last line without a newline; one root, several; a count that does
  // not balance (R10's splitter that loses a line)
  const d = tmp();
  const put = (name, text) => { const f = join(d, name); writeFileSync(f, text); return f; };
  const rec = (u, p) => JSON.stringify({ type: 'user', uuid: u, parentUuid: p, message: { content: 'x' }, promptSource: 'typed' });
  const files = [
    join(here, 'fixtures', 'demo.jsonl'), synthetic(d), put('empty.jsonl', ''), put('one.jsonl', '{"type":"x"}'), put('blank.jsonl', '\n'),
    put('roots.jsonl', [rec('r1', null), rec('r2', null), rec('c1', 'r1')].join('\n') + '\n'),
  ];
  const balance = [];
  for (const f of files) { const r = run(f); assert.equal(r.status, 0, r.stderr); balance.push(r.stderr.trimEnd().split('\n').pop()); }
  const skip = importModule(d, 'skip.mjs', [
    'const indexOf = Buffer.prototype.indexOf; let starts = 0;',
    'Buffer.prototype.indexOf = function (v, from, ...rest) { if (v === 10 && from === 0 && ++starts === 2) { const i = indexOf.call(this, v, 0); return i < 0 ? i : indexOf.call(this, v, i + 1); } return indexOf.call(this, v, from, ...rest); };',
  ].join('\n'));
  const u = spawnSync(process.execPath, ['--import', skip, CLI, 'records', files[1]], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(u.status, 1, u.stderr);
  balance.push(u.stderr.trimEnd().split('\n').pop());
  for (const l of balance) {
    assert.match(l, fromReadme.re, `a balance line the README's form does not give: ${l}`);
    assert.match(l, fromHelp.re, `a balance line the help's form does not give: ${l}`);
  }
  for (const seen of [/: 37 lines read, /, /: 1 line read \(the last without a newline\), 1 record written \(1 other\); /, /: 0 lines read, 0 records written; /, /: 1 line read, 1 record written \(1 blank\); /, / 1 root, /, / 2 roots, /, / THE COUNT DOES NOT BALANCE: /]) {
    assert.ok(balance.some((l) => seen.test(l)), `no balance line here has the form ${seen}: the test misses a form`);
  }
  // a path that holds control characters: escaped (\n, \t, \r by name, any other as \xHH), on every line records prints
  if (process.platform === 'win32') { t.diagnostic('no control characters in a name on win32'); rmSync(d, { recursive: true }); return; }
  const odd = 'new\nline\ttab\rcr\x01\x7f\u0085', escaped = 'new\\nline\\ttab\\rcr\\x01\\x7f\\x85';
  const named = join(d, `${odd}.jsonl`);
  writeFileSync(named, readFileSync(join(here, 'fixtures', 'demo.jsonl')));
  const dirNamed = join(d, `${odd}-dir.jsonl`); mkdirSync(dirNamed);
  const fifoNamed = join(d, `${odd}-fifo.jsonl`);
  const cases = [[named, 0, / 37 lines read, /], [join(d, `${odd}-missing.jsonl`), 1, /cannot read .*: no such file or directory/], [dirNamed, 2, /is a directory; records reads one transcript\. For a folder: /]];
  if (spawnSync('mkfifo', [fifoNamed]).status === 0) cases.push([fifoNamed, 2, /is not a regular file/]);
  for (const [f, status, re] of cases) {
    const r = run(f);
    assert.equal(r.status, status, r.stderr);
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 1, `one line of stderr for '${JSON.stringify(f)}', not split by its path: ${JSON.stringify(r.stderr)}`);
    assert.match(r.stderr, re);
    assert.ok(r.stderr.includes(`'${d}/${escaped}`), `the path with its control characters escaped: ${JSON.stringify(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, 'a control character on stderr');
  }
  rmSync(d, { recursive: true });
});

test('records (S376, CS): a write to stdout that fails after one line was written says so in the singular, "after 1 of their lines was written", in the words shapes shares', () => {
  const d = tmp(), f = synthetic(d);
  // the second write to stdout fails as a reader that stopped makes it fail: the first, the header, was written whole
  const mod = importModule(d, 'epipe2.mjs', [
    'const writeSync = fs.writeSync; let calls = 0;',
    "fs.writeSync = (fd, ...a) => { if (fd === 1 && ++calls === 2) { const e = new Error('write EPIPE'); e.code = 'EPIPE'; throw e; } return writeSync(fd, ...a); };",
  ].join('\n'));
  const r = spawnSync(process.execPath, ['--import', mod, CLI, 'records', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(lines(r.stdout).length, 1, 'the header was written, and nothing after it');
  assert.match(r.stderr, /^ltms records: '.*': the records were cut: writing them to stdout failed \(EPIPE: the reader stopped before the end\) after 1 of their lines was written; the second read stopped there, so they are not a view of it\.$/m);
  // shapes' list of one line, cut at its first write: the same words, the noun in the singular too
  if (existsSync('/dev/full')) {
    const one = join(d, 'one.jsonl'); writeFileSync(one, '{"type":"user"}\n');
    const fd = openSync('/dev/full', 'w');
    let s;
    try { s = spawnSync(process.execPath, [CLI, 'shapes', '--unlisted', one], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' }); } finally { closeSync(fd); }
    assert.equal(s.status, 1, s.stderr);
    assert.match(s.stderr, /the list was cut: writing it to stdout failed \(ENOSPC: the disk is full\) after 0 of its 1 line were written; the rest were not, or not whole\./);
  }
  rmSync(d, { recursive: true });
});

test('records (S375, R6 of the closure check): a FIFO is refused before it is opened, so a writer already waiting on it is not joined and ended: its data reaches a reader that comes later, whole', { skip: process.platform === 'win32' && 'no FIFOs on win32' }, async () => {
  const d = tmp(), fifo = join(d, 'waiting.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const body = 'line\n'.repeat(1000);
  // the writer says so, then blocks in open until a reader opens the other end
  const writer = spawn(process.execPath, ['-e', `process.stderr.write('opening\\n'); require('node:fs').writeFileSync(${JSON.stringify(fifo)}, ${JSON.stringify(body)});`], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((res) => writer.stderr.on('data', (c) => { if (String(c).includes('opening')) res(); }));
  await new Promise((res) => setTimeout(res, 200));
  const r = spawnSync(process.execPath, [CLI, 'records', fifo], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /is not a regular file/);
  // still waiting: a records that had opened the FIFO would have joined the writer and, closing it, ended it (EPIPE);
  // read only then, or this test would wait for a writer that is gone
  await new Promise((res) => setTimeout(res, 300));
  if (writer.exitCode !== null || writer.signalCode !== null) assert.fail(`the writer ended (code ${writer.exitCode}, signal ${writer.signalCode}) when records was given its FIFO`);
  const got = readFileSync(fifo, 'utf8');                 // a reader that comes later
  const code = await new Promise((res) => writer.on('close', (c, sig) => res(sig ?? c)));
  assert.equal(code, 0, 'the writer was not ended by records');
  assert.equal(got, body, 'its data reached the later reader whole');
  rmSync(d, { recursive: true });
});
