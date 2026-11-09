// Writes the generated test fixtures (each is introduced by a comment below: labels, unanswered, cycle, rare-shapes,
// journal-launched, lexer, labels2, errors, parallel, compacted and compacted-nopointer, stale-head, retried3,
// orphan-first, the cycle-* three, content, parallel-msgid, request-two-turns, errors2, unicode, parallel-fail,
// api-request-records, types-only, passed-over, nul-padding; then the library-* fixtures of test/library.test.mjs, and
// the search-* fixtures of test/search.test.mjs).
// Every string in them is invented; the record format follows the hand-written
// fixtures (edges.jsonl). The output is the same on every run.
//
//   node test/make-fixtures.mjs test/fixtures
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const DIR = process.argv[2];
if (!DIR) { console.error('usage: node test/make-fixtures.mjs <directory to write the fixtures in, e.g. test/fixtures>'); process.exit(2); }
const env = (sid) => ({ isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid });
function file(name, sid, pre) {
  const lines = []; let n = 0, last = null, sec = 0;
  const uuid = (k) => `${pre}-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const ts = () => { sec += 2; return new Date(Date.UTC(2026, 7, 1, 10, 0, sec)).toISOString(); };
  const api = {
    raw(obj) { lines.push(JSON.stringify(obj)); },
    prompt(text, extra = {}, parent = last) { const u = uuid(++n); lines.push(JSON.stringify({ parentUuid: parent, ...env(sid), type: 'user', message: { role: 'user', content: text }, uuid: u, timestamp: ts(), promptId: `${pre}-1111-4000-8000-${String(n).padStart(12, '0')}`, ...extra })); last = u; return u; },
    use(id, name, input, parent = last, extra = {}) { const u = uuid(++n); lines.push(JSON.stringify({ parentUuid: parent, ...env(sid), type: 'assistant', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } }, requestId: `req_${id}`, uuid: u, timestamp: ts(), ...extra })); last = u; return u; },
    result(id, content, { isError = false, tur, blocks, parent = last } = {}) {
      const u = uuid(++n);
      const block = { tool_use_id: id, type: 'tool_result', content, is_error: isError };
      const rec = { parentUuid: parent, ...env(sid), type: 'user', message: { role: 'user', content: blocks ? blocks(block) : [block] }, uuid: u, timestamp: ts(),
        toolUseResult: tur ?? (isError ? `Error: ${typeof content === 'string' ? content : 'demo failure text'}` : { stdout: 'demo standard output', stderr: '', interrupted: false, isImage: false }),
        sourceToolAssistantUUID: parent };
      lines.push(JSON.stringify(rec)); last = u; return u;
    },
    text(t, parent = last, extra = {}) { const u = uuid(++n); lines.push(JSON.stringify({ parentUuid: parent, ...env(sid), type: 'assistant', message: { id: `msg_${pre}_${n}`, type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }, requestId: `req_${pre}_${n}`, uuid: u, timestamp: ts(), ...extra })); last = u; return u; },
    replay(lineNo, newParent) { const o = JSON.parse(lines[lineNo - 1]); if (newParent !== undefined) o.parentUuid = newParent; lines.push(JSON.stringify(o)); },
    leaf(text, u = last) { lines.push(JSON.stringify({ type: 'last-prompt', lastPrompt: text, leafUuid: u, sessionId: sid })); },
    uuid, get last() { return last; }, set last(v) { last = v; },
    write() { writeFileSync(join(DIR, name), lines.join('\n') + '\n'); },
  };
  return api;
}

// labels.jsonl: one rule of the label check per call, then two prompts whose channel is the record's own word.
{
  const f = file('labels.jsonl', '12121212-3434-4565-8787-909090909090', 'd1000000');
  const p1 = 'Exercise every labelling rule in the demo project.';
  f.prompt(p1, { promptSource: 'typed' });
  const calls = [
    ['toolu_labels_01', 'Skill', { skill: { note: 'INVENTED PAYLOAD TEXT inside the skill field' } }],
    ['toolu_labels_02', 'Agent', { subagent_type: 'a long invented sentence standing in for free text typed into the field', description: 'invented review task', prompt: 'Review the invented demo changes.' }],
    ['toolu_labels_03', 'Read', { file_path: 'C:\\Users\\invented.person\\projects\\Makefile' }],
    ['toolu_labels_04', 'Read', { file_path: 'C:\\Users\\invented.person\\notes\\plan.txt' }],
    ['toolu_labels_05', 'Bash', { command: 'C:\\Users\\invented.person\\bin\\tool.exe --x' }],
    ['toolu_labels_06', 'Bash', { command: 'T=$(cat /work/demo-project/secret-token.txt)' }],
    ['toolu_labels_07', 'Bash', { command: 'TS=$(date +%s.%N)\nnpm test' }],
    ['toolu_labels_08', 'Bash', { command: '{ make demo; } 2>&1' }],
    ['toolu_labels_09', 'Bash', { command: 'nice -n 10 make demo' }],
    ['toolu_labels_10', 'Bash', { command: 'cd /work/demo-project\nnpm test' }],
    ['toolu_labels_11', 'Bash', { command: '"$PY" scripts/demo.py' }],
    ['toolu_labels_12', 'Bash', { command: '[[ -f demo.txt ]] && make demo' }],
    ['toolu_labels_13', 'Bash', { command: '# a comment line\nls -la' }],
    ['toolu_labels_14', 'Bash', { command: 'timeout -s KILL 10 make demo' }],
    ['toolu_labels_15', 'Bash', { command: 'env -i PATH=/usr/bin make demo' }],
    ['toolu_labels_16', 'Bash', { command: '(cd /work/demo-project && make demo)' }],
    ['toolu_labels_17', 'Bash', { command: '! grep -q demo notes.txt' }],
    ['toolu_labels_18', 'Bash', { command: '2>/dev/null ls' }],
    ['toolu_labels_19', 'Bash', { command: 'REV="$(git rev-parse HEAD)"' }],
    ['toolu_labels_20', 'do something invented', { what: 'an invented tool that no harness defines' }],
    ['toolu_labels_21', 'Bash', { command: 'cd /work/demo-project && FILES=$(ls *.txt) && wc -l $FILES' }],
    ['toolu_labels_22', 'Bash', { command: 'A=1 B=\'two words\' C="$(echo nested $(pwd))" make demo' }],
    ['toolu_labels_23', 'Bash', { command: './node_modules/.bin/a-very-long-program-name-that-goes-past-the-sixty-four-character-label-limit --x' }],
    ['toolu_labels_24', 'Bash', { command: 'sudo -u demo make install' }],
    ['toolu_labels_25', 'Bash', { command: 'cd /work/demo-project 2>/dev/null && make demo' }],
    ['toolu_labels_26', 'Bash', { command: 'F=(); for f in *.txt; do F+=("$f"); done' }],
    ['toolu_labels_27', 'Bash', { command: '$DEMO_DIR/scripts/demo-run.sh --fast' }],
    ['toolu_labels_28', 'Bash', { command: 'MARK="demo-$(head -c6 /dev/urandom | od -An -tx1)"\nsystemctl --user status demo.service' }],
  ];
  calls.forEach(([id, name, input], i) => { f.use(id, name, input); f.result(id, `invented output number ${String(i + 1).padStart(2, '0')}`); });
  f.text('Every rule was exercised on the demo project.');
  f.prompt('A message relayed from another invented agent.', { origin: { kind: 'peer' } });
  f.text('The peer message was read.');
  f.prompt('A message whose origin field holds free text.', { origin: { kind: 'free text with spaces in the origin kind' } });
  f.text('That message was read too.');
  f.leaf('A message whose origin field holds free text.');
  f.write();
}

// unanswered.jsonl: a failed make, a make whose result was never written, a passing make; then a call
// at the end of the file, cut before it returned.
{
  const f = file('unanswered.jsonl', '23232323-4545-4676-8898-a0a0a0a0a0a0', 'd3000000');
  f.prompt('Run the demo tests until they pass.', { promptSource: 'typed' });
  f.use('toolu_unanswered_01', 'Bash', { command: 'make test' });
  f.result('toolu_unanswered_01', 'Exit code 2\nmake: *** [test] Error 2', { isError: true });
  f.use('toolu_unanswered_02', 'Bash', { command: 'make test' });
  f.use('toolu_unanswered_03', 'Bash', { command: 'make test' });
  f.result('toolu_unanswered_03', 'all demo tests passed at last');
  f.text('The tests pass now.');
  f.prompt('Now build the demo release.', { promptSource: 'typed' });
  f.use('toolu_unanswered_04', 'Bash', { command: 'make release' });
  f.leaf('Now build the demo release.');
  f.write();
}

// cycle.jsonl: a prompt whose parentUuid names itself, a call below it, and two records that name each other.
{
  const f = file('cycle.jsonl', '34343434-5656-4787-89a9-b0b0b0b0b0b0', 'd5000000');
  const u1 = f.uuid(1);
  f.prompt('Run the demo tests once.', { promptSource: 'typed' }, u1);
  f.use('toolu_cycle_01', 'Bash', { command: 'make test' });
  f.result('toolu_cycle_01', 'all demo tests passed');
  const a = f.uuid(4), b = f.uuid(5);
  f.text('An invented record whose parent is the next one.', b);
  f.text('An invented record whose parent is the previous one.', a);
  f.write();
}

// rare-shapes.jsonl: result content holding a bare string; a hook block that only the PreToolUse: prefix
// identifies; a tool result recognised only by toolUseResult (its first block is text); and the first
// call and its result written again at the end, the call re-parented, as replays are.
{
  const f = file('rare-shapes.jsonl', '45454545-6767-4898-8aba-c0c0c0c0c0c0', 'd7000000');
  f.prompt('Show the rare record shapes of the demo project.', { promptSource: 'typed' });
  f.use('toolu_rare_01', 'Bash', { command: 'make demo-report' });
  f.result('toolu_rare_01', ['the first part, as a bare string', { type: 'text', text: 'the second part, as a text block' }]);
  f.use('toolu_rare_02', 'Read', { file_path: '/work/elsewhere/invented-outside-file.txt' });
  f.result('toolu_rare_02', 'PreToolUse:Read hook error: [node /work/demo-project/.claude/hooks/demo-guard.mjs]: refused: reads outside the demo project', { isError: true });
  f.use('toolu_rare_03', 'Bash', { command: 'make demo-lint' });
  f.result('toolu_rare_03', 'demo lint found nothing to report', { blocks: (b) => [{ type: 'text', text: 'an invented note written before the result block' }, b] });
  const end = f.text('The rare shapes were shown.');
  f.replay(2, end);
  f.replay(3);
  f.leaf('Show the rare record shapes of the demo project.', end);
  f.write();
}

// journal-launched.jsonl: a workflow journal as newer harness versions write it, opening with "launched".
writeFileSync(join(DIR, 'journal-launched.jsonl'), [
  { type: 'launched' },
  { type: 'started', key: 'v2:0000000000000000000000000000000000000000000000000000000000000002', agentId: 'demo-agent-2', label: 'invented label', phase: 'invented phase' },
  { type: 'result', key: 'v2:0000000000000000000000000000000000000000000000000000000000000002', agentId: 'demo-agent-2', result: 'invented result text' },
].map((o) => JSON.stringify(o)).join('\n') + '\n');

// ---- the second set: what the pre-publish review found (every string invented; ZQX markers must never print) ----

// lexer.jsonl: one Bash call per shape the verb lexer must read, or must withhold (fail closed)
const LEXER_CASES = [
  // [command, expected verb]
  ["MSG=$(cat <<'EOF'\nTwo invented fixes:\n1) ZQXA01 parser guard\nEOF\n)\ngit commit -m \"$MSG\"", '(withheld)'],
  ['exec 3<<EOF\nZQXA02 invented secret\nEOF\ncat <&3', '(withheld)'],
  ['cd /work/demo-project <<EOF\nZQXA03 body word\nEOF', 'cd'],
  ['<<EOF\nZQXA04 body\nEOF', '(withheld)'],
  ["X=$'a\\' ZQXA05 b'", '(withheld)'],
  ['NAME="${NAME:-"Invented ZQXA06 Person"}" ./run.sh', '(withheld)'],
  ["X=$(echo a # a comment with ) and 'ZQXA07\n)\nmake demo", '(withheld)'],
  ['X=$(case $y in a) echo ZQXA08;; esac)', '(withheld)'],
  ['((ZQXA09++))', '(withheld)'],
  ['X=$[ZQXA10+1]', '(withheld)'],
  ["X='$(ZQXA11 invented)'", '(empty)'],
  ['X="it\'s $(date +%s)"', '(withheld)'],
  ['command time -o payroll-ZQXA12.txt make demo', 'time'],
  ['env -P /opt/ZQXA13/bin make demo', '(withheld)'],
  ["env -S 'ZQXA14 make'", '(withheld)'],
  ['time --format=ZQXA15 make demo', '(withheld)'],
  ['nice -n10 make demo', '(withheld)'],
  ['timeout --signal=KILL 5 make demo', '(withheld)'],
  ['exec -a ZQXA16 make demo', '(withheld)'],
  ['timeout --kill-sig=9 5 ZQXA17', '(withheld)'],
  ['X=$(make', '(withheld)'],
  ['echo "ZQXA18 never closed', 'echo'],
  ['ZQXA19name() { make demo; }', '(withheld)'],
  ['function ZQXA20 { make demo; }', '(withheld)'],
  ['env | grep zqx', 'env'],
  ['cd /work/demo-project &>/dev/null && make demo', 'make'],
  ["IFS=$'\\n' read -r line", '(withheld)'],
  [Array.from({ length: 70 }, (_, i) => `V${i}=1`).join(' ') + ' make demo', '(withheld)'],
  ['X=$(cat ZQXA21.txt) && wc -l "$X"', 'wc'],
  [': > /work/demo-project/out.txt', ':'],
  ['g++ demo.cpp -o demo', 'g++'],
  ['./' + 'a'.repeat(64) + ' --x', 'a'.repeat(64)],
  ['./' + 'b'.repeat(65) + ' --x', '(withheld)'],
  ['X="$(printf %s "ZQXA22") done"', '(withheld)'],
  // whitelist edges: what is passed over must be plain or passable; the program must be plain
  ['N=${#ZQXA23}\necho }ZQXA24 ZQXA25', '(withheld)'],
  ['X=1 \\\nZQXA26 a', '(withheld)'],
  ['nohup X=1 ZQXA27 a', '(withheld)'],
  ['builtin ZQXA28', 'builtin'],
  ['ZQXA29 () { make demo; }', '(withheld)'],
  ['X=1 time ZQXA30 a', 'time'],
  ['command -v ZQXA31', '(withheld)'],
  ['cd "/work/demo project" && make demo', 'make'],
  ['cd "$HOME/demo" 2>/dev/null && make demo', 'make'],
  ["X='a b c' Y=\"$HOME/x\" make demo", 'make'],
  ['# a comment line ending in a backslash \\\nmake demo', 'make'],
  ['X=$(cat <<EOF\nZQXA32) ZQXA33\nEOF\n)', '(withheld)'],
  ['X=$(case v in a) ZQXA34 b;; esac)', '(withheld)'],
  ['env -i PATH=/usr/bin make demo', 'make'],
  ['F=$(ls *.txt) && wc -l $F', 'wc'],
  ['"$DIR"/bin/ZQXA35 --x', '(withheld)'],
  ['X=1; cd /work/demo-project && make demo', 'make'],
  ['X=$(git rev-parse HEAD) make demo', 'make'],
  ['timeout 5 nice -n 3 env A=1 make demo', 'make'],
  ['2 >ZQXA36 ZQXA37', '2'],
  // the shapes a third review's surviving mutants printed: each refusal pinned
  ['A="x\\" ZQXA38 ;" make demo', '(withheld)'],
  ['A="`" ZQXA39 "`" make demo', '(withheld)'],
  ['1A=x ZQXA40', '(withheld)'],
  ['A-B=1 ZQXA41', '(withheld)'],
  ['X=$(a (b) ZQXA42)', '(withheld)'],
  ['X=$(ab{ c) make demo', '(withheld)'],
  ['{ cd /work/demo-project; } ZQXA43', '(withheld)'],
  ['X="$(a)x ZQXA44;" make demo', '(withheld)'],
  ['X=$(a)ZQXA45 make demo', '(withheld)'],
  ['time -pZQXA46 a', '(withheld)'],
  ['timeout 5ZQXA47 make demo', '(withheld)'],
  ['nice -5ZQXA48 make demo', '(withheld)'],
  ['env -iZQXA49 make demo', '(withheld)'],
  ['ZQXA50 ( ) { make demo; }', '(withheld)'],
  // after env a NAME=value is an argument: an unquoted $NAME is split by bash; quoted it is one word
  ['env X=$V make demo', '(withheld)'],
  ['env X="$V" make demo', 'make'],
  // after a wrapper, command and exec are programs on PATH, not the shell's builtins
  ['nohup command make demo', 'command'],
  ['timeout 5 exec make demo', 'exec'],
  ['command make demo', 'make'],
  // ... but only after a wrapper that looks its next word up on PATH (nohup, env, nice, timeout, exec). After command (a
  // builtin) or time (a keyword), command and exec are still the shell's builtins, and bash runs the word after them
  ['command exec make demo', 'make'],
  ['command command make demo', 'make'],
  ['time command make demo', 'make'],
  ['time -p command make demo', 'make'],
  ['time exec make demo', 'make'],
  ['X=1 command exec make demo', 'make'],
  ['{ command exec make demo; }', 'make'],
  ['( time command make demo )', 'make'],
  ['! command exec make demo', 'make'],
  ['cd /work/demo-project && time exec make demo', 'make'],
  ['# a comment\ncommand exec make demo', 'make'],
  ['exec command make demo', 'command'],
  ['env exec make demo', 'exec'],
  ['nice command make demo', 'command'],
  ['exec exec make demo', 'exec'],
  // a wrapper with only its options after it is the program, for nice as for env -i, timeout 5 and time -p
  ['nice -n 5', 'nice'],
  ['nice -19', 'nice'],
  ['nice -n 5; make demo', 'nice'],
  // a redirection right after a wrapper or its options: bash applies it and runs the next word, which this does not read
  ['nice -19>/dev/null make demo', '(withheld)'],
  ['nice -n 5>/dev/null make demo', '(withheld)'],
  ['nice -19&>/dev/null make demo', '(withheld)'],
  ['nohup >/dev/null make demo', '(withheld)'],
  ['env &>/dev/null make demo', '(withheld)'],
  ['timeout 5 >/dev/null make demo', '(withheld)'],
  ['command <input.txt make demo', '(withheld)'],
  // time right after the time keyword is the keyword again (bash's grammar); after nohup it is a program on PATH
  ['time time make demo', 'make'],
  ['time -p time make demo', 'make'],
  ['time time -p make demo', 'make'],
  ['nohup time make demo', 'time'],
  // env's assignments count toward the limit of 63 words before the program
  ['env ' + 'A=1 '.repeat(70) + 'make demo', '(withheld)'],
];
{
  const f = file('lexer.jsonl', '56565656-7878-4909-8bcb-d0d0d0d0d0d0', 'd9000000');
  f.prompt('Run each invented shell shape once.', { promptSource: 'typed' });
  LEXER_CASES.forEach(([command], i) => {
    const id = `toolu_lexer_${String(i + 1).padStart(2, '0')}`;
    f.use(id, 'Bash', { command });
    f.result(id, `invented lexer output ${String(i + 1).padStart(2, '0')}`);
  });
  f.text('Every shape was run.');
  f.leaf('Run each invented shell shape once.');
  f.write();
}
writeFileSync(join(DIR, 'lexer.expected.json'), JSON.stringify(LEXER_CASES.map(([, v]) => v)) + '\n');

// labels2.jsonl: labels that are not strings, at the length limit, and file names with a ':' in them
const LABEL2_CASES = [
  ['Agent', { subagent_type: ['zqx-array-ZQXB01'], description: 'invented task one', prompt: 'Invented prompt one.' }, '(withheld)'],
  ['Agent', { subagent_type: 42, description: 'invented task two', prompt: 'Invented prompt two.' }, '(withheld)'],
  ['Skill', { skill: ['ZQXB02-skill'] }, '(withheld)'],
  ['Agent', { subagent_type: 'team/ZQXB03', description: 'invented task three', prompt: 'Invented prompt three.' }, '(withheld)'],
  ['mcp__demo_server__demo_tool', { query: 'an invented query ZQXB04' }, 'mcp__demo_server__demo_tool'],
  ['Read', { file_path: 'invented-host:ZQXB05' }, '(withheld)'],
  ['Read', { file_path: '/work/demo-project/notes.txt:ZQXB06' }, '(withheld)'],
  ['Read', { file_path: { toString: 'ZQXB07 not callable' } }, '(withheld)'],
  ['Bash', { command: { ZQXB08: 'an object, not a command' } }, '(withheld)'],
  ['Bash', { command: ['ZQXB09-command-in-an-array'] }, '(withheld)'],
  ['Bash', { command: true }, '(withheld)'],
  ['Read', { file_path: '/work/demo-project/' + 'f'.repeat(65) }, '(withheld)'],
  ['Read', { file_path: '/work/demo-project/' + 'g'.repeat(64) }, 'g'.repeat(64)],
];
{
  const f = file('labels2.jsonl', '67676767-8989-4a1a-8cdc-e0e0e0e0e0e0', 'da000000');
  f.prompt('Exercise the remaining label rules.', { promptSource: 'typed' });
  LABEL2_CASES.forEach(([name, input], i) => {
    const id = `toolu_labels2_${String(i + 1).padStart(2, '0')}`;
    f.use(id, name, input);
    f.result(id, `invented label output ${String(i + 1).padStart(2, '0')}`);
  });
  f.text('The remaining rules were exercised.');
  f.leaf('Exercise the remaining label rules.');
  f.write();
}
writeFileSync(join(DIR, 'labels2.expected.json'), JSON.stringify(LABEL2_CASES.map(([n, , v]) => [n, v])) + '\n');

// errors.jsonl: error classes come from the harness's own formats only, never from words of a tool's output
{
  const f = file('errors.jsonl', '78787878-9a9a-4b2b-8ded-f0f0f0f0f0f0', 'db000000');
  f.prompt('Run the invented failing tools.', { promptSource: 'typed' });
  const cases = [
    ['toolu_errors_01', 'WebFetch', { url: 'https://example.invalid/ZQXC01' }, 'Request blocked by the corporate hook [ZQXC02_client.js] see the invented log'],
    ['toolu_errors_02', 'Read', { file_path: '/work/demo-project/a.txt' }, 'Error: an invented failure\nthe log said Exit code 4111111111111111 at the end'],
    ['toolu_errors_03', 'Bash', { command: 'make demo' }, 'PreToolUse:Bash hook error: [bash /work/demo-project/.claude/hooks/' + 'h'.repeat(60) + '.sh]: an invented refusal'],
    ['toolu_errors_04', 'Bash', { command: 'make demo' }, 'Exit code 1\nmake: an invented error'],
    ['toolu_errors_05', 'Bash', { command: 'make demo' }, 'Exit code 4096\nan invented error with a long code'],
    ['toolu_errors_06', 'Bash', { command: 'make demo' }, 'PreToolUse:Bash hook error: [node /work/demo-project/.claude/hooks/demo-guard.mjs]: an invented refusal'],
  ];
  for (const [id, name, input, text] of cases) { f.use(id, name, input); f.result(id, text, { isError: true }); }
  f.text('The failures were seen.');
  f.leaf('Run the invented failing tools.');
  f.write();
}

// parallel.jsonl: two calls of ONE API response; the second call's result is written first, and the session goes
// on from the first call's result. Both calls belong to the turn.
{
  const sid = '89898989-abab-4c3c-8efe-a1a1a1a1a1a1', pre = 'dc000000';
  const f = file('parallel.jsonl', sid, pre);
  const p = f.prompt('Read two invented files at once.', { promptSource: 'typed' });
  const a1 = f.uuid(2), a2 = f.uuid(3), r2 = f.uuid(4), r1 = f.uuid(5), t = f.uuid(6);
  const env = { isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid };
  const msg = (id, block) => ({ id: 'msg_parallel_01', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [block], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } });
  f.raw({ parentUuid: p, ...env, type: 'assistant', message: msg('a', { type: 'tool_use', id: 'toolu_parallel_01', name: 'Read', input: { file_path: '/work/demo-project/one.txt' } }), requestId: 'req_parallel_01', uuid: a1, timestamp: '2026-08-01T11:00:02.000Z' });
  f.raw({ parentUuid: a1, ...env, type: 'assistant', message: msg('b', { type: 'tool_use', id: 'toolu_parallel_02', name: 'Read', input: { file_path: '/work/demo-project/two.txt' } }), requestId: 'req_parallel_01', uuid: a2, timestamp: '2026-08-01T11:00:02.100Z' });
  f.raw({ parentUuid: a2, ...env, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_parallel_02', type: 'tool_result', content: 'the invented second file' }] }, uuid: r2, timestamp: '2026-08-01T11:00:03.000Z', toolUseResult: { type: 'text' }, sourceToolAssistantUUID: a2 });
  f.raw({ parentUuid: a1, ...env, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_parallel_01', type: 'tool_result', content: 'the invented first file' }] }, uuid: r1, timestamp: '2026-08-01T11:00:04.000Z', toolUseResult: { type: 'text' }, sourceToolAssistantUUID: a1 });
  f.raw({ parentUuid: r1, ...env, type: 'assistant', message: { id: 'msg_parallel_02', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: 'Both invented files were read.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }, requestId: 'req_parallel_02', uuid: t, timestamp: '2026-08-01T11:00:05.000Z' });
  f.leaf('Read two invented files at once.', t);
  f.write();
}

// compacted.jsonl / compacted-nopointer.jsonl: a full compaction (the boundary is a new root whose
// logicalParentUuid names the last record before it). The segment before it is the longer one. Without a
// last-prompt pointer the path still ends at the last record written, and the join still brings the first segment.
for (const [name, pointer] of [['compacted.jsonl', true], ['compacted-nopointer.jsonl', false]]) {
  const sid = pointer ? '9a9a9a9a-bcbc-4d4d-8f0f-b2b2b2b2b2b2' : 'abababab-cdcd-4e5e-8a1a-c3c3c3c3c3c3';
  const f = file(name, sid, pointer ? 'dd000000' : 'de000000');
  f.prompt('Build the invented demo, part one.', { promptSource: 'typed' });
  for (let i = 1; i <= 3; i++) { f.use(`toolu_${pointer ? 'cp' : 'cn'}_0${i}`, 'Bash', { command: `make part-${i}` }); f.result(`toolu_${pointer ? 'cp' : 'cn'}_0${i}`, `invented part ${i} built`); }
  const before = f.text('Part one is built.');
  const boundary = f.uuid(20), summary = f.uuid(21);
  const env = { isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid };
  f.raw({ parentUuid: null, logicalParentUuid: before, ...env, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 12000 }, uuid: boundary, timestamp: '2026-08-01T12:00:00.000Z' });
  f.raw({ parentUuid: boundary, ...env, type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary of part one.' }, uuid: summary, timestamp: '2026-08-01T12:00:01.000Z' });
  f.last = summary;
  f.prompt('Build the invented demo, part two.', { promptSource: 'typed' });
  f.use(`toolu_${pointer ? 'cp' : 'cn'}_04`, 'Bash', { command: 'make part-4' });
  f.result(`toolu_${pointer ? 'cp' : 'cn'}_04`, 'invented part 4 built');
  const end = f.text('Part two is built.');
  if (pointer) f.leaf('Build the invented demo, part two.', end);
  f.write();
}

// stale-head.jsonl: the last-prompt pointer was written before the final exchange, which sits below it
{
  const f = file('stale-head.jsonl', 'bcbcbcbc-dede-4f6f-8b2b-d4d4d4d4d4d4', 'df000000');
  const p = f.prompt('Run the two invented checks.', { promptSource: 'typed' });
  f.leaf('Run the two invented checks.', p);
  f.use('toolu_stale_01', 'Bash', { command: 'make check-one' }); f.result('toolu_stale_01', 'invented check one passed');
  f.use('toolu_stale_02', 'Bash', { command: 'make check-two' }); f.result('toolu_stale_02', 'invented check two passed');
  f.text('Both invented checks passed.');
  f.write();
}

// retried3.jsonl: a request failed; the retried branch made three calls; the api_error record was written after
// all of them but parented before them, and the turn's last record hangs off the error
{
  const sid = 'cdcdcdcd-efef-4a7a-8c3c-e5e5e5e5e5e5';
  const f = file('retried3.jsonl', sid, 'e0000000');
  f.prompt('Run the invented suite with retries.', { promptSource: 'typed' });
  f.use('toolu_retry3_01', 'Bash', { command: 'make prepare' });
  const tip = f.result('toolu_retry3_01', 'invented preparation done');
  for (let i = 2; i <= 4; i++) { f.use(`toolu_retry3_0${i}`, 'Bash', { command: `make step-${i}` }); f.result(`toolu_retry3_0${i}`, `invented step ${i} done`); }
  const env = { isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid };
  const err = f.uuid(30);
  f.raw({ parentUuid: tip, ...env, type: 'system', subtype: 'api_error', level: 'error', content: 'invented connection reset', uuid: err, timestamp: '2026-08-01T10:00:05.000Z' });
  f.last = err;
  const end = f.text('The invented suite finished after a retry.');
  f.leaf('Run the invented suite with retries.', end);
  f.write();
}

// orphan-first.jsonl: the first record names a parent that is in no file
{
  const f = file('orphan-first.jsonl', 'dededede-0a0a-4b8b-8d4d-f6f6f6f6f6f6', 'e1000000');
  f.prompt('Continue the invented work.', { promptSource: 'typed' }, 'e1999999-0000-4000-8000-000000000999');
  f.use('toolu_orphan_01', 'Bash', { command: 'make continue' }); f.result('toolu_orphan_01', 'invented work continued');
  f.text('The invented work continued.');
  f.leaf('Continue the invented work.');
  f.write();
}

// cycle-stale.jsonl, cycle-logical.jsonl, cycle-head.jsonl: a parentUuid cycle reached through each guarded walk -
// the stale-head extension, a compaction join through the logical parent, and one through preservedSegment.headUuid
{
  const env = (sid) => ({ isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid });
  const rec = (sid, uuid, parent, type, content, extra = {}) => JSON.stringify({ parentUuid: parent, ...env(sid), type, message: type === 'user' ? { role: 'user', content } : { id: 'msg_' + uuid.slice(0, 8), type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: content }], stop_reason: 'end_turn' }, uuid, timestamp: '2026-08-01T13:00:00.000Z', ...(type === 'user' ? { promptSource: 'typed' } : { requestId: 'req_' + uuid.slice(0, 8) }), ...extra });
  const u = (pre, k) => `${pre}-0000-4000-8000-${String(k).padStart(12, '0')}`;
  let sid = 'e2e2e2e2-1111-4c9c-8e5e-a7a7a7a7a7a7', P = 'e2000000';
  writeFileSync(join(DIR, 'cycle-stale.jsonl'), [
    rec(sid, u(P, 1), null, 'user', 'An invented first prompt.'),
    rec(sid, u(P, 2), u(P, 1), 'assistant', 'An invented first reply.'),
    rec(sid, u(P, 3), u(P, 4), 'user', 'An invented prompt on a cycle.'),
    rec(sid, u(P, 4), u(P, 3), 'assistant', 'An invented reply on a cycle.'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'An invented prompt on a cycle.', leafUuid: u(P, 3), sessionId: sid }),
  ].join('\n') + '\n');
  sid = 'e3e3e3e3-2222-4dad-8f6f-b8b8b8b8b8b8'; P = 'e3000000';
  writeFileSync(join(DIR, 'cycle-logical.jsonl'), [
    rec(sid, u(P, 1), u(P, 2), 'user', 'An invented prompt on a cycle.'),
    rec(sid, u(P, 2), u(P, 1), 'assistant', 'An invented reply on a cycle.'),
    JSON.stringify({ parentUuid: null, logicalParentUuid: u(P, 2), ...env(sid), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', uuid: u(P, 3), timestamp: '2026-08-01T13:00:01.000Z' }),
    JSON.stringify({ parentUuid: u(P, 3), ...env(sid), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary.' }, uuid: u(P, 4), timestamp: '2026-08-01T13:00:02.000Z' }),
    rec(sid, u(P, 5), u(P, 4), 'user', 'An invented prompt after the compaction.'),
    rec(sid, u(P, 6), u(P, 5), 'assistant', 'An invented reply after the compaction.'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'An invented prompt after the compaction.', leafUuid: u(P, 6), sessionId: sid }),
  ].join('\n') + '\n');
  sid = 'e4e4e4e4-3333-4ebe-8a7a-c9c9c9c9c9c9'; P = 'e4000000';
  writeFileSync(join(DIR, 'cycle-head.jsonl'), [
    rec(sid, u(P, 1), u(P, 2), 'user', 'An invented prompt on a cycle.'),
    rec(sid, u(P, 2), u(P, 1), 'assistant', 'An invented reply on a cycle.'),
    JSON.stringify({ parentUuid: null, logicalParentUuid: u(P, 6), ...env(sid), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: u(P, 1), tailUuid: u(P, 6) } }, uuid: u(P, 3), timestamp: '2026-08-01T13:00:01.000Z' }),
    JSON.stringify({ parentUuid: u(P, 3), ...env(sid), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary.' }, uuid: u(P, 4), timestamp: '2026-08-01T13:00:02.000Z' }),
    rec(sid, u(P, 5), u(P, 4), 'user', 'An invented prompt after the compaction.'),
    rec(sid, u(P, 6), u(P, 5), 'assistant', 'An invented reply after the compaction.'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'An invented prompt after the compaction.', leafUuid: u(P, 6), sessionId: sid }),
  ].join('\n') + '\n');
}

// content.jsonl: a result holding only an image (two different images must hash apart), and nulls inside content arrays
{
  const f = file('content.jsonl', 'f5f5f5f5-4444-4fcf-8b8b-dadadadadada', 'e5000000');
  f.prompt('Look at the two invented pictures.', { promptSource: 'typed' });
  f.use('toolu_content_01', 'Read', { file_path: '/work/demo-project/one.png' });
  f.result('toolu_content_01', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZQXD01aW52ZW50ZWQgb25l' } }]);
  f.use('toolu_content_02', 'Read', { file_path: '/work/demo-project/two.png' });
  f.result('toolu_content_02', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZQXD02aW52ZW50ZWQgdHdv' } }]);
  f.use('toolu_content_03', 'Bash', { command: 'make demo' });
  f.result('toolu_content_03', [null, { type: 'text', text: 'the invented output after a null block' }]);
  // a null block directly in a message's content array (S3: every reader of block.type crashed on it)
  const a4 = f.uuid(40);
  f.raw({ parentUuid: f.last, isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: 'f5f5f5f5-4444-4fcf-8b8b-dadadadadada', type: 'assistant', message: { id: 'msg_content_04', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [null, { type: 'tool_use', id: 'toolu_content_04', name: 'Bash', input: { command: 'make demo-two' } }], stop_reason: 'tool_use' }, requestId: 'req_content_04', uuid: a4, timestamp: '2026-08-01T10:09:00.000Z' });
  f.last = a4;
  f.result('toolu_content_04', 'the invented second output');
  f.text('Both invented pictures were seen.');
  f.leaf('Look at the two invented pictures.');
  f.write();
}

// parallel-msgid.jsonl: parallel.jsonl as older harness versions wrote it: no requestId, so the records of the one API
// response share only message.id. Both calls still belong to the turn.
{
  const sid = '9a9a9a9a-bcbc-4d4d-8f0f-a2a2a2a2a2a2', pre = 'e6000000';
  const f = file('parallel-msgid.jsonl', sid, pre);
  const p = f.prompt('Read two more invented files at once.', { promptSource: 'typed' });
  const a1 = f.uuid(2), a2 = f.uuid(3), r2 = f.uuid(4), r1 = f.uuid(5), t = f.uuid(6), e = env(sid);
  const msg = (block) => ({ id: 'msg_pmsg_01', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [block], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } });
  f.raw({ parentUuid: p, ...e, type: 'assistant', message: msg({ type: 'tool_use', id: 'toolu_pmsg_01', name: 'Read', input: { file_path: '/work/demo-project/three.txt' } }), uuid: a1, timestamp: '2026-08-01T11:10:02.000Z' });
  f.raw({ parentUuid: a1, ...e, type: 'assistant', message: msg({ type: 'tool_use', id: 'toolu_pmsg_02', name: 'Read', input: { file_path: '/work/demo-project/four.txt' } }), uuid: a2, timestamp: '2026-08-01T11:10:02.100Z' });
  f.raw({ parentUuid: a2, ...e, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_pmsg_02', type: 'tool_result', content: 'the invented fourth file' }] }, uuid: r2, timestamp: '2026-08-01T11:10:03.000Z', toolUseResult: { type: 'text' }, sourceToolAssistantUUID: a2 });
  f.raw({ parentUuid: a1, ...e, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_pmsg_01', type: 'tool_result', content: 'the invented third file' }] }, uuid: r1, timestamp: '2026-08-01T11:10:04.000Z', toolUseResult: { type: 'text' }, sourceToolAssistantUUID: a1 });
  f.raw({ parentUuid: r1, ...e, type: 'assistant', message: { id: 'msg_pmsg_02', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: 'Both invented files were read again.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }, uuid: t, timestamp: '2026-08-01T11:10:05.000Z' });
  f.leaf('Read two more invented files at once.', t);
  f.write();
}

// request-two-turns.jsonl: one API response whose two records fall in two turns (a queued prompt was written between
// them). Its calls belong to the first turn, and each is printed once.
{
  const sid = 'abababab-cdcd-4e5e-8a1a-b3b3b3b3b3b3', pre = 'e7000000';
  const f = file('request-two-turns.jsonl', sid, pre);
  const p1 = f.prompt('Build the invented demo twice over.', { promptSource: 'typed' });
  const a1 = f.uuid(2), p2 = f.uuid(3), a2 = f.uuid(4), r1 = f.uuid(5), r2 = f.uuid(6), t = f.uuid(7), e = env(sid);
  const msg = (block) => ({ id: 'msg_rtt_01', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [block], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } });
  f.raw({ parentUuid: p1, ...e, type: 'assistant', message: msg({ type: 'tool_use', id: 'toolu_rtt_01', name: 'Bash', input: { command: 'make demo-one' } }), requestId: 'req_rtt_01', uuid: a1, timestamp: '2026-08-01T11:20:02.000Z' });
  f.raw({ parentUuid: a1, ...e, type: 'user', message: { role: 'user', content: 'A queued invented follow-up prompt.' }, uuid: p2, timestamp: '2026-08-01T11:20:02.050Z', promptId: 'e7000000-1111-4000-8000-000000000002', promptSource: 'typed' });
  f.raw({ parentUuid: p2, ...e, type: 'assistant', message: msg({ type: 'tool_use', id: 'toolu_rtt_02', name: 'Bash', input: { command: 'make demo-two' } }), requestId: 'req_rtt_01', uuid: a2, timestamp: '2026-08-01T11:20:02.100Z' });
  f.raw({ parentUuid: a2, ...e, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_rtt_01', type: 'tool_result', content: 'the invented first build' }] }, uuid: r1, timestamp: '2026-08-01T11:20:03.000Z', toolUseResult: { type: 'text' }, sourceToolAssistantUUID: a1 });
  f.raw({ parentUuid: r1, ...e, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_rtt_02', type: 'tool_result', content: 'the invented second build' }] }, uuid: r2, timestamp: '2026-08-01T11:20:04.000Z', toolUseResult: { type: 'text' }, sourceToolAssistantUUID: a2 });
  f.raw({ parentUuid: r2, ...e, type: 'assistant', message: { id: 'msg_rtt_02', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: 'Both invented builds ran.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }, requestId: 'req_rtt_02', uuid: t, timestamp: '2026-08-01T11:20:05.000Z' });
  f.leaf('A queued invented follow-up prompt.', t);
  f.write();
}

// errors2.jsonl: the exit code is read first, so a command's own output cannot change its class; no-anchor and not-read
// come from a first line only; a hook's name is its script's, never an argument written after it
{
  const f = file('errors2.jsonl', 'bcbcbcbc-eded-4f7f-8b3b-c4c4c4c4c4c4', 'e8000000');
  f.prompt('Run the second set of invented failing tools.', { promptSource: 'typed' });
  const cases = [
    ['toolu_errors2_01', 'Bash', { command: 'make demo-edit' }, 'Exit code 1\nmake: String to replace not found in the invented log'],
    ['toolu_errors2_02', 'Bash', { command: 'make demo-read' }, 'Exit code 2\nthe invented tool says you must read the manual'],
    ['toolu_errors2_03', 'Bash', { command: 'make demo-hook' }, 'PreToolUse:Bash hook error: [bash /work/demo-project/.claude/hooks/demo-gate.sh /work/demo-project/ZQXE21-argument.py]: an invented refusal'],
    ['toolu_errors2_04', 'Bash', { command: 'make demo-check' }, 'PreToolUse:Bash hook error: [python3 /work/demo-project/.claude/hooks/demo-check.py --strict]: an invented refusal'],
    ['toolu_errors2_05', 'Edit', { file_path: '/work/demo-project/a.txt', old_string: 'invented old text', new_string: 'invented new text' }, 'String to replace not found in file.\nString: invented old text'],
    ['toolu_errors2_06', 'Write', { file_path: '/work/demo-project/b.txt', content: 'invented content here' }, 'File has not been read yet. Read it first before writing to it.'],
    ['toolu_errors2_07', 'Edit', { file_path: '/work/demo-project/c.txt', old_string: 'invented old words', new_string: 'invented new words' }, 'An invented failure of another kind\nString to replace not found further down'],
  ];
  for (const [id, name, input, text] of cases) { f.use(id, name, input); f.result(id, text, { isError: true }); }
  f.text('The second set of failures was seen.');
  f.leaf('Run the second set of invented failing tools.');
  f.write();
}

// unicode.jsonl: text outside ASCII in a prompt, a file name and a result. n is what JavaScript counts (UTF-16 code
// units) and the hashes are of the UTF-8 bytes; a reader that took the file as latin1 would print other values.
{
  const f = file('unicode.jsonl', 'cdcdcdcd-fefe-4a8a-8c4c-d5d5d5d5d5d5', 'e9000000');
  const p = 'Summarise the invented café notes: naïve façade, 中文 text and an emoji 🙂.';
  f.prompt(p, { promptSource: 'typed' });
  f.use('toolu_unicode_01', 'Read', { file_path: '/work/demo-project/café-notes.txt' });
  f.result('toolu_unicode_01', 'Invented contents: déjà vu, 日本語, and 🙂🙂 twice.');
  f.text('The invented café notes were read.');
  f.leaf(p);
  f.write();
}

// parallel-fail.jsonl: two calls of one response; the first fails, the second (the same verb) succeeds. The second
// was sent before the failure existed: it is not a retry, and it does not close a chain.
{
  const sid = 'dededede-1212-4c4c-8e8e-e2e2e2e2e2e2', pre = 'ea000000';
  const f = file('parallel-fail.jsonl', sid, pre);
  const p = f.prompt('Build both invented parts at once.', { promptSource: 'typed' });
  const a1 = f.uuid(2), a2 = f.uuid(3), r2 = f.uuid(4), r1 = f.uuid(5), t = f.uuid(6), e = env(sid);
  const msg = (block) => ({ id: 'msg_pfail_01', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [block], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } });
  f.raw({ parentUuid: p, ...e, type: 'assistant', message: msg({ type: 'tool_use', id: 'toolu_pfail_01', name: 'Bash', input: { command: 'make part-one' } }), requestId: 'req_pfail_01', uuid: a1, timestamp: '2026-08-01T11:30:02.000Z' });
  f.raw({ parentUuid: a1, ...e, type: 'assistant', message: msg({ type: 'tool_use', id: 'toolu_pfail_02', name: 'Bash', input: { command: 'make part-two' } }), requestId: 'req_pfail_01', uuid: a2, timestamp: '2026-08-01T11:30:02.100Z' });
  f.raw({ parentUuid: a2, ...e, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_pfail_02', type: 'tool_result', content: 'the invented second part built' }] }, uuid: r2, timestamp: '2026-08-01T11:30:03.000Z', toolUseResult: { stdout: 'built', stderr: '' }, sourceToolAssistantUUID: a2 });
  f.raw({ parentUuid: a1, ...e, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_pfail_01', type: 'tool_result', content: 'Exit code 2\nthe invented first part failed', is_error: true }] }, uuid: r1, timestamp: '2026-08-01T11:30:04.000Z', toolUseResult: 'Error: Exit code 2', sourceToolAssistantUUID: a1 });
  f.raw({ parentUuid: r1, ...e, type: 'assistant', message: { id: 'msg_pfail_02', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: 'One invented part failed.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }, requestId: 'req_pfail_02', uuid: t, timestamp: '2026-08-01T11:30:05.000Z' });
  f.leaf('Build both invented parts at once.', t);
  f.write();
}

// api-request-records.jsonl: the records Claude Code 2.1.300 began to write beside the conversation (api-request,
// api-request-blob, api-request-shape: the API requests themselves, the system prompt among them) and the requestRef
// on assistant records. They carry no uuid, so they are side records: passed over, and nothing in them reaches the
// output (each holds a ZQX marker).
{
  const sid = '2a2a2a2a-3b3b-4c4c-8d8d-5e5e5e5e5e5e';
  const f = file('api-request-records.jsonl', sid, 'da000000');
  const req = (k) => `da000000-2222-4000-8000-${String(k).padStart(12, '0')}`;
  const hex = (c) => c.repeat(64);
  const blob = (h, text) => f.raw({ type: 'api-request-blob', sessionId: sid, hash: hex(h), message: { role: 'user', content: [{ type: 'text', text }] } });
  const request = (k, tail) => f.raw({ type: 'api-request', sessionId: sid, id: req(k), timestamp: `2026-08-01T10:00:0${k}.500Z`, version: '2.1.300', querySource: 'sdk',
    shapeHash: hex('a'), params: { model: 'claude-demo-model', max_tokens: 1000, thinking: { type: 'disabled' } }, keep: 0, tail, cacheControl: [{ type: 'ephemeral' }], requestDigest: hex('d') });
  f.prompt('Run the invented demo tests once.', { promptSource: 'typed' });
  f.raw({ type: 'api-request-shape', sessionId: sid, shapeHash: hex('a'), timestamp: '2026-08-01T10:00:01.000Z', version: '2.1.300',
    shape: { system: [{ type: 'text', text: 'ZQXR01 invented system prompt block' }], tools: [{ name: 'Bash', description: 'ZQXR02 invented tool description' }] } });
  blob('b', 'ZQXR03 invented request message');
  request(1, [hex('b')]);
  f.use('toolu_reqrec_01', 'Bash', { command: 'npm test' }, undefined, { requestRef: req(1) });
  f.result('toolu_reqrec_01', 'invented test output: 3 passed');
  blob('c', 'ZQXR04 invented tool result, as the next request carries it');
  request(2, [hex('b'), hex('c')]);
  f.text('The invented tests passed.', undefined, { requestRef: req(2) });
  f.leaf('Run the invented demo tests once.');
  f.write();
}

// types-only.jsonl: no conversation records. The warning names the record types it found, each label-checked: free
// text in a type field prints as (withheld).
writeFileSync(join(DIR, 'types-only.jsonl'), [
  JSON.stringify({ type: 'an invented free text type ZQXW01', note: 'an invented note' }),
  JSON.stringify({ type: 'summary', summary: 'an invented summary line' }),
].join('\n') + '\n');

// passed-over.jsonl: the Bash verb at its limit. Every call runs the same program after a preamble of commands the verb
// reader passes over: after 15 of them the verb is the program, after 16 it is (withheld) (the README: "more than 15
// commands passed over"). The first two calls mix the kinds (cd DIR, then NAME=value lines). Then, for each separator
// the README names (a new line, ';' and '&&') and each kind of command passed over (cd DIR, a command of one
// assignment, a command of two), a pair of calls, 15 commands and 16: the limit counts commands, whatever ends them and
// however many words each holds.
{
  const f = file('passed-over.jsonl', '0f1e2d3c-4b5a-4968-8776-655443322110', 'eb000000');
  const preamble = (k) => ['cd /work/demo-project', ...Array.from({ length: k - 1 }, (_, i) => `DEMO_STEP_${String(i + 1).padStart(2, '0')}=on`)];
  const separators = [['a new line', '\n'], ['a semicolon', '; '], ['&&', ' && ']];
  const kinds = [
    ['cd DIR', (nn) => `cd /work/demo-project/step-${nn}`],
    ['one assignment', (nn) => `DEMO_STEP_${nn}=on`],
    ['two assignments', (nn) => `DEMO_STEP_${nn}=on DEMO_MODE_${nn}=off`],
  ];
  f.prompt('Build the invented demo after each preamble.', { promptSource: 'typed' });
  let calls = 0;
  const call = (command, what) => {
    const id = `toolu_passed_${String(++calls).padStart(2, '0')}`;
    f.use(id, 'Bash', { command });
    f.result(id, `invented build output after ${what}`);
  };
  [15, 16].forEach((k) => call([...preamble(k), 'make demo'].join('\n'), `${k} commands passed over`));
  for (const [sepName, sep] of separators) for (const [kindName, kind] of kinds) for (const k of [15, 16]) {
    const commands = Array.from({ length: k }, (_, i) => kind(String(i + 1).padStart(2, '0')));
    call([...commands, 'make demo'].join(sep), `${k} commands passed over, each of ${kindName}, each followed by ${sepName}`);
  }
  f.text('Every invented build ran.');
  f.leaf('Build the invented demo after each preamble.');
  f.write();
}

// nul-padding.jsonl: the shapes of NUL padding the parser knows: a line of NUL bytes only (line 3), a record with a run
// of NUL bytes before it (line 4, the first call's result), NUL bytes with blanks between them (line 5), a record
// between two runs of NUL bytes (line 7, the second call's result) and a JSON array behind NUL bytes (line 8). ltms
// parses without repairNul, so it skips all five lines and says so on stderr; the library, given repairNul, reports
// lines 3 and 5 as padding, recovers lines 4 and 7, each reported as repaired, and reports line 8 once, as not an
// object. The NUL byte and the tab are built, not typed: an editor can turn a typed escape into the byte it names.
{
  const sid = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', e = env(sid);
  const u = (k) => `ec000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const NUL = String.fromCharCode(0), TAB = String.fromCharCode(9);
  writeFileSync(join(DIR, 'nul-padding.jsonl'), [
    JSON.stringify({ parentUuid: null, ...e, type: 'user', message: { role: 'user', content: 'Build the invented demo once more.' }, uuid: u(1), timestamp: '2026-08-01T14:00:00.000Z', promptSource: 'typed' }),
    JSON.stringify({ parentUuid: u(1), ...e, type: 'assistant', message: { id: 'msg_nul_01', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'tool_use', id: 'toolu_nul_01', name: 'Bash', input: { command: 'make demo' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } }, requestId: 'req_nul_01', uuid: u(2), timestamp: '2026-08-01T14:00:02.000Z' }),
    NUL.repeat(64),
    NUL.repeat(32) + JSON.stringify({ parentUuid: u(2), ...e, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_nul_01', type: 'tool_result', content: 'ZQXV01 the invented build output, written after NUL bytes', is_error: false }] }, uuid: u(3), timestamp: '2026-08-01T14:00:04.000Z',
      toolUseResult: { stdout: 'ZQXV02 invented standard output', stderr: '', interrupted: false, isImage: false }, sourceToolAssistantUUID: u(2) }),
    NUL.repeat(16) + ' ' + TAB + ' ' + NUL.repeat(16),
    JSON.stringify({ parentUuid: u(3), ...e, type: 'assistant', message: { id: 'msg_nul_02', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'tool_use', id: 'toolu_nul_02', name: 'Bash', input: { command: 'make check' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } }, requestId: 'req_nul_02', uuid: u(4), timestamp: '2026-08-01T14:00:06.000Z' }),
    NUL.repeat(16) + JSON.stringify({ parentUuid: u(4), ...e, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_nul_02', type: 'tool_result', content: 'ZQXV03 the invented check output, written between NUL bytes', is_error: false }] }, uuid: u(5), timestamp: '2026-08-01T14:00:08.000Z',
      toolUseResult: { stdout: 'ZQXV04 invented check output', stderr: '', interrupted: false, isImage: false }, sourceToolAssistantUUID: u(4) }) + NUL.repeat(16),
    NUL.repeat(8) + JSON.stringify(['ZQXV05 an invented array behind NUL bytes']),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'Build the invented demo once more.', leafUuid: u(5), sessionId: sid }),
  ].join('\n') + '\n');
}

// ---- the library's fixtures (test/library.test.mjs reads every value the library computes from them) ----
// Every record is written out in full, so each value the test expects can be read off its generator: a uuid ends in
// the number of the line it is written on (a replay keeps the uuid of the record it copies), and every timestamp is
// written by hand.
const libEnv = (sid, version) => ({ isSidechain: false, userType: 'external', cwd: '/work/demo-project', version, gitBranch: 'main', entrypoint: 'cli', sessionId: sid });
const libUuid = (pre, k) => `${pre}-0000-4000-8000-${String(k).padStart(12, '0')}`;
const libWrite = (name, lines) => writeFileSync(join(DIR, name), lines.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
const libReply = (model, content, extra = {}) => ({ type: 'message', role: 'assistant', model, content, stop_reason: 'end_turn', ...extra });

// library-lines.jsonl: one line of each shape the line parser tells apart, each short enough to count its bytes by
// hand: a record holding a 2-byte character (line 1), a blank line, a record holding a 4-byte character, a line of
// three blanks, four JSON values that are not objects (null, an array, a string, a number), a record ending in a
// carriage return, a line cut short, a line of 121 UTF-16 code units whose 120th is the first half of a surrogate
// pair, a line nested 1,001 levels deep, a record behind a NUL byte, and a last record. The characters outside ASCII,
// the NUL byte and the carriage return are built from their code points.
{
  const NUL = String.fromCharCode(0), CR = String.fromCharCode(13);
  const E_ACUTE = String.fromCodePoint(0xe9), GRIN = String.fromCodePoint(0x1f600);
  libWrite('library-lines.jsonl', [
    `{"type":"a","s":"${E_ACUTE}"}`,
    '',
    `{"type":"b","s":"${GRIN}"}`,
    '   ',
    'null',
    '[1,2]',
    '"x"',
    '42',
    `{"type":"c"}${CR}`,
    '{"type":',
    `{"s":"${'a'.repeat(113)}${GRIN}`,
    '['.repeat(1001) + ']'.repeat(1001),
    `${NUL}{"type":"d"}`,
    '{"type":"e"}',
  ]);
}

// library-forest.jsonl: the tree and the census. A prompt; one response written as two records (a thinking block and
// a call, one message id, one usage); the call's result, an attachment and a system record. Then a rewind: a prompt
// and its reply abandoned, and a prompt typed again under the same parent (the one node with two children). On that
// branch: a reply, a harness note (isMeta), a task's notification and its reply, another agent's message (in a second
// session id) and its reply (whose version is ''). Then two replays: the result written again as it was, and the
// thinking record written again with keys a census would read (another version, an agentId, isSidechain true and the
// earliest timestamp of all), so a census that counted replays would show them. Then a prompt whose parent is in no
// file and its reply (the latest timestamp, with a smaller one written after it); two records whose parents name
// each other (one timestamp is a number); an ai-title record in a third session id; three last-prompt records (the
// head moved, and the last names its leaf with a number); a record with no type; and the call written again as it was.
{
  const S1 = 'f1f1f1f1-1111-4111-8111-111111111111', S2 = 'f1f1f1f1-2222-4222-8222-222222222222', S3 = 'f1f1f1f1-3333-4333-8333-333333333333';
  const U = (k) => libUuid('f1000000', k);
  const e = (k, parent) => ({ parentUuid: parent, ...libEnv(S1, '2.1.300'), uuid: U(k) });
  const at = (mmss) => `2026-08-02T09:${mmss}.000Z`;
  const prompt = (k, parent, content, ts, extra = {}) => ({ ...e(k, parent), type: 'user', promptSource: 'typed', message: { role: 'user', content }, timestamp: ts, ...extra });
  const reply = (k, parent, n, text, ts, extra = {}) => ({ ...e(k, parent), type: 'assistant', requestId: `req_f1_0${n}`, message: { id: `msg_f1_0${n}`, ...libReply('claude-demo-model', [{ type: 'text', text }]) }, timestamp: ts, ...extra });
  const usage = { input_tokens: 10, output_tokens: 5 };
  const recs = [
    prompt(1, null, 'An invented first prompt.', at('00:10')),
    { ...e(2, U(1)), type: 'assistant', requestId: 'req_f1_01', message: { id: 'msg_f1_01', ...libReply('claude-demo-model', [{ type: 'thinking', thinking: 'An invented thought.', signature: 'invented-signature' }], { stop_reason: null, usage }) }, timestamp: at('00:11') },
    { ...e(3, U(2)), type: 'assistant', requestId: 'req_f1_01', message: { id: 'msg_f1_01', ...libReply('claude-demo-model', [{ type: 'tool_use', id: 'toolu_f1_01', name: 'Bash', input: { command: 'make demo' } }], { stop_reason: 'tool_use', usage }) }, timestamp: at('00:12') },
    { ...e(4, U(3)), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_f1_01', content: 'invented demo output' }] }, toolUseResult: { stdout: 'invented demo output', stderr: '' }, sourceToolAssistantUUID: U(3), timestamp: at('00:13') },
    { ...e(5, U(4)), type: 'attachment', attachment: { type: 'hook_success', content: 'an invented hook note' }, timestamp: at('00:14') },
    { ...e(6, U(5)), type: 'system', subtype: 'turn_duration', durationMs: 4000, timestamp: at('00:15') },
    prompt(7, U(6), 'An invented prompt, rewound.', at('00:20')),
    reply(8, U(7), 2, 'An invented reply, rewound.', at('00:21')),
    prompt(9, U(6), 'An invented prompt, typed again.', at('00:30')),
    reply(10, U(9), 3, 'An invented reply.', at('00:31')),
    { ...e(11, U(10)), type: 'user', isMeta: true, message: { role: 'user', content: 'An invented note from the harness.' }, timestamp: at('00:32') },
    { ...e(12, U(11)), type: 'user', message: { role: 'user', content: '<task-notification>An invented task finished.</task-notification>' }, timestamp: at('00:33') },
    reply(13, U(12), 4, 'An invented reply to the task.', at('00:34'), { agentId: 'agent-f1-a' }),
    { ...e(14, U(13)), sessionId: S2, type: 'user', origin: { kind: 'peer' }, message: { role: 'user', content: 'An invented message from another agent.' }, timestamp: at('00:35') },
    reply(15, U(14), 5, 'An invented reply to the other agent.', at('00:36'), { version: '', agentId: 'agent-f1-b' }),
  ];
  recs.push(recs[3]);
  recs.push({ ...recs[1], version: '2.1.319', agentId: 'agent-f1-replay', isSidechain: true, slug: 'invented-slug', timestamp: '2026-08-02T08:58:00.000Z' });
  recs.push(
    prompt(18, libUuid('f1999999', 999), 'An invented prompt whose parent is in no file.', '2026-08-02T08:59:00.000Z'),
    reply(19, U(18), 6, 'An invented reply below it.', at('10:00')),
    reply(20, U(21), 7, 'An invented record whose parent is the next one.', at('00:42')),
    reply(21, U(20), 8, 'An invented record whose parent is the previous one.', 99),
    { type: 'ai-title', aiTitle: 'An invented title', sessionId: S3 },
    { type: 'last-prompt', lastPrompt: 'An invented prompt, typed again.', leafUuid: U(10), sessionId: S1 },
    { type: 'last-prompt', lastPrompt: 'An invented message from another agent.', leafUuid: U(15), sessionId: S1 },
    { type: 'last-prompt', lastPrompt: 'An invented message from another agent.', leafUuid: 7, sessionId: S1 },
    { note: 'an invented record without a type', sessionId: S1 },
  );
  recs.push(recs[2]);   // line 27: the call written again as it was, so the copies as written (2) and the copies that differ (1) are not equal in number
  libWrite('library-forest.jsonl', recs);
}

// library-requests.jsonl: requests, tool calls and turns. Turn 1: one response written as two records, the call
// first (apiBlockIndex 1) and the thinking block second (apiBlockIndex 0), with one usage; the call's result, an
// error written as a string in toolUseResult. Then one record holding two calls, with wireToolInputs: the Bash
// command as the model emitted it (with a `cd` the harness stripped), and the Read input with its keys in another
// order; their results, the Read's first; a second result record for the Read, without toolUseResult; and a reply
// with no requestId (an older version). Turn 2: two calls made in parallel by one response; the second call's result
// is written first, and the session goes on from the first call's result (an is_error), so the second call and its
// result are off the live path.
{
  const S = 'f2f2f2f2-1111-4111-8111-111111111111';
  const R = (k) => libUuid('f2000000', k);
  const e = (k, parent) => ({ parentUuid: parent, ...libEnv(S, '2.1.319'), uuid: R(k) });
  const at = (ss) => `2026-08-03T10:00:${ss}Z`;
  const prompt = (k, parent, content, ts) => ({ ...e(k, parent), type: 'user', promptSource: 'typed', message: { role: 'user', content }, timestamp: ts });
  const result = (k, parent, block, ts, extra = {}) => ({ ...e(k, parent), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', ...block }] }, timestamp: ts, ...extra });
  const usageA = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 40, output_tokens_details: { thinking_tokens: 15 } };
  const usageD = { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 30 };
  libWrite('library-requests.jsonl', [
    prompt(1, null, 'Run the invented demo and fix what fails.', at('00.000')),
    { ...e(2, R(1)), type: 'assistant', requestId: 'req_f2_01', effort: 'high', apiBlockIndex: 1, message: { id: 'msg_f2_01', ...libReply('claude-demo-model', [{ type: 'tool_use', id: 'toolu_f2_01', name: 'Bash', input: { command: 'make demo' }, caller: { type: 'direct' } }], { stop_reason: 'tool_use', usage: usageA }) }, timestamp: at('02.000') },
    { ...e(3, R(2)), type: 'assistant', requestId: 'req_f2_01', effort: 'high', apiBlockIndex: 0, message: { id: 'msg_f2_01', ...libReply('claude-demo-model', [{ type: 'thinking', thinking: 'An invented thought.', signature: 'invented-signature' }], { stop_reason: 'tool_use', usage: usageA }) }, timestamp: at('03.000') },
    result(4, R(3), { tool_use_id: 'toolu_f2_01', content: 'Exit code 2\nan invented failure' }, at('04.000'), { toolUseResult: 'Error: Exit code 2\nan invented failure', sourceToolAssistantUUID: R(2) }),
    { ...e(5, R(4)), type: 'assistant', requestId: 'req_f2_02', message: { id: 'msg_f2_02', ...libReply('claude-demo-model', [
      { type: 'tool_use', id: 'toolu_f2_02', name: 'Bash', input: { command: 'make demo' }, caller: { type: 'direct' } },
      { type: 'tool_use', id: 'toolu_f2_03', name: 'Read', input: { file_path: '/work/demo-project/notes.txt', limit: 20 } },
    ], { stop_reason: 'tool_use', usage: { input_tokens: 7, cache_read_input_tokens: 500, output_tokens: 60 } }) },
    wireToolInputs: { toolu_f2_02: { command: 'cd /work/demo-project && make demo' }, toolu_f2_03: { limit: 20, file_path: '/work/demo-project/notes.txt' } }, timestamp: at('05.000') },
    result(6, R(5), { tool_use_id: 'toolu_f2_03', content: 'invented notes', is_error: false }, at('06.000'), { toolUseResult: { type: 'text', file: { filePath: '/work/demo-project/notes.txt', numLines: 1 } }, sourceToolAssistantUUID: R(5) }),
    result(7, R(6), { tool_use_id: 'toolu_f2_02', content: 'invented build output', is_error: false }, at('07.000'), { toolUseResult: { stdout: 'invented build output', stderr: '', interrupted: false, isImage: false }, sourceToolAssistantUUID: R(5) }),
    result(8, R(7), { tool_use_id: 'toolu_f2_03', content: 'invented notes, recorded again' }, at('08.000')),
    { ...e(9, R(8)), type: 'assistant', message: { id: 'msg_f2_03', ...libReply('claude-demo-model', [{ type: 'text', text: 'The invented demo builds now.' }], { usage: { input_tokens: 3, cache_creation_input_tokens: 40, output_tokens: 9 } }) }, timestamp: at('09.000') },
    prompt(10, R(9), 'Now read the two invented files.', at('10.000')),
    { ...e(11, R(10)), type: 'assistant', requestId: 'req_f2_04', message: { id: 'msg_f2_04', ...libReply('claude-demo-model', [{ type: 'tool_use', id: 'toolu_f2_04', name: 'Read', input: { file_path: '/work/demo-project/one.txt' } }], { stop_reason: 'tool_use', usage: usageD }) }, timestamp: at('11.000') },
    { ...e(12, R(11)), type: 'assistant', requestId: 'req_f2_04', message: { id: 'msg_f2_04', ...libReply('claude-demo-model', [{ type: 'tool_use', id: 'toolu_f2_05', name: 'Read', input: { file_path: '/work/demo-project/two.txt' } }], { stop_reason: 'tool_use', usage: usageD }) }, timestamp: at('11.500') },
    result(13, R(12), { tool_use_id: 'toolu_f2_05', content: 'the invented second file' }, at('12.000'), { toolUseResult: { type: 'text' }, sourceToolAssistantUUID: R(12) }),
    result(14, R(11), { tool_use_id: 'toolu_f2_04', content: 'File does not exist.', is_error: true }, at('13.000'), { toolUseResult: { invented: 'an invented structured error' }, sourceToolAssistantUUID: R(11) }),
    { ...e(15, R(14)), type: 'assistant', requestId: 'req_f2_05', message: { id: 'msg_f2_05', ...libReply('claude-demo-model', [{ type: 'text', text: 'The first invented file is missing; the second was read.' }], { usage: { input_tokens: 1, cache_read_input_tokens: 1100, output_tokens: 8 } }) }, timestamp: at('14.000') },
    { type: 'last-prompt', lastPrompt: 'Now read the two invented files.', leafUuid: R(15), sessionId: S },
  ]);
}

// library-request-keys.jsonl: crafted shapes of the grouping and the charging. A response of two records, each with
// its own message id, model, effort, usage and timestamp, the second-written one first by apiBlockIndex; a response
// whose message id was charged already; a response of two records with no message id, each charged; a record with
// neither a requestId nor a message id, and its child (one group, read from the parent link); an assistant record
// without the envelope and with neither key; a record whose requestId is empty; and one record of three calls: two
// with one id, and one whose id is a number. The result of the first id is a record without the envelope.
{
  const S = 'f3f3f3f3-1111-4111-8111-111111111111';
  const K = (k) => libUuid('f3000000', k);
  const e = (k, parent) => ({ parentUuid: parent, ...libEnv(S, '2.1.319'), uuid: K(k) });
  const at = (ss) => `2026-08-04T11:00:${ss}.000Z`;
  const text = (t) => [{ type: 'text', text: t }];
  libWrite('library-request-keys.jsonl', [
    { ...e(1, null), type: 'user', promptSource: 'typed', message: { role: 'user', content: 'Write the invented responses.' }, timestamp: at('00') },
    { ...e(2, K(1)), type: 'assistant', requestId: 'req_e', apiBlockIndex: 1, effort: 'low', message: { id: 'msg_e1', ...libReply('model-e1', text('the second block, written first'), { usage: { input_tokens: 1, output_tokens: 2 } }) }, timestamp: at('01') },
    { ...e(3, K(2)), type: 'assistant', requestId: 'req_e', apiBlockIndex: 0, effort: 'max', message: { id: 'msg_e2', ...libReply('model-e2', text('the first block, written second'), { usage: { input_tokens: 4, cache_read_input_tokens: 8, output_tokens: 16, output_tokens_details: { thinking_tokens: 32 } } }) }, timestamp: at('02') },
    { ...e(4, K(3)), type: 'assistant', requestId: 'req_f', message: { id: 'msg_e1', ...libReply('model-e1', text('a response whose message id was charged already'), { usage: { input_tokens: 1000, output_tokens: 1000 } }) }, timestamp: at('03') },
    { ...e(5, K(4)), type: 'assistant', requestId: 'req_g', message: libReply('model-g', text('a record with no message id'), { usage: { input_tokens: 3, output_tokens: 1 } }), timestamp: at('04') },
    { ...e(6, K(5)), type: 'assistant', requestId: 'req_g', message: libReply('model-g', text('another record with no message id'), { usage: { input_tokens: 3, output_tokens: 1 } }), timestamp: at('05') },
    { ...e(7, K(6)), type: 'assistant', message: { role: 'assistant', content: text('a record with neither key') }, timestamp: at('06') },
    { ...e(8, K(7)), type: 'assistant', message: { role: 'assistant', content: text('its child, with neither key either') }, timestamp: at('07') },
    { type: 'assistant', message: { role: 'assistant', content: text('an assistant record without the envelope') } },
    { ...e(10, K(8)), type: 'assistant', requestId: '', message: { id: 'msg_j', ...libReply('model-j', text('a record whose requestId is empty')) }, timestamp: at('09') },
    { ...e(11, K(10)), type: 'assistant', requestId: 'req_t', message: { id: 'msg_t', ...libReply('model-t', [
      { type: 'tool_use', id: 'toolu_dup', name: 'Bash', input: { command: 'make one' } },
      { type: 'tool_use', id: 'toolu_dup', name: 'Bash', input: { command: 'make two' } },
      { type: 'tool_use', id: 42, name: 'Read', input: { file_path: '/work/demo-project/n.txt' } },
    ], { stop_reason: 'tool_use' }) }, timestamp: at('10') },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_dup', content: 'invented output of make two' }] }, toolUseResult: { stdout: 'invented output of make two', stderr: '' } },
    { type: 'last-prompt', lastPrompt: 'Write the invented responses.', leafUuid: K(11), sessionId: S },
  ]);
}

// library-bridges.jsonl: two records whose parents are in no file, on the live path. The head's record is written
// before its own parent (the second orphan), so the bridge from that orphan passes over it, already on the path, to
// the record written before it; the first orphan is bridged to the reply written just before it.
{
  const S = 'f4f4f4f4-1111-4111-8111-111111111111';
  const B = (k) => libUuid('f4000000', k);
  const e = (k, parent) => ({ parentUuid: parent, ...libEnv(S, '2.1.319'), uuid: B(k) });
  const at = (ss) => `2026-08-05T12:00:${ss}.000Z`;
  const reply = (k, parent, t, ts) => ({ ...e(k, parent), type: 'assistant', requestId: `req_f4_0${k}`, message: { id: `msg_f4_0${k}`, ...libReply('claude-demo-model', [{ type: 'text', text: t }]) }, timestamp: ts });
  libWrite('library-bridges.jsonl', [
    { ...e(1, null), type: 'user', promptSource: 'typed', message: { role: 'user', content: 'Carry on with the invented work.' }, timestamp: at('00') },
    reply(2, B(1), 'An invented first reply.', at('01')),
    reply(3, libUuid('f4999999', 999), 'An invented reply whose parent was never written.', at('02')),
    reply(4, B(5), 'An invented reply written before its parent.', at('04')),
    reply(5, libUuid('f4999999', 998), 'Another invented reply whose parent was never written.', at('03')),
    { type: 'last-prompt', lastPrompt: 'Carry on with the invented work.', leafUuid: B(4), sessionId: S },
  ]);
}

// library-preserved.jsonl: a compaction whose kept segment is written after its summary (the terminal UI's shape):
// the boundary's logicalParentUuid names the kept segment's tail, written after the summary, and the history before
// the boundary hangs off compactMetadata.preservedSegment.headUuid. Its compactMetadata holds all four values.
{
  const S = 'f5f5f5f5-1111-4111-8111-111111111111';
  const C = (k) => libUuid('f5000000', k);
  const e = (k, parent) => ({ parentUuid: parent, ...libEnv(S, '2.1.319'), uuid: C(k) });
  const at = (ss) => `2026-08-06T13:00:${ss}.000Z`;
  const prompt = (k, parent, content, ts) => ({ ...e(k, parent), type: 'user', promptSource: 'typed', message: { role: 'user', content }, timestamp: ts });
  const reply = (k, parent, t, ts) => ({ ...e(k, parent), type: 'assistant', requestId: `req_f5_0${k}`, message: { id: `msg_f5_0${k}`, ...libReply('claude-demo-model', [{ type: 'text', text: t }]) }, timestamp: ts });
  libWrite('library-preserved.jsonl', [
    prompt(1, null, 'An invented first prompt.', at('00')),
    reply(2, C(1), 'An invented first reply.', at('01')),
    prompt(3, C(2), 'An invented second prompt.', at('02')),
    reply(4, C(3), 'An invented second reply.', at('03')),
    { ...e(5, null), logicalParentUuid: C(7), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 150000, postTokens: 30000, durationMs: 45000, preservedSegment: { headUuid: C(3), tailUuid: C(7) } }, timestamp: at('10') },
    { ...e(6, C(5)), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary of the first prompt.' }, timestamp: at('11') },
    reply(7, C(6), 'The invented second reply, kept.', at('12')),
    prompt(8, C(7), 'An invented third prompt.', at('20')),
    reply(9, C(8), 'An invented third reply.', at('21')),
    { type: 'last-prompt', lastPrompt: 'An invented third prompt.', leafUuid: C(9), sessionId: S },
  ]);
}

// library-detached.jsonl: a detached compaction (CLI 2.1.295 and 2.1.300), with no compactMetadata: the boundary and
// its summary are a branch of their own, and the /compact command (stamped before them, written after them) and its
// output are parented around them.
{
  const S = 'f6f6f6f6-1111-4111-8111-111111111111';
  const D = (k) => libUuid('f6000000', k);
  const e = (k, parent) => ({ parentUuid: parent, ...libEnv(S, '2.1.300'), uuid: D(k) });
  const at = (ss) => `2026-08-07T14:00:${ss}.000Z`;
  const user = (k, parent, content, ts, extra = {}) => ({ ...e(k, parent), type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra });
  const reply = (k, parent, t, ts) => ({ ...e(k, parent), type: 'assistant', requestId: `req_f6_0${k}`, message: { id: `msg_f6_0${k}`, ...libReply('claude-demo-model', [{ type: 'text', text: t }]) }, timestamp: ts });
  libWrite('library-detached.jsonl', [
    user(1, null, 'An invented first prompt.', at('00'), { promptSource: 'typed' }),
    reply(2, D(1), 'An invented first reply.', at('01')),
    { ...e(3, null), logicalParentUuid: D(2), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: at('05') },
    user(4, D(3), 'An invented summary.', at('05'), { isCompactSummary: true }),
    user(5, D(2), '<command-name>/compact</command-name>', at('02')),
    user(6, D(5), '<local-command-stdout>Compacted</local-command-stdout>', at('06')),
    user(7, D(6), 'An invented prompt after the compaction.', at('10'), { promptSource: 'typed' }),
    reply(8, D(7), 'An invented reply after the compaction.', at('11')),
    { type: 'last-prompt', lastPrompt: 'An invented prompt after the compaction.', leafUuid: D(8), sessionId: S },
  ]);
}

// library-compacted-twice.jsonl: two full compactions, each boundary naming the last record before it, so the walk
// back from the head meets the later one first.
{
  const S = 'fbfbfbfb-1111-4111-8111-111111111111';
  const G = (k) => libUuid('fb000000', k);
  const e = (k, parent) => ({ parentUuid: parent, ...libEnv(S, '2.1.319'), uuid: G(k) });
  const at = (ss) => `2026-08-08T15:00:${ss}.000Z`;
  const prompt = (k, parent, content, ts) => ({ ...e(k, parent), type: 'user', promptSource: 'typed', message: { role: 'user', content }, timestamp: ts });
  const reply = (k, parent, t, ts) => ({ ...e(k, parent), type: 'assistant', requestId: `req_fb_${k}`, message: { id: `msg_fb_${k}`, ...libReply('claude-demo-model', [{ type: 'text', text: t }]) }, timestamp: ts });
  const boundary = (k, logical, compactMetadata, ts) => ({ ...e(k, null), logicalParentUuid: logical, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata, timestamp: ts });
  const summary = (k, parent, ts) => ({ ...e(k, parent), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary.' }, timestamp: ts });
  libWrite('library-compacted-twice.jsonl', [
    prompt(1, null, 'An invented first prompt.', at('00')),
    reply(2, G(1), 'An invented first reply.', at('01')),
    boundary(3, G(2), { trigger: 'manual', preTokens: 1000 }, at('10')),
    summary(4, G(3), at('11')),
    prompt(5, G(4), 'An invented second prompt.', at('20')),
    reply(6, G(5), 'An invented second reply.', at('21')),
    boundary(7, G(6), { trigger: 'auto', preTokens: 2000, postTokens: 500, durationMs: 3000 }, at('30')),
    summary(8, G(7), at('31')),
    prompt(9, G(8), 'An invented third prompt.', at('40')),
    reply(10, G(9), 'An invented third reply.', at('41')),
    { type: 'last-prompt', lastPrompt: 'An invented third prompt.', leafUuid: G(10), sessionId: S },
  ]);
}

// library-detached-first.jsonl: a detached compaction (its boundary and summary a branch of their own, the /compact
// command and its output parented around them), then a full compaction later in the session. The walk finds the
// later one; the detached one is placed afterwards, earlier in the path.
{
  const S = 'fcfcfcfc-1111-4111-8111-111111111111';
  const H = (k) => libUuid('fc000000', k);
  const e = (k, parent) => ({ parentUuid: parent, ...libEnv(S, '2.1.300'), uuid: H(k) });
  const at = (ss) => `2026-08-09T16:00:${ss}.000Z`;
  const user = (k, parent, content, ts, extra = {}) => ({ ...e(k, parent), type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra });
  const reply = (k, parent, t, ts) => ({ ...e(k, parent), type: 'assistant', requestId: `req_fc_${k}`, message: { id: `msg_fc_${k}`, ...libReply('claude-demo-model', [{ type: 'text', text: t }]) }, timestamp: ts });
  const boundary = (k, logical, compactMetadata, ts) => ({ ...e(k, null), logicalParentUuid: logical, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata, timestamp: ts });
  libWrite('library-detached-first.jsonl', [
    user(1, null, 'An invented first prompt.', at('00'), { promptSource: 'typed' }),
    reply(2, H(1), 'An invented first reply.', at('01')),
    boundary(3, H(2), { trigger: 'manual', preTokens: 4000 }, at('05')),
    user(4, H(3), 'An invented summary.', at('05'), { isCompactSummary: true }),
    user(5, H(2), '<command-name>/compact</command-name>', at('02')),
    user(6, H(5), '<local-command-stdout>Compacted</local-command-stdout>', at('06')),
    user(7, H(6), 'An invented second prompt.', at('10'), { promptSource: 'typed' }),
    reply(8, H(7), 'An invented second reply.', at('11')),
    boundary(9, H(8), { trigger: 'auto', preTokens: 6000 }, at('20')),
    user(10, H(9), 'An invented summary.', at('21'), { isCompactSummary: true }),
    user(11, H(10), 'An invented third prompt.', at('30'), { promptSource: 'typed' }),
    reply(12, H(11), 'An invented third reply.', at('31')),
    { type: 'last-prompt', lastPrompt: 'An invented third prompt.', leafUuid: H(12), sessionId: S },
  ]);
}

// ---- the search fixtures (S358, ltms search): every string invented. A planted zqk* word marks where a test expects a
// term to be found, or not to be. Every character outside ASCII, every new line and tab, and every backslash of the
// JSON-escaped text are built from code points, never typed: an editor or a tool can turn a typed escape into the
// character it names.
const cpS = (...c) => String.fromCodePoint(...c);
const BSL = String.fromCharCode(92), NL = String.fromCharCode(10);
/** A file whose envelope records are written in order, one second apart, each parented to the one before unless told
 *  otherwise. */
function searchFile(name, sid, pre) {
  const lines = [];
  let k = 0, last = null;
  const uuid = (i) => `${pre}-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const stamp = (i) => new Date(Date.UTC(2026, 8, 1, 9, 0, 0) + i * 1000).toISOString();
  const api = {
    rec(type, body, parent = last) {
      const u = uuid(++k);
      lines.push(JSON.stringify({ parentUuid: parent, ...env(sid), type, ...body, uuid: u, timestamp: stamp(k) }));
      last = u;
      return u;
    },
    prompt(content, parent = last) {
      return api.rec('user', { message: { role: 'user', content }, promptId: `${pre}-1111-4000-8000-${String(k + 1).padStart(12, '0')}`, promptSource: 'typed' }, parent);
    },
    reply(content, extra = {}, parent = last) {
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
      return api.rec('assistant', { message: { id: `msg_${pre}_${k + 1}`, type: 'message', role: 'assistant', model: 'claude-demo-model', content: blocks,
        stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }, requestId: `req_${pre}_${k + 1}`, ...extra }, parent);
    },
    call(id, name, input, extra = {}) { return api.reply([{ type: 'tool_use', id, name, input }], extra); },
    result(id, content, extra = {}) {
      return api.rec('user', { message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: false }] },
        toolUseResult: { stdout: 'invented standard output', stderr: '', interrupted: false, isImage: false }, sourceToolAssistantUUID: last, ...extra });
    },
    side(obj) { lines.push(JSON.stringify(obj)); },
    line(text) { lines.push(text); },
    replay(lineNo) { lines.push(lines[lineNo - 1]); },
    uuid, get last() { return last; }, set last(v) { last = v; },
    write() { writeFileSync(join(DIR, name), lines.join(NL) + NL); },
  };
  return api;
}

// search-kinds.jsonl: a record of every kind of text, each holding its own word, and everything search does not read. The
// line of each record is given beside it; the tests name the lines.
{
  const sid = 'f1f1f1f1-2a2a-4b3b-8c4c-5d5d5d5d5d5d', f = searchFile('search-kinds.jsonl', sid, 'f1000000');
  // L1, before the first prompt: a SessionStart hook's attachment (kind attachment, so off by default; it is T001's)
  f.rec('attachment', { attachment: { type: 'hook_success', hookName: 'SessionStart:startup', toolUseID: 'toolu_sk_00', hookEvent: 'SessionStart',
    content: 'zqkhook: the session start context', stdout: 'zqkhook', stderr: '', exitCode: 0, command: 'bash /work/hooks/start.sh', durationMs: 7 } }, null);
  f.prompt('Find the zqkinput word in the demo project.');                                                   // L2: T001
  f.reply([{ type: 'thinking', thinking: 'zqkthinking about where to look', signature: 'c2lnbmF0dXJl' }]);    // L3: thinking
  f.reply('zqkreply: I will search the project.');                                                          // L4: reply
  f.call('toolu_sk_01', 'Bash', { command: 'grep -rn zqkcall .', description: 'Search for the zqkdesc word' },   // L5: call,
    { wireToolInputs: { toolu_sk_01: { command: 'cd /work/demo-project && grep -rn zqkwire .', description: 'Search for the zqkdesc word' } } });   // wire inputs
  f.result('toolu_sk_01', 'zqkresult: one file holds it',                                                   // L6: result,
    { toolUseResult: { stdout: 'zqktur: the structured copy', stderr: '', interrupted: false, isImage: false } });   // toolUseResult
  f.rec('system', { subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'bash /work/hooks/zqksystem.sh', durationMs: 12 }], hookErrors: [],
    hookAdditionalContext: [], preventedContinuation: false, stopReason: '', hasOutput: false, level: 'info', toolUseID: 'toolu_sk_01' });   // L7: system
  f.rec('user', { message: { role: 'user', content: 'zqkmeta: a caveat the harness wrote' }, isMeta: true });   // L8: meta
  f.rec('attachment', { attachment: { type: 'todo_reminder', content: [{ content: 'zqkattach: the remaining item', status: 'pending' }], itemCount: 1 } });   // L9
  f.reply([{ type: 'redacted_thinking', data: 'zqkredacted' }]);                                             // L10: redacted
  f.reply('API Error: zqkapierror, the server is overloaded', { isApiErrorMessage: true });                  // L11: system
  f.prompt([{ type: 'text', text: 'Look at the zqkimage screenshot.' },                                      // L12: T002, with
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'zqkbase64' } }]);             // an image
  f.call('toolu_sk_02', 'Read', { file_path: '/work/demo-project/build.log' });                              // L13
  f.result('toolu_sk_02', NL + '<persisted-output>' + NL + 'Output too large. Full output saved to: /work/demo-project/tool-results/toolu_sk_02.txt' + NL + NL +
    'Preview (first 2KB):' + NL + 'zqkspill: the preview line' + NL + '</persisted-output>');               // L14: spilled
  f.call('toolu_sk_03', 'Bash', { command: 'cat notes.txt', 'a key with spaces': 'zqkkey value' });          // L15
  f.result('toolu_sk_03', 'The notes quote the marker <persisted-output> mid-text: zqkquote.');              // L16: not spilled
  f.rec('system', { subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, level: 'info', logicalParentUuid: f.last,
    compactMetadata: { trigger: 'manual', preTokens: 9000 } }, null);                                       // L17: the boundary
  f.rec('user', { message: { role: 'user', content: 'zqksummary: the session searched the project and read a log.' }, isCompactSummary: true,
    isVisibleInTranscriptOnly: true });                                                                     // L18: summary
  const queued = f.rec('attachment', { attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'zqkqueued: also check the tests' }],
    commandMode: 'prompt', timestamp: '2026-09-01T09:00:19.500Z' } });                                       // L19: input
  f.prompt('zqkrewound: an abandoned question');                                                            // L20: rewound
  f.reply('zqkrewound reply, abandoned');                                                                    // L21: rewound
  f.prompt('Run the zqkthird check, zqkleft side.', queued);                                                // L22: T003
  const end = f.reply('The zqkthird check passed on the zqkright side.');                                   // L23
  f.side({ type: 'last-prompt', lastPrompt: 'Run the zqkthird check, zqkleft side.', leafUuid: end, sessionId: sid });   // L24: side
  f.side({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-01T09:00:30.000Z', sessionId: sid, content: 'zqkqueueop' });   // L25
  f.line('this line is not JSON: zqkbad');                                                                  // L26
  f.replay(4);                                                                                              // L27: replay
  f.write();
}

// search-entries.jsonl: one record holding three kinds (thinking, a reply and a call) and a result whose two text blocks
// hold different words: one entry per record and kind, by line, then by kind; each names the first field of its kind
// that holds a term.
{
  const sid = 'f2f2f2f2-3b3b-4c4c-8d5d-6e6e6e6e6e6e', f = searchFile('search-entries.jsonl', sid, 'f2000000');
  f.prompt('zqkmulti: the order of the entries');                                                           // L1
  f.reply([{ type: 'thinking', thinking: 'zqkmulti thinking comes first', signature: 'c2ln' }, { type: 'text', text: 'the zqkmulti reply comes second' },
    { type: 'tool_use', id: 'toolu_se_01', name: 'Bash', input: { command: 'echo zqkmulti', description: 'zqkmulti call' } }]);   // L2
  f.result('toolu_se_01', [{ type: 'text', text: 'the first block holds zqkother' }, { type: 'text', text: 'the second block holds zqkmulti' }]);   // L3
  const end = f.reply('done');                                                                               // L4
  f.side({ type: 'last-prompt', lastPrompt: 'zqkmulti: the order of the entries', leafUuid: end, sessionId: sid });
  f.write();
}

// search-escapes.jsonl: results holding JSON-escaped text: a backslash-n glued to a word, a Hebrew word written as four
// backslash-u escapes, a surrogate pair and a lone surrogate, two invalid escapes beside a valid one, a Windows path that
// the written form reads right, phrases in each form, and an escaped backslash before an n.
{
  const sid = 'f3f3f3f3-4c4c-4d5d-8e6e-7f7f7f7f7f7f', f = searchFile('search-escapes.jsonl', sid, 'f3000000');
  const u = (hex) => BSL + 'u' + hex;
  f.prompt('Read the invented JSON files.');                                                                 // L1
  f.call('toolu_es_01', 'Bash', { command: 'cat data.json' });                                              // L2
  f.result('toolu_es_01', '{"text":"done' + BSL + 'nzqkglued: failed"}');                                   // L3
  f.call('toolu_es_02', 'Bash', { command: 'cat hebrew.json' });                                            // L4
  f.result('toolu_es_02', 'name: ' + u('05e9') + u('05dc') + u('05d5') + u('05dd') + ' end');                // L5
  f.call('toolu_es_03', 'Bash', { command: 'cat emoji.json' });                                             // L6
  f.result('toolu_es_03', 'face ' + u('d83d') + u('de00') + 'zqkpair and ' + u('d83d') + 'zqklone');          // L7
  f.call('toolu_es_04', 'Bash', { command: 'cat broken.json' });                                            // L8
  f.result('toolu_es_04', 'bad ' + BSL + 'xzqkinvalid and ' + BSL + 'u12zqkshort ok ' + BSL + 'tzqktab');      // L9
  f.call('toolu_es_05', 'Bash', { command: 'cat path.txt' });                                               // L10
  f.result('toolu_es_05', 'C:' + BSL + 'new' + BSL + 'zqkpath');                                            // L11
  f.call('toolu_es_06', 'Bash', { command: 'cat phrases.txt' });                                            // L12
  f.result('toolu_es_06', 'zqkone' + BSL + 'nzqktwo then ' + BSL + 'nzqkaa zqkbb' + BSL + 'tzqkcc and ' + BSL + BSL + 'nzqkliteral');   // L13
  const end = f.reply('The invented files were read.');                                                      // L14
  f.side({ type: 'last-prompt', lastPrompt: 'Read the invented JSON files.', leafUuid: end, sessionId: sid });
  f.write();
}

// search-scripts.jsonl: one turn per known string (a prompt of one '.', then a reply holding the string): Hebrew with
// prefixes, a Hebrew prefix letter glued to Latin words, pointed Hebrew, Arabic with al- and tatweel, Chinese, Japanese,
// Thai, Greek capitals before a period and an apostrophe, a zero-width space, full-width letters, a ligature and
// mathematical bold capitals, code tokens, Hangul with a word written in conjoining jamo, a Persian word with a
// zero-width non-joiner, and a soft hyphen.
{
  const sid = 'f4f4f4f4-5d5d-4e6e-8f7f-8a8a8a8a8a8a', f = searchFile('search-scripts.jsonl', sid, 'f4000000');
  const strings = [
    'zqk1 ' + cpS(0x5d5, 0x5d4, 0x5d1, 0x5d9, 0x5ea) + ' ' + cpS(0x5de, 0x5d4, 0x5e2, 0x5d9, 0x5e8),
    cpS(0x5d1) + 'ltms ' + cpS(0x5d4) + 'API node' + cpS(0x5d9, 0x5dd),
    cpS(0x5d5, 0x5b0, 0x5d4, 0x5b7, 0x5d1, 0x5b7, 0x5bc, 0x5d9, 0x5b4, 0x5ea) + ' ' + cpS(0x5d1, 0x5b0, 0x5bc, 0x5e9, 0x5b8, 0x5c1, 0x5dc, 0x5d5, 0x5b9, 0x5dd),
    cpS(0x648, 0x627, 0x644, 0x643, 0x62a, 0x627, 0x628) + ' ' + cpS(0x643, 0x640, 0x62a, 0x640, 0x627, 0x628),
    cpS(0x6211, 0x4eec, 0x4eca, 0x5929, 0x5728, 0x5317, 0x4eac, 0x5927, 0x5b66, 0x5f00, 0x4f1a),
    cpS(0x6771, 0x4eac, 0x5927, 0x5b66, 0x3067, 0x30b3, 0x30fc, 0x30d2, 0x30fc, 0x3092, 0x98f2, 0x307f, 0x307e, 0x3057, 0x305f),
    cpS(0xe20, 0xe32, 0xe29, 0xe32, 0xe44, 0xe17, 0xe22, 0xe44, 0xe21, 0xe48, 0xe21, 0xe35, 0xe01, 0xe32, 0xe23, 0xe40, 0xe27, 0xe49, 0xe19, 0xe27, 0xe23, 0xe23, 0xe04),
    cpS(0x39f, 0x394, 0x39f, 0x3a3) + '.' + cpS(0x39a, 0x391, 0x399) + ' ' + cpS(0x39f, 0x394, 0x39f, 0x3a3) + "'" + cpS(0x391),
    'zqkfoo' + cpS(0x200b) + 'zqkbar',
    cpS(0xff3a, 0xff31, 0xff2b, 0xff37, 0xff29, 0xff24, 0xff25) + ' zqk' + cpS(0xfb01) + 'nd ' + cpS(0x1d419, 0x1d410, 0x1d40a) + ' zqkafter',
    'parseQueryString node:sqlite 2.1.314 snake_case_name C++',
    cpS(0xd559, 0xad50) + ' ' + cpS(0x1112, 0x1161, 0x11a8) + ' zqkko',
    cpS(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645),
    'co' + cpS(0xad) + 'operate',
  ];
  for (const s of strings) { f.prompt('.'); f.reply(s); }
  f.side({ type: 'last-prompt', lastPrompt: '.', leafUuid: f.last, sessionId: sid });
  f.write();
}

// search-noturn.jsonl: conversation records but no input turn (a hook's attachment, a reply, an isMeta record): every
// path record is counted as before the first turn, and nothing matches.
{
  const sid = 'f5f5f5f5-6e6e-4f7f-8a8a-9b9b9b9b9b9b', f = searchFile('search-noturn.jsonl', sid, 'f5000000');
  f.rec('attachment', { attachment: { type: 'hook_success', hookEvent: 'SessionStart', content: 'zqknoturn context' } }, null);
  f.reply('zqknoturn reply with no prompt before it');
  f.rec('user', { message: { role: 'user', content: 'zqknoturn meta text' }, isMeta: true });
  f.write();
}

// search-cases.jsonl: the scouts' 18 known strings (scout-search/cases.mjs, invented), one turn each: a prompt of one
// '.', then a reply holding the string. The 120 queries, and what each must give, are in test/search.test.mjs.
{
  const sid = 'f6f6f6f6-7f7f-4a8a-8b9b-acacacacacac', f = searchFile('search-cases.jsonl', sid, 'f6000000');
  const cases = [
    { id: 'english', text: "The user's file doesn't exist; it's on the U.S. mirror, v3.5 (re-run it)." },
    { id: 'hebrew-prefixes', text: cpS(0x5d7, 0x5d6, 0x5e8, 0x5e0, 0x5d5) + ' ' + cpS(0x5de, 0x5d4, 0x5e2, 0x5d9, 0x5e8) + ' ' + cpS(0x5d5, 0x5d4, 0x5d1, 0x5d9, 0x5ea) + ' ' + cpS(0x5d4, 0x5d9, 0x5d4) + ' ' + cpS(0x5d1, 0x5e9, 0x5dc, 0x5d5, 0x5dd) },
    { id: 'hebrew-pointed', text: cpS(0x5d5, 0x5b0, 0x5d4, 0x5b7, 0x5d1, 0x5b7, 0x5bc, 0x5d9, 0x5b4, 0x5ea) + ' ' + cpS(0x5d1, 0x5b0, 0x5bc, 0x5e9, 0x5b8, 0x5c1, 0x5dc, 0x5d5, 0x5b9, 0x5dd) },
    { id: 'hebrew-maqaf-geresh', text: cpS(0x5d1, 0x5d9, 0x5ea, 0x5be, 0x5d4, 0x5db, 0x5e0, 0x5e1, 0x5ea) + ' ' + cpS(0x5e9, 0x5dc) + ' ' + cpS(0x5e8, 0x5f3) + ' ' + cpS(0x5d9, 0x5d4, 0x5d5, 0x5d3, 0x5d4) + ', ' + cpS(0x5db, 0x5de, 0x5d5) + ' ' + cpS(0x5e9, 0x5db, 0x5ea, 0x5d1) + ' ' + cpS(0x5e8, 0x5e9, 0x5f4, 0x5d9) + ' (' + cpS(0x5e8, 0x5e9) + '"' + cpS(0x5d9) + ')' },
    { id: 'arabic-al', text: cpS(0x630, 0x647, 0x628, 0x62a) + ' ' + cpS(0x625, 0x644, 0x649) + ' ' + cpS(0x627, 0x644, 0x645, 0x62f, 0x631, 0x633, 0x629) + ' ' + cpS(0x648, 0x627, 0x644, 0x643, 0x62a, 0x627, 0x628) + ' ' + cpS(0x645, 0x639, 0x64a) + ' ' + cpS(0x648, 0x643, 0x62a, 0x627, 0x628, 0x647, 0x645) + ' ' + cpS(0x628, 0x627, 0x644, 0x628, 0x64a, 0x62a) },
    { id: 'arabic-marks-tatweel-forms', text: cpS(0x627, 0x644, 0x652, 0x643, 0x650, 0x62a, 0x64e, 0x627, 0x628, 0x64f) + ' ' + cpS(0x643, 0x640, 0x62a, 0x640, 0x627, 0x628) + ' ' + cpS(0xfedb, 0xfe98, 0xfe8e, 0xfe8f) },
    { id: 'chinese', text: cpS(0x6211, 0x4eec, 0x4eca, 0x5929, 0x5728, 0x5317, 0x4eac, 0x5927, 0x5b66, 0x5f00, 0x4f1a, 0x3002, 0x4f1a, 0x8bae, 0x5728, 0x4e0b, 0x5348, 0x4e09, 0x70b9, 0x3002) },
    { id: 'japanese', text: cpS(0x79c1, 0x306f, 0x6771, 0x4eac, 0x5927, 0x5b66, 0x3067, 0x30b3, 0x30fc, 0x30d2, 0x30fc, 0x3092, 0x98f2, 0x307f, 0x307e, 0x3057, 0x305f, 0x3002, 0x6771, 0x4eac, 0x90fd, 0x306b, 0x4f4f, 0x3093, 0x3067, 0x3044, 0x307e, 0x3059, 0x3002) },
    { id: 'thai', text: cpS(0xe20, 0xe32, 0xe29, 0xe32, 0xe44, 0xe17, 0xe22, 0xe44, 0xe21, 0xe48, 0xe21, 0xe35, 0xe01, 0xe32, 0xe23, 0xe40, 0xe27, 0xe49, 0xe19, 0xe27, 0xe23, 0xe23, 0xe04, 0xe23, 0xe30, 0xe2b, 0xe27, 0xe48, 0xe32, 0xe07, 0xe04, 0xe33) },
    { id: 'korean', text: cpS(0xd559, 0xad50, 0xc5d0, 0xc11c) + ' ' + cpS(0xce5c, 0xad6c, 0xb97c) + ' ' + cpS(0xb9cc, 0xb0ac, 0xc2b5, 0xb2c8, 0xb2e4) },
    { id: 'emoji', text: 'Great job ' + cpS(0x1f44d, 0x1f3fd) + ' and ' + cpS(0x1f642) + 'glued word, family ' + cpS(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467) + ', flag ' + cpS(0x1f1ee, 0x1f1f1) + ', heart ' + cpS(0x2764, 0xfe0f) },
    { id: 'code', text: 'parseQueryString snake_case_name kebab-case-name /usr/local/bin --force 2.1.314 9f86d081 user.name@example.com node:sqlite file.test.mjs C++ S24.E' },
    { id: 'fold', text: 'Caf' + cpS(0xe9) + ' and Cafe' + cpS(0x301) + ', ' + cpS(0x130) + 'stanbul, STRASSE and Stra' + cpS(0xdf) + 'e, ' + cpS(0xfb01) + 'le, ' + cpS(0xff26, 0xff35, 0xff2c, 0xff2c) + ' ' + cpS(0xff11, 0xff12, 0xff13) },
    { id: 'fold-sharp-s-a', text: 'Die Stra' + cpS(0xdf) + 'e ist lang' },
    { id: 'fold-sharp-s-b', text: 'DIE STRASSE IST LANG' },
    { id: 'fold-greek-sigma', text: cpS(0x39f, 0x394, 0x39f, 0x3a3) + ' ' + cpS(0x3bf, 0x3b4, 0x3bf, 0x3c2) },
    { id: 'escaped-json', text: 'alpha' + BSL + 'nbeta ' + BSL + '"gamma' + BSL + '" C:' + BSL + BSL + 'Users' + BSL + BSL + 'delta' },
    { id: 'escaped-json-hebrew', text: cpS(0x5dc, 0x5d9, 0x5dc) + BSL + 'n' + cpS(0x5e9, 0x5d9, 0x5e9, 0x5d9) + ' ' + cpS(0x5d5, 0x5d2, 0x5dd) + ' ' + BSL + 'u05e9' + BSL + 'u05dc' + BSL + 'u05d5' + BSL + 'u05dd' },
  ];
  for (const c of cases) { f.prompt('.'); f.reply(c.text); }
  f.side({ type: 'last-prompt', lastPrompt: '.', leafUuid: f.last, sessionId: sid });
  f.write();
}
