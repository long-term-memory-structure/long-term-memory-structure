// Tests for ltms records (0.3.0), run against the built dist/cli.js (build first). Every record's address is recomputed
// here by another route (the file's bytes split and hashed in this file), every fixture of the package must balance,
// and a synthetic transcript holds one record of each kind of the draft's section 13, its texts planted with markers
// that must never reach the output (D2: content by address).
//
// LTMS_DIST=<a dist directory> runs the same tests against another build (a mutation check).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assert.match(r.stderr, /: 27 lines read \(the last without a newline\), 27 records written \(6 input, 3 reply, 1 thinking, 1 tool call, 1 tool result, 3 system, 2 context, 1 summary, 1 compaction, 1 marker, 4 other, 1 blank, 2 malformed\); 1 repeating an earlier record's uuid; parents: 17 in the file, 1 root, 1 not in this file, 8 outside the tree\.$/m);
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
  for (const [args, re] of [[[], /give one transcript \(none was given\)/], [['a.jsonl', 'b.jsonl'], /give one transcript \(2 were given\)/], [[d], /is a directory; records reads one transcript\. For a folder: mkdir -p records; for f in /], [['-'], /reading from standard input/], [['--frobnicate', 'x.jsonl'], /unknown option '--frobnicate'/]]) {
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
