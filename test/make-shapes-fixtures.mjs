// Writes the fixtures of test/shapes.test.mjs (ltms shapes, 0.3.0): synthetic transcripts in which every channel a leak
// could use carries a canary, and two sketch vocabularies for the supplier-neutrality test. Every text is invented: the
// token zq7canary in text and values, zq-prefixed key names, the numbers 31337 and 4242, the time 03:04:05.678, versions
// with suffixes. A report on these files must hold none of them. The transcripts are the S373 prototype's
// (make-fixtures.mjs), written here by the same code, byte for byte; the output is the same on every run.
//
//   node test/make-shapes-fixtures.mjs test/shapes-fixtures
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { process.stderr.write('usage: node test/make-shapes-fixtures.mjs <directory to write the fixtures in, e.g. test/shapes-fixtures>\n'); process.exit(2); }
mkdirSync(dir, { recursive: true });

/** NUL, built: a typed backslash-u escape can be turned into the character it names before it reaches the file. */
const NUL = String.fromCharCode(0);
const T = '2026-01-02T03:04:05.678Z';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const J = (o) => JSON.stringify(o);

// Claude-Code-shaped: three files, one per version, and a map in a fourth
function cc(version, opts = {}) {
  const sid = uuid();
  const env = (type, parent, extra = {}) => ({ parentUuid: parent, isSidechain: false, userType: 'external', cwd: '/home/zqcanary/proj', sessionId: sid, version, gitBranch: 'zq/secret-branch', type, uuid: uuid(), timestamp: T, ...extra });
  const L = [];
  L.push(J({ type: 'file-history-snapshot', messageId: uuid(), snapshot: { messageId: uuid(), trackedFileBackups: { '/home/zqcanary/a.txt': { backupFileName: 'zqhash@v1', version: 1, backupTime: T } }, timestamp: T }, isSnapshotUpdate: false }));
  const u1 = env('user', null, { message: { role: 'user', content: 'zq7canary prompt: please fix zqbug' }, promptId: uuid() });
  L.push(J(u1));
  const a1 = env('assistant', u1.uuid, { message: { id: 'msg_zq7canary', type: 'message', role: 'assistant', model: 'claude-zqmodel-9', content: [{ type: 'text', text: 'zq7canary reply' }], stop_reason: null, usage: { input_tokens: 31337, output_tokens: 4242, cache_read_input_tokens: 0 } }, requestId: 'req_zq7canary' });
  L.push(J(a1));
  const a2 = env('assistant', a1.uuid, { message: { id: 'msg_zq7canary', type: 'message', role: 'assistant', model: 'claude-zqmodel-9', content: [{ type: 'tool_use', id: 'toolu_zq1', name: 'mcp__zqprivate__lookup', input: { command: 'user', zqPrivateParam: 'zq7canary', CANARY_KEY_ZQ: 'x' } }], usage: { input_tokens: 31337, output_tokens: 4242 } }, requestId: 'req_zq7canary' });
  L.push(J(a2));
  const r1 = env('user', a2.uuid, { message: { role: 'user', content: [{ tool_use_id: 'toolu_zq1', type: 'tool_result', content: 'zq7canary output', is_error: false }] }, toolUseResult: { stdout: 'zq7canary', '/home/zqcanary/key.pem': 'zq', '0b6f8f9e-1111-4222-8333-944455556666': 1, zqPrivateParam: true }, sourceToolAssistantUUID: a2.uuid, promptId: uuid() });
  L.push(J(r1));
  L.push(J(env('system', r1.uuid, { subtype: 'turn_duration', durationMs: 4242, level: 'info', message: { content: [] } })));
  L.push(J(env('attachment', r1.uuid, { attachment: { type: 'hook_success', hookName: 'zqhook', content: 'zq7canary' } })));
  if (opts.probe) L.push(J(env('user', r1.uuid, { message: { role: 'user', content: 'plain' }, floorProbe: 'zq7canary' })));
  // in EVERY file, so that the floor cannot hide a leak: unlisted values at value paths, an unlisted key under a named
  // object, a vocabulary word (user) and a model id in fields that are not value paths
  L.push(J({ type: 'zqcanarytype3', zq3: 'zq7canary' }));
  L.push(J(env('system', r1.uuid, { subtype: 'zq_sub3', level: 'info' })));
  L.push(J(env('attachment', r1.uuid, { attachment: { type: 'zq_attach3', zqfield3: 'zq7canary' } })));
  L.push(J(env('user', r1.uuid, { message: { role: 'user', zqKey3: 'zq7canary', content: [{ type: 'zq_block3', text: 'zq7canary' }] } })));
  if (opts.canaries) {
    L.push(J(env('system', r1.uuid, { subtype: 'zq_new_subtype', content: 'zq7canary', level: 'info' })));
    L.push(J({ type: 'zqcanarytype', zq: 'zq7canary' }));
    L.push(J(env('attachment', r1.uuid, { attachment: { type: 'zq_attach', zqfield: 'zq7canary' } })));
    L.push(J({ 'message.content': 'zq7canary spoof', 'message': { 'content[]': 'zq7canary' }, type: 'user' }));
    L.push('{"__proto__":{"zq":"zq7canary"},"constructor":"zq7canary","type":"user"}');
    L.push(J(env('assistant', r1.uuid, { version: '9.9.9-zqcanary', message: { role: 'assistant', content: [] } })));
    L.push(J(env('assistant', r1.uuid, { version: 'zq-not-a-version', message: { role: 'assistant', content: [] } })));
    L.push(J(env('assistant', r1.uuid, { version: '31337.1.1', message: { role: 'assistant', content: [] } })));
    L.push('not json zq7canary');
    L.push(J(['zq7canary', 'root array']));
    L.push('');
    L.push('   \t  ');
    L.push(J({ type: 'user', message: { role: 'user', content: 'crlf zq7canary' } }) + '\r');
    L.push(NUL + NUL + J({ type: 'user' }));
    L.push(J({ type: 'user', message: { role: 'user', content: 'zq7canary '.repeat(800) } }));    // ~8 KB: over a --max-line of 4096
    L.push('{"type":"user","toolUseResult":' + '['.repeat(100000) + '"zq7canary"' + ']'.repeat(100000) + '}');
    L.push('{"type":"user","zqDeep":' + '{"zqk":'.repeat(100000) + '"zq7canary"' + '}'.repeat(100000) + '}');
    L.push(J(env('user', r1.uuid, { message: { role: 'user', content: [{ type: 'zq_block', zq: 'zq7canary' }] } })));
  }
  return L.join('\n') + '\n';
}

writeFileSync(join(dir, 'cc-a.jsonl'), cc('2.1.300', { canaries: true, probe: true }));
writeFileSync(join(dir, 'cc-b.jsonl'), cc('2.1.301', { probe: true }));
writeFileSync(join(dir, 'cc-c.jsonl'), cc('2.1.299'));

// a map: 100 file-path keys and 100 uuid keys, in a file of their own
const backups = {};
for (let i = 0; i < 100; i++) backups[`/home/zqcanary/f${i}.txt`] = { backupFileName: `zq${i}@v1`, version: 1, backupTime: T };
for (let i = 0; i < 100; i++) backups[uuid()] = { backupFileName: null, version: 2, backupTime: T };
writeFileSync(join(dir, 'cc-map.jsonl'), J({ type: 'file-history-snapshot', messageId: uuid(), snapshot: { messageId: uuid(), trackedFileBackups: backups, timestamp: T }, isSnapshotUpdate: true }) + '\n');

// Codex-shaped (the line envelope, and its kinds): not a captured file
function codex() {
  const L = [];
  L.push(J({ timestamp: T, type: 'session_meta', payload: { id: uuid(), session_id: uuid(), timestamp: T, cwd: '/home/zqcanary', originator: 'codex_cli_rs', cli_version: '0.169.0', source: 'cli', model_provider: 'zqprovider', base_instructions: { text: 'zq7canary' }, history_mode: 'legacy' } }));
  L.push(J({ timestamp: T, type: 'turn_context', payload: { cwd: '/home/zqcanary', approval_policy: 'on-request', model: 'zqmodel', effort: 'medium' } }));
  L.push(J({ timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'zq7canary' }] } }));
  L.push(J({ timestamp: T, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["zq7canary"]}', call_id: 'call_zq7canary' } }));
  L.push(J({ timestamp: T, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_zq7canary', output: 'zq7canary' } }));
  L.push(J({ timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'zq7canary', kind: 'plain' } }));
  L.push(J({ timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: null } }));
  L.push(J({ timestamp: T, type: 'compacted', payload: { message: 'zq7canary summary' } }));
  return L.join('\n') + '\n';
}
for (const x of ['a', 'b', 'c']) writeFileSync(join(dir, `codex-${x}.jsonl`), codex());

// Gemini-CLI-shaped (its five kinds of line): not a captured file
function gemini() {
  const m1 = uuid(), m2 = uuid();
  const L = [];
  L.push(J({ sessionId: uuid(), projectHash: 'zqhash7canary', startTime: T, lastUpdated: T, kind: 'main' }));
  L.push(J({ id: m1, timestamp: T, type: 'user', content: [{ text: 'zq7canary' }] }));
  L.push(J({ id: m2, timestamp: T, type: 'gemini', content: '', model: 'zqmodel', thoughts: [{ subject: 'zq', description: 'zq7canary', timestamp: T }], toolCalls: [{ id: 'zq', name: 'read_file', args: { absolute_path: '/home/zqcanary' }, status: 'success', timestamp: T }] }));
  L.push(J({ $set: { lastUpdated: T } }));
  L.push(J({ $rewindTo: m1 }));
  L.push(J({ $patch: { id: m2, removeIds: [m1] } }));
  return L.join('\n') + '\n';
}
for (const x of ['a', 'b', 'c']) writeFileSync(join(dir, `gemini-${x}.jsonl`), gemini());

// Two sketch vocabularies, for the supplier-neutrality test only: ltms ships neither. Their names are the S373
// prototype's sketches', as an earlier research note quoted them from the two programs' public source (not checked
// against that source here); each is incomplete by design.
const vocabulary = (o) => '{\n' + Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n}\n';
writeFileSync(join(dir, 'codex.sketch.json'), vocabulary({
  format: 'ltms-shapes-vocabulary/0',
  name: 'codex-sketch',
  source: "A test fixture of ltms (test/make-shapes-fixtures.mjs), not a vocabulary it ships: a sketch of Codex's rollout line, from names quoted from openai/codex at 81b995a6 (codex-rs/protocol), incomplete by design. A real vocabulary is compiled from that source at a pinned commit; nobody's transcripts are needed for it.",
  kinds: { path: '.type', sub: { response_item: '.payload.type', event_msg: '.payload.type' } },
  versions: ['.payload.cli_version'],
  paths: ['.timestamp', '.ordinal', '.type', '.payload', '.metadata',
    '.payload.type', '.payload.id', '.payload.session_id', '.payload.timestamp', '.payload.cwd', '.payload.originator',
    '.payload.cli_version', '.payload.source', '.payload.model_provider', '.payload.base_instructions', '.payload.history_mode',
    '.payload.forked_from_id', '.payload.parent_thread_id', '.payload.history_base', '.payload.subagent_history_start_ordinal',
    '.payload.turn_id', '.payload.root_turn_id', '.payload.approval_policy', '.payload.permission_profile', '.payload.model',
    '.payload.effort', '.payload.role', '.payload.content', '.payload.content[]', '.payload.content[].type',
    '.payload.content[].text', '.payload.name', '.payload.arguments', '.payload.call_id', '.payload.output',
    '.payload.message', '.payload.kind', '.payload.info'],
  values: {
    '.type': ['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted', 'inter_agent_communication',
      'inter_agent_communication_metadata', 'token_usage_record', 'world_state', 'retained_context', 'security_risk_score',
      'dynamic_tools_updated', 'realtime_item'],
    '.payload.type': ['message', 'token_count', 'thread_goal_updated', 'thread_rolled_back', 'turn_aborted', 'turn_started', 'turn_complete',
      'thread_settings_applied', 'user_message', 'agent_message', 'agent_reasoning', 'item_completed'],
    '.payload.history_mode': ['legacy', 'paginated'],
  },
}));
writeFileSync(join(dir, 'gemini-cli.sketch.json'), vocabulary({
  format: 'ltms-shapes-vocabulary/0',
  name: 'gemini-cli-sketch',
  source: "A test fixture of ltms (test/make-shapes-fixtures.mjs), not a vocabulary it ships: a sketch of Gemini CLI's chat recording lines (the metadata line, MessageRecord, $set, $rewindTo, $patch), from names quoted from google-gemini/gemini-cli at 4ed06ed0 (chatRecordingTypes.ts), incomplete by design.",
  kinds: { path: '.type', sub: {} },
  versions: [],
  paths: ['.sessionId', '.projectHash', '.startTime', '.lastUpdated', '.kind', '.directories', '.directories[]',
    '.id', '.timestamp', '.type', '.content', '.content[]', '.content[].text', '.displayContent', '.model',
    '.thoughts', '.thoughts[]', '.thoughts[].subject', '.thoughts[].description', '.thoughts[].timestamp',
    '.toolCalls', '.toolCalls[]', '.toolCalls[].id', '.toolCalls[].name', '.toolCalls[].args', '.toolCalls[].status',
    '.toolCalls[].timestamp', '.toolCalls[].result', '.tokens',
    '.$set', '.$set.lastUpdated', '.$set.summary', '.$set.directories', '.$set.memoryScratchpad',
    '.$rewindTo',
    '.$patch', '.$patch.id', '.$patch.content', '.$patch.toolCalls', '.$patch.updates', '.$patch.removeIds',
    '.$patch.removeIds[]', '.$patch.orderIds'],
  values: { '.type': ['user', 'info', 'error', 'warning', 'gemini'], '.kind': ['main', 'subagent'] },
}));
process.stderr.write(`make-shapes-fixtures: wrote 12 files to ${dir}\n`);
