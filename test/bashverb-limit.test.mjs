// Tests of the Bash verb at its 16-command limit and at a command's end (DESIGN.md S358 §4.4, a5 and a6), run against
// the built dist/cli.js (build first). LTMS_CLI=<path to a cli.js> runs them against another build.
//
// The rule. After the 16th command passed over, the loop's head runs once more (blanks, new lines, comment lines, and
// an opening ( { or !, as for any command): when that reaches the end, the verb is what the end gives a shorter
// command (the first substitution's program, else (empty)); anything else gives (withheld). At any count, a command
// that ends in &&, || or | (or |&) with nothing after it but blanks, new lines, line continuations and comment lines
// gives (withheld): bash rejects it as a syntax error. The end is read as text: the LIMITS below are what that costs, each pinned.
//
// The inputs are the edges seat's (review-edges/limit-probe.mjs), in its order, then the dangling operators of the
// rule's second part, then controls, then the limits. Each expected verb is what the rule says, and the last test
// checks each one against bash 5 itself: fake git and make on PATH log when they run, so a printed program must be one
// bash runs, (empty) must run nothing, and the dangling cases must be syntax errors. Every string is invented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.LTMS_CLI || join(here, '..', 'dist', 'cli.js');
const W = '(withheld)', E = '(empty)';
const NL = '\n', CR = String.fromCharCode(13), NBSP = String.fromCharCode(0xa0), BS = String.fromCharCode(92);
const A = (n, from = 1) => Array.from({ length: n }, (_, k) => `A${from + k}=1`);
const SUB = 'X=$(git rev-parse HEAD)';

// [name, the command, the verb, what bash 5 does with it: the fake programs that ran ('-' for none) and the error
// ('' none, 'syntax' a syntax error, 'not-found' a command not found, or 'exit1' for `!` alone, which returns 1)]
const PROBE = [
  ['A sub, 15 assignments, then a program (a5 input)', [SUB, ...A(15, 2), 'make demo'].join(NL), W, 'git+make', ''],
  ['B 16 assignments, a final new line', A(16).join(NL) + NL, E, '-', ''],
  ['B0 16 assignments, no final new line', A(16).join(NL), E, '-', ''],
  ['B2 16 assignments, two final new lines', A(16).join(NL) + NL + NL, E, '-', ''],
  ['Bc 16 assignments, a new line, a comment line', A(16).join(NL) + NL + '# done' + NL, E, '-', ''],
  ['Bcs 16 assignments, a comment on the 16th line', A(15).join(NL) + NL + 'A16=1 # done' + NL, W, '-', ''],
  ['Bcs15 15 assignments, a comment on the 15th line', A(14).join(NL) + NL + 'A15=1 # done' + NL, W, '-', ''],
  ['C sub and 15 assignments, a final new line', [SUB, ...A(15, 2)].join(NL) + NL, 'git', 'git', ''],
  ['C&& sub && 15 assignments &&, on one line', [SUB, ...A(15, 2)].join(' && ') + ' &&' + NL, W, '-', 'syntax'],
  ['C&&15 sub && 14 assignments &&, on one line', [SUB, ...A(14, 2)].join(' && ') + ' &&' + NL, W, '-', 'syntax'],
  ['Cnl&& sub on line 1, the 16th line ends in &&', [SUB, ...A(14, 2), 'A16=1 &&'].join(NL) + NL, W, 'git', 'syntax'],
  ['B;cr 16 assignments joined by ;, then ; and CR', A(16).join(';') + ';' + CR, W, '-', 'not-found'],
  ['B;cr15 15 assignments joined by ;, then ; and CR', A(15).join(';') + ';' + CR, W, '-', 'not-found'],
  ['B;nb 16 assignments joined by ;, then ; and NBSP', A(16).join(';') + ';' + NBSP, W, '-', 'not-found'],
  ['B( 16 assignments, a new line, (', A(16).join(NL) + NL + '(', E, '-', 'syntax'],
  ['B(15 15 assignments, a new line, (', A(15).join(NL) + NL + '(', E, '-', 'syntax'],
  ['C( sub and 15 assignments, a new line, (', [SUB, ...A(15, 2)].join(NL) + NL + '(', 'git', 'git', 'syntax'],
  ['B{ 16 assignments, a new line, { and a blank', A(16).join(NL) + NL + '{ ', E, '-', 'syntax'],
  ['B! 16 assignments, a new line, ! and a blank', A(16).join(NL) + NL + '! ', E, '-', 'exit1'],
];
const DANGLING = [
  ['make &&', 'make demo &&', W, '-', 'syntax'],
  ['make ||', 'make demo ||', W, '-', 'syntax'],
  ['make |', 'make demo |', W, '-', 'syntax'],
  ['make |&', 'make demo |&', W, '-', 'syntax'],
  ['make && and blanks', 'make demo &&  \t ', W, '-', 'syntax'],
  ['make &&, new lines and comment lines', 'make demo &&' + NL + NL + '  # then the checks' + NL + '#' + NL, W, '-', 'syntax'],
  ['cd ||', 'cd work ||', W, '-', 'syntax'],
  ['cd |', 'cd work |', W, '-', 'syntax'],
  ['env | (a wrapper alone)', 'env |', W, '-', 'syntax'],
  ['sub &&, at one command', SUB + ' &&', W, '-', 'syntax'],
  ['an assignment &&', 'A1=1 &&', W, '-', 'syntax'],
  ['cd &&', 'cd work &&', W, '-', 'syntax'],
  ['a dangling && inside a substitution', 'X=$(git rev-parse HEAD &&)', W, '-', 'syntax'],
  ['make &&, then a tab-indented comment line', 'make demo &&' + NL + '\t# later' + NL, W, '-', 'syntax'],   // C25
  // a backslash right before a new line continues the line: after an operator, it joins nothing
  ['make && and a line continuation', 'make demo && ' + BS + NL, W, '-', 'syntax'],
  ['make | and a line continuation', 'make demo | ' + BS + NL, W, '-', 'syntax'],
  ['make && and a line continuation, no blank between them', 'make demo &&' + BS + NL, W, '-', 'syntax'],
  ['make &&, a line continuation, then a comment line', 'make demo && ' + BS + NL + '  # then the checks' + NL, W, '-', 'syntax'],
];
const CONTROLS = [
  ['make && make', 'make demo && make check', 'make', 'make+make', ''],
  ['make & (in the background)', 'make demo &', 'make', 'make', ''],
  ['make ;', 'make demo;', 'make', 'make', ''],
  ['make | a program', 'make demo | tee out.txt', 'make', 'make', ''],
  ['make, a comment holding &&', 'make demo # && is not an operator here', 'make', 'make', ''],
  ['make, a quoted &&', "make demo '&&'", 'make', 'make', ''],
  ['cd && make', 'cd work && make demo', 'make', 'make', ''],
  ['sub && make', SUB + ' && make demo', 'make', 'git+make', ''],
  ['15 assignments, then a program', [...A(15), 'make demo'].join(NL), 'make', 'make', ''],
  ['16 assignments, then a program (the passed-over fixture\'s shape)', [...A(16), 'make demo'].join(NL), W, 'make', ''],
  ['sub and 14 assignments, a final new line', [SUB, ...A(14, 2)].join(NL) + NL, 'git', 'git', ''],
  ['make &&, a line continuation, then a program', 'make demo && ' + BS + NL + 'make check', 'make', 'make+make', ''],
  ['make && and an escaped backslash (a word), then a new line', 'make demo && ' + BS + BS + NL, 'make', 'make', 'not-found'],
  ['make && and three backslashes (a word, then a line continuation)', 'make demo && ' + BS + BS + BS + NL, 'make', 'make', 'not-found'],
  ['make && and a backslash at the very end (a word)', 'make demo && ' + BS, 'make', 'make', 'not-found'],
];
// The cost of reading the end as text, each stated in the README. A comment on the operator's own line is not read,
// so the program is printed though bash rejects the command (measured: a rule that read it withheld 238 of 119,786
// commands of our own sessions, every one a command bash accepts, and caught none bash rejects). An operator escaped,
// or inside a comment, at the very end counts, so the verb is withheld though bash runs the command.
const LIMITS = [
  ['limit: make && and a comment on its line', 'make demo && # then the checks', 'make', '-', 'syntax'],
  ['limit: make &&#, a comment right after the operator', 'make demo &&#x', 'make', '-', 'syntax'],
  ['limit: an escaped | at the end', 'make demo \\|', W, 'make', ''],
  ['limit: a comment ending in &&', 'make demo # then the checks &&', W, 'make', ''],
];
const PRINTED_THOUGH_REJECTED = new Set(LIMITS.filter(([, , verb]) => verb !== W).map(([name]) => name));
const CASES = [...PROBE, ...DANGLING, ...CONTROLS, ...LIMITS];

/** One prompt, then one Bash call per case with a result, and a last-prompt record: the skeleton's call lines are in
 *  case order. */
function verbsOf(cases) {
  const dir = mkdtempSync(join(tmpdir(), 'ltms-bashverb-'));
  try {
    const lines = [JSON.stringify({ type: 'user', uuid: 'u', parentUuid: null, promptSource: 'typed', message: { role: 'user', content: 'an invented prompt' } })];
    let parent = 'u';
    cases.forEach(([, command], i) => {
      lines.push(JSON.stringify({ type: 'assistant', uuid: `a${i}`, parentUuid: parent, requestId: `r${i}`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }] } }));
      lines.push(JSON.stringify({ type: 'user', uuid: `s${i}`, parentUuid: `a${i}`, toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'an invented result' }] } }));
      parent = `s${i}`;
    });
    lines.push(JSON.stringify({ type: 'last-prompt', leafUuid: parent }));
    const file = join(dir, 'limit.jsonl');
    writeFileSync(file, lines.join(NL) + NL);
    const r = spawnSync(process.execPath, [CLI, 'skeleton', file], { encoding: 'utf8', timeout: 20000 });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, r.stderr);
    const calls = r.stdout.split(NL).filter((l) => l !== '').map((l) => JSON.parse(l)).filter((o) => o.k === 'call');
    assert.equal(calls.length, cases.length);
    return new Map(cases.map(([name], i) => [name, calls[i].verb]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const verbs = verbsOf(CASES);

test('the cases are what they say: the probe\'s inputs count 16 commands where they say 16, and every name is unique', () => {
  assert.equal(new Set(CASES.map(([name]) => name)).size, CASES.length);
  const commands = (c) => c.split(/\n|; ?| && /).filter((p) => p.trim() !== '' && !p.trim().startsWith('#') && !['&&', '(', '{', '!'].includes(p.trim())).length;
  assert.deepEqual(PROBE.slice(0, 11).map(([name, c]) => [name.split(' ')[0], commands(c)]),
    [['A', 17], ['B', 16], ['B0', 16], ['B2', 16], ['Bc', 16], ['Bcs', 16], ['Bcs15', 15], ['C', 16], ['C&&', 16], ['C&&15', 15], ['Cnl&&', 16]]);
});

for (const [name, command, verb] of CASES) {
  test(`${name}: ${JSON.stringify(command).slice(0, 60)}${JSON.stringify(command).length > 60 ? '...' : ''} -> ${verb}`, () => {
    assert.equal(verbs.get(name), verb);
  });
}

/** bash's major version, or null when there is no bash on PATH. */
function bashMajor() {
  const r = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const m = /version (\d+)\./.exec(r.stdout);
  return m ? Number(m[1]) : null;
}
const major = process.platform === 'win32' ? null : bashMajor();

test('each expected verb against bash 5 itself, by -c and through eval: a printed program is one bash runs, (empty) runs nothing, each dangling operator is a syntax error, and each limit does what the README says', { skip: major === null ? 'no bash on PATH (or win32)' : major < 5 ? `bash ${major}, not 5` : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ltms-bash-'));
  try {
    const bin = join(dir, 'bin'), log = join(dir, 'ran.log');
    mkdirSync(bin);
    mkdirSync(join(dir, 'work'));   // cd work: a directory that exists, so cd itself succeeds
    for (const p of ['git', 'make', 'tee']) {
      writeFileSync(join(bin, p), `#!/bin/sh\necho ${p} >> '${log}'\n`);
      chmodSync(join(bin, p), 0o755);
    }
    const run = (command, viaEval) => {
      if (existsSync(log)) rmSync(log);
      const args = viaEval ? ['-c', 'eval "$1"', '_', command] : ['-c', command];
      const r = spawnSync('bash', args, { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', input: '', cwd: dir });
      const ran = existsSync(log) ? readFileSync(log, 'utf8').trim().split(NL).filter((p) => p !== 'tee').join('+') : '-';
      const error = /syntax error/.test(r.stderr) ? 'syntax' : /command not found/.test(r.stderr) ? 'not-found' : r.status === 1 ? 'exit1' : '';
      return { ran, error };
    };
    for (const [name, command, verb, ran, error] of CASES) {
      for (const viaEval of [false, true]) {
        const how = `${name}, ${viaEval ? 'eval' : '-c'}`;
        const got = run(command, viaEval);
        assert.deepEqual(got, { ran, error }, how);
        // a printed program is one bash runs: the first, unless a substitution's program runs before the command's own
        const ranList = got.ran.split('+'), candidates = command.includes('$(') ? ranList : ranList.slice(0, 1);
        if (PRINTED_THOUGH_REJECTED.has(name)) assert.deepEqual([got.ran, got.error], ['-', 'syntax'], `${how}: the stated limit`);
        else if (verb === E) assert.equal(got.ran, '-', `${how}: (empty), and bash ran ${got.ran}`);
        else if (verb !== W) assert.ok(candidates.includes(verb), `${how}: ltms prints ${verb}, and bash ran ${got.ran}`);
        if (DANGLING.some(([n]) => n === name)) assert.equal(got.error, 'syntax', `${how}: a dangling operator`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
