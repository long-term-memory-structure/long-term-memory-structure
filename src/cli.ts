#!/usr/bin/env node
// Long-Term Memory Structure: an index of Claude Code transcripts, without their content.
//
// When Claude Code compacts a session, the model's context is replaced by a summary, but the transcript on disk keeps
// every record (it is only ever appended to). The index lets what compaction took out of the context be found again.
//
// Every turn and every tool call on a session's live path becomes one JSON line in which the
// payload is replaced by an ADDRESS (where it lives: <first 8 chars of the file name>:L<line>)
// and a HASH (which bytes were there: sha256, first 12 hex characters). The output can be read
// whole; a shape found in it is opened by its address, in the transcript itself, only where it
// matters.
//
// Reads only the files named on the command line. Writes only to stdout and stderr.
// No network, no telemetry.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import { parseTranscript, repairedLivePath, turnsOf, inputChannel } from './parser.js';
import type { Transcript, TreeNode } from './parser.js';

/** A turn: where its prompt is, which channel it came through, and the prompt's length. */
interface TurnLine { k: 'turn'; a: string; ta: string; ch: string; n: number }
/** A tool call: where it is, a label for what it did, and hashes of what went in and came out.
 *  ok, r, out and n are null when no result was recorded. */
interface CallLine {
  k: 'call'; a: string; ta: string; tool: string; verb: string;
  in: string; ok: boolean | null; ek: string | undefined; r: string | null; out: string | null; n: number | null;
}
type SkeletonLine = TurnLine | CallLine;

/** Counts over one file's skeleton. */
interface StatsLine {
  session: string; turns: number; prompts: number; calls: number; failures: number; unanswered: number;
  errorClasses: Record<string, number>; retries: number; detours: number; maxHops: number; hopsOver2: number;
}

const USAGE = `Usage:
  ltms skeleton <file.jsonl>...   one JSON line per turn and per tool call
  ltms stats <file.jsonl>...      one JSON line of counts per file
  ltms --help                     show the help, with every output field
  ltms --version                  show the version
`;

const HELP = `Long-Term Memory Structure: an index of Claude Code transcripts,
without their content.

${USAGE}
When Claude Code compacts a session, the conversation in the model's context
is replaced by a summary, but the transcript on disk keeps every record:
Claude Code only appends to it. ltms prints an index of the transcript,
one line per turn and per tool call, each with the line of the file where it
is written, so what compaction took out of the context can be found and read
again (for line 22: sed -n 22p <file>).

Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.
ltms reads only the files it is given, writes only to stdout and stderr,
and uses no network.

It follows each session's live path: the branch the session ended on, as the
transcript's own last-prompt record names it (without one, the branch of the
last record written), joined across compactions and late-written error
records. No line holds a prompt, a reply, a tool input or a tool output (the
labels are short words read from them, by the label rule below). A turn line
gives the address of its prompt; a call line gives the addresses of the call
and its result, and hashes of what went in and what came out. An address is
<prefix>:L<line number>: the prefix is the file name's first 8 characters,
or, for a subagent's agent-<id>.jsonl, agent- and the id's first 8. Files
that get the same prefix cannot be told apart in one run (a warning names
them): give them to separate runs.

skeleton, one line per turn:
  k             "turn"
  a             address of the prompt
  ta            turn id: <prefix>:T001, T002, ...
  ch            channel the prompt came through: typed (typed at the CLI),
                sdk (sent through the SDK or another entry point), input (the
                record names no channel), task, loop, parent, or the record's
                own word for another agent (for example peer); none when that
                word is empty
  n             length of the prompt text (JavaScript string length: UTF-16
                code units)

skeleton, one line per tool call, after the turn it belongs to:
  k             "call"
  a             address of the tool call
  ta            the turn it belongs to
  tool          tool name
  verb          a short label for what the call did. Bash: the program the
                command runs, by a whitelist (the README's "The Bash verb"
                has every rule): printed only when it is a plain word and
                every word before it can be passed over with certainty:
                blank and comment lines; cd DIR (with redirections) followed
                by && ; or a newline; NAME=value with a plain, '...', simple
                "..." or $NAME value; an opening ( { or !; the wrappers nohup,
                command, exec, time (-p; where a command starts, or right
                after time), env
                (-i, NAME=value; an unquoted $NAME withholds the verb),
                timeout (a duration) and nice (-n N or -N). After nohup, env,
                nice, timeout or exec, which look the next word up as a file,
                command and exec are programs of their own; after command or
                time they are still the shell's builtins. A path is cut to its
                last part. (empty) when nothing runs after the words passed
                over, or the call has no command; a command that only assigns
                values is labelled by the program inside its first $(...) when
                that is made of such words. A wrapper with nothing after it
                but its own options is the program; [ [[ and shell keywords
                print as themselves. Anything else before the program (a
                redirection after a wrapper too), more than 63 assignments,
                cd commands and wrappers before it, more than 15 commands
                passed over, a program that is not a plain word, or a
                function definition gives (withheld).
                Read, Edit, Write, NotebookEdit: the file's extension (its
                name when it has none; (none) when there is no path, or it
                ends in /). Agent, Task: the subagent type (agent when the call
                names none). Skill: the skill name (skill when it names none).
                Other tools: the name
  in            sha256 of the input as JSON.stringify writes it (keys that are
                whole numbers up to 4294967294 first, ascending; a missing
                input counts as {}), first 12 hex characters; (too large)
                when the input, written as JSON,
                would pass JavaScript's limit on a string's length
  ok            true when the call succeeded; false when it failed (its
                result is marked is_error, or Claude Code wrote the error as
                a string in toolUseResult); null when no result was recorded
                (the session ended, or the file was cut, before the call
                returned, or the call was still running when the file was
                read)
  ek            error class, only when the call failed, from the result's
                first line: exit-<code> (a leading "Exit code N", read
                first), hook-block:<hook script name> or hook-block (Claude
                Code's own format only: PreToolUse:<tool> hook error:
                [<command>]; the name is the last part of the path of the one
                word in the brackets with a script extension (.sh .bash .py
                .js .mjs .cjs .ts .rb .pl; quotes and punctuation around it
                are not part of it), cut at the extension, when that word is
                the command or comes right after an interpreter (node or
                nodejs, deno, bun, python, python3 or another python
                version, bash, sh, zsh, dash, ksh, ruby, perl, tsx or
                ts-node), after any leading env (-i) and NAME=value words;
                and when it is made of ASCII letters, digits, _ . and - and is
                at most 48 characters; a plain hook-block when two or more
                words do, when the word stands anywhere else, when the name
                does not qualify, or when the bracket is longer than 300
                characters), no-anchor, not-read, bad-input, denied, other
  r             address of the result, or null when none was recorded
  out           sha256 of the result text (UTF-8), first 12 hex characters;
                of the whole result as JSON when it holds anything but text
                ((too large) as for in); null when no result was recorded
  n             length of the result text, JavaScript string length (null
                when no result was recorded)

A label (tool, verb, ch, the hook name in ek) is printed only when it looks
like one: at most 64 ASCII letters, digits and . _ : + - (a file name or
extension: without ':'; the shell's [ and [[ as they are). Anything else
prints as (withheld), except that a hook name that does not qualify gives a
plain hook-block.

stats, one line per file:
  session       the file's address prefix
  turns         turns on the live path
  prompts       turns opened by a prompt (channel typed, sdk or input)
  calls         tool calls
  failures      tool calls that failed
  unanswered    tool calls with no recorded result
  errorClasses  failures by error class
  retries       calls right after a failed call in the same turn, with the
                same tool (any input), issued after its result
  detours       the same, with a different tool
  maxHops       the longest chain of failures with one verb, each issued
                after the previous one's result, that a later success with
                that verb closed in the same turn, counting the success. A
                failure with another verb ends a chain and starts a new one,
                even when it was sent in the same response
  hopsOver2     chains of more than 2 hops

Warnings go to stderr: lines that are not JSON objects (or are nested more
than 1,000 levels deep), files with nothing to show (empty, a workflow journal,
no conversation records, no turns), records whose parent links loop, values
too large to hash, files in one run that share a prefix, and records whose
response was read from their parent links (no requestId and no string
message.id), so a zero never reads as a clean result. An internal error is
reported by its kind and where in ltms it happened, never its message.

Every rule in full is in the README:
https://github.com/long-term-memory-structure/long-term-memory-structure

Exit status: 0 when every file was processed, 1 when a file could not be read
or processed, 2 on a usage error.
`;

const TRANSCRIPTS_HINT = 'Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.';

const h12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);
const pad3 = (n: number): string => String(n).padStart(3, '0');

/** Every label printed from a transcript must LOOK like a label: letters, digits and . _ : + -, at most 64
 *  characters; a file's name or extension, the same without ':'. Anything else is a value that may carry payload,
 *  and prints as (withheld). */
const LABEL = /^[\w.:+-]{1,64}$/;
const FILE_LABEL = /^[\w.+-]{1,64}$/;
const WITHHELD = '(withheld)';
const label = (v: unknown, fallback: string, re: RegExp = LABEL): string =>
  (!v ? fallback : typeof v === 'string' && re.test(v) ? v : WITHHELD);
const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- the shell command's verb ---------------------------------------------------------------
// A WHITELIST, not a model of bash. The PROGRAM is printed only when it is a plain word: letters, digits and
// . _ / : , + % @ = ~ ^ - and nothing else. The words before it are passed over only when each is PASSABLE: made of
// plain parts (and the glob characters * and ?), '...' (literal in bash), "..." holding no \, `, " or $ other than $NAME, ${NAME} or $0-$9, and those
// expansions bare. Where such a word ends is certain, so bash's reading and this one cannot differ about which word
// is the program, and nothing the shell would treat as data can be taken for it. Two reviews of an earlier lexer
// that modelled quotes, substitutions, here-documents and comments in full found payload printed through each part
// it modelled wrong; a whitelist has no such parts. Passed over before the program: blank and comment lines;
// `cd DIR` (with redirections) followed by `&&`, `;` or a new line; NAME=value assignments; an opening `(`, `{` or
// `!`; and the wrappers below. Anything else met before the program withholds the verb. What follows the program
// is never read.

/** A word bash reads as exactly its own text. */
const PLAIN = /[A-Za-z0-9_.\/:,+%@=~^-]+/y;
/** One part of a passable word. */
const PART = /[A-Za-z0-9_.\/:,+%@=~^*?-]+|'[^']*'|"(?:[^"\\$`]|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d))*"|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d)/y;
const NAME_EQ = /[A-Za-z_]\w*\+?=/y;
/** A redirection cd may carry before its separator: N>file, N>>file, <file, &>file, N>&M, N>&-. */
const REDIR = /\d*[<>]&(?:\d+|-)(?=[ \t\n;&|]|$)|(?:\d*(?:>>|>|<)|&>>?)(?!\()[ \t]*/y;
/** What may be inside a $(...) that is read: plain parts, blanks, ; & | < > and new lines, '...', safe "...", $NAME. */
const INNER = /(?:[A-Za-z0-9_.\/:,+%@=~^*? \t\n;&|<>-]|'[^']*'|"(?:[^"\\$`]|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d))*"|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d))*\)/y;
/** Wrappers that run the program after them. The words each takes before it: nothing (nohup, command, exec), -p
 *  (time), -i and NAME=value (env), a duration (timeout), -n N or -N (nice). Any other option withholds the verb, and so
 *  does a NAME=value after any wrapper but env: there it is the program's name, not an assignment. time is the
 *  keyword only where a command starts; elsewhere it is a program of its own. (builtin is not a wrapper here: what
 *  follows it names a builtin, or an error.) */
const WRAPPERS = new Set(['time', 'nohup', 'env', 'command', 'exec', 'timeout', 'nice']);
/** The wrappers that look the next word up as a file on PATH. After one of them, command and exec are programs of their
 *  own; after command (a builtin) or time (a keyword), they are still the shell's builtins. */
const LOOK_UP_ON_PATH = new Set(['nohup', 'env', 'nice', 'timeout', 'exec']);

/** Bash: the program in command position, by the whitelist above. A path prints its last segment; [ and [[ print
 *  as themselves, and so does a shell keyword (if, for, while, ...): neither carries payload. A command whose only
 *  words are assignments prints (empty), or, when the first assignment's value is a substitution $(...) or
 *  "$(...)" made only of what INNER allows, the program inside it. A function definition is withheld. */
function bashVerb(s: string, depth = 0): string {
  let i = 0, words = 0, sub: string | undefined;
  const blank = (nl = false) => { while (s[i] === ' ' || s[i] === '\t' || (nl && s[i] === '\n')) i++; };
  const ends = (j: number) => j >= s.length || ' \t\n;&|<>)'.includes(s[j]);
  const at = (re: RegExp, k: number): string | null => { re.lastIndex = k; const m = re.exec(s); return m ? m[0] : null; };
  /** The end of a passable word starting at k (possibly empty), or -1. bare = false refuses an unquoted $NAME: in
   *  an ARGUMENT (env's NAME=value) bash word-splits it, and its second word could become the program. */
  const passable = (k: number, bare = true): number => {
    let j = k;
    for (let p = at(PART, j); p !== null && p.length; p = at(PART, j)) {
      if (!bare && p[0] === '$') return -1;
      j += p.length;
    }
    return ends(j) ? j : -1;
  };
  const separator = (): number => (s.startsWith('&&', i) ? 2 : s[i] === ';' || s[i] === '\n' ? 1 : 0);
  for (let cmd = 0; cmd < 16; cmd++) {               // simple commands passed over: cd DIR, assignments only
    for (;;) {                                        // blank and comment lines; a command may open with ( { or !
      blank(true);
      if (s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (s[i] === '(' && s[i + 1] !== '(') { i++; continue; }
      if ((s[i] === '{' || s[i] === '!') && (s[i + 1] === ' ' || s[i + 1] === '\t' || s[i + 1] === '\n')) { i++; continue; }
      break;
    }
    let first = true, next = false, wrapped = false, lookedUp = false, afterTime = false;
    while (!next) {
      if (i >= s.length) return sub ?? '(empty)';
      if (++words > 64) return WITHHELD;
      const name = at(NAME_EQ, i);
      if (name !== null) {                                             // NAME=value
        if (wrapped) return WITHHELD;                                  // after a wrapper it is the program's name
        let j = i + name.length;
        if (s.startsWith('$(', j) || s.startsWith('"$(', j)) {         // NAME=$(...) or NAME="$(...)"
          const q = s[j] === '"' ? 1 : 0, open = j + q + 2;
          const inner = depth < 3 && s[open] !== '(' ? at(INNER, open) : null;
          // a here-document's body or a case pattern can hold a ')' that closes nothing: refused, not modelled
          if (inner === null || (q && s[open + inner.length] !== '"') || /<<|(?:^|[\s;&|])case\s/.test(inner)) return WITHHELD;
          sub ??= bashVerb(s.slice(open, open + inner.length - 1), depth + 1);
          j = open + inner.length + q;
          if (!ends(j)) return WITHHELD;
        } else {
          j = passable(j);
          if (j < 0) return WITHHELD;
        }
        i = j;
        blank();
        first = false;
        const sep = separator();
        if (sep) { i += sep; next = true; }
        else if (i >= s.length) return sub ?? '(empty)';
        continue;
      }
      const x = at(PLAIN, i);
      if (x === null) {
        if (s.startsWith('[[', i) && ends(i + 2)) return '[[';
        if (s[i] === '[' && ends(i + 1)) return '[';
        return WITHHELD;
      }
      const j = i + x.length;
      if (!ends(j)) return WITHHELD;                                   // the word goes on in a way this does not read
      i = j;
      blank();
      if (x === 'cd' && first) {                                       // cd DIR && ...: the program is the next one's
        const d = passable(i);
        if (d > i) { i = d; blank(); }
        for (let r = at(REDIR, i); r !== null; r = at(REDIR, i)) {
          i += r.length;
          if (!/&(?:\d+|-)$/.test(r)) { const t = passable(i); if (t <= i) return 'cd'; i = t; }
          blank();
        }
        const sep = separator();
        if (!sep) return 'cd';
        i += sep;
        next = true;
        continue;
      }
      // time is the keyword where a command starts, and right after the time keyword (bash's grammar accepts it there
      // too); after a wrapper that looks its next word up on PATH, command and exec are files there, not the builtins
      if (WRAPPERS.has(x) && (x !== 'time' || first || afterTime) && !(lookedUp && (x === 'command' || x === 'exec'))) {
        first = false;
        wrapped = true;
        lookedUp = LOOK_UP_ON_PATH.has(x);
        afterTime = x === 'time';
        if (x === 'time' && s.startsWith('-p', i) && ends(i + 2)) { i += 2; blank(); }
        if (x === 'timeout') {
          const d = at(/\d+(?:\.\d+)?[smhd]?/y, i);
          if (d === null || !ends(i + d.length)) return i >= s.length || separator() ? x : WITHHELD;
          i += d.length; blank();
        }
        if (x === 'nice') {
          const d = at(/-n[ \t]+-?\d+|-\d+/y, i);
          if (d !== null && ends(i + d.length)) { i += d.length; blank(); }
        }
        if (x === 'env') {
          if (s.startsWith('-i', i) && ends(i + 2)) { i += 2; blank(); }
          for (let a = at(NAME_EQ, i); a !== null; a = at(NAME_EQ, i)) {
            if (++words > 64) return WITHHELD;                            // env's assignments count toward the limit
            const e = passable(i + a.length, false);
            if (e < 0) return WITHHELD;
            i = e; blank();
          }
        }
        // a redirection after a wrapper (or its options): the program comes after it, and this reader does not pass one
        if (s[i] === '<' || s[i] === '>' || s.startsWith('&>', i)) return WITHHELD;
        if (i >= s.length || separator() || '|&)'.includes(s[i])) return x;    // the wrapper alone: `env | grep x`
        if (s[i] === '-') return WITHHELD;                                       // an option it does not read
        continue;
      }
      if (x === 'function' || (/^\d+$/.test(x) && (s[j] === '<' || s[j] === '>'))) return WITHHELD;   // a definition; an fd
      if (/^\(\s*\)/.test(s.slice(i, i + 64))) return WITHHELD;                                        // NAME () { ...: a definition
      return label(x.slice(x.lastIndexOf('/') + 1), WITHHELD);
    }
  }
  return WITHHELD;
}

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit'];

/** A short label for what a call did, read from its input; the input itself is never printed.
 *  Bash: see bashVerb. Read, Edit, Write, NotebookEdit: the file's extension, or its name when it has none (a path
 *  is cut at / and at \). Agent, Task: the subagent type. Skill: the skill. Else the tool's name. A value that is
 *  not a string, or not label-shaped, prints as (withheld). */
/** bashVerb, with a stack overflow in a regex on a huge input (millions of characters in one quoted word) read as
 *  "not understood": the verb is withheld and the rest of the file is still read. */
function safeBashVerb(command: string): string {
  try { return bashVerb(command); } catch (e) { if (e instanceof RangeError) return WITHHELD; throw e; }
}

function verbOf(tool: string, input?: unknown): string {
  const inp = isRecord(input) ? input : {};
  if (tool === 'Bash') {
    const c = inp.command;
    return typeof c === 'string' ? safeBashVerb(c) : c === undefined || c === null ? '(empty)' : WITHHELD;
  }
  if (FILE_TOOLS.includes(tool)) {
    const p = inp.file_path ?? inp.notebook_path;
    if (p === undefined || p === null || p === '') return '(none)';
    if (typeof p !== 'string') return WITHHELD;
    const name = p.split(/[\\/]/).pop() || '';
    return label(extname(name) || name, '(none)', FILE_LABEL);
  }
  if (tool === 'Agent' || tool === 'Task') return label(inp.subagent_type, 'agent');
  if (tool === 'Skill') return label(inp.skill, 'skill');
  return label(tool, WITHHELD);
}

/** A failed call's error CLASS, by fixed rules over the result's FIRST line: a label, never the text. A hook block
 *  is recognised only in the harness's own format (PreToolUse:<tool> hook error: [<command>]: ...). The hook's name is
 *  the one word inside those brackets that ends in a script extension (.sh .bash .py .js .mjs .cjs .ts .rb .pl), cut at
 *  the extension, when that word stands where a command's script does: first, or right after an interpreter. None when
 *  two or more words end in an extension (one of them is an argument, and which is not certain), none when the one
 *  such word stands anywhere else (an argument, an option's value, an assignment), and none when the name is longer
 *  than 48 characters or fails the label rule. A bracket longer than 300 characters is a plain hook-block. An exit code
 *  is read only from a leading "Exit code N", before anything else, so a command's own output cannot change its class. */
const SCRIPT_EXTENSION = /\.(?:sh|bash|mjs|cjs|js|ts|py|rb|pl)$/;
/** The programs a hook's script may follow, as the bracket's first word (a path is cut to its last part). */
const INTERPRETER = /^(?:node(?:js)?|deno|bun|python[\d.]*|bash|sh|zsh|dash|ksh|ruby|perl|tsx|ts-node)$/;
/** Quotes, backquotes and punctuation that stand around a word in a command without being part of it. */
const AROUND = /^["'`(]+|["'`;)|&]+$/g;
function errorClass(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) || '').slice(0, 400);
  const opening = /^PreToolUse:[\w.:-]* hook error: \[/.exec(first);
  if (opening) {
    const hook = /^([^\]]{0,300})\]/.exec(first.slice(opening[0].length));
    if (!hook) return 'hook-block';
    // every word that ends in a script extension counts, once the quotes and punctuation around it are taken off: one
    // is the hook's; with two or more, one of them is an argument, and which is not certain. The one such word names
    // the hook only where a command's script stands, after any leading env (with -i) and NAME=value words: as the
    // command itself, or right after an interpreter. Measured over every hook block in the transcripts at hand: 897
    // `bash <script>`, 2 `env NAME=value ... python3 <script>`, 67 with no script word. Anywhere else the word may
    // be an argument, an option's value or an assignment. The name must then be label-shaped and at most 48 characters.
    const words = hook[1].trim().split(/\s+/).map((w) => w.replace(AROUND, ''));
    const scripts = words.flatMap((w, i) => (SCRIPT_EXTENSION.test(w) ? [i] : []));
    const at = scripts.length === 1 ? scripts[0] : -1;
    const lastPart = (w: string | undefined) => w?.split(/[\\/]/).pop() ?? '';
    let k = 0;
    if (lastPart(words[k]) === 'env') { k++; if (words[k] === '-i') k++; }
    while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k])) k++;
    const word = at === k || (at === k + 1 && INTERPRETER.test(lastPart(words[k]))) ? words[at] : undefined;
    const name = word ? /(?:^|[\\/])([\w.-]+)\.[a-z]+$/.exec(word)?.[1] : undefined;
    return name && FILE_LABEL.test(name) && name.length <= 48 ? `hook-block:${name}` : 'hook-block';
  }
  const ex = /^\s*Exit code (\d{1,3})\b/.exec(first);
  if (ex) return `exit-${ex[1]}`;
  if (/String to replace not found/.test(first)) return 'no-anchor';
  if (/has not been read yet|must (?:first )?read/i.test(first)) return 'not-read';
  if (/InputValidationError|invalid input/i.test(first)) return 'bad-input';
  if (/denied|not permitted|permission/i.test(first)) return 'denied';
  return 'other';
}

/** Content as one string: a string as it is; an array as its text blocks (and bare strings) joined by newlines. */
const flat = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '')).join('\n') : '');
/** Printed in place of a hash when the value, written as JSON, would pass JavaScript's limit on a string's length. */
const TOO_LARGE = '(too large)';
/** The parser skips a line nested deeper than 1,000 levels, so the stack is safe here. The length is not: JSON.stringify
 *  can write a value longer than its text in the file (1e20 is written as 21 digits), so a line under the size limit
 *  can still serialize past the string limit. That value prints as (too large), with a warning, and the rest of the
 *  file is read as usual. */
const jsonHash = (v: unknown): string => {
  try { return h12(JSON.stringify(v) ?? ''); }
  catch (e) { if (e instanceof RangeError) return TOO_LARGE; throw e; }
};
/** What a result's hash covers: its text, or, when it holds anything else (an image), the whole content as JSON. */
const outHash = (c: unknown): string => (Array.isArray(c) && c.some((x) => isRecord(x) && x.type !== 'text') ? jsonHash(c) : h12(flat(c)));
const promptLen = (rec: any): number => flat(rec?.message?.content).length;

/** The address prefix: the file name's first 8 characters. A subagent's transcript is named
 *  agent-<id>.jsonl, and those names share their first 8 characters, so there it is agent- and the
 *  id's first 8. */
function prefixOf(file: string): string {
  const name = basename(file);
  return name.startsWith('agent-') ? `agent-${name.slice(6, 14)}` : name.slice(0, 8);
}

/** One line per input turn and per tool call on the live path, in path order. A call whose result
 *  was never recorded has ok, r, out and n null. */
function skeletonOf(file: string, t: Transcript): SkeletonLine[] {
  const pre = prefixOf(file);
  const at = (n: TreeNode) => `${pre}:L${t.positions[n.index].line}`;
  const turns = turnsOf(t, repairedLivePath(t).path);
  const lines: SkeletonLine[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i], ta = `${pre}:T${pad3(i + 1)}`;
    lines.push({ k: 'turn', a: at(turn.prompt), ta, ch: label(inputChannel(turn.prompt.record), 'none'), n: promptLen(turn.prompt.record) });
    for (const c of turn.toolCalls) {
      const answered = c.resultBlock !== undefined, rt = flat(c.resultBlock?.content);
      lines.push({ k: 'call', a: at(c.callNode), ta, tool: label(c.name, WITHHELD), verb: verbOf(c.name, c.input),
        in: jsonHash(c.input ?? {}), ok: answered ? !c.isError : null, ek: answered && c.isError ? errorClass(rt) : undefined,
        r: c.resultNode ? at(c.resultNode) : null, out: answered ? outHash(c.resultBlock?.content) : null, n: answered ? rt.length : null });
    }
  }
  return lines;
}

/** The skeleton's shapes, counted: what follows a failed call, and how many calls a chain of
 *  failures with one verb took to come good. Everything is counted within a turn. A call with no
 *  recorded result is neither a failure nor a success: it is counted as unanswered and leaves a
 *  chain as it was. */
function statsOf(file: string, lines: SkeletonLine[]): StatsLine {
  const s: StatsLine = { session: prefixOf(file), turns: 0, prompts: 0, calls: 0, failures: 0, unanswered: 0, errorClasses: {}, retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 };
  // A call issued in the same response as a failed call (its line is above the failure's result) was made before
  // the failure existed: it is neither a retry nor a detour of it, and it neither extends nor closes its chain.
  const lineOf = (addr: string | null): number => (addr ? Number(addr.slice(addr.lastIndexOf(':L') + 2)) : NaN);
  let prev: CallLine | null = null, run = 0, runVerb: string | null = null, lastFail = -1;
  for (const r of lines) {
    if (r.k === 'turn') { s.turns++; if (r.ch === 'typed' || r.ch === 'sdk' || r.ch === 'input') s.prompts++; prev = null; run = 0; runVerb = null; lastFail = -1; continue; }
    s.calls++;
    if (r.ok === null) s.unanswered++;
    if (r.ok === false) { const ek = r.ek ?? 'other'; s.failures++; s.errorClasses[ek] = (s.errorClasses[ek] || 0) + 1; }
    const at = lineOf(r.a);
    if (prev && prev.ok === false && at > lineOf(prev.r)) { if (r.tool === prev.tool) s.retries++; else s.detours++; }
    if (r.ok === false) {
      if (!run || r.verb !== runVerb) { run = 1; runVerb = r.verb; lastFail = lineOf(r.r); }
      else if (at > lastFail) { run++; lastFail = lineOf(r.r); }
    } else if (r.ok === true && run && r.verb === runVerb && at > lastFail) { s.maxHops = Math.max(s.maxHops, run + 1); if (run + 1 > 2) s.hopsOver2++; run = 0; runVerb = null; }
    prev = r;
  }
  return s;
}

/** Records reachable from no root and no orphan: they sit on a parentUuid cycle, or below one. */
function cycleRecords(t: Transcript): number {
  const seen = new Set<TreeNode>(), stack = [...t.roots, ...t.orphans];
  while (stack.length) { const n = stack.pop()!; if (seen.has(n)) continue; seen.add(n); for (const c of n.children) stack.push(c); }
  return t.nodes.size - seen.size;
}

/** Why a file that parsed still has nothing to show, so a zero never reads as a clean result. */
function warningsFor(cmd: string, file: string, t: Transcript, lines: SkeletonLine[]): string[] {
  const warnings: string[] = [];
  const consequence = cmd === 'stats' ? 'its counts are 0' : 'it adds no lines';
  const p = t.problems.length;
  if (p) warnings.push(`ltms ${cmd}: warning: '${file}': ${p} line${p === 1 ? '' : 's'} could not be read as a JSON object of at most 1,000 levels (first: line ${t.problems[0].line}) and ${p === 1 ? 'was' : 'were'} skipped.`);
  if (t.fileKind === 'empty') warnings.push(`ltms ${cmd}: warning: '${file}' holds no records, so ${consequence}.`);
  else if (t.fileKind === 'journal') warnings.push(`ltms ${cmd}: warning: '${file}' is a workflow journal (launched, started and result records only), not a conversation, so ${consequence}.`);
  else if (t.fileKind === 'unknown') {
    const types = [...new Set(t.records.map((r) => (r.type === undefined || r.type === null ? '(none)' : label(r.type, '(none)'))))].sort();
    const shown = types.slice(0, 6).join(', ') + (types.length > 6 ? `, and ${types.length - 6} more` : '');
    warnings.push(`ltms ${cmd}: warning: '${file}' has no conversation records (no record carries both uuid and parentUuid; record types found: ${shown}), so ${consequence}. Conversation transcripts are the <session>.jsonl files in ~/.claude/projects/<project>/ and the agent-<id>.jsonl files under <session>/subagents/.`);
  }
  else if (lines.length === 0) warnings.push(`ltms ${cmd}: warning: '${file}' has conversation records but no turn on its live path, so ${consequence}.`);
  const large = lines.filter((l) => l.k === 'call' && (l.in === TOO_LARGE || l.out === TOO_LARGE)).length;
  if (large) warnings.push(`ltms ${cmd}: warning: '${file}': ${large} call${large === 1 ? ' holds' : 's hold'} a value too large to write as JSON (it would pass JavaScript's limit on a string's length), ${cmd === 'stats' ? 'so it cannot be hashed (skeleton prints ' + TOO_LARGE + ' there)' : `so ${large === 1 ? 'its' : 'their'} in or out prints ${TOO_LARGE}`}.`);
  const g = t.stats.requestKeyGuessed;
  if (g) warnings.push(`ltms ${cmd}: warning: '${file}': ${g} assistant record${g === 1 ? ' carries' : 's carry'} neither a requestId nor a string message.id, so which records form one response was read from their parent links; a parallel call's turn may be misread.`);
  const c = t.fileKind === 'transcript' ? cycleRecords(t) : 0;
  if (c) warnings.push(`ltms ${cmd}: warning: '${file}': ${c} record${c === 1 ? '' : 's'} sit${c === 1 ? 's' : ''} on a parentUuid cycle or below one (following the parent links never reaches the start of the session), so the live path through ${c === 1 ? 'it' : 'them'} may be incomplete.`);
  return warnings;
}

function cannotRead(cmd: string, file: string, e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return `ltms ${cmd}: cannot read '${file}': no such file or directory. Check the path. ${TRANSCRIPTS_HINT}`;
  if (code === 'EISDIR') return `ltms ${cmd}: '${file}' is a directory. Pass the .jsonl files inside it, e.g. ltms ${cmd} ${file.replace(/\/+$/, '')}/*.jsonl`;
  if (code === 'EACCES' || code === 'EPERM') return `ltms ${cmd}: cannot read '${file}': permission denied. Check its permissions with: ls -l '${file}'`;
  if (code === 'ERR_STRING_TOO_LONG') return `ltms ${cmd}: cannot read '${file}': the file is too large to load as one string (the limit is about 512 MB).`;
  return `ltms ${cmd}: cannot read '${file}': ${(e as Error)?.message ?? String(e)}`;
}

function readVersion(): string {
  return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
}
function printVersion(): number {
  try { out(readVersion() + '\n'); return 0; }
  catch (e) { err(`ltms: cannot read the version from package.json next to this program: ${(e as Error)?.message ?? String(e)}`); return 1; }
}

/** An internal error by its kind and by the place in ltms's own code where it was raised, never by its message: a
 *  message can quote the value that caused it, and so could a future bug's, with the transcript's text in it. The stack
 *  opens with "<name>: <message>", and a message can run over several lines shaped like frames: only what follows that
 *  header is read as the stack, and only ltms's own files are named. Anything else gives the kind alone. */
function internalError(e: unknown): string {
  if (!(e instanceof Error)) return 'Error';
  const kind = LABEL.test(e.name) ? e.name : 'Error';
  const head = e.message ? `${e.name}: ${e.message}` : e.name;
  const stack = typeof e.stack === 'string' && e.stack.startsWith(head) ? e.stack.slice(head.length) : '';
  const frame = stack.split('\n').map((l) => /^\s+at .*?([^()\s/\\]+\.js):(\d+):\d+\)?$/.exec(l)).find((m) => m !== null && /^(?:cli|parser)\.js$/.test(m[1]));
  return frame ? `${kind} at ${frame[1]}:${frame[2]}` : kind;
}

/** Files that get one address prefix cannot be told apart in one run's output: say so, naming them. */
function prefixCollisions(cmd: string, files: string[]): string[] {
  const byPrefix = new Map<string, string[]>();
  for (const f of files) {
    const p = prefixOf(f), l = byPrefix.get(p) ?? [];
    if (!l.some((x) => resolve(x) === resolve(f))) l.push(f);    // the same file twice is not a collision
    byPrefix.set(p, l);
  }
  const warnings: string[] = [];
  for (const [p, l] of byPrefix) {
    if (l.length < 2) continue;
    const names = l.slice(0, 4).map((f) => `'${f}'`), more = l.length - names.length;
    const list = more ? `${names.join(', ')} and ${more} more` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    warnings.push(`ltms ${cmd}: warning: ${list} share the address prefix '${p}', so their lines cannot be told apart in this run's output; run them separately.`);
  }
  return warnings;
}

const out = (s: string): void => { if (s) process.stdout.write(s); };
const err = (s: string): void => { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); };
/** The skeleton is written in chunks, never joined whole: millions of call lines can pass JavaScript's limit on a
 *  string's length even when the file itself could be read. */
function writeSkeleton(lines: SkeletonLine[]): void {
  for (let i = 0; i < lines.length; i += 10000) out(lines.slice(i, i + 10000).map((l) => JSON.stringify(l) + '\n').join(''));
}

function main(argv: string[]): number {
  const cmd = argv[0];
  if (cmd === undefined) { err(`ltms: no command given.\n\n${USAGE}`); return 2; }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { out(HELP); return 0; }
  if (cmd === '--version' || cmd === '-v') return printVersion();
  if (cmd !== 'skeleton' && cmd !== 'stats') {
    if (cmd.startsWith('-')) err(`ltms: unknown option '${cmd}'. The options are --help and --version.\n\n${USAGE}`);
    else err(`ltms: unknown command '${cmd}'. The commands are skeleton and stats.\n\n${USAGE}`);
    return 2;
  }

  const files: string[] = [];
  let optionsEnded = false;
  for (const a of argv.slice(1)) {
    if (!optionsEnded && a === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && (a === '--help' || a === '-h')) { out(HELP); return 0; }
    if (!optionsEnded && (a === '--version' || a === '-v')) return printVersion();
    if (!optionsEnded && a === '-') { err(`ltms ${cmd}: reading from standard input ('-') is not supported. Pass the transcript's path, e.g. ltms ${cmd} ~/.claude/projects/<project>/<session>.jsonl`); return 2; }
    if (!optionsEnded && a.startsWith('-')) { err(`ltms ${cmd}: unknown option '${a}'. ${cmd} takes file names only; put -- before a file name that starts with '-'.`); return 2; }
    files.push(a);
  }
  if (!files.length) { err(`ltms ${cmd}: no input files. Pass one or more transcripts, e.g. ltms ${cmd} ~/.claude/projects/<project>/<session>.jsonl`); return 2; }

  let failed = 0;
  const done: string[] = [];
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); }
    catch (e) { err(cannotRead(cmd, file, e)); failed++; continue; }
    try {
      const t = parseTranscript(text);
      const lines = skeletonOf(file, t);
      for (const w of warningsFor(cmd, file, t, lines)) err(w);
      if (cmd === 'skeleton') writeSkeleton(lines); else out(JSON.stringify(statsOf(file, lines)) + '\n');
      done.push(file);
    } catch (e) {
      err(`ltms ${cmd}: '${file}': stopped with an internal error (${internalError(e)}), so nothing was written for it. This is a bug in ltms; the other files are processed as usual.`);
      failed++;
    }
  }
  for (const w of prefixCollisions(cmd, done)) err(w);
  if (failed) { err(`ltms ${cmd}: ${files.length - failed} of ${files.length} files done; ${failed} failed, as reported above.`); return 1; }
  return 0;
}

// A reader that stops early (e.g. `| head`) closes the pipe: stop quietly, it is not an error here.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  process.stderr.write(`ltms: cannot write the output (${e.code ?? e.message}); what was written so far is incomplete.\n`);
  process.exit(1);
});
process.exitCode = main(process.argv.slice(2));
