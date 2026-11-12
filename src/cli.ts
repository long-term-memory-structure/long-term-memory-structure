#!/usr/bin/env node
// Long-Term Memory Structure: an index of Claude Code transcripts, without their content.
//
// When Claude Code compacts a session, the model's context is replaced by a summary, but the transcript on disk keeps
// every record (Claude Code appends to it; it can rewrite one only in rare cases, and pin keeps both versions). The
// index lets what compaction took out of the context be found again.
//
// Every turn and every tool call on a session's live path becomes one JSON line in which the
// payload is replaced by an ADDRESS (where it lives: <first 8 chars of the file name>:L<line>)
// and a HASH (which bytes were there: sha256, first 12 hex characters). The output can be read
// whole; a shape found in it is opened by its address, in the transcript itself, only where it
// matters.
//
// skeleton and stats read only the files named on the command line; search reads the files named and the .jsonl files
// under the directories named; index the same, but those in a session's own directory, set-aside copies and pin
// directories, which it counts; pin reads the files under the paths it is given, and its pin directory; skill reads its
// own SKILL.md. Writes only to stdout and stderr, except pin, which writes only into its --to directory.
// No network, no telemetry.

import { accessSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { BigIntStats, Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { parseTranscript, repairedLivePath, turnsOf, inputChannel } from './parser.js';
import type { Transcript, TreeNode } from './parser.js';
import { checkSearchSupport, parseSearchQuery, searchTranscript, sieveMayHold, sieveResult, sieveTranscript, SEARCH_DEFAULT_KINDS, SEARCH_GAP_SCRIPTS, SEARCH_KINDS } from './search.js';
import { openSieveCache, sieveKey } from './sieve-cache.js';
import type { SieveCache, SieveFlags } from './sieve-cache.js';
import type { SearchCounts, SearchKind, SearchNotSearched, SearchQuery, SearchResult, SearchTurnHit } from './search.js';
import { indexTranscript } from './session.js';
import { checkPin, claudeConfigDir, isSweepShaped, pinPaths, projectPinReaches } from './pin.js';
import type { PinCheckDone, PinCoverage, PinDone, PinLogLine, PinRefusal } from './pin.js';

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
  ltms index <path>...            one JSON line per session, newest first
  ltms skeleton <file.jsonl>...   one JSON line per turn and per tool call
  ltms stats <file.jsonl>...      one JSON line of counts per file
  ltms search <query> <path>...   the turns that hold every word of the query
  ltms pin <path>... --to <dir>   copies the cleanup does not delete, and a log
  ltms skill                      the skill that teaches an agent to use ltms
  ltms --help                     show the help, with every output field
  ltms --version                  show the version
`;

const HELP = `Long-Term Memory Structure: an index of Claude Code transcripts,
without their content.

${USAGE}
When Claude Code compacts a session, the conversation in the model's context
is replaced by a summary, but the transcript on disk keeps every record:
Claude Code appends to it (it can rewrite one only in rare cases, and pin
keeps both versions). ltms index lists the sessions, one line each, and
ltms skeleton prints one line per turn and per tool call of a session, each
with the line of the file where it is written, so what compaction took out of
the context can be found and read again (for line 22: sed -n 22p <file>).

Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.
ltms reads only the files it is given (search and index: also the .jsonl
files under the directories they are given, index not those in a session's
own directory, set-aside copies or pin directories; pin: the files under the
paths it is given; skill: its own SKILL.md and package.json), writes only to
stdout and stderr, except pin, which writes only into its --to directory, and
uses no network.

It follows each session's live path: the branch the session ended on, as the
transcript's own last-prompt record names it (without one, the branch of the
last record written), joined across compactions and late-written error
records. No line holds a prompt, a reply, a tool input or a tool output (the
labels are short words read from them, by the label rule below). A turn line
gives the address of its prompt; a call line gives the addresses of the call
and its result, and hashes of what went in and what came out. An address is
<prefix>:L<line number>: the prefix is the file name's first 8 characters,
or, for a subagent's agent-<id>.jsonl, agent- and the id's first 8. Files
that get the same prefix cannot be told apart in one run of skeleton or stats
(a warning names them): give them to separate runs.

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

search finds the turns that hold every word of a query, in the transcripts
named and in every .jsonl under the directories named, and prints where
they are: addresses, key paths and offsets, never the text. The query comes
first, as one quoted argument: ltms search 'compaction summary' <path>...
ltms search --help gives its whole part: the query, the paths, the coverage
line, how to read a hit, the options, and every field.

index lists the sessions in the transcripts named and under the directories
named, one line each, newest first: when each ran, its turns, calls and
failures, and the addresses of its prompts, its compaction summaries and its
last reply. ltms index --help gives its whole part.

pin keeps copies of the transcripts that Claude Code's cleanup deletes (after
30 days by default), in a directory of your own, with a log to check them
against: ltms pin <path>... --to <dir>. ltms pin --help has its forms and
output.

skill prints SKILL.md, which teaches an agent the loop: index, skeleton,
search, then read one address. ltms skill --help says how to install it.

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
// is never read, but for the command's end: a command that ends in a dangling &&, || or | is withheld
// (endsInDanglingOperator).

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

/** A command that ends in &&, || or | (or |&) with nothing after it but blanks, new lines, line continuations and
 *  comment lines: bash rejects it as a syntax error, so no program in it is certain to run. Read from the end, as text,
 *  in one backward pass. A comment on the operator's own line is not read (the command keeps the verb its program
 *  gets), and an operator escaped or inside a comment at the very end counts (the verb is withheld). A backslash right
 *  before a new line continues the line onto the next one, so it is passed over too; when it is the last of several,
 *  what is left still ends in a backslash (an escaped one: a word, as bash reads it), never in an operator. Measured on
 *  119,786 Bash commands of our own sessions: this rule withholds none of them; a version that also read a comment
 *  after the operator withheld 238, every one a command bash accepts (a | in a quoted pattern, then a #). */
function endsInDanglingOperator(s: string): boolean {
  let e = s.length;
  for (;;) {
    while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t' || s[e - 1] === '\n')) e--;
    const start = s.lastIndexOf('\n', e - 1) + 1;
    let k = start;
    while (k < e && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k < e && s[k] === '#') { e = start; continue; }   // a comment line: the line before it is the last one
    if (s[e] === '\n' && s[e - 1] === '\\') { e--; continue; }   // a line continuation: the line goes on to the next
    return e > start && (s[e - 1] === '|' || (e - start >= 2 && s[e - 1] === '&' && (s[e - 2] === '&' || s[e - 2] === '|')));
  }
}

/** Bash: the program in command position, by the whitelist above. A path prints its last segment; [ and [[ print
 *  as themselves, and so does a shell keyword (if, for, while, ...): neither carries payload. A command whose only
 *  words are assignments prints (empty), or, when the first assignment's value is a substitution $(...) or
 *  "$(...)" made only of what INNER allows, the program inside it. A function definition is withheld, and so is a
 *  command that ends in a dangling &&, || or |. */
function bashVerb(s: string, depth = 0): string {
  if (endsInDanglingOperator(s)) return WITHHELD;
  let i = 0, words = 0, sub: string | undefined;
  const blank = (nl = false) => { while (s[i] === ' ' || s[i] === '\t' || (nl && s[i] === '\n')) i++; };
  /** Where any command starts: blank and comment lines, and an opening ( { or ! */
  const head = (): void => {
    for (;;) {
      blank(true);
      if (s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (s[i] === '(' && s[i + 1] !== '(') { i++; continue; }
      if ((s[i] === '{' || s[i] === '!') && (s[i + 1] === ' ' || s[i + 1] === '\t' || s[i + 1] === '\n')) { i++; continue; }
      break;
    }
  };
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
    head();
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
  // after the 16th command, the head once more: when it reaches the end, the verb is what the end gives a shorter
  // command; anything else (a program, a 17th command) is past the limit
  head();
  return i >= s.length ? (sub ?? '(empty)') : WITHHELD;
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

function verbOf(tool: string | undefined, input?: unknown): string {
  const inp = isRecord(input) ? input : {};
  if (tool === 'Bash') {
    const c = inp.command;
    return typeof c === 'string' ? safeBashVerb(c) : c === undefined || c === null ? '(empty)' : WITHHELD;
  }
  if ((FILE_TOOLS as readonly unknown[]).includes(tool)) {
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
  const large = lines.filter((l) => l.k === 'call' && (l.in === TOO_LARGE || l.out === TOO_LARGE)).length;
  return fileWarnings(cmd, file, t, lines.length === 0, large);
}
/** warningsFor's texts, for any command: `noTurn` when the live path holds no turn, `large` the calls with a value too
 *  large to hash (search hashes nothing: 0). */
function fileWarnings(cmd: string, file: string, t: Transcript, noTurn: boolean, large: number): string[] {
  const warnings: string[] = [];
  const consequence = cmd === 'stats' ? 'its counts are 0' : cmd === 'search' ? 'nothing in it is searched' : 'it adds no lines';
  const p = t.problems.length;
  if (p) warnings.push(`ltms ${cmd}: warning: '${file}': ${p} line${p === 1 ? '' : 's'} could not be read as a JSON object of at most 1,000 levels (first: line ${t.problems[0].line}) and ${p === 1 ? 'was' : 'were'} skipped.`);
  if (t.fileKind === 'empty') warnings.push(`ltms ${cmd}: warning: '${file}' holds no records, so ${consequence}.`);
  else if (t.fileKind === 'journal') warnings.push(`ltms ${cmd}: warning: '${file}' is a workflow journal (launched, started and result records only), not a conversation, so ${consequence}.`);
  else if (t.fileKind === 'unknown') {
    const types = [...new Set(t.records.map((r) => (r.type === undefined || r.type === null ? '(none)' : label(r.type, '(none)'))))].sort();
    const shown = types.slice(0, 6).join(', ') + (types.length > 6 ? `, and ${types.length - 6} more` : '');
    warnings.push(`ltms ${cmd}: warning: '${file}' has no conversation records (no record carries both uuid and parentUuid; record types found: ${shown}), so ${consequence}. Conversation transcripts are the <session>.jsonl files in ~/.claude/projects/<project>/ and the agent-<id>.jsonl files under <session>/subagents/.`);
  }
  else if (noTurn) warnings.push(`ltms ${cmd}: warning: '${file}' has conversation records but no turn on its live path, so ${consequence}.`);
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
  if (code === 'EISDIR') return `ltms ${cmd}: '${file}' is a directory. Pass the .jsonl files inside it, e.g. ltms ${cmd}${dashFor([file])} ${q(file.replace(/\/+$/, ''))}/*.jsonl`;
  if (code === 'EACCES' || code === 'EPERM') return `ltms ${cmd}: cannot read '${file}': permission denied. Check its permissions with: ls -l${dashFor([file])} ${q(file)}`;
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
  const frame = stack.split('\n').map((l) => /^\s+at .*?([^()\s/\\]+\.js):(\d+):\d+\)?$/.exec(l)).find((m) => m !== null && /^(?:cli|parser|pin|search|session)\.js$/.test(m[1]));
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

// ---- search ---------------------------------------------------------------------------------
// The query first, then the paths. A file named is read whatever its name; under a directory, every *.jsonl at any
// depth, the paths found sorted by UTF-16 code units, each file once (by its real path). A symbolic link named is
// followed; links met under a directory are counted, not followed. The hits are held until the scan ends, then
// written: the coverage line first, then the files newest first, each with its matching turns, at most --max turns in
// all. No line holds a record's text: addresses, key names, offsets, and the query's own terms.

/** A backslash, built: a typed backslash-u escape in this file could be turned into the character it names. */
const BS = String.fromCharCode(92);
const cp = (...c: number[]): string => String.fromCodePoint(...c);
/** A file larger than this fraction of the heap limit is not read: a file takes up to about 9 times its size in
 *  memory (README, What it reads), and running out of memory cannot be caught, so it would end the whole search. */
const SEARCH_HEAP_SHARE = 10;
/** The one-line command that prints a window of 600 characters around a hit's match: path, line, field, at. At a key
 *  of field printed (withheld), it prints instead the keys there whose value leads, along the rest of field, to a string
 *  longer than at (K: an object's keys; s: whether the steps of field from i lead to such a string), to put one in.
 *  Where field leads to no string, it prints `not a string here`, and to one too short, `at is past the end of this
 *  field`, never an empty line or a stack trace. No single quote inside: the shell's quotes hold it.
 *  (node -e has the REPL's modules, fs among them, without an import.) */
const SEARCH_WINDOW = `node -e 'const [p,l,f,a]=process.argv.slice(1),F=JSON.parse(f),K=v=>v!==null&&typeof v=="object"?Object.keys(v):[],s=(v,i)=>i<F.length?F[i]=="(withheld)"?K(v).some(x=>s(v[x],i+1)):s(v?.[F[i]],i+1):typeof v=="string"&&v.length>a;let v=JSON.parse(fs.readFileSync(p,"utf8").split("${BS}n")[l-1]),w;for(const [i,k] of F.entries()){if(k=="(withheld)"){w=K(v).filter(x=>s(v[x],i+1));break}v=v?.[k]}console.log(w?"keys here: "+JSON.stringify(w):typeof v!="string"?"not a string here":a>=v.length?"at is past the end of this field":v.slice(Math.max(0,a-300),+a+300))'`;
/** A file's latest timestamp is printed only when it looks like one (ISO 8601, as Claude Code writes it): the
 *  parser takes any string from a record's timestamp, and anything else could carry text. It prints (withheld). */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** A timestamp as a time, or NaN: ISO 8601 in shape AND a real time (month 13 is not). One rule for printing and
 *  sorting, so that a line never shows a date and sorts with the undated. */
const timeOf = (v: string | null): number => (v !== null && ISO_TIME.test(v) ? Date.parse(v) : NaN);
const isoOrWithheld = (v: string | null): string | null => (v === null ? null : Number.isNaN(timeOf(v)) ? WITHHELD : v);
const KINDS_TEXT = `${SEARCH_KINDS.join(', ')}, or all`;
const SEARCH_OPTIONS = '--kind <list>, --substring, --max <n>, --skip <n>, --count, --oldest, --cache and --no-cache';
/** For the scripts whose words take attached letters: a word, and a longer word holding it that words mode does not
 *  find (Hebrew: house, and the house; Arabic: book, and the book; Korean: school, and at school). */
const CLITIC_EXAMPLE: Record<string, [string, string]> = {
  Hebrew: [cp(0x5d1, 0x5d9, 0x5ea), cp(0x5d5, 0x5d4, 0x5d1, 0x5d9, 0x5ea)],
  Arabic: [cp(0x643, 0x62a, 0x627, 0x628), cp(0x648, 0x627, 0x644, 0x643, 0x62a, 0x627, 0x628)],
  Hangul: [cp(0xd559, 0xad50), cp(0xd559, 0xad50, 0xc5d0, 0xc11c)],
};

const SEARCH_HELP = `ltms search <query> <path>...

Finds the turns of Claude Code transcripts that hold every word of the
query, and prints where they are: addresses, key paths and offsets, never
the text.

The query comes first, as ONE quoted argument; the paths follow:
  ltms search 'compaction summary' ~/.claude/projects/-home-me-my-app
Its words are ANDed over a turn: each must be somewhere in it. A phrase in
"..." (or curly quotes) must stand in one field, its words adjacent and in
order, and so must a word that reads as several (node:sqlite, 2.1.314). A
path is a transcript, or a directory: every .jsonl under it, at any depth.

A project's transcripts are in ~/.claude/projects/, in a folder named after
the project's directory: its path with every character other than A-Z, a-z
and 0-9 written as - (/home/me/my.app: ~/.claude/projects/-home-me-my-app).
A name longer than 200 characters is cut and given a hash: ls
~/.claude/projects lists the folders.

The first line printed is the coverage: what was searched, what was not,
and how many turns matched. Then, newest session first, a line for each
file with a hit, followed by its matching turns, one line per turn: at most
--max turns in all (20 unless set), after the first --skip. left counts the
matching turns after the ones printed, and next is the command that prints
the next ones. stderr holds the notices about the query, the warnings, and
one closing line with the totals.

A hit names each record of the turn that holds a word of the query, with
the kind of its text, the key path of the first field of that kind that
holds a word (field) and the UTF-16 offset of the first match in it (at).
A record can be hundreds of KB: print a window of 600 characters around the
match instead (the file's path, the line number after :L in the record's
address, field, at):
  ${SEARCH_WINDOW} <path> 22 '["message","content",0,"text"]' 1234
Where field holds (withheld), it prints instead the keys at that place whose
value leads to a string longer than at: put one in its place, and run it
again. It prints not a string here where field leads to no string, and at is
past the end of this field where that string is no longer than at.

--kind <list>   the kinds of text searched, separated by commas (or
                --kind=<list>): input (a prompt, on any channel, and a
                prompt queued while the model worked), summary (a
                compaction summary), reply, thinking, call (a tool's input),
                result (a tool's output), system (hook and API-error text),
                meta (other user text: command output, caveats, the
                harness's notes), attachment (the harness's attachments),
                or all. Without it: all but meta and attachment, which hold
                the harness's own text (system prompt, skill listings,
                reminders) and would match most sessions.
--substring     find each term inside longer words too, after the same
                folding (cat also finds concatenate)
--max <n>       the turns printed (default 20; 0 prints every one)
--skip <n>      the matching turns passed over before printing (default 0):
                next gives it, to print the ones after those printed
--count         print the coverage line only
--oldest        oldest sessions first
--cache         keep a sieve of each file read, and answer from the sieves
                kept where they can (below); LTMS_CACHE=1 in the
                environment does the same for every search
--no-cache      no sieve, whatever LTMS_CACHE says: every file is read

What is folded, in the query and in the text: case, accents and other
marks (Hebrew and Arabic points too), compatibility forms (full-width
letters, ligatures), final sigma; JSON escapes in a string (${BS}n, ${BS}u0041) are
read decoded too. A word is a run of letters and digits, and a change of
script inside one cuts it (a Hebrew prefix letter glued to a Latin word is
a word of its own). Chinese, Japanese, Thai, Lao, Khmer and Myanmar are cut
into the dictionary words of Node's Intl.Segmenter. Nothing else: no stems
and no prefixes. A Hebrew, Arabic or Korean word with letters attached is
another word, and a notice gives the --substring command.

Time, measured on one machine: 0.40 to 0.46 s for 18.9 MB of transcripts
(35 files), 2.8 to 3.2 s for 189 MB (350 files): 40 to 65 MB a second. At
that rate 6 GB would take 1.5 to 2.5 minutes, around the Bash tool's
default timeout of 2 minutes: search the project's own folder, or give the
command a longer timeout.

The sieves (--cache, or LTMS_CACHE=1; experimental): each file read under
a directory given gets a sieve, kept in $XDG_CACHE_HOME/ltms/sieves (else
~/.cache/ltms/sieves): the counts the coverage line takes from it, and
which words and which runs of up to 3 characters its text holds, each by
kind, as bits. No text. A later search answers a file from its sieve,
without opening it, when the sieve shows that some term is in no kind
searched; any other file is read as without one. So the output is the
same, the time aside. A sieve is used only while its file is unchanged
(the same size, times and inode); a file that changed while it was read
gets none. The first search with --cache reads every file and is slower
(it builds the sieves); rm -r ~/.cache/ltms removes them. Files named on
the command line are always read.

The coverage line:
  k             "coverage"
  query         the terms searched for, as typed (a hit's w indexes it)
  mode          "words", or "substring" (each term is also found inside
                longer words: cat finds concatenate)
  kinds         the kinds of text searched
  kindsOff      the kinds left out
  files         given: path arguments. found: the files named, and the
                .jsonl files under the directories named, each file once;
                each path that does not exist; and each directory that
                could not be read. read: found minus failed
                (notConversation included). failed: what could not be read,
                as reported on stderr. notConversation: files read that hold
                no turn (empty, a workflow journal, no conversation records,
                or no turn on the live path). symlinks: links met under the
                directories, not followed
  turns         the turns in the files read (skeleton's turns)
  records       the records of those turns that were searched
  notSearched   in records, unless named: offPath (rewound branches),
                toolUseResult (the harness's copy of a result), wireInputs
                (a call's input as the model wrote it), redactedThinking (in
                blocks), sidecars (records outside the conversation), images
                (in blocks), spilled (results written to a file: their
                preview is searched), replays (records written again),
                beforeFirstTurn (records of a file with no turn),
                unreadableLines (in lines), kindsOff (records whose only
                text is of kinds left out). records + offPath + replays +
                beforeFirstTurn + sidecars + kindsOff = the records in the
                files read; toolUseResult, wireInputs, redactedThinking,
                images and spilled are counted over the turns' records,
                searched or not
  hits          files, turns and records with a hit; byKind: for each kind
                searched, the matching turns with that kind of text in a hit
  shown         skipped: the matching turns passed over (--skip); turns: the
                turns printed; order: "newest" or "oldest"
  left          the matching turns after the ones printed
  next          the command that prints the next ones: this search with
                --skip past those printed, and the same --max; null when
                none is left
  segmenter     "icu", or "no-dictionary" when this Node's Intl.Segmenter
                does not cut Chinese and Thai into words (such a run is then
                one word, and a notice says so)
  gapScripts    only for a query holding Hebrew, Arabic, Hangul, Han,
                Hiragana, Katakana, Thai, Lao, Khmer or Myanmar letters: that
                script's letters in the text searched
  ms            the time the search took, in milliseconds

A file line, before its hits:
  k             "file"
  f             the file's number: 1, 2, ... in the order printed
  p             its address prefix, as skeleton's
  path          its path
  last          the latest timestamp of its records (null when none;
                (withheld) when it is not an ISO 8601 time)

A hit line, one per matching turn, in the order of its file's turns:
  k             "hit"
  f             the number of its file's line
  ta            the turn, as skeleton numbers it: <prefix>:T001, T002, ...
  ch            the channel of the turn's prompt, as skeleton's ch
  at            one entry per record and kind of text holding a term, in
                line order: a (the record's address), kind, field (the key
                path of the first field of that kind holding a term: key
                names, down to a tool's parameter and a system or
                attachment record's own keys, each one passing the label
                rule or printed (withheld); a key below them is (withheld);
                and array indices), at (the UTF-16 offset of the
                first match in that field's string, as JSON reads it), w
                (the terms found in that record's text of that kind, in any
                of its fields, as indices into query)

Exit status: 0 when every file was read (no hit is still 0), 1 when a file
or a directory could not be read or was too large, 2 on a usage error.
`;

interface SearchSetup {
  query: string; paths: string[]; kinds: Set<SearchKind>; kindsGiven: boolean;
  substring: boolean; max: number; skip: number; count: boolean; oldest: boolean;
  /** Keep and use sieves: --cache, or LTMS_CACHE=1, and no --no-cache. */
  cache: boolean;
  /** The query also names an existing path (and looks like one), and a path argument exists: searched, with a notice. */
  queryIsPath: boolean;
}

/** A word of a printed command, read the same by sh, bash, zsh and fish: its text in single quotes, with every ' and
 *  every backslash written outside them, as backslash-quote and backslash-backslash. (0.1.2 left a backslash inside the
 *  quotes, where fish reads backslash-backslash and backslash-quote as escapes.) The one copy of this rule, but pin.ts's
 *  own for the notices its library builds. */
const quoted = (s: string): string => `'${s.replace(/['\\]/g, (c) => `'${BS}${c}'`)}'`;
/** A word the shell reads as itself, else the word quoted. It never starts with '-' (an option), '=' (zsh looks the rest
 *  up as a command) or '%' (fish reads %self as its process id). */
const shellWord = (s: string): string => (/^[A-Za-z0-9_.\/:,+@][A-Za-z0-9_.\/:,+%@=-]*$/.test(s) ? s : quoted(s));
/** ' --' when one of the words a command line ends with (the query, the paths) starts with '-': after --, it is not
 *  read as an option. */
const dashFor = (words: string[]): string => (words.some((w) => w.startsWith('-')) ? ' --' : '');
/** The search command for these settings, with `extra` options, the query quoted, and the paths given (or `paths`). */
function searchCommand(s: SearchSetup, extra: string, paths: string[] = s.paths): string {
  const all = s.kinds.size === SEARCH_KINDS.length;
  const kinds = s.kindsGiven ? ` --kind ${all ? 'all' : SEARCH_KINDS.filter((k) => s.kinds.has(k)).join(',')}` : '';
  const dash = dashFor([s.query, ...paths]);
  return `ltms search${s.substring ? ' --substring' : ''}${kinds}${s.oldest ? ' --oldest' : ''}${extra}${dash} ${quoted(s.query)} ${paths.map(shellWord).join(' ')}`.trimEnd();
}

/** "a", "a and b", "a, b and c". */
const listed = (xs: string[], and = 'and'): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** <config>/projects, where <config> is $CLAUDE_CONFIG_DIR or ~/.claude: as a command line writes it, and as a path. */
function projectsDir(): { base: string; raw: string } {
  const config = claudeConfigDir();   // the rule's one copy, in pin.ts
  const raw = join(config.path, 'projects');
  return { base: config.fromEnv ? shellWord(raw) : '~/.claude/projects', raw };
}
/** The current directory's project folder, by Claude Code's rule: under <config>/projects, the directory's path with
 *  every UTF-16 unit outside A-Z, a-z and 0-9 written as '-'. A name longer than 200 characters is cut and given a
 *  hash, which is not computed here. Null when the current directory no longer exists (process.cwd() throws). */
function projectFolder(): { base: string; folder: string; real: string; long: boolean } | null {
  let cwd: string;
  try { cwd = process.cwd(); } catch { return null; }
  const name = cwd.replace(/[^A-Za-z0-9]/g, '-'), { base, raw } = projectsDir();
  return { base, folder: `${base}/${name}`, real: join(raw, name), long: name.length > 200 };
}

const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** ' --' when the projects directory, as a command line writes it, would be read as an option: a relative
 *  $CLAUDE_CONFIG_DIR that starts with '-'. */
const projectsDash = (): string => (projectsDir().raw.startsWith('-') ? ' --' : '');
/** The message for a command given no path (search, after its query; index): the next command, with this directory's
 *  project folder when it exists. */
function noPathMessage(cmd: 'search' | 'index', query?: string): string {
  const p = projectFolder(), { base } = projectsDir(), lead = projectsDash();
  const words = query === undefined ? [] : [query];
  const run = `ltms ${cmd}${dashFor(words) || lead}${words.map((w) => ` ${quoted(w)}`).join('')}`, ls = `ls${lead} ${base}`;
  const head = `ltms ${cmd}: no path given. Give the transcripts' folder or files${query === undefined ? '' : ' after the query'}`;
  if (!p) return `${head}. The current directory no longer exists, so its project folder cannot be named; ${ls} lists the project folders: ${run} ${base}/<folder>`;
  if (p.long) return `${head}. This directory's path is longer than 200 characters, so Claude Code cuts its folder's name and adds a hash: find the folder with ${ls}, then run ${run} ${base}/<folder>`;
  if (isDirectory(p.real)) return `${head}; this directory's project folder is ${p.folder}: ${run} ${p.folder}`;
  return `${head}. This directory's project folder would be ${p.folder}, which does not exist; ${ls} lists the project folders: ${run} ${base}/<folder>`;
}

/** A path argument that names nothing (statSync: ENOENT or ENOTDIR). */
function missing(path: string): boolean {
  try { statSync(path); return false; } catch (e) { const c = (e as NodeJS.ErrnoException)?.code; return c === 'ENOENT' || c === 'ENOTDIR'; }
}
const looksLikePath = (s: string): boolean => /[\\/]/.test(s) || s.endsWith('.jsonl') || s === '.' || s === '..';
/** A missing path argument shaped like a word: no / and not ending in .jsonl. */
const wordNotPath = (s: string): boolean => !/[\\/]/.test(s) && !s.endsWith('.jsonl') && missing(s);

/** The query names an existing path, and looks like one: it holds a / or ends in .jsonl, or is . or .. */
const queryNamesPath = (query: string): boolean => looksLikePath(query) && !missing(query);
/** The query and the paths in the wrong order: a path argument names nothing and looks like a word; or the query names
 *  an existing path (queryNamesPath) and no path argument names one, so the query was left out. Null when neither: a
 *  query that names a path, with a path argument that exists, is searched (with a notice). */
function misorder(query: string, paths: string[]): string | null {
  const queryIsPath = queryNamesPath(query);
  const words = paths.filter(wordNotPath);
  if (!words.length && !(queryIsPath && paths.every(missing))) return null;
  const given = `Read as the query: '${query}'${queryIsPath ? ', which is an existing path' : ''}; as paths: ${paths.length ? paths.map((p) => `'${p}'${words.includes(p) ? ' (no such file or directory)' : ''}`).join(', ') : 'none'}.`;
  const intended = [...(queryIsPath ? [] : [query]), ...words];
  const rest = [...(queryIsPath ? [query] : []), ...paths.filter((p) => !words.includes(p))];
  const example = `ltms search${dashFor([intended.join(' '), ...rest])} ${intended.length ? quoted(intended.join(' ')) : "'<query>'"} ${rest.length ? rest.map(shellWord).join(' ') : '<path>...'}`;
  return `ltms search: the query comes first, as one quoted argument, then the paths. ${given} ${intended.length ? `If the query is '${intended.join(' ')}'` : 'For example'}: ${example}`;
}

/** search's arguments, or the exit status of a usage error already reported (or of --help, --version). */
function readSearchArgs(args: string[]): SearchSetup | number {
  const usage = (m: string): number => { err(`ltms search: ${m}`); return 2; };
  const positional: string[] = [];
  const kinds = new Set<SearchKind>();
  let kindsGiven = false, substring = false, count = false, oldest = false, cache = process.env.LTMS_CACHE === '1', max = 20, skip = 0, ended = false;
  let cacheFlag: boolean | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!ended && a === '--') { ended = true; continue; }
    if (ended || !a.startsWith('-')) { positional.push(a); continue; }
    if (a === '--help' || a === '-h') { out(SEARCH_HELP); return 0; }
    if (a === '--version' || a === '-v') return printVersion();
    if (a === '-') return usage(`reading from standard input ('-') is not supported. Give the transcripts' folder or files after the query, e.g. ltms search 'compaction summary' ~/.claude/projects/<project>`);
    const eq = a.indexOf('='), name = eq < 0 ? a : a.slice(0, eq);
    if (name === '--kind' || name === '--max' || name === '--skip') {
      let v: string;
      if (eq >= 0) v = a.slice(eq + 1);
      else if (i + 1 < args.length) v = args[++i];
      else return usage(name === '--kind' ? `--kind needs a list of kinds after it: ${KINDS_TEXT} (e.g. --kind input,reply).` : name === '--max' ? '--max needs a number after it: the turns to print (0 prints every one).' : '--skip needs a number after it: the matching turns to pass over before printing.');
      if (name === '--max') {
        if (!/^\d+$/.test(v)) return usage(`--max takes a whole number of turns to print (0 prints every one); '${v}' is not one.`);
        max = Number(v);
        continue;
      }
      if (name === '--skip') {
        if (!/^\d+$/.test(v)) return usage(`--skip takes a whole number of matching turns to pass over before printing; '${v}' is not one.`);
        skip = Number(v);
        continue;
      }
      const names = v.split(',').map((x) => x.trim()).filter((x) => x !== '');
      if (!names.length) return usage(`--kind '${v}' names no kind. The kinds are ${KINDS_TEXT}.`);
      for (const k of names) {
        if (k === 'all') { for (const x of SEARCH_KINDS) kinds.add(x); continue; }
        if (!(SEARCH_KINDS as readonly string[]).includes(k)) return usage(`unknown kind '${k}'${names.length > 1 ? ` in --kind '${v}'` : ''}. The kinds are ${KINDS_TEXT}.`);
        kinds.add(k as SearchKind);
      }
      kindsGiven = true;
      continue;
    }
    if (a === '--substring') { substring = true; continue; }
    if (a === '--count') { count = true; continue; }
    if (a === '--oldest') { oldest = true; continue; }
    if (a === '--cache' || a === '--no-cache') {
      if (cacheFlag !== null && cacheFlag !== (a === '--cache')) return usage('--cache and --no-cache are both given: give one.');
      cacheFlag = a === '--cache';
      continue;
    }
    if (name === '--substring' || name === '--count' || name === '--oldest' || name === '--cache' || name === '--no-cache') return usage(`${name} takes no value; '${a}' gives it one.`);
    return usage(`unknown option '${a}'. The options are ${SEARCH_OPTIONS}; put -- before a query or a path that starts with '-'.`);
  }
  if (!positional.length) {
    const p = projectFolder(), folder = p && !p.long && isDirectory(p.real) ? p.folder : `${projectsDir().base}/<project>`;
    return usage(`no query given. The query comes first, as one quoted argument, then the transcripts' folder or files: ltms search${projectsDash()} 'compaction summary' ${folder}`);
  }
  const [query, ...paths] = positional;
  const wrong = misorder(query, paths);
  if (wrong) { err(wrong); return 2; }
  if (!paths.length) { err(noPathMessage('search', query)); return 2; }
  if (cacheFlag !== null) cache = cacheFlag;
  return { query, paths, kinds: kindsGiven ? kinds : new Set(SEARCH_DEFAULT_KINDS), kindsGiven, substring, max, skip, count, oldest, cache, queryIsPath: queryNamesPath(query) };
}

/** The notices about the query, before the scan: terms dropped, an unclosed quote, the scripts whose words this search
 *  can miss (with the --substring command), and a Segmenter without dictionaries. */
function searchNotices(q: SearchQuery, s: SearchSetup): string[] {
  const notes: string[] = [];
  if (s.queryIsPath) notes.push(`ltms search: notice: the query '${s.query}' is also an existing path; it is searched for, in the paths after it. If it was meant as a path, the query comes first: ltms search${dashFor([s.query, ...s.paths])} '<query>' ${[s.query, ...s.paths].map(shellWord).join(' ')}`);
  for (const d of q.dropped) notes.push(`ltms search: notice: the query's term '${d}' has no letter or digit, so it is left out.`);
  if (q.unbalanced) notes.push(`ltms search: notice: a quote in the query '${s.query}' is not closed, so its phrase runs to the end of the query.`);
  const termsIn = (scripts: string[]) => q.terms.filter((t) => t.gapScripts.some((x) => scripts.includes(x)));
  const echo = (scripts: string[]) => {
    const ts = termsIn(scripts);
    return { words: listed(ts.map((t) => `'${t.text}'`)), is: ts.length === 1 ? 'is' : 'are', them: ts.length === 1 ? 'it' : 'them' };
  };
  const substring = searchCommand({ ...s, substring: true }, '');
  if (q.mode === 'substring') {
    // its cost, for every query: every term is found inside longer words too
    notes.push(`ltms search: notice: --substring finds ${listed(q.terms.map((t) => `'${t.text}'`))} inside longer words too, so it also finds words that only contain ${q.terms.length === 1 ? 'it' : 'them'} (as cat finds concatenate).`);
    return notes;
  }
  const clitics = q.gapScripts.filter((x) => SEARCH_GAP_SCRIPTS[x] === 'clitics');
  const spaceless = q.gapScripts.filter((x) => SEARCH_GAP_SCRIPTS[x] === 'spaceless');
  if (clitics.length) {
    const e = echo(clitics);
    const examples = clitics.map((x) => `${CLITIC_EXAMPLE[x][0]} does not find ${CLITIC_EXAMPLE[x][1]}`);
    notes.push(`ltms search: notice: ${e.words} ${e.is} in the ${listed(clitics)} script${clitics.length > 1 ? 's' : ''}, whose words take letters attached before or after them, and words mode finds whole words only: for example, ${listed(examples)}. To find ${e.them} inside longer words too: ${substring}`);
  }
  if (spaceless.length) {
    const e = echo(spaceless);
    const how = q.segmenter === 'icu'
      ? "a word in the dictionary of this Node's Intl.Segmenter is found, an inflected or compound form of it may not be"
      : "this Node's Intl.Segmenter has no dictionary for them, so a run of such text is read as one word, and only a whole run is found";
    notes.push(`ltms search: notice: ${e.words} ${e.is} in the ${listed(spaceless)} script${spaceless.length > 1 ? 's' : ''}, written without spaces between words: ${how}. To find ${e.them} inside any run of text: ${substring}`);
  } else if (q.segmenter === 'no-dictionary') {
    notes.push("ltms search: notice: this Node's Intl.Segmenter does not cut Chinese and Thai into words (it has no dictionary for them), so a run of Chinese, Japanese, Thai, Lao, Khmer or Myanmar text is read as one word: only a whole run is found, and --substring finds a word inside one.");
  }
  return notes;
}

/** U+FFFD, which the text listing of a directory puts in a name for each byte that is not UTF-8. */
const REPLACEMENT = cp(0xfffd);
/** A name's bytes as text: printable ASCII as it is, every other byte (and the backslash) as backslash, x and two hex
 *  digits. */
const escapedName = (b: Buffer): string => [...b].map((x) => (x >= 0x20 && x < 0x7f && x !== 0x5c ? String.fromCharCode(x) : `${BS}x${x.toString(16).padStart(2, '0')}`)).join('');
/** A directory's entries whose names are not valid UTF-8, read again as bytes: `lossy` holds them as the text listing
 *  gives them (which opens nothing), `report` the directories and the files named .jsonl among them (in the listing's
 *  order: on Unix, libuv sorts the names by their bytes). */
function notUtf8Names(d: string): { lossy: Set<string>; report: { name: Buffer; dir: boolean }[]; links: Buffer[] } {
  const lossy = new Set<string>(), report: { name: Buffer; dir: boolean }[] = [], links: Buffer[] = [];
  let names: Buffer[];
  try { names = readdirSync(d, { encoding: 'buffer' }); } catch { return { lossy, report, links }; }
  for (const b of names) {
    const s = b.toString('utf8');
    if (Buffer.from(s, 'utf8').equals(b)) continue;
    lossy.add(s);
    let st;
    try { st = lstatSync(Buffer.concat([Buffer.from(d + '/'), b])); } catch { continue; }
    if (st.isSymbolicLink()) links.push(b);
    else if (st.isDirectory()) report.push({ name: b, dir: true });
    else if (s.endsWith('.jsonl')) report.push({ name: b, dir: false });
  }
  return { lossy, report, links };
}

/** A command that walks the paths it is given (search, index): its name, the word for what it does with a file, what a
 *  stop would lose, and its own command line run again on other paths (for the messages that give one). */
interface Walker { cmd: 'search' | 'index'; done: string; whole: string; lost: string; again: (paths: string[]) => string }
/** What the walk found: the files to read (a file found under a directory named with that directory, `under`); the
 *  paths that failed (reported); the symbolic links met; the entries named .jsonl that are not regular files, beyond
 *  those a no-.jsonl warning already named; and the directories met again (the same device and inode as one already
 *  read). For index (`classify`), also what it does not read: the .jsonl files in a session's own directory, the
 *  set-aside copies of a session, the pin directories, and, for each session directory, its agent transcripts. Every
 *  count is of distinct paths: a directory given twice, or under another one given, is walked for each, as 0.1.2
 *  walked it, and counted once. */
interface SearchWalk {
  files: { path: string; named: boolean; under?: string }[]; failed: number; symlinks: number; special: number; again: number;
  /** .jsonl files under a session's own directory: counted, not read (index). */
  parts: number;
  /** Set-aside copies of a session: counted, not read (index). */
  setAside: number;
  /** Directories holding PINS.log below a directory given: not entered (index). */
  pinStores: string[];
  /** For each session directory met (by its resolved path): the agent-*.jsonl files under it, or null when a directory
   *  under it could not be listed, or it was a symbolic link (index). */
  agents: Map<string, number | null>;
  /** The directories listed whole (resolved): a session file whose directory is not among them gets agents null. */
  listed: Set<string>;
}
/** A session's own directory, by pin's rule (pin.ts, the sweep's shape): its name is a UUID, or its name plus .jsonl
 *  names a regular file beside it. Claude Code keeps a session's subagents/, tool-results/, mcp-tasks/ and workflows
 *  there. */
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A set-aside copy of a session: Claude Code's <session>.orphaned-<timestamp>-<suffix>.jsonl, and the copy pin keeps
 *  of a rewritten version, <stem>.superseded-<12 hex digits>.jsonl (pin.ts, keptRel). */
const SET_ASIDE_NAME = /\.(?:orphaned-[^/]*|superseded-[0-9a-f]{12})\.jsonl$/;
/** An agent transcript's name, as Claude Code writes it under subagents/. */
const AGENT_NAME = /^agent-.*\.jsonl$/;
/** The files to read: each path given, and the *.jsonl files under each directory given (sorted by UTF-16 code
 *  units), each file once by its real path. Each directory is entered once per path given, by its device and inode;
 *  the counts are of distinct entries across the paths given. Paths that cannot be read, directories that cannot be listed, and names that are not UTF-8 are reported
 *  here and counted as failed. With `classify` (index), below a directory given: a .jsonl file in a session's own
 *  directory, and a set-aside copy, is counted and not read; a directory holding PINS.log is not entered. */
function walkPaths(wk: Walker, paths: string[], classify = false): SearchWalk {
  const all: { path: string; named: boolean; under?: string }[] = [];
  let failed = 0, special = 0, again = 0;
  // each counted entry is keyed by what it IS (lstat's device and inode), not by its name: two spellings of one file
  // (an argument that is a link) count once, and two names that differ only in bytes that are not UTF-8 count twice
  const idOf = (path: string | Buffer, follow = false): string => {
    try { const st = (follow ? statSync : lstatSync)(path, { bigint: true }); return `${st.dev}:${st.ino}`; }
    catch { return `path:${typeof path === 'string' ? resolve(path) : path.toString('hex')}`; }
  };
  const links = new Set<string>(), parts = new Set<string>(), setAside = new Set<string>(), pinStores = new Map<string, string>(), failedDirs = new Set<string>();
  const agentFiles = new Map<string, Set<string> | null>(), listed = new Set<string>();
  const isSessionDir = (name: string, siblings: Dirent[]): boolean => UUID_NAME.test(name) || siblings.some((x) => x.name === `${name}.jsonl` && x.isFile());
  const part = (session: string, path: string | Buffer, name: string): void => {
    const id = idOf(path);
    parts.add(id);
    const a = agentFiles.get(session);
    if (a && AGENT_NAME.test(name)) a.add(id);
  };
  for (const p of paths) {
    let dir: boolean;
    try { dir = statSync(p).isDirectory(); }
    catch (e) { err(cannotRead(wk.cmd, p, e)); failed++; continue; }
    if (!dir) { all.push({ path: p, named: true }); continue; }
    // each directory with the session directory it is in (resolved), if any; a directory is entered once per argument,
    // by its device and inode, as 0.1.2 did; the counts are of distinct entries across the arguments
    const found: string[] = [], stack: { d: string; session: string | null }[] = [{ d: p, session: null }], entered = new Set<string>();
    let met = 0, reported = 0, pipes = 0, counted = 0;
    while (stack.length) {
      const { d, session } = stack.pop()!;
      const top = d === p && session === null && entered.size === 0;
      let id: string | null = null;
      try { const st = statSync(d, { bigint: true }); id = `${st.dev}:${st.ino}`; } catch { /* the listing below reports it */ }
      if (id !== null) { if (entered.has(id)) { again++; continue; } entered.add(id); }
      let entries: Dirent[];
      try { entries = readdirSync(d, { withFileTypes: true }); }
      catch (e) {
        if (session !== null) agentFiles.set(session, null);
        reported++;
        const key = id ?? `path:${resolve(d)}`;
        if (failedDirs.has(key)) continue;   // reached again through another argument: reported and counted once
        failedDirs.add(key);
        const code = (e as NodeJS.ErrnoException)?.code;
        err(code === 'EACCES' || code === 'EPERM'
          ? `ltms ${wk.cmd}: cannot read the directory '${d}': permission denied, so the files under it are not ${wk.done}. Check its permissions with: ls -ld${dashFor([d])} ${q(d)}`
          : `ltms ${wk.cmd}: cannot read the directory '${d}': ${(e as Error)?.message ?? String(e)}; the files under it are not ${wk.done}.`);
        failed++;
        continue;
      }
      if (classify && !top && entries.some((e) => e.name === 'PINS.log' && e.isFile())) {
        const key = id ?? `path:${resolve(d)}`;
        if (!pinStores.has(key)) pinStores.set(key, d);
        counted++;   // it holds files, not entered: never "holds no .jsonl file"
        continue;
      }
      if (classify) listed.add(resolve(d));
      const bad = entries.some((e) => e.name.includes(REPLACEMENT)) ? notUtf8Names(d) : null;
      for (const e of entries) {
        if (bad?.lossy.has(e.name)) continue;   // counted or reported below, by its bytes
        const full = join(d, e.name);
        if (e.isSymbolicLink()) {
          met++; links.add(idOf(full));
          // a link is not followed: in a session's own directory, or as a session's directory, its agents are not known
          if (classify && session !== null) agentFiles.set(session, null);
          else if (classify && isSessionDir(e.name, entries)) agentFiles.set(resolve(full), null);
        } else if (e.isDirectory()) {
          let inside = session;
          if (classify && inside === null && isSessionDir(e.name, entries)) { inside = resolve(full); if (!agentFiles.has(inside)) agentFiles.set(inside, new Set()); }
          stack.push({ d: full, session: inside });
        } else if (e.name.endsWith('.jsonl')) {
          if (!e.isFile()) pipes++;
          else if (classify && session !== null) { part(session, full, e.name); counted++; }
          else if (classify && SET_ASIDE_NAME.test(e.name)) { setAside.add(idOf(full)); counted++; }
          else found.push(full);
        }
      }
      for (const b of bad?.links ?? []) {
        met++; links.add(idOf(Buffer.concat([Buffer.from(d + '/'), b])));
        if (classify && session !== null) agentFiles.set(session, null);
      }
      for (const b of bad?.report ?? []) {
        const bytes = Buffer.concat([Buffer.from(d + '/'), b.name]), name = b.name.toString('utf8');
        if (classify && session !== null) {
          // in a session's own directory nothing is read, so a name that is not UTF-8 is counted there, not failed
          if (b.dir) agentFiles.set(session, null);
          else { part(session, bytes, name); counted++; }
          continue;
        }
        if (classify && !b.dir && SET_ASIDE_NAME.test(name)) { setAside.add(idOf(bytes)); counted++; continue; }   // never read: counted, not failed
        const what = b.dir ? `the directory '${join(d, escapedName(b.name))}'` : `'${join(d, escapedName(b.name))}'`;
        err(`ltms ${wk.cmd}: cannot read ${what} (the bytes of its name that are not printable ASCII written as ${BS}xHH): its name is not valid UTF-8, and ltms reads paths as text, so ${b.dir ? 'the files under it are' : 'it is'} not ${wk.done}. Give it a UTF-8 name to ${wk.cmd} it; ls -b${dashFor([d])} ${q(d)} shows the name.`);
        failed++; reported++;
      }
    }
    if (!found.length && !reported && !counted) {
      const notes = [
        met ? `${plural(met, 'symbolic link', 'symbolic links')} met there ${met === 1 ? 'was' : 'were'} not followed` : '',
        pipes ? `${plural(pipes, 'entry', 'entries')} named .jsonl there ${pipes === 1 ? 'is not a regular file, such as a pipe or a socket, and was' : 'are not regular files, such as pipes or sockets, and were'} not read` : '',
      ].filter((x) => x);
      err(`ltms ${wk.cmd}: warning: '${p}' holds no .jsonl file at any depth${notes.length ? ` (${notes.join('; ')})` : ''}, so nothing in it is ${wk.done}. ${TRANSCRIPTS_HINT}`);
    } else special += pipes;
    for (const f of found.sort()) all.push({ path: f, named: false, under: p });
  }
  const seen = new Set<string>(), files: { path: string; named: boolean; under?: string }[] = [];
  for (const f of all) {
    let real: string;
    try { real = realpathSync(f.path); } catch { real = resolve(f.path); }
    if (seen.has(real)) continue;
    seen.add(real);
    files.push(f);
  }
  // a file that is read (a directory under a session's own one given too, or a set-aside copy named) is not also
  // counted as not read: found = the files read + failed + parts + set aside, with no file in two of them
  for (const f of files) { const r = idOf(f.path, true); parts.delete(r); setAside.delete(r); }
  const agents = new Map<string, number | null>();
  for (const [k, v] of agentFiles) agents.set(k, v === null ? null : v.size);
  return { files, failed, symlinks: links.size, special, again, parts: parts.size, setAside: setAside.size, pinStores: [...pinStores.values()], agents, listed };
}

/** A file too large to read within this Node's memory: skipped, with the command that gives Node enough. */
function tooLarge(wk: Walker, file: string, size: number, limit: number): string {
  const bytes = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const need = Math.ceil((size * SEARCH_HEAP_SHARE) / 2 ** 30) * 1024;
  return `ltms ${wk.cmd}: '${file}' is ${bytes(size)} bytes, over the ${bytes(limit)} this Node can ${wk.cmd} in one file (a tenth of its memory limit: reading it could run out of memory, which would stop ${wk.whole} and lose ${wk.lost}), so it is skipped. To ${wk.cmd} it, give Node more memory: NODE_OPTIONS=--max-old-space-size=${need} ${wk.again([file])}`;
}

/** A file read under the directories given, with the kinds of warning it has of its own. */
interface WarnedFile { path: string; kinds: string[] }
/** What the files read under the directories add up to, in the walk's one summary line; null when nothing is worth it.
 *  The files with warnings of their own come last: up to four are named, with the command that shows their warnings. */
function walkSummary(wk: Walker, w: { read: number; journal: number; empty: number; unknown: number; noTurn: number; warned: WarnedFile[] }, walk: SearchWalk): string | null {
  const parts: string[] = [];
  const kinds = [
    w.journal ? `${w.journal} ${w.journal === 1 ? 'is a workflow journal' : 'are workflow journals'}` : '',
    w.empty ? `${w.empty} ${w.empty === 1 ? 'is' : 'are'} empty` : '',
    w.unknown ? `${w.unknown} ${w.unknown === 1 ? 'has' : 'have'} no conversation records` : '',
    w.noTurn ? `${w.noTurn} ${w.noTurn === 1 ? 'has' : 'have'} no turn on ${w.noTurn === 1 ? 'its' : 'their'} live path` : '',
  ].filter((x) => x);
  const none = w.journal + w.empty + w.unknown + w.noTurn;
  if (none) parts.push(`of the ${plural(w.read, 'file', 'files')} read under the directories given, ${listed(kinds)}, so nothing in ${none === 1 ? 'it' : 'them'} is ${wk.done} (files.notConversation)`);
  if (walk.symlinks) parts.push(`${plural(walk.symlinks, 'symbolic link was', 'symbolic links were')} met under the directories given and not followed (files.symlinks)`);
  if (walk.special) parts.push(`${plural(walk.special, 'entry', 'entries')} named .jsonl under the directories given ${walk.special === 1 ? 'is not a regular file, such as a pipe or a socket, and was' : 'are not regular files, such as pipes or sockets, and were'} not read`);
  if (walk.again) parts.push(`${plural(walk.again, 'directory', 'directories')} met under the directories given ${walk.again === 1 ? 'has' : 'have'} the same device and inode as one already read (a bind mount can do that), so ${walk.again === 1 ? 'it was' : 'they were'} not read again`);
  const n = w.warned.length;
  if (n) {
    const named = w.warned.slice(0, 4).map((x) => `'${x.path}' (${listed(x.kinds)})`), more = n - named.length;
    parts.push(`${plural(n, 'file', 'files')} read under the directories given ${n === 1 ? 'has' : 'have'} warnings of ${n === 1 ? 'its' : 'their'} own: ${more ? `${named.join(', ')} and ${more} more` : listed(named)}: name ${n === 1 ? 'it' : 'one'} on the command line to see its warnings: ${wk.again([w.warned[0].path])}`);
  }
  // a line that ends in a command ends without a period, which would be read as part of the last path
  return parts.length ? `ltms ${wk.cmd}: warning: ${parts.join('; ')}${n ? '' : '.'}` : null;
}

/** search, with an internal error outside any one file reported by its kind and its place, never its message. */
function searchMain(args: string[]): number {
  try { return searchRun(args); }
  catch (e) { err(`ltms search: stopped with an internal error (${internalError(e)}). This is a bug in ltms; anything printed before it is incomplete.`); return 1; }
}
function searchRun(args: string[]): number {
  const started = Date.now();
  const s = readSearchArgs(args);
  if (typeof s === 'number') return s;
  const support = checkSearchSupport();
  if (!support.ok) { err(`ltms search: this Node cannot run the search: it has no ${support.missing}. index, skeleton, stats, pin and skill do not need it. Node 20 or newer, built with Intl (as the builds from nodejs.org are), has it.`); return 2; }
  const q = parseSearchQuery(s.query, { mode: s.substring ? 'substring' : 'words', segmenter: support.segmenter ?? 'no-dictionary' });
  if (!q.terms.length) {
    const why = q.dropped.length === 0 ? 'it is empty' : q.dropped.length === 1 ? 'it has no letter or digit' : 'none of its terms has a letter or digit';
    err(`ltms search: the query '${s.query}' has no word to search: ${why}. Give words, e.g. ltms search${dashFor(s.paths)} 'compaction summary' ${s.paths.map(shellWord).join(' ')}`);
    return 2;
  }
  for (const n of searchNotices(q, s)) err(n);

  const wk: Walker = { cmd: 'search', done: 'searched', whole: 'the whole search', lost: 'every hit', again: (paths) => searchCommand(s, '', paths) };
  const walk = walkPaths(wk, s.paths);
  let failed = walk.failed;
  const limit = Math.floor(getHeapStatistics().heap_size_limit / SEARCH_HEAP_SHARE);
  const sum = { turns: 0, records: 0, notConversation: 0, hitFiles: 0, hitTurns: 0, hitRecords: 0 };
  const notSearched: SearchNotSearched = { offPath: 0, toolUseResult: 0, wireInputs: 0, redactedThinking: 0, sidecars: 0,
    images: 0, spilled: 0, replays: 0, beforeFirstTurn: 0, unreadableLines: 0, kindsOff: 0 };
  const byKind: Record<string, number> = {};
  for (const k of SEARCH_KINDS) if (s.kinds.has(k)) byKind[k] = 0;
  const gap: Record<string, number> = {};
  for (const x of q.gapScripts) gap[x] = 0;
  const walked = { read: 0, journal: 0, empty: 0, unknown: 0, noTurn: 0, warned: [] as WarnedFile[] };
  const held: { path: string; prefix: string; last: string | null; order: number; turns: SearchTurnHit[] }[] = [];
  const add = (c: SearchCounts): void => {
    sum.turns += c.turns; sum.records += c.searched; sum.hitTurns += c.hits.turns; sum.hitRecords += c.hits.records;
    for (const k of Object.keys(notSearched) as (keyof SearchNotSearched)[]) notSearched[k] += c.notSearched[k];
    for (const [k, v] of Object.entries(c.hits.byKind)) byKind[k] = (byKind[k] ?? 0) + (v ?? 0);
    for (const [k, v] of Object.entries(c.gapScripts)) gap[k] = (gap[k] ?? 0) + v;
  };
  // the sieves (search.ts, section 10): for a file found under a directory, unchanged since its sieve was kept
  const kindList = [...s.kinds];
  let cache: SieveCache | null = null;
  const sieves = { answered: 0, kept: 0 };
  if (s.cache) {
    let version = '';
    try { version = readVersion(); } catch { /* no version: no cache */ }
    const c = version ? openSieveCache(version) : { why: 'the ltms version could not be read' };
    if ('why' in c) err(`ltms search: notice: no sieve is kept or used: ${c.why}. Every file is read, as with --no-cache.`);
    else cache = c;
  }
  /** One file's result, counted: from its search, or from its sieve. */
  const account = (f: { path: string; named: boolean }, r: SearchResult, flags: SieveFlags, t: Transcript | null): void => {
    const noTurn = r.counts.turns === 0;
    if (r.fileKind !== 'transcript' || noTurn) sum.notConversation++;
    if (f.named) { if (t) for (const w of fileWarnings('search', f.path, t, noTurn, 0)) err(w); }
    else {
      walked.read++;
      if (r.fileKind === 'journal') walked.journal++;
      else if (r.fileKind === 'empty') walked.empty++;
      else if (r.fileKind === 'unknown') walked.unknown++;
      else if (noTurn) walked.noTurn++;
      const kinds = [flags.problems ? 'lines that could not be read' : '', flags.cycle ? 'records on a parentUuid cycle' : '',
        flags.guessed ? 'responses read from parent links' : ''].filter((x) => x);
      if (kinds.length) walked.warned.push({ path: f.path, kinds });
    }
    add(r.counts);
    if (r.turns.length) { sum.hitFiles++; held.push({ path: f.path, prefix: prefixOf(f.path), last: r.last, order: held.length, turns: r.turns }); }
  };
  for (const f of walk.files) {
    let st: BigIntStats;
    try { st = statSync(f.path, { bigint: true }); } catch (e) { err(cannotRead('search', f.path, e)); failed++; continue; }
    const size = Number(st.size);
    if (size > limit) { err(tooLarge(wk, f.path, size, limit)); failed++; continue; }
    const kept = cache && !f.named ? cache.read(st) : null;
    if (kept && !sieveMayHold(kept.sieve, q, kindList)) {
      account(f, sieveResult(kept.sieve, q, kindList), kept.flags, null);
      sieves.answered++;
      continue;
    }
    let bytes: Buffer, text: string;
    try { bytes = readFileSync(f.path); text = bytes.toString('utf8'); } catch (e) { err(cannotRead('search', f.path, e)); failed++; continue; }
    try {
      const t = parseTranscript(text);
      const r = searchTranscript(t, q, { kinds: kindList, prefix: prefixOf(f.path) });
      const flags: SieveFlags = { problems: t.problems.length > 0, cycle: t.fileKind === 'transcript' && cycleRecords(t) > 0, guessed: !!t.stats.requestKeyGuessed };
      account(f, r, flags, t);
      // keep its sieve when there was none for the file as it stands, and the file did not change while it was read
      if (cache && !f.named && !kept && bytes.length === size) {
        let after: BigIntStats | null = null;
        try { after = statSync(f.path, { bigint: true }); } catch { /* gone: keep nothing */ }
        if (after && sieveKey(after) === sieveKey(st)) { cache.write(st, sieveTranscript(t, q.segmenter), flags); sieves.kept++; }
      }
    } catch (e) {
      err(`ltms search: '${f.path}': stopped with an internal error (${internalError(e)}), so nothing in it was searched. This is a bug in ltms; the other files are processed as usual.`);
      failed++;
    }
  }
  const summary = walkSummary(wk, walked, walk);
  if (summary) err(summary);

  // newest first (or oldest), by the latest timestamp; files without one last; ties in the order they were read
  const time = timeOf;
  held.sort((a, b) => {
    const x = time(a.last), y = time(b.last);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y) ? a.order - b.order : Number.isNaN(x) ? 1 : -1;
    return x === y ? a.order - b.order : s.oldest ? x - y : y - x;
  });
  // the matching turns in the order printed: the first `skipped` passed over, then at most --max printed
  const cap = s.count ? 0 : s.max === 0 ? Infinity : s.max, skipped = Math.min(s.skip, sum.hitTurns);
  const lines: string[] = [];
  let shown = 0, passed = 0, fileNo = 0;
  for (const h of held) {
    if (shown >= cap) break;
    let fileLine = false;
    for (const turn of h.turns) {
      if (shown >= cap) break;
      if (passed < skipped) { passed++; continue; }
      if (!fileLine) {
        fileNo++; fileLine = true;
        lines.push(JSON.stringify({ k: 'file', f: fileNo, p: h.prefix, path: h.path, last: isoOrWithheld(h.last) }));
      }
      lines.push(JSON.stringify({ k: 'hit', f: fileNo, ta: turn.ta, ch: turn.ch, at: turn.entries }));
      shown++;
    }
  }
  const found = walk.files.length + walk.failed, read = found - failed, left = sum.hitTurns - skipped - shown;
  const coverage = {
    k: 'coverage', query: q.terms.map((t) => t.text), mode: q.mode,
    kinds: SEARCH_KINDS.filter((k) => s.kinds.has(k)), kindsOff: SEARCH_KINDS.filter((k) => !s.kinds.has(k)),
    files: { given: s.paths.length, found, read, failed, notConversation: sum.notConversation, symlinks: walk.symlinks },
    turns: sum.turns, records: sum.records, notSearched,
    hits: { files: sum.hitFiles, turns: sum.hitTurns, records: sum.hitRecords, byKind },
    shown: { skipped, turns: shown, order: s.oldest ? 'oldest' : 'newest' }, left,
    next: left > 0 ? searchCommand({ ...s, count: false }, ` --skip ${skipped + shown} --max ${s.max}`) : null,
    segmenter: q.segmenter,
    ...(q.gapScripts.length ? { gapScripts: gap } : {}),
    ms: Date.now() - started,
  };
  out(JSON.stringify(coverage) + '\n');
  for (let i = 0; i < lines.length; i += 10000) out(lines.slice(i, i + 10000).join('\n') + '\n');

  const n = sum.hitTurns;
  let close = `ltms search: ${plural(n, 'matching turn', 'matching turns')} in ${n ? `${sum.hitFiles} of ` : ''}${plural(found, 'file', 'files')} (${read} read, ${failed} failed${failed ? ', as reported above' : ''}); ${shown} shown`;
  if (s.count && n) close += ' (--count prints the coverage line only)';
  else if (n && !shown) close += `: --skip ${s.skip} passes over all ${n}`;
  else {
    if (skipped) close += ` after the first ${skipped}`;
    if (left > 0) close += `, ${left} left: --skip ${skipped + shown} shows the next ${s.max === 0 ? left : Math.min(left, s.max)}`;
  }
  close += '.';
  if (cache) close += ` The sieves in ${cache.dir} answered ${sieves.answered} of the ${plural(read, 'file', 'files')} read without opening ${sieves.answered === 1 ? 'it' : 'them'}, and ${sieves.kept} ${sieves.kept === 1 ? 'was' : 'were'} kept (--no-cache opens every file).`;
  if (cache?.writeError) close += ` A sieve could not be written (${cache.writeError}); the search is complete without it.`;
  if (sum.hitTurns === 0 && sum.turns > 0) {
    const ways: string[] = [];
    if (q.terms.length > 1) ways.push('fewer words');
    if (coverage.kindsOff.length) ways.push(`--kind all (${listed(coverage.kindsOff)} ${coverage.kindsOff.length === 1 ? 'was' : 'were'} not searched)`);
    if (q.mode === 'words') ways.push('--substring (each term inside longer words too)');
    const wider = q.mode === 'words' ? searchCommand({ ...s, substring: true, count: false }, '') : coverage.kindsOff.length ? searchCommand({ ...s, kinds: new Set(SEARCH_KINDS), kindsGiven: true, count: false }, '') : '';
    if (ways.length) close += ` To find more, try ${listed(ways, 'or')}${wider ? `: ${wider}` : '.'}`;
  }
  err(close);
  return failed ? 1 : 0;
}

// ---- index ------------------------------------------------------------------------------------
// The paths, as search reads them; below a directory given, a session's own directory, set-aside copies and pin
// directories are counted and not read (walkPaths, classify). Each file read is reduced to its line by the library's
// indexTranscript and dropped; the lines are held until the walk ends, then sorted, newest first by the time the
// session started, and paged as search pages its turns. No line holds a record's text.

const INDEX_HELP = `ltms index <path>...

Lists the sessions of Claude Code transcripts, one line each, newest first:
when each ran, its turns, calls and failures, and the addresses of its
prompts, its compaction summaries and its last reply, never their text.
  ltms index ~/.claude/projects/-home-me-my-app
A path is a transcript, or a directory: every .jsonl under it, at any depth.
A project's transcripts are in ~/.claude/projects/, in a folder named after
the project's directory: its path with every character other than A-Z, a-z
and 0-9 written as - (/home/me/my.app: ~/.claude/projects/-home-me-my-app).
A name longer than 200 characters is cut and given a hash: ls
~/.claude/projects lists the folders. With no path, the message names this
directory's project folder.

Under a directory given, these are counted and not read:
  - the .jsonl files in a session's own directory: one named by a UUID, or
    named as a .jsonl file beside it. Claude Code keeps a session's
    subagents/, tool-results/, mcp-tasks/ and workflows/ there. To list a
    session's agent transcripts, give its subagents directory.
  - set-aside copies of a session: Claude Code's
    <session>.orphaned-<time>-<suffix>.jsonl, and the copies pin keeps of a
    rewritten version, <session>.superseded-<12 hex digits>.jsonl.
  - a directory holding PINS.log, a pin directory, is not entered: give it to
    list the sessions pinned there.
A file named is read whatever its name. Every other file read that holds a
turn gets a line: sessions run with claude -p, the Agent SDK or /loop too,
which Claude Code's session picker leaves out.

The first line printed is the coverage. Then one line per session, newest
first by the time it started: at most --max lines (20 unless set), after the
first --skip. next is the command that prints the next ones. A session
started between two runs moves the later pages down by one, so a line can
print twice; one deleted between them moves them up by one, so one can be
passed over. --max 0 prints every one at once. stderr holds the warnings and
one closing line with the totals.

--max <n>       the sessions printed (default 20; 0 prints every one)
--skip <n>      the sessions passed over before printing (default 0): next
                gives it, to print the ones after those printed
--oldest        oldest sessions first

Time: every file read is parsed whole, as search reads it, at about the same
rate (search --help gives the times measured): index one project's folder,
or give the command a longer timeout.

The coverage line:
  k             "coverage"
  files         given: path arguments. found: the files named, the .jsonl
                files under the directories named (each file once), each
                path that does not exist, and each directory that could not
                be read. read: found minus failed, sessionParts and
                setAside. failed: what could not be read, as reported on
                stderr. notConversation: files read that hold no turn
                (empty, a workflow journal, no conversation records, or no
                turn on the live path). sessionParts: .jsonl files in a
                session's own directory, not read. setAside: set-aside
                copies, not read. symlinks: links met under the
                directories, not followed
  pinStores     directories holding PINS.log below a directory given, not
                entered
  sessions      the files read that hold a turn: one line each
  shown         skipped: the sessions passed over (--skip); sessions: the
                lines printed; order: "newest" or "oldest"
  left          the sessions after the ones printed
  next          the command that prints the next ones: this one with --skip
                past those printed, and the same --max; null when none is
                left
  ms            the time the run took, in milliseconds

A session line:
  k             "session"
  p             the file's address prefix, as skeleton's
  first, last   its earliest and its latest record timestamp, compared as
                strings (Claude Code writes them in one format and one time
                zone); null when it has none; (withheld) when not an ISO 8601
                time. Undated sessions come last, in both orders
  turns         its turns, as skeleton counts them
  calls         its tool calls, as skeleton's call lines
  failures      the calls that failed (ok false)
  compactions   one entry per compaction on its live path: boundary, the
                address of the compact_boundary record; summary, the address
                of the summary the model carried on from, or null when none
                follows the boundary before the next turn
  agents        the agent transcripts (agent-*.jsonl) in its own directory;
                null when that directory was not under a directory given (a
                file named), or could not be listed whole
  firstPrompt   the address of its first turn's prompt
  lastPrompt    the address of its last turn's prompt
  lastReply     the address of its last reply: the last assistant record on
                its live path holding text (search's kind reply); null when
                none
  path          its path

An address is <prefix>:L<line>, line 186 of the file is
  sed -n 186p <path> | cut -c1-2000
A line can be hundreds of KB: read a window of it.

Exit status: 0 when every file was read, 1 when a file or a directory could
not be read or was too large, 2 on a usage error.
`;

interface IndexSetup { paths: string[]; max: number; skip: number; oldest: boolean }
/** The index command for these settings, with `extra` options and the paths given (or `paths`). */
function indexCommand(s: IndexSetup, extra: string, paths: string[] = s.paths): string {
  return `ltms index${s.oldest ? ' --oldest' : ''}${extra}${dashFor(paths)} ${paths.map(shellWord).join(' ')}`.trimEnd();
}

/** index's arguments, or the exit status of a usage error already reported (or of --help, --version). */
function readIndexArgs(args: string[]): IndexSetup | number {
  const usage = (m: string): number => { err(`ltms index: ${m}`); return 2; };
  const paths: string[] = [];
  let max = 20, skip = 0, oldest = false, ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!ended && a === '--') { ended = true; continue; }
    if (ended || !a.startsWith('-')) { paths.push(a); continue; }
    if (a === '--help' || a === '-h') { out(INDEX_HELP); return 0; }
    if (a === '--version' || a === '-v') return printVersion();
    if (a === '-') return usage(`reading from standard input ('-') is not supported. Give the transcripts' folder or files, e.g. ltms index ~/.claude/projects/<project>`);
    const eq = a.indexOf('='), name = eq < 0 ? a : a.slice(0, eq);
    if (name === '--max' || name === '--skip') {
      let v: string;
      if (eq >= 0) v = a.slice(eq + 1);
      else if (i + 1 < args.length) v = args[++i];
      else return usage(name === '--max' ? '--max needs a number after it: the sessions to print (0 prints every one).' : '--skip needs a number after it: the sessions to pass over before printing.');
      if (!/^\d+$/.test(v)) return usage(name === '--max' ? `--max takes a whole number of sessions to print (0 prints every one); '${v}' is not one.` : `--skip takes a whole number of sessions to pass over before printing; '${v}' is not one.`);
      if (name === '--max') max = Number(v); else skip = Number(v);
      continue;
    }
    if (a === '--oldest') { oldest = true; continue; }
    if (name === '--oldest') return usage(`--oldest takes no value; '${a}' gives it one.`);
    return usage(`unknown option '${a}'. The options are --max <n>, --skip <n> and --oldest; put -- before a path that starts with '-'.`);
  }
  if (!paths.length) { err(noPathMessage('index')); return 2; }
  return { paths, max, skip, oldest };
}

/** index, with an internal error outside any one file reported by its kind and its place, never its message. */
function indexMain(args: string[]): number {
  try { return indexRun(args); }
  catch (e) { err(`ltms index: stopped with an internal error (${internalError(e)}). This is a bug in ltms; anything printed before it is incomplete.`); return 1; }
}
function indexRun(args: string[]): number {
  const started = Date.now();
  const s = readIndexArgs(args);
  if (typeof s === 'number') return s;
  const wk: Walker = { cmd: 'index', done: 'indexed', whole: 'the whole run', lost: 'every line', again: (paths) => indexCommand(s, '', paths) };
  const walk = walkPaths(wk, s.paths, true);
  let failed = walk.failed, notConversation = 0;
  const limit = Math.floor(getHeapStatistics().heap_size_limit / SEARCH_HEAP_SHARE);
  const walked = { read: 0, journal: 0, empty: 0, unknown: 0, noTurn: 0, warned: [] as WarnedFile[] };
  const held: { first: string | null; order: number; line: Record<string, unknown> }[] = [];
  const iso = isoOrWithheld;
  for (const f of walk.files) {
    let size: number;
    try { size = statSync(f.path).size; } catch (e) { err(cannotRead('index', f.path, e)); failed++; continue; }
    if (size > limit) { err(tooLarge(wk, f.path, size, limit)); failed++; continue; }
    let text: string;
    try { text = readFileSync(f.path, 'utf8'); } catch (e) { err(cannotRead('index', f.path, e)); failed++; continue; }
    try {
      const t = parseTranscript(text), prefix = prefixOf(f.path);
      const x = indexTranscript(t, { prefix });
      const noTurn = x.turns === 0;
      if (t.fileKind !== 'transcript' || noTurn) notConversation++;
      if (f.named) for (const w of fileWarnings('index', f.path, t, noTurn, 0)) err(w);
      else {
        walked.read++;
        if (t.fileKind === 'journal') walked.journal++;
        else if (t.fileKind === 'empty') walked.empty++;
        else if (t.fileKind === 'unknown') walked.unknown++;
        else if (noTurn) walked.noTurn++;
        const kinds = [t.problems.length ? 'lines that could not be read' : '', t.fileKind === 'transcript' && cycleRecords(t) ? 'records on a parentUuid cycle' : '',
          t.stats.requestKeyGuessed ? 'responses read from parent links' : ''].filter((k) => k);
        if (kinds.length) walked.warned.push({ path: f.path, kinds });
      }
      if (t.fileKind !== 'transcript' || noTurn) continue;
      // its own directory: <name without .jsonl>/ beside it; listed by the walk, or known to be absent from a directory
      // the walk listed; else (a file named) not known
      const home = dirname(f.path), own = resolve(join(home, basename(f.path).replace(/\.jsonl$/, '')));
      const agents = walk.agents.has(own) ? walk.agents.get(own)! : walk.listed.has(resolve(home)) ? 0 : null;
      held.push({ first: x.first, order: held.length, line: {
        k: 'session', p: prefix, first: iso(x.first), last: iso(x.last), turns: x.turns, calls: x.calls, failures: x.failures,
        compactions: x.compactions, agents, firstPrompt: x.firstPrompt, lastPrompt: x.lastPrompt, lastReply: x.lastReply, path: f.path,
      } });
    } catch (e) {
      err(`ltms index: '${f.path}': stopped with an internal error (${internalError(e)}), so it has no line. This is a bug in ltms; the other files are processed as usual.`);
      failed++;
    }
  }
  const summary = walkSummary(wk, walked, walk);
  if (summary) err(summary);
  for (const d of walk.pinStores) err(`ltms index: notice: '${d}' holds PINS.log, a pin directory, so it was not entered: the copies there would list sessions again. To list the sessions pinned there, give it: ${indexCommand(s, '', [d])}`);

  // newest first (or oldest) by the time a session started; undated last in both orders; ties in the order read
  const time = timeOf;
  held.sort((a, b) => {
    const x = time(a.first), y = time(b.first);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y) ? a.order - b.order : Number.isNaN(x) ? 1 : -1;
    return x === y ? a.order - b.order : s.oldest ? x - y : y - x;
  });
  const skipped = Math.min(s.skip, held.length), shown = held.slice(skipped, s.max === 0 ? held.length : skipped + s.max);
  const left = held.length - skipped - shown.length;
  const found = walk.files.length + walk.failed + walk.parts + walk.setAside, read = found - failed - walk.parts - walk.setAside;
  const coverage = {
    k: 'coverage',
    files: { given: s.paths.length, found, read, failed, notConversation, sessionParts: walk.parts, setAside: walk.setAside, symlinks: walk.symlinks },
    pinStores: walk.pinStores.length, sessions: held.length,
    shown: { skipped, sessions: shown.length, order: s.oldest ? 'oldest' : 'newest' }, left,
    next: left > 0 ? indexCommand(s, ` --skip ${skipped + shown.length} --max ${s.max}`) : null,
    ms: Date.now() - started,
  };
  out(JSON.stringify(coverage) + '\n');
  for (let i = 0; i < shown.length; i += 10000) out(shown.slice(i, i + 10000).map((h) => JSON.stringify(h.line) + '\n').join(''));

  const n = held.length, notRead = walk.parts + walk.setAside;
  let close = `ltms index: ${plural(n, 'session', 'sessions')} in ${plural(found, 'file', 'files')} (${read} read, ${failed} failed${failed ? ', as reported above' : ''}${notRead ? `; ${walk.parts} in sessions' own directories and ${walk.setAside} set aside, not read` : ''}); ${shown.length} shown`;
  if (n && !shown.length) close += `: --skip ${s.skip} passes over all ${n}`;
  else {
    if (skipped) close += ` after the first ${skipped}`;
    if (left > 0) close += `, ${left} left: --skip ${skipped + shown.length} shows the next ${Math.min(left, s.max)}`;
  }
  err(close + '.');
  return failed ? 1 : 0;
}

// ---- skill --------------------------------------------------------------------------------------
// Prints the package's own SKILL.md (skills/ltms/SKILL.md, the Claude Code plugin's layout and the Agent Skills format),
// and on stderr the command that installs it where Claude Code looks for personal skills. Reads only that file.

/** The command that installs the skill: under $CLAUDE_CONFIG_DIR when it is set, else ~/.claude; npx -y, since without
 *  it npx writes its install prompt into the file; a temporary file, so a run that fails leaves the old copy whole. */
function skillInstallLine(): string {
  const config = claudeConfigDir(), minor = readVersion().split('.').slice(0, 2).join('.');
  const raw = join(config.path, 'skills', 'ltms'), dir = config.fromEnv ? shellWord(raw) : '~/.claude/skills/ltms';
  const dash = config.fromEnv && raw.startsWith('-') ? ' --' : '';
  return `mkdir -p${dash} ${dir} && npx -y long-term-memory-structure@${minor} skill > ${dir}/SKILL.md.tmp && mv${dash} ${dir}/SKILL.md.tmp ${dir}/SKILL.md`;
}
const installOrWhy = (): string => { try { return skillInstallLine(); } catch (e) { return `(the version could not be read from package.json: ${(e as NodeJS.ErrnoException)?.code ?? 'an error'}; the line is in the README)`; } };
const skillHelp = (): string => `ltms skill

Prints the skill that teaches an agent to use ltms: SKILL.md, in the Agent
Skills format. To install it for Claude Code (and again after upgrading
ltms, so that it names the fields this version prints):
  ${installOrWhy()}
It reads only its own SKILL.md, and package.json for the version; it writes only to
stdout and stderr.

Exit status: 0 when it printed the skill, 1 when it could not read it, 2 on a
usage error.
`;
function skillMain(args: string[]): number {
  for (const a of args) {
    if (a === '--help' || a === '-h') { out(skillHelp()); return 0; }
    if (a === '--version' || a === '-v') return printVersion();
    err(`ltms skill: ${a.startsWith('-') ? `unknown option '${a}'` : `unexpected argument '${a}'`}. skill takes no arguments; ltms skill --help says how to install it.`);
    return 2;
  }
  let text: string;
  try { text = readFileSync(new URL('../skills/ltms/SKILL.md', import.meta.url), 'utf8'); }
  catch (e) { err(`ltms skill: cannot read the skill file next to this program (skills/ltms/SKILL.md): ${(e as NodeJS.ErrnoException)?.code ?? 'an error'}.`); return 1; }
  out(text);
  try { err(`ltms skill: to install it for Claude Code: ${skillInstallLine()}`); } catch { /* the version could not be read: the skill is printed all the same */ }
  return 0;
}

// ---- ltms pin ---------------------------------------------------------------------------------------------------
// The command around the ./pin library (pin.ts): the arguments, the hook's JSON, the output lines, the messages and
// the exit status. What is pinned, how, and the refusals' own sentences are the library's.

const PIN_HELP = `ltms pin: copies of Claude Code's transcripts that its cleanup does not
delete, and a log to check them against.

Usage:
  ltms pin <path>... --to <dir> [--root <dir>] [--list] [--rehash]
  ltms pin --from-hook --to <dir> [--root <dir>] [--list] [--rehash]
  ltms pin --check <dir> [--root <dir>]

Claude Code deletes a session's transcript, and the session's directory with
it, once the transcript has not been modified for cleanupPeriodDays (30 by
default), and deletes each file under a session's tool-results/ by its own
age, even while the transcript lives. pin copies them into <dir>, which the
cleanup does not reach, and appends what changed to <dir>/PINS.log.

The root is <config>/projects, where <config> is $CLAUDE_CONFIG_DIR, or
~/.claude when that is unset or empty; --root names another. Paths resolve
against the current directory and must be under the root; a file's place in
the pin (its rel) is its path under the root. Under each project directory (a
directory directly under the root) pin copies <name>.jsonl,
<name>.jsonl.superseded-*, and every file under subagents/, tool-results/,
workflows/ and mcp-tasks/ of a session directory (one named by a UUID, or by
a <name> whose <name>.jsonl is beside it). A <sid>.jsonl given by itself
brings its <sid>/. Other files are counted, not copied; memory/, .git and
symbolic links met under a path are counted, not entered.

Each file is read once. A .jsonl is copied up to its last new line, so a line
still being written waits for a later pin; one with no new line yet is not
copied (notCopied). A file is new; grown (its copy is a prefix of it);
rewritten (anything else: the old copy is first kept by a hard link,
<stem>.superseded-<sha12>.jsonl, or <name>.superseded-<sha12> for another
file); or unchanged (the same size and sha256). A file whose size and mtime
are what its last line in PINS.log records is not read again, unless
--rehash is given; --rehash also reads each copy whose source still holds
the version its last line records, and writes it again from that source when
it holds other bytes. pin never writes through a symbolic link inside <dir>,
never reads PINS.log, the lock or a kept copy through one, and never waits on
a FIFO there: one of those that is not a regular file is a failure
(not-a-regular-file), or, for PINS.log before a pin starts, a refusal.

The pin directory <dir>:
  <rel>           the newest bytes of each file, with its source's mtime
  PINS.log        JSON lines: a root line, then one line per change (new,
                  grown, rewritten, recovered, takeover), each holding the
                  sha256 of the line before it
  .ltms-pin.lock  while a pin runs: its pid, host and start time
Copies and PINS.log are 0600 (or the source's mode, when stricter);
directories are 0700.

Refused (exit 2, nothing written): no --to; --to inside Claude Code's config
directory, a path given or the root; a path inside --to or outside the root;
a --to that is not a directory, or that holds files and no PINS.log; a
PINS.log that is not a regular file, has another name (a hard link), or does
not open with its root line; a root other than the one PINS.log records. Each
message gives the next command.

stdout: one coverage line, then one line per failure.
  {"k":"coverage","root","to","files":{"seen","new","grown","rewritten",
  "unchanged","notCopied","failed"},"failures","partial","skipped":{
  "notSessionShaped","symlinks","memory","git"},"bytesCopied",
  "keptSourceGone","lastLog","ms"}
  seen            new + grown + rewritten + unchanged + notCopied + failed
  notCopied       .jsonl files with no new line yet (empty, or their first
                  line still being written): nothing whole to copy
  failed          the source files that could not be read, kept or written
  failures        every failure line that follows: failed of them are
                  source files, the rest the pin directory, its lock or log,
                  a path or a directory under it, or a copy recovery read
  partial         .jsonl files with bytes after their last new line, left
                  for a later pin; also counted among the six above
  skipped         found under the paths and not copied
  bytesCopied     the bytes written into copies
  keptSourceGone  pinned files under the paths whose source is gone: what
                  only the pin now keeps
  lastLog         when PINS.log's last line was written
  {"k":"failure","path","rel","op","code"}: a file or directory that could
  not be read or written; op is to, lock, log, walk, read, keep, write or
  recover, and code the error code (symlink-in-pin: a directory on the way
  to the copy is a symbolic link, which pin does not write through;
  not-a-regular-file: PINS.log, the lock or a kept copy's name is a link, a
  FIFO or another thing that is not a regular file)
--list adds one line per line appended to PINS.log for a file:
  {"k":"pin","rel","how","bytes","prev","kept"}: prev is the length of the
  version before (null for a new file); kept, after a rewrite, the old one's
  rel
stderr: what recovery found and did, and one closing line when something
failed or nothing was found to pin.

--from-hook reads a Claude Code hook's JSON from standard input and pins the
directory its transcript_path is in: the session's project directory. It
refuses (exit 2), saying why, when standard input is a terminal or empty, is
not JSON, is not an object, or has no transcript_path string. In a SessionEnd
hook, set "timeout": 60 (Claude Code gives SessionEnd hooks 1.5 s by
default); the README has the settings.json lines.

A lock held by a running pin is waited for up to 30 s; then pin exits 1 with
the holder's pid and start time, and the rm command. A lock whose pid is no
longer running on this host is taken over. SIGINT, SIGTERM or SIGHUP stops a
pin between two files: it removes the lock, and every file it pinned is
whole and in PINS.log.

--check <dir> reads every version PINS.log records back from the copy that
holds it, checks that each line holds the sha256 of the line before it, and
counts the files under the root (the one PINS.log records, or --root) that
are missing from the pin or longer than their copy (a .jsonl with no new
line yet is not missing, and one whose copy is a prefix of it, longer only
by an unfinished line, which a pin does not copy, is counted apart:
unfinished). It writes nothing, and first waits for a pin that is running,
as pin does: up to 30 s. After a mismatch in a current copy whose source is
there (under the root PINS.log records, as a file pin copies), its closing
line gives the --rehash command for the projects of those copies (for a
file under .git, or under memory/ directly under a project directory,
where a pin of its project does not go, the file itself): it writes back
what the sources still hold, and --check, run again, says what remains.
The files missing from the pin or longer than their copies get the command
that pins them, from the root PINS.log records (with --root), when that is
the root walked. Beside the --rehash command it gives none, and says to run
the --rehash first: a pin run before it may record a damaged copy.
While PINS.log has another name (a hard link), which a pin refuses, it says
so, gives no pin command, and says nothing of what a next pin would do.
stdout: one line, then one line per finding.
  {"k":"check","dir","root","lines","versions","files","mismatches",
  "chainBreaks","unreadableLines","unlogged","temps","lock","lastLog",
  "staleness":{"root","fromLog","sources","missing","longer","unfinished",
  "projectsNotPinned","failed"},"ms"}
  {"k":"mismatch","rel","copy","line","want":{"bytes","sha256"},"got"}
  {"k":"chain","line","want","got"}
  {"k":"unreadable","line"}
  {"k":"unlogged","rel"}
In the first line, lines, versions and files count PINS.log's lines, the
versions they record and the copies read. line is a line's number in
PINS.log; copy is the rel of the copy read (rel's own, or a kept copy); got
is null when that copy is missing or cannot be read.

Exit status: 0 when every file was pinned; 1 when a file or directory failed,
or the lock stayed held; 2 on a usage error or a refusal. --check: 0 when the
pin holds what PINS.log records; 1 on a mismatch, a chain break, a line that
is not a log line, a directory under the root that could not be read, or a
lock held for the whole wait (unlogged files, temp files, a lock left by a
pin that stopped, and missing sources are reported, and fail nothing); 2 on
a usage error or a directory that is not a pin.
`;

/** pin's arguments, read as cli.ts reads skeleton's: --help and --version anywhere before --, and -- ends the options. */
interface PinArgs { k: 'args'; paths: string[]; to?: string; root?: string; check?: string; fromHook: boolean; list: boolean; rehash: boolean }
type PinArgsRead = PinArgs | { k: 'usage'; message: string } | { k: 'help' } | { k: 'version' };
const PIN_VALUE_OPTIONS = ['--to', '--root', '--check'] as const;
type PinValueOption = typeof PIN_VALUE_OPTIONS[number];
const PIN_OPTION_KEY = { '--to': 'to', '--root': 'root', '--check': 'check' } as const;
const PIN_OPTIONS = '--to, --root, --from-hook, --check, --list, --rehash, --help and --version';
/** A path in a next command: single-quoted, a quote in it written as the shell reads it back. */
const q = quoted;

function readPinArgs(argv: string[]): PinArgsRead {
  const a: PinArgs = { k: 'args', paths: [], fromHook: false, list: false, rehash: false };
  const usage = (message: string): PinArgsRead => ({ k: 'usage', message });
  let ended = false;
  for (let n = 0; n < argv.length; n++) {
    const x = argv[n];
    if (ended || !x.startsWith('-')) { a.paths.push(x); continue; }
    if (x === '--') { ended = true; continue; }
    if (x === '--help' || x === '-h') return { k: 'help' };
    if (x === '--version' || x === '-v') return { k: 'version' };
    if (x === '-') return usage(`'-' is not a path: pin reads no file from standard input (a hook's JSON comes in with --from-hook).`);
    if (x === '--from-hook') { a.fromHook = true; continue; }
    if (x === '--list') { a.list = true; continue; }
    if (x === '--rehash') { a.rehash = true; continue; }
    const eq = x.indexOf('=');
    const name = (eq < 0 ? x : x.slice(0, eq)) as PinValueOption;
    if (!PIN_VALUE_OPTIONS.includes(name)) return usage(`unknown option '${x}'. The options are ${PIN_OPTIONS}; put -- before a path that starts with '-'.`);
    let value: string;
    if (eq >= 0) value = x.slice(eq + 1);
    else {
      if (n + 1 >= argv.length) return usage(`${name} needs a directory after it: ${name} <dir>.`);
      value = argv[++n];
      if (value.startsWith('-')) return usage(`${name} needs a directory after it, and '${value}' starts with '-': for a directory whose name starts with '-', write ${name}=<dir> or ${name} ./<dir>.`);
    }
    if (value === '') return usage(`${name} is empty: name a directory, ${name} <dir>.`);
    const key = PIN_OPTION_KEY[name], before = a[key];
    if (before !== undefined) return usage(`${name} is given twice ('${before}' and '${value}'): give it once.`);
    a[key] = value;
  }
  return a;
}

/** The project directory a Claude Code hook's JSON names: the directory of its transcript_path. Nothing of the JSON
 *  is echoed but its keys (label-checked) and transcript_path: a hook's JSON can hold a prompt. */
type HookRead = { k: 'hook'; transcript: string; project: string } | { k: 'usage'; message: string };
async function readHook(to: string, root: string): Promise<HookRead> {
  const byHand = `In a hook, Claude Code writes that JSON; to try it by hand: printf '%s\\n' ${q(JSON.stringify({ transcript_path: `${root}/<project>/<session>.jsonl` }))} | ltms pin --from-hook --to ${q(to)}`;
  const usage = (what: string): HookRead => ({ k: 'usage', message: `--from-hook reads a Claude Code hook's JSON from standard input, and ${what}. ${byHand}` });
  if (process.stdin.isTTY) return usage('standard input is a terminal');
  let raw: Buffer;
  try {
    raw = await new Promise<Buffer>((done, fail) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
      process.stdin.on('end', () => done(Buffer.concat(chunks)));
      process.stdin.on('error', fail);
    });
  } catch (e) { return usage(`standard input could not be read (${(e as NodeJS.ErrnoException)?.code ?? 'error'})`); }
  const text = raw.toString('utf8');
  if (text.trim() === '') return usage(raw.length ? `standard input holds only blanks (${raw.length} bytes)` : 'standard input is empty');
  let o: unknown;
  try { o = JSON.parse(text); } catch { return usage(`standard input (${raw.length} bytes) is not JSON`); }
  /** What a JSON value is, in words, never the value. */
  const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'an array' : v === '' ? 'an empty string'
    : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
  if (!isRecord(o)) return usage(`standard input holds JSON that is not an object (${kind(o)})`);
  const tp = o.transcript_path;
  if (tp === undefined) {
    const keys = Object.keys(o).map((k) => label(k, '(empty)'));
    const shown = keys.length ? `its keys: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? `, and ${keys.length - 8} more` : ''}` : 'it has no keys';
    return usage(`its JSON object has no transcript_path (${shown})`);
  }
  if (typeof tp !== 'string' || tp === '') return usage(`its transcript_path is not a path (${kind(tp)})`);
  return { k: 'hook', transcript: tp, project: dirname(resolve(tp)) };
}

/** A path's real path, or the path made absolute when it has none (it does not exist). */
const realOr = (p: string): string => { try { return realpathSync.native(p); } catch { return resolve(p); } };
/** p is dir or under it, by their real paths, as the library measures them (without case on darwin and win32). */
function isUnder(p: string, dir: string): boolean {
  const fold = (x: string): string => (process.platform === 'darwin' || process.platform === 'win32' ? x.toLowerCase() : x);
  const r = relative(fold(realOr(dir)), fold(realOr(p)));
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
/** Whether this process may read the file at p (access, R_OK). */
const readable = (p: string): boolean => { try { accessSync(p, fsConstants.R_OK); return true; } catch { return false; } };

/** The next command after a refusal, from its reason and the arguments as given. */
function pinNext(r: PinRefusal, a: PinArgs, paths: string[], root: string): string {
  const given = paths.map(q).join(' ');
  const elsewhere = `Choose a directory outside it, e.g. ltms pin ${given} --to ~/claude-pins`;
  switch (r.reason) {
    case 'to-inside-config': return elsewhere;
    case 'to-inside-path': case 'to-inside-root': return `Choose a pin directory outside the paths given and outside the root, e.g. ltms pin ${given} --to ~/claude-pins`;
    case 'path-inside-to': return `A pin is not pinned again: give paths under the root ${q(root)}. To check this pin: ltms pin --check ${q(a.to!)}`;
    case 'path-outside-root': {
      // a project directory under the root that is a symbolic link leads outside it: pin goes by where a path leads
      const link = paths.find((p) => isLink(p) && !isUnder(p, root));
      if (link !== undefined) {
        const real = realOr(link);
        return `${q(link)} is a symbolic link to ${q(real)}, and pin measures a path by where it leads, so it does not pin through a link. To pin where it leads, into a pin directory of its own: ltms pin ${q(real)} --to <dir> --root ${q(dirname(real))}`;
      }
      return `Give paths under ${q(root)}, or name the root they are under: ltms pin ${given} --to ${q(a.to!)} --root <dir>`;
    }
    case 'to-not-a-directory': return `Give a directory, new or a pin, e.g. ltms pin ${given} --to ~/claude-pins`;
    case 'root-differs': {
      const rec = r.recordedRoot;   // as the library read it: the log is not read again here
      if (rec === undefined) return 'Give the root it records with --root, or pin into another directory (--to).';
      // paths outside the root it records would be refused with that root too: only another directory takes them
      if (!paths.every((p) => isUnder(p, rec))) return `The paths given are not under the root it records, so pin them into another directory, e.g. ltms pin ${given} --to ~/claude-pins${a.root === undefined ? '' : ` --root ${q(a.root)}`}`;
      return `Pin with the root it records: ltms pin ${given} --to ${q(a.to!)} --root ${q(rec)}; or pin into another directory (--to).`;
    }
    case 'log-unreadable': {
      // head would read through a link, and wait on a FIFO: what is not a regular file is looked at with ls. One that
      // cannot be read (pin opens it before it counts its names) too: ls shows its mode and owner, where head would
      // meet the same refusal. A log with another name (a hard link) is the same file under that name, wherever it
      // is: find names them
      const log = join(a.to!, 'PINS.log');
      let kind: 'file' | 'named' | 'unreadable' | 'other' = 'other';
      try { const s = lstatSync(log); kind = !s.isFile() ? 'other' : !readable(log) ? 'unreadable' : s.nlink > 1 ? 'named' : 'file'; } catch { /* gone since */ }
      return kind === 'named' ? `Find its other names: find / -samefile ${q(log)} 2>/dev/null; to start a pin elsewhere, give another --to.`
        : kind === 'file' ? `Look at its first line: head -n 1 ${q(log)}; to start a pin elsewhere, give another --to.`
          : kind === 'unreadable' ? `See its mode and owner: ls -l ${q(log)}; to start a pin elsewhere, give another --to.`
            : `See what it is: ls -l ${q(log)}; to start a pin elsewhere, give another --to.`;
    }
    case 'to-holds-files': return `Pin into a directory of its own, e.g. ltms pin ${given} --to ${q(join(a.to!, 'claude-pins'))}; what it holds now: ls -A ${q(a.to!)}`;
    case 'not-a-pin': {
      // a PINS.log that is there is looked at with ls, which reads nothing through it: one that is not a regular file (a
      // link, a FIFO, a directory) for what it is, a regular file the check could not read for its mode and owner. The
      // directory given is the pin, so it is not sent elsewhere
      const log = join(a.check!, 'PINS.log');
      let there: 'file' | 'other' | null = null;
      try { there = lstatSync(log).isFile() ? 'file' : 'other'; } catch { /* no PINS.log: the directory given is not a pin */ }
      return there === 'other' ? `See what it is: ls -l ${q(log)}`
        : there === 'file' ? `See its mode and owner: ls -l ${q(log)}`
          : 'Give the directory a pin wrote into (the --to of ltms pin): ltms pin --check <dir>';
    }
    default: return 'ltms pin --help has the forms.';
  }
}

/** The coverage line, its fields in the documented order. */
function coverageLine(c: PinCoverage): Record<string, unknown> {
  const f = c.files, s = c.skipped;
  return { k: 'coverage', root: c.root, to: c.to,
    files: { seen: f.seen, new: f.new, grown: f.grown, rewritten: f.rewritten, unchanged: f.unchanged, notCopied: f.notCopied, failed: f.failed }, failures: c.failures,
    partial: c.partial, skipped: { notSessionShaped: s.notSessionShaped, symlinks: s.symlinks, memory: s.memory, git: s.git },
    bytesCopied: c.bytesCopied, keptSourceGone: c.keptSourceGone, lastLog: c.lastLog, ms: c.ms };
}
/** --list: one line per line appended to PINS.log for a file. */
function listLine(l: PinLogLine): Record<string, unknown> {
  return { k: 'pin', rel: l.rel, how: l.how, bytes: l.bytes, prev: l.prev ? l.prev.bytes : null, ...(l.kept === undefined ? {} : { kept: l.kept }) };
}
/** --check's first line: the counts, the staleness and the time of the last log line. */
function checkLine(r: PinCheckDone): Record<string, unknown> {
  const s = r.staleness;
  return { k: 'check', dir: r.dir, root: r.root, lines: r.lines, versions: r.versions, files: r.files, mismatches: r.mismatches.length,
    chainBreaks: r.chainBreaks.length, unreadableLines: r.unreadableLines.length, unlogged: r.unlogged.length, temps: r.temps, lock: r.lock,
    lastLog: r.lastLog,
    staleness: s === null ? null : { root: s.root, fromLog: s.fromLog, sources: s.sources, missing: s.missing, longer: s.longer, unfinished: s.unfinished, projectsNotPinned: s.projectsNotPinned, failed: s.failed },
    ms: r.ms };
}
const jsonLine = (o: unknown): string => JSON.stringify(o) + '\n';
/** How long ago an ISO time was, in the unit that reads best; '' when it cannot be read. */
function ago(iso: string | null): string {
  const ms = iso === null ? NaN : Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return '';
  const min = Math.round(ms / 60000);
  return min < 120 ? `${min} min ago` : min < 2880 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
}

function printPinned(r: PinDone, a: PinArgs, paths: string[], root: string): number {
  const c = r.coverage, f = c.files;
  out(jsonLine(coverageLine(c)) + r.failures.map((x) => jsonLine({ k: 'failure', path: x.path, rel: x.rel, op: x.op, code: x.code })).join('')
    + (a.list ? r.lines.filter((l) => l.rel !== undefined).map((l) => jsonLine(listLine(l))).join('') : ''));
  for (const n of r.notices) err(`ltms pin: ${n}`);
  if (r.failures.length) {
    const x = r.failures[0];
    // a lock that is not a regular file stops a pin before any file, at every pin until it is gone: what is at its name
    // is looked at with ls, which reads nothing through it
    const look = x.op === 'lock' && x.code === 'not-a-regular-file' ? ` See what is at the lock: ls -l ${q(x.path)}` : '';
    err(`ltms pin: ${plural(r.failures.length, 'failure', 'failures')}, each named on stdout ("k":"failure": the path, the step and the error code; the first: ${x.op} ${q(x.path)}, ${x.code}). Every file pinned is whole and in PINS.log; once the cause is fixed, the same command pins the rest.${look}`);
    return 1;
  }
  if (f.seen === 0) {
    const s = c.skipped;
    err(`ltms pin: nothing to pin under ${paths.map(q).join(', ')}: no file there is of a transcript's shape (<name>.jsonl and <name>.jsonl.superseded-* in a project directory, and the files under a session's subagents/, tool-results/, workflows/ and mcp-tasks/); passed over: ${plural(s.notSessionShaped, 'other file', 'other files')}, ${plural(s.symlinks, 'symbolic link', 'symbolic links')}, ${plural(s.memory, 'memory/ directory', 'memory/ directories')} and ${plural(s.git, '.git directory', '.git directories')}. Pin a project directory under the root, e.g. ltms pin ${q(root)} --to ${q(a.to!)}`);
  }
  return r.interrupted !== null ? 1 : 0;
}

/** A pinned rel's source is there, under the root PINS.log records, as itself: a regular file at that path whose real path
 *  is that path (no symbolic link on the way to it, or at its end), so that a pin of its project with that root is not
 *  refused for leading elsewhere. Nothing of the file is read. */
function sourceThere(root: string, rel: string): boolean {
  const p = join(root, ...rel.split('/'));
  try { return lstatSync(p).isFile() && realpathSync.native(p) === p; } catch { return false; }
}

function printChecked(r: PinCheckDone): number {
  out(jsonLine(checkLine(r)) + r.mismatches.map((m) => jsonLine({ k: 'mismatch', rel: m.rel, copy: m.copy, line: m.line, want: m.want, got: m.got })).join('')
    + r.chainBreaks.map((b) => jsonLine({ k: 'chain', line: b.line, want: b.want, got: b.got })).join('')
    + r.unreadableLines.map((n) => jsonLine({ k: 'unreadable', line: n })).join('')
    + r.unlogged.map((rel) => jsonLine({ k: 'unlogged', rel })).join(''));
  for (const n of r.notices) err(`ltms pin: ${n}`);
  const log = q(join(r.dir, 'PINS.log'));
  // a PINS.log with another name makes every pin into this directory a refusal (the notice above says so): no pin
  // command is given until it has one name again
  const pinRuns = r.logNames <= 1;
  const damage = r.mismatches.length + r.chainBreaks.length + r.unreadableLines.length;
  // whether the closing line gives the --rehash command: a pin run before it could record a damaged copy as a version
  // and keep it as an old copy (README, Limits), so the line on the files behind the pin then gives no pin command
  let rehashGiven = false;
  if (damage) {
    const first = r.mismatches[0]?.line ?? r.chainBreaks[0]?.line ?? r.unreadableLines[0];
    const parts = [`ltms pin: ${q(r.dir)} does not hold what ${log} records: ${plural(r.mismatches.length, 'mismatch', 'mismatches')}, ${plural(r.chainBreaks.length, 'chain break', 'chain breaks')} and ${plural(r.unreadableLines.length, 'line that is not a log line', 'lines that are not log lines')}, each on stdout with its line in PINS.log`,
      `To read the first: sed -n '${first}p' ${log}`];
    // The --rehash command, for the current copies with a mismatch whose source is there, of the sweep's shape (one a
    // pin copies): it writes back what the sources still hold, and a check run again says what remains. Nothing here
    // predicts which mismatches that clears (a kept copy is never written again; a source may no longer hold a
    // version). Only when PINS.log records its root, which the rels are measured from and a pin into this directory
    // needs. The command names projects, not the whole root; and a file the walk of its project directory does not
    // reach (under .git, or memory/ directly under a project directory) by its own path: a file given by itself is
    // pinned whatever directories it is under
    const root = r.root;
    if (root !== null && pinRuns) {
      const sources = r.mismatches.filter((m) => m.copy === m.rel && isSweepShaped(root, m.rel) && sourceThere(root, m.rel));
      const paths = [...new Set(sources.map((m) => join(root, ...(projectPinReaches(m.rel) ? [m.rel.split('/')[0]] : m.rel.split('/')))))];
      if (paths.length) {
        parts.push(`To write back into the current copies what their sources still hold (ltms pin --check, run again, then says what remains): ltms pin ${paths.map(q).join(' ')} --to ${q(r.dir)} --root ${q(root)} --rehash`);
        rehashGiven = true;
      }
    }
    // every part after the first ends in a command, so the line has no closing period
    err(parts.join('. '));
  }
  // while PINS.log has another name, the notice above says once that every pin is refused: no line says what a next pin
  // would do
  if (r.unlogged.length) err(`ltms pin: ${plural(r.unlogged.length, 'file', 'files')} in ${q(r.dir)} ${r.unlogged.length === 1 ? 'is' : 'are'} named by no line in PINS.log (on stdout, "k":"unlogged")${pinRuns ? '; the next pin records each with a recovered line' : ''}.`);
  if (r.temps) err(`ltms pin: ${plural(r.temps, 'temp file', 'temp files')} in ${q(r.dir)} ${r.temps === 1 ? 'was' : 'were'} left by a pin that stopped${pinRuns ? `; the next pin removes ${r.temps === 1 ? 'it' : 'them'}` : ''}.`);
  if (r.lock) err(`ltms pin: ${q(join(r.dir, '.ltms-pin.lock'))} names pid ${r.lock.pid} on ${r.lock.host}, since ${r.lock.started}: a pin is running, or one stopped without removing it${pinRuns ? ' (the next pin takes over a lock whose pid is no longer running on this host)' : ''}.`);
  const s = r.staleness;
  if (s !== null && s.failed) {
    let rootCode: string | null = null;   // the root itself, read again here to name its code: it fails the whole count
    try { readdirSync(s.root); } catch (e) { rootCode = (e as NodeJS.ErrnoException)?.code ?? 'Error'; }
    err(rootCode !== null
      ? `ltms pin: the root ${q(s.root)} could not be read (${rootCode}), so no file under it was counted, and the counts of files missing from the pin are short of the truth. Check it: ls -ld ${q(s.root)}`
      : `ltms pin: ${plural(s.failed, 'directory', 'directories')} under the root ${q(s.root)} could not be read, so the counts of files missing from the pin are short of the truth. Check it: ls -ld ${q(s.root)}`);
  }
  if (s !== null && (s.missing || s.longer)) {
    const when = r.lastLog === null ? '' : ` (PINS.log's last line: ${r.lastLog}${ago(r.lastLog) ? `, ${ago(r.lastLog)}` : ''})`;
    // the pin command runs as printed: into this directory, with --root naming the root PINS.log records (a pin into it is
    // refused under any other, and the default root may be another), so only when that is the root walked here
    const command = !pinRuns ? ''
      : rehashGiven ? ' To pin them, first run the --rehash command above: a pin run before it may record a damaged copy as a version. ltms pin --check, run again, then says what remains.'
      : r.root !== null && s.root === r.root ? ` To pin them: ltms pin ${q(s.root)} --to ${q(r.dir)} --root ${q(r.root)}`
      : '';
    err(`ltms pin: ${plural(s.missing, 'file', 'files')} under the root ${q(s.root)} ${s.missing === 1 ? 'is' : 'are'} missing from the pin, and ${s.longer} ${s.longer === 1 ? 'is' : 'are'} longer than ${s.longer === 1 ? 'its copy' : 'their copies'}${when}.${command}`);
  }
  // longer only by a line not yet finished: a pin would copy nothing of it, so no command is given
  if (s !== null && s.unfinished) {
    const one = s.unfinished === 1;
    err(`ltms pin: ${plural(s.unfinished, 'file', 'files')} under the root ${q(s.root)} ${one ? 'ends' : 'end'} in an unfinished line, which a pin does not copy: ${one ? 'it is longer than its copy' : 'they are longer than their copies'} only by that line, and ${one ? 'is' : 'are'} not counted as longer.`);
  }
  return damage || (s !== null && s.failed) ? 1 : 0;
}

async function pinMain(argv: string[]): Promise<number> {
  const a = readPinArgs(argv);
  if (a.k === 'help') { out(PIN_HELP); return 0; }
  if (a.k === 'version') return printVersion();
  if (a.k === 'usage') { err(`ltms pin: ${a.message}`); return 2; }
  const config = claudeConfigDir().path;   // the rule's one copy, in pin.ts
  const root = a.root ?? join(config, 'projects');
  if (a.check !== undefined) {
    const extra = [...a.paths.map(q), ...(a.to === undefined ? [] : [`--to ${q(a.to)}`]), ...(a.fromHook ? ['--from-hook'] : []), ...(a.list ? ['--list'] : []), ...(a.rehash ? ['--rehash'] : [])];
    if (extra.length) { err(`ltms pin: --check reads a pin and takes only --root besides it, and ${extra.join(', ')} ${extra.length === 1 ? 'was' : 'were'} given too. To check: ltms pin --check ${q(a.check)}`); return 2; }
    const r = await checkPin(a.check, a.root === undefined ? {} : { root: a.root });
    if (r.k === 'refused') { err(`ltms pin: ${r.message} ${pinNext(r, a, [], root)}`); return 2; }
    if (r.k === 'busy') { err(`ltms pin: ${r.message}`); return 1; }
    return printChecked(r);
  }
  if (a.fromHook && a.paths.length) { err(`ltms pin: --from-hook takes the path from the hook's JSON, so it takes no paths, and ${a.paths.map(q).join(', ')} ${a.paths.length === 1 ? 'was' : 'were'} given. In a hook: ltms pin --from-hook --to ${a.to === undefined ? '<dir>' : q(a.to)}`); return 2; }
  if (a.to === undefined) {
    const what = a.fromHook ? '--from-hook' : a.paths.length ? a.paths.map(q).join(' ') : q(root);
    err(`ltms pin: ${a.paths.length || a.fromHook ? 'no --to' : 'no paths and no --to'}: name the directory to write the copies into, outside Claude Code's config directory ${q(config)}, e.g. ltms pin ${what} --to ~/claude-pins`);
    return 2;
  }
  let paths = a.paths;
  if (a.fromHook) {
    const h = await readHook(a.to, root);
    if (h.k === 'usage') { err(`ltms pin: ${h.message}`); return 2; }
    err(`ltms pin: --from-hook: the hook names ${q(h.transcript)}, so the path to pin is its directory ${q(h.project)}.`);
    paths = [h.project];
  }
  if (!paths.length) { err(`ltms pin: no paths: give the directories or files to pin, under the root ${q(root)}, e.g. ltms pin ${q(root)} --to ${q(a.to)}; in a hook, ltms pin --from-hook --to ${q(a.to)}`); return 2; }
  const r = await pinPaths(paths, { to: a.to, root, configDir: config, rehash: a.rehash });
  if (r.k === 'refused') { err(`ltms pin: ${r.message} ${pinNext(r, a, paths, root)}`); return 2; }
  if (r.k === 'busy') { err(`ltms pin: ${r.message}`); return 1; }
  return printPinned(r, a, paths, root);
}

function main(argv: string[]): number | Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined) { err(`ltms: no command given.\n\n${USAGE}`); return 2; }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { out(HELP); return 0; }
  if (cmd === '--version' || cmd === '-v') return printVersion();
  if (cmd === 'search') return searchMain(argv.slice(1));
  if (cmd === 'index') return indexMain(argv.slice(1));
  if (cmd === 'skill') return skillMain(argv.slice(1));
  if (cmd === 'pin') return pinMain(argv.slice(1));
  if (cmd !== 'skeleton' && cmd !== 'stats') {
    if (cmd.startsWith('-')) err(`ltms: unknown option '${cmd}'. The options are --help and --version.\n\n${USAGE}`);
    else err(`ltms: unknown command '${cmd}'. The commands are index, skeleton, stats, search, pin and skill.\n\n${USAGE}`);
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
const status = main(process.argv.slice(2));
if (typeof status === 'number') process.exitCode = status;
else {
  // pin is the only command that runs asynchronously: the lock is removed on a signal only while the event loop turns
  status.then((s) => { process.exitCode = s; }, (e: unknown) => {
    err(`ltms pin: stopped with an internal error (${internalError(e)}). This is a bug in ltms; a pin's lock is removed when it stops, and the next pin records what this one left.`);
    process.exitCode = 1;
  });
}
