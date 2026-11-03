# Long-Term Memory Structure

When a Claude Code session fills its context window, or on `/compact`, Claude Code compacts it: the conversation in the model's context is replaced by a summary, and the model carries on from the summary. The details, such as which commands ran, which of them failed and which files were read or changed, are no longer in front of the model. They are still on disk. Claude Code only ever appends to a session's transcript, the `.jsonl` file under `~/.claude/projects/`: a compaction adds a boundary record and the summary, and every record before them stays where it was. The summary itself gives the transcript's path, so the details can be read back from it. (Claude Code deletes old transcripts after 30 days by default; its `cleanupPeriodDays` setting changes that.)

What compaction writes, and what each model keeps through it, measured: [Claude Code's compaction doesn't delete your history. It re-roots it.](https://long-term-memory-structure.github.io/long-term-memory-structure/compaction.html)

Long-Term Memory Structure reads that transcript, across its compactions, and prints an index of it without its content: one JSON line per turn and per tool call. A turn's line gives the address of its prompt, the line of the file where it is written. A tool call's line gives the addresses of the call and of its result, and hashes of what went in and what came out. On the 2,539 transcripts it was tested on (3.35 GB), the index came to 0.7 % of their size, so it fits in a context window where the transcript does not, and every address leads back to the line to read.

Long-Term Memory Structure is an independent project. It is not affiliated with or endorsed by Anthropic.

Formerly published as `memobrain`.

## Why this exists

A context window keeps nothing between sessions, and every call re-sends all of it, so an agent pays again and again for everything it carries, and models do worse as it grows: context rot (Hong et al. 2025). This project is built around that budget: memory for one long-lived agent, with a small fixed cost in every session (an index of about 9,000 tokens, read from cache) and as little as possible per question: a surgical search, through a language server or a syntax tree, that reads one address (a line of a transcript, a symbol) rather than whole files.

One popular approach is a shared "company brain" for a swarm of agents. This is something else: persistence for a single agent. The design and its measurements are in the report *Durable Memory on a Fixed Context Budget* (Ben Yanai 2026). This package is the first piece released: the index of a transcript.

## Install

Needs Node.js 20 or newer. No dependencies.

```sh
npx long-term-memory-structure stats ~/.claude/projects/<project>/<session>.jsonl
```

Or install it once: `npm install -g long-term-memory-structure`, which gives the command `ltms`. Without installing, write `npx long-term-memory-structure` where this page says `ltms`.

`<project>` is your project's directory path with every character other than an ASCII letter or digit written as `-` (`/home/me/my.app` becomes `~/.claude/projects/-home-me-my-app/`); Claude Code cuts a name longer than 200 characters there and adds a hash, so for a very long path find the folder with `ls ~/.claude/projects/`. The newest `.jsonl` there is the latest session, and a subagent's transcript is in `<session>/subagents/`. A first look, then reading one line back:

```sh
f=$(ls -t ~/.claude/projects/-home-me-my-app/*.jsonl | head -1)
npx long-term-memory-structure skeleton "$f" | grep '"ok":false'
sed -n 22p "$f"    # the line an address names, here <prefix>:L22
```

## Commands

### `ltms skeleton <file.jsonl>...`

One JSON line per turn and per tool call. A turn starts at a prompt; its tool calls follow it in order. This is one turn of the synthetic test transcript [`test/fixtures/demo.jsonl`](https://github.com/long-term-memory-structure/long-term-memory-structure/blob/main/test/fixtures/demo.jsonl): a hook blocks a command, the tests fail twice, a fix is made, the tests pass.

```
{"k":"turn","a":"demo.jso:L20","ta":"demo.jso:T003","ch":"typed","n":47}
{"k":"call","a":"demo.jso:L22","ta":"demo.jso:T003","tool":"Bash","verb":"rm","in":"8672006e23d8","ok":false,"ek":"hook-block:demo-gate","r":"demo.jso:L23","out":"f69cbd101377","n":111}
{"k":"call","a":"demo.jso:L24","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"84c7c646123a","ok":false,"ek":"exit-1","r":"demo.jso:L25","out":"429ad9a9f725","n":58}
{"k":"call","a":"demo.jso:L26","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"d990b201195a","ok":false,"ek":"exit-1","r":"demo.jso:L27","out":"3953f9b8b91c","n":69}
{"k":"call","a":"demo.jso:L28","ta":"demo.jso:T003","tool":"Edit","verb":".js","in":"42eb1ba06a92","ok":true,"r":"demo.jso:L29","out":"99a70feb06ce","n":56}
{"k":"call","a":"demo.jso:L30","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"5d0af2eddc4d","ok":true,"r":"demo.jso:L31","out":"12112eacc5de","n":35}
```

An address such as `demo.jso:L22` means line 22 of the file whose name starts with `demo.jso`. Claude Code names each transcript after its session id, so for real files the prefix is the first 8 characters of the session id. A subagent's transcript is named `agent-<id>.jsonl`, and those names all start alike, so there the prefix is `agent-` and the id's first 8 characters (`agent-a0123456:L2`). To read what a line hides, open that line of the transcript, for example `sed -n 22p <file.jsonl>`. Two calls made in one record share that record's address. Files that get the same prefix (the same first 8 characters, or, for agent files, the same first 14) cannot be told apart in one run's output, and a warning on stderr names them: give them to separate runs.

| field | in | meaning |
|---|---|---|
| `k` | both | `"turn"` or `"call"` |
| `a` | both | address of the prompt, or of the tool call |
| `ta` | both | turn id: `<address prefix>:T001`, `T002`, ... |
| `ch` | turn | the channel the prompt came through: `typed` (typed at the CLI), `sdk` (sent through the SDK or another entry point), `input` (the record names no channel), `task` (a background task's notification), `loop` (a timer), `parent` (the agent that delegated to this one), or the record's own word for another agent (for example `peer`); `none` when that word is empty, and `(withheld)` when it does not pass the label rule |
| `n` | both | length of the prompt text, or of the result text, as JavaScript counts it (UTF-16 code units; a content array's blocks are joined with a new line, and a block that is not text counts as an empty one); `null` on a call whose result was never recorded |
| `tool` | call | tool name |
| `verb` | call | a short label. For Bash, the program the command runs, read by the rule in [The Bash verb](#the-bash-verb) below; `(withheld)` when that rule cannot be sure, and `(empty)` when nothing runs or the call has no command. For Read, Edit, Write and NotebookEdit, the file's extension (its name when it has none; `(none)` when there is no path, or it ends in `/`). For Agent and Task, the subagent type (`agent` when the call names none); for Skill, the skill name (`skill` when it names none); for other tools, the tool's name |
| `in` | call | sha256 of the input as JavaScript's `JSON.stringify` writes it (keys that are whole numbers up to 4294967294 first, in ascending order, then the others in the transcript's order; a missing input counts as `{}`), first 12 hex characters; `(too large)` when the input, written as JSON, would pass JavaScript's limit on a string's length (a warning says so) |
| `ok` | call | `true` when the call succeeded; `false` when it failed (its result is marked `is_error`, or Claude Code wrote the error as a string in `toolUseResult`); `null` when no result was recorded (the session ended, or the file was cut, before the call returned, or the call was still running when the file was read, as the call that runs ltms on its own session is) |
| `ek` | call | only on a failed call, its error class, from the result's first line: `exit-<code>` (a leading `Exit code N`, up to 3 digits; read first, so a command's own output cannot change it), `hook-block:<hook script name>` and `hook-block` (only in Claude Code's own format, `PreToolUse:<tool> hook error: [<command>]`; the name is the last part of the path of the one word in the brackets that ends in a script extension (`.sh` `.bash` `.py` `.js` `.mjs` `.cjs` `.ts` `.rb` `.pl`, lower case; quotes and punctuation around a word are not part of it), cut at the extension, and it is printed only when that word is the command itself or comes right after an interpreter (`node` or `nodejs`, `deno`, `bun`, `python`, `python3` or another Python version such as `python3.12`, `bash`, `sh`, `zsh`, `dash`, `ksh`, `ruby`, `perl`, `tsx`, `ts-node`), after any leading `env` (with `-i`) and `NAME=value` words (`bash /x/gate.sh` is how a hook's command is usually written), and the name is made of ASCII letters, digits, `_`, `.` and `-` and is at most 48 characters long; when two or more words end in a script extension, or the one such word stands anywhere else (an argument, an option's value, an assignment), or the name does not qualify, or the bracket is longer than 300 characters, the class is a plain `hook-block`), `no-anchor` (Edit's text was not found), `not-read`, `bad-input`, `denied`, `other` |
| `r` | call | address of the result, or `null` when none was recorded |
| `out` | call | sha256 of the result text (its UTF-8 bytes; blocks joined as for `n`), first 12 hex characters; of the whole result as JSON when it holds anything but text (an image), with `(too large)` as for `in`; `null` when no result was recorded |

### The Bash verb

The verb is printed only when ltms can be certain it is the program bash runs. It is a whitelist, not a model of the shell: the program must be a **plain word** (ASCII letters, digits and `. _ / : , + % @ = ~ ^ -`, nothing else), and every word before it must be one ltms can pass over with certainty:

- blank lines and comment lines;
- `cd DIR`, with redirections such as `2>/dev/null`, followed by `&&`, `;` or a new line (the program is the next command's);
- `NAME=value` assignments whose value is made of plain words, `'...'`, `"..."` holding no `\`, `` ` ``, `"` or `$` other than `$NAME`, `${NAME}` and `$0`–`$9`, those expansions bare, and `*` and `?`;
- an opening `(`, `{` or `!`;
- the wrappers `nohup`, `command`, `exec`, `time` (with `-p`; where a command starts, or right after another `time`, since elsewhere `time` is a program of its own), `env` (with `-i` and `NAME=value`, where an unquoted `$NAME` withholds the verb: after `env` it is an argument, and bash splits it), `timeout` (with a duration) and `nice` (with `-n N` or `-N`). After `nohup`, `env`, `nice`, `timeout` or `exec`, which look the next word up as a file, `command` and `exec` are programs of their own; after `command` or `time` they are still the shell's builtins.

A path is cut to its last part. When nothing runs after the words passed over (a command of assignments only, or `cd DIR;` with nothing after it), the verb is `(empty)`; when an assignment's value is a command substitution made of such words, it is the program inside the first such substitution. A wrapper with nothing after it but its own options is the program. The shell's test brackets print as `[` and `[[`, and a shell keyword prints as itself. Anything else before the program (a here-document, another redirection, an option the wrapper list does not name, any other `$(...)` or `${...}`, a backslash, a redirection after a wrapper, more than 63 assignments, `cd` commands and wrappers before the program, more than 15 commands passed over), a program that is not a plain word, and a function definition make the verb `(withheld)`. The program then passes the label rule in [Privacy](#privacy), like every label, so a name holding `,` `%` `@` `=` `~` or `^` prints `(withheld)` too. What follows the program is never read.

| command | verb |
|---|---|
| `cd ~/proj && npm test` | `npm` |
| `CI=1 timeout 120 npm test` | `npm` |
| `REV="$(git rev-parse HEAD)"` | `git` |
| `X=$(git log -1 --format='%H') make demo` | `make` |
| `cd "$HOME/my project" 2>/dev/null && make demo` | `make` |
| `env \| grep x` | `env` |
| `for f in *.txt; do wc -l "$f"; done` | `for` |
| `sudo -u demo make install` | `sudo` |
| `X=1 time make demo` | `time` |
| `"$PY" scripts/run.py` | `(withheld)` |
| `$DIR/run.sh --fast` | `(withheld)` |
| `command -v node` | `(withheld)` |
| `nohup X=1 ./job.sh` | `(withheld)` (after a wrapper, `X=1` is the program's name) |
| `command exec make demo` | `make` |
| `nohup command make demo` | `command` |
| `time time make demo` | `make` |
| `nohup >/dev/null make demo` | `(withheld)` |

On the transcripts it was tested on, about 1 Bash call in 100 prints `(withheld)`.

### `ltms stats <file.jsonl>...`

One JSON line of counts per file. For the same test transcript:

```
{"session":"demo.jso","turns":4,"prompts":3,"calls":12,"failures":5,"unanswered":0,"errorClasses":{"other":1,"no-anchor":1,"hook-block:demo-gate":1,"exit-1":2},"retries":2,"detours":2,"maxHops":3,"hopsOver2":1}
```

| field | meaning |
|---|---|
| `session` | the file's address prefix |
| `turns` | turns on the live path |
| `prompts` | turns opened by a prompt (channel `typed`, `sdk` or `input`); every other channel (task notifications, timers, delegations, another agent's word, `none`, `(withheld)`) is not counted |
| `calls` | tool calls |
| `failures` | tool calls that failed |
| `unanswered` | tool calls whose result was never recorded; they count neither as failures nor as successes |
| `errorClasses` | failures by error class |
| `retries` | calls made right after a failed call in the same turn, with the same tool (any input: in the example, the `npm test` after the blocked `rm` counts), and issued after its result (a call sent in the same response as the failed one is not its retry) |
| `detours` | the same, with a different tool |
| `maxHops` | the longest chain of failures with one verb, each issued after the previous one's result, that a later success with the same verb closed in the same turn, counting the success (above: two failed `npm` runs, then a passing one, is 3 hops). A failure with another verb ends a chain and starts a new one, even when it was sent in the same response; a placeholder such as `(withheld)` counts as one verb |
| `hopsOver2` | how many such chains were longer than 2 hops |

`ltms --help` lists every field; `ltms --version` prints the version.

## What it reads

- Only the files named on the command line.
- Only the live path of each session: the branch it ended on, as the transcript's own `last-prompt` record names it (a file without one is read along the branch of the last record written). The path is joined across compactions, and across API-error records that Claude Code writes late, after the retry that followed the error, and a record whose parent is not in the file is joined to the record written just before it. Branches that were rewound are not shown. Calls made in parallel by one response all belong to their turn, even when their results came back out of order; a response is known by its `requestId`, or by its `message.id` in versions that wrote none, and a response whose records fall in two turns gives its calls to the first.
- Compaction, as measured on Claude Code 2.1.270, 2.1.272 and 2.1.300: the file before a `/compact` is a byte-for-byte prefix of the file after it. The compaction appends a boundary record, which starts a new root and points back to the last record before it, and then the summary. ltms follows that pointer, so the turns before and after a compaction appear in order.
- The transcript format is internal to Claude Code and changes between versions. Records of a shape ltms does not know are passed over, not treated as errors.
- A file is read into memory whole: it takes about five to eight times the file's size (up to about nine for a file packed with very small tool calls). For a file over about 200 MB, give Node more memory, for example `NODE_OPTIONS=--max-old-space-size=4096`; a file over about 500 MB cannot be read at all (JavaScript's limit on a string's length).
- A line that is not a JSON object, or that is nested more than 1,000 levels deep, is skipped and reported on stderr. A file with nothing to show (empty, a workflow journal, no conversation records, no turns) is reported too, so a zero never reads as a clean result, and so are records whose parent links loop instead of reaching the start of the session, files in one run that share an address prefix, and assistant records with neither a `requestId` nor a string `message.id` (which records form one response is then read from their parent links). An internal error is reported by its kind and the place in ltms where it happened, never by its message, which could quote the transcript.

Exit status: 0 when every file was processed, 1 when a file could not be read or processed, 2 on a usage error.

## Privacy

- ltms reads local files only, writes only to stdout and stderr, makes no network connections and collects no telemetry. It has no runtime dependencies.
- The output contains no prompts, replies, tool inputs or tool outputs. It does contain a few short labels derived from them: the program a shell command runs (or a shell keyword), a file's extension (or its name, when it has none), a subagent type, a skill name, a tool's name, the channel a prompt came through, the name of a hook script that blocked a call, an error class, and the lengths of prompts and results.
- A label is printed only when it looks like one: at most 64 ASCII letters, digits and `. _ : + -` (a file's name or extension: without `:`; the shell's `[` and `[[` as they are). Anything else (free text, a quoted or computed command, a value that is not a string) prints as `(withheld)`, except that a hook name that does not qualify gives a plain `hook-block`. The shell command's label is read by the whitelist in [The Bash verb](#the-bash-verb): it is printed only when it and every word before it are words bash reads exactly as written, so an argument, a quoted string or a here-document is never taken for the program. The record types named in a warning pass the same label rule.
- A hash cannot be reversed, but it can confirm a guess: whoever can guess the exact bytes of an input or a result (a short command and its description, a one-line output) can hash the guess and compare. Treat the output as derived from your transcripts.

## Status

Version 0.0.4. Early: the output format may change between versions.

## Development

```sh
npm install      # TypeScript and Node type definitions, for building only
npm run build    # compiles src/ to dist/
npm test         # runs test/cli.test.mjs against dist/cli.js
```

`LTMS_HEAVY=1 npm test` also runs two tests that write files of about 125 MB, one file at a time (the second writes nine), and need about 3 GB of memory.

The test transcripts in `test/fixtures/` are synthetic, with invented text: some hand-written, the rest written by `node test/make-fixtures.mjs test/fixtures` (the output is the same on every run).

## License

MIT
