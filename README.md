# Long-Term Memory Structure
[![Socket](https://socket.dev/api/badge/npm/package/long-term-memory-structure)](https://socket.dev/npm/package/long-term-memory-structure)

When a Claude Code session fills its context window, or on `/compact`, Claude Code compacts it: the conversation in the model's context is replaced by a summary, and the model carries on from the summary. The details, such as which commands ran, which of them failed and which files were read or changed, are no longer in front of the model. They are still on disk. Claude Code appends to a session's transcript, the `.jsonl` file under `~/.claude/projects/`; it can rewrite one only in rare cases, and `ltms pin` keeps both versions. A compaction adds a boundary record and the summary, and every record before them stays where it was. The summary itself gives the transcript's path, so the details can be read back from it. (Claude Code deletes old transcripts after 30 days by default; its `cleanupPeriodDays` setting changes that.)

What compaction writes, and what each model keeps through it, measured: [Claude Code's compaction doesn't delete your history. It re-roots it.](https://long-term-memory-structure.github.io/long-term-memory-structure/compaction.html)

Long-Term Memory Structure reads that transcript, across its compactions, and prints an index of it without its content: `ltms skeleton` gives one JSON line per turn and per tool call. A turn's line gives the address of its prompt, the line of the file where it is written. A tool call's line gives the addresses of the call and of its result, and hashes of what went in and what came out. On the 2,539 transcripts it was tested on (3.35 GB), that index came to 0.7 % of their size, so it fits in a context window where the transcript does not, and every address leads back to the line to read.

Five more commands. `ltms index` lists a project's sessions, one line each, newest first: when each ran, its turns, calls and failures, and the addresses of its prompts, its compaction summaries and its last reply. `ltms search` finds the turns that hold every word of a query, and prints their addresses. `ltms stats` counts each transcript's turns, calls and failures. `ltms pin` keeps copies of the transcripts outside Claude Code's config directory, where its cleanup does not delete them, so the addresses still lead somewhere after it; its log is only appended to, and each line after the first holds the sha256 of the line before it. `ltms skill` prints a skill, a SKILL.md, that teaches an agent to use them. ltms reads local files only, makes no network connections and has no runtime dependencies.

Long-Term Memory Structure is an independent project. It is not affiliated with or endorsed by Anthropic.

Formerly published as `memobrain`.

## Intent and tradeoffs

The objective of this tool is to provide support, a dependency sub-system of the operation of a SINGLE privately scoped persistent substrate longitudinally across time, with a small fixed budget cost and minimal variable costs per query. We don't assume the value of a memory fragment until we need to retrieve it, if at all in some distant future.

**What it leaves to you, and what it sits beside:**
- It does not include an identity (disposition) layer. Bring your own: ltms indexes the record, not the self.
- It is orthogonal to a shared brain in any configuration (a swarm, a company brain). Whatever a shared brain is, it reaches this record only as what the agent read from it, and nothing in this record reaches it except what the agent chose to send.

**The objectives of the design as a whole, and what each one costs** (this package is its first piece: the indexes of a transcript and of a project's sessions):

1. **Monotonically rising, append-only, heal by addition ⟹ data structure L0.**
   *Costs:* the store only grows. A mistake is corrected by a new record, never erased, so it stays visible beside its correction. Anything sensitive that was written stays written.
2. **Preserve structure and sequence ⟹ the compaction JSONL: walk the tree backwards.**
   *Costs:* the indexes depend on the harness's transcript format, which changes between versions. It carries one path through the tree, the one the session ended on, in its order, not a bag of facts.
3. **Cryptographically verifiable and recomputable ⟹ Merkle root hashes, etc.**
   *Costs:* the bytes are kept exactly as written, with no reformatting and no lossy compression. A correction is a new record, never an edit.
4. **Automatic write sequence, independent of the model.**
   *Costs:* everything is written, noise included. The write path is tied to the harness's hooks and files.
   *Declined:* a model that decides what is worth saving. It would price every fragment before anyone has asked for it.
5. **Expose the substrate to the active context window through a small CLI "lens".** Retrieval and attention compete for the same budget, in a zero-sum game. A monotonically rising, append-only scheme would invariably reach a critical failure point, where retrieval crowds reasoning out of the active window. Grep and ack don't scale well. The solution is a CLI tool that exposes a search surface, the "lens", at a small fixed cost (a few thousand tokens), and keeps the variable cost of each query low through LSP, AST, etc.
   *Costs:* a fixed cost in every session, even when memory is not needed. The agent must ask well: a search answers only the questions it already thought to ask.
6. **Restrict summarization to the active writer at write time ⟹ the window lifecycle, `<recap></recap>`.** Disposition and behavioral modification are limited in scope: the necessary proprioception, and a skill for using ltms.
   *Costs:* a summary exists only if the writer wrote it in the moment, and what is written hot is not therefore true. Nobody fills the gaps later.
   *Declined:* background summaries by another model, which put a second voice into the memory under one name.
7. **A shared surface and ground truth for the user and the agent ⟹ GUI.**
   *Costs:* a GUI to build and maintain, and no private view for the agent.
8. **Offline audit capabilities that don't depend on agentic workflows ⟹ raw DAG, GUI.**
   *Costs:* plain, documented formats; the audit is a person's work.
9. **Existence is never priced; residence is ruled ⟹ an address in the store for every fragment, hot context for a few.** Every fragment keeps its address in the store, whatever it may be worth; nothing is deleted to make room. Hot context is a small view of the store: a permanent part, loaded into every session, and a part that follows the work at hand. What sits in it is a ruling: at a point in the window's lifecycle, the active writer demotes a line from hot context, and its address still leads to it. Nobody re-reads the store to decide what comes back.
   *Costs:* the active writer must rule, at those points, on what stays hot. What was demoted is found only when someone asks for it.
   *Declined:* a background model that retires fragments on its own schedule, deciding in one step both what is kept and what is hot.

## Why this exists

A context window keeps nothing between sessions, and every call reads all of it again, so an agent pays again and again for everything it carries, and models do worse as it grows: context rot (Hong et al. 2025). This project is built around that budget: memory for one long-lived agent, with a small fixed cost in every session (an index of about 9,000 tokens, read from cache) and as little as possible per question: a surgical search, through a language server or a syntax tree, that reads one address (a line of a transcript, a symbol) rather than whole files.

One popular approach is a shared "company brain" for a swarm of agents. This is something else: persistence for a single agent. The design and its measurements are in the report *Durable Memory on a Fixed Context Budget* (Ben Yanai 2026). This package is the first piece released: the indexes of a transcript and of a project's sessions.

## Install

Needs Node.js 20 or newer. No dependencies.

```sh
npx long-term-memory-structure stats ~/.claude/projects/<project>/<session>.jsonl
```

Or install it once: `npm install -g long-term-memory-structure`, which gives the command `ltms`. Without installing, write `npx long-term-memory-structure` where this page says `ltms`. npx asks the npm registry about the package on every run; an installed `ltms` runs without the network.

To give your agent the skill that teaches it these commands (Claude Code reads personal skills from `~/.claude/skills/`; after upgrading, run the line that `ltms skill --help` prints, which names the installed version, so that the skill names the fields that version prints):

```sh
mkdir -p ~/.claude/skills/ltms && npx -y long-term-memory-structure@0.2 skill > ~/.claude/skills/ltms/SKILL.md.tmp && mv ~/.claude/skills/ltms/SKILL.md.tmp ~/.claude/skills/ltms/SKILL.md
```

Keep the `-y`: without it, npx asks before installing the package, and its question would be written into the file. `ltms skill --help` gives the line for a `CLAUDE_CONFIG_DIR` of your own.

`<project>` is your project's directory path with every character other than an ASCII letter or digit written as `-` (`/home/me/my.app` becomes `~/.claude/projects/-home-me-my-app/`); Claude Code cuts a name longer than 200 characters there and adds a hash, so for a very long path find the folder with `ls ~/.claude/projects/`. The newest `.jsonl` there is the latest session, and a subagent's transcript is in `<session>/subagents/`. A first look, then reading one line back:

```sh
npx long-term-memory-structure index ~/.claude/projects/-home-me-my-app    # the sessions, newest first
f=$(ls -t ~/.claude/projects/-home-me-my-app/*.jsonl | head -1)
npx long-term-memory-structure skeleton "$f" | grep '"ok":false'
sed -n 22p "$f"    # the line an address names, here <prefix>:L22
```

## Commands

### `ltms index <path>...`

One JSON line per session, newest first by the time it started: when it ran, its turns, calls and failures, and the addresses of its prompts, of its compaction summaries and of its last reply. It is where to start in a project's history: on a demo project of 31 sessions, a line came to about 340 bytes and the default page of 20 to 6,785 bytes. Two of the test transcripts, named on the command line:

```
{"k":"coverage","files":{"given":2,"found":2,"read":2,"failed":0,"notConversation":0,"sessionParts":0,"setAside":0,"symlinks":0},"pinStores":0,"sessions":2,"shown":{"skipped":0,"sessions":2,"order":"newest"},"left":0,"next":null,"ms":3}
{"k":"session","p":"compacte","first":"2026-08-01T10:00:02.000Z","last":"2026-08-01T12:00:01.000Z","turns":2,"calls":4,"failures":0,"compactions":[{"boundary":"compacte:L9","summary":"compacte:L10"}],"agents":null,"firstPrompt":"compacte:L1","lastPrompt":"compacte:L11","lastReply":"compacte:L14","path":"test/fixtures/compacted.jsonl"}
{"k":"session","p":"demo.jso","first":"2026-01-05T09:00:00.000Z","last":"2026-01-05T09:03:05.000Z","turns":4,"calls":12,"failures":5,"compactions":[],"agents":null,"firstPrompt":"demo.jso:L2","lastPrompt":"demo.jso:L33","lastReply":"demo.jso:L36","path":"test/fixtures/demo.jsonl"}
```

- `compactions`: for each compaction on the session's live path, the address of its `boundary` and of the `summary` the model carried on from (`null` when none follows). The summary says what the session had done until then; the lines before the boundary hold what it left out.
- `agents`: the agent transcripts in the session's own directory. Here it is `null`, because the files were named on the command line: their sessions' directories were not given.
- `p` is the address prefix, as skeleton's; `first` and `last` the session's earliest and latest timestamps, compared as strings, as Claude Code writes them; `turns`, `calls` and `failures` are `ltms stats`'s; `firstPrompt` and `lastPrompt` the addresses of its first and last turn's prompts; `lastReply` the address of the last assistant record with text, by search's rule for a reply; `path` the file.
- Each line's `k` says what it is: the coverage line, first, then one `session` line each. The coverage line: of the `files` given and found, those read, `failed`, `notConversation` (read, with no turn), and those counted and not read (`sessionParts`, `setAside`), with the `symlinks` met; the `pinStores` not entered; the `sessions` listed, those `shown` (`skipped`, `sessions`, `order`), those `left`, the `next` command, and the `ms` it took. Its `given`, `found` and `read` are counted as search counts them, outside the pin directories not entered: `read` is `found` less `failed`, `sessionParts` and `setAside`.

Under a directory given, these are counted and not read: the `.jsonl` files in a session's own directory (a directory named by a UUID, or named as a `.jsonl` file beside it, where Claude Code keeps a session's `subagents/`, `tool-results/`, `mcp-tasks/` and `workflows/`); set-aside copies of a session (Claude Code's `<session>.orphaned-<time>-<suffix>.jsonl`, and pin's `<session>.superseded-<12 hex digits>.jsonl`); and a pin directory, one that holds `PINS.log`, which is not entered, and whose files are neither read nor counted (give it to list the sessions pinned there). To list a session's agent transcripts, give its `subagents` directory. Every other file read that holds a turn gets a line, including sessions run with `claude -p`, the Agent SDK or `/loop`, which Claude Code's session picker leaves out.

`--max <n>` (20 by default; 0 prints every one), `--skip <n>` and `--oldest` page the sessions as search pages its turns, and the coverage line's `next` is the command that prints the next page. A session started between two runs moves the later pages down by one, so a line can print twice; one deleted between them (Claude Code's cleanup deletes the oldest first) moves them up by one, so a session can be passed over. index parses every file it reads, as search does: on this machine, 31 demo sessions (17.9 MB) took 0.37 s, and a project folder of 385 sessions, with 2,849 files of their own directories counted and not read, took 39 s. `ltms index --help` describes every field.

### `ltms skeleton <file.jsonl>...`

One JSON line per turn and per tool call. A turn starts at a prompt; its tool calls follow it in order. This is one turn of the synthetic test transcript [`test/fixtures/demo.jsonl`](https://github.com/long-term-memory-structure/long-term-memory-structure/blob/v0.2.0/test/fixtures/demo.jsonl): a hook blocks a command, the tests fail twice, a fix is made, the tests pass.

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
| `ok` | call | `true` when the call succeeded; `false` when it failed (its result is marked `is_error`, or Claude Code wrote the error as a string in `toolUseResult`); `null` when no result was recorded (the session ended, or the file was cut, before the call returned, or the call was still running when the file was read, as the call that runs ltms on its own session is). The status of the call as a whole: for a Bash command of several parts, the one the shell returned for the whole command (in `a; b`, that of `b`), so a part that failed before the last can read `true`, and what it printed, if anything, is in the result's text at the call's `r` address; for a command run in the background, the status of its launch, its exit coming later in another record |
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

A path is cut to its last part. When nothing runs after the words passed over (a command of assignments only, or `cd DIR;` with nothing after it), the verb is `(empty)`; when an assignment's value is a command substitution made of such words, it is the program inside the first such substitution. A wrapper with nothing after it but its own options is the program. The shell's test brackets print as `[` and `[[`, and a shell keyword prints as itself. Anything else before the program (a here-document, another redirection, an option the wrapper list does not name, any other `$(...)` or `${...}`, a backslash, a redirection after a wrapper, more than 63 assignments, `cd` commands and wrappers before the program, more than 15 commands passed over), a program that is not a plain word, and a function definition make the verb `(withheld)`. The program then passes the label rule in [Privacy](#privacy), like every label, so a name holding `,` `%` `@` `=` `~` or `^` prints `(withheld)` too. What follows the program is never read, but for the command's end: a command that ends in `&&`, `||` or `|` (or `|&`), with nothing after it but blanks, new lines, line continuations and comment lines, is `(withheld)` however many commands come before it, since bash rejects it as a syntax error. That end is read as text: a comment on the operator's own line hides the operator (the program is printed), and an operator escaped or inside a comment at the very end counts (the verb is withheld). After the 15 commands that may be passed over, a 16th is passed over too when nothing but blank lines, comment lines and an opening `(`, `{` or `!` follows it, and the verb is then what a shorter command gets there: `(empty)`, or the first substitution's program.

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
| `cd ~/proj && npm test &&` | `(withheld)` (bash rejects the dangling `&&`) |

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

### `ltms search <query> <path>...`

The turns that hold every word of a query, as addresses: no line holds the text that matched. The query comes first, as one quoted argument; the paths follow, transcripts or directories (every `.jsonl` file under a directory, at any depth, subagents' transcripts included). For the same test transcript:

```sh
ltms search 'npm test' test/fixtures/demo.jsonl
```

```
{"k":"coverage","query":["npm","test"],"mode":"words","kinds":["input","summary","reply","thinking","call","result","system"],"kindsOff":["meta","attachment"],"files":{"given":1,"found":1,"read":1,"failed":0,"notConversation":0,"symlinks":0},"turns":4,"records":34,"notSearched":{"offPath":0,"toolUseResult":11,"wireInputs":0,"redactedThinking":0,"sidecars":2,"images":0,"spilled":0,"replays":0,"beforeFirstTurn":0,"unreadableLines":0,"kindsOff":1},"hits":{"files":1,"turns":1,"records":6,"byKind":{"input":0,"summary":0,"reply":0,"thinking":0,"call":1,"result":1,"system":0}},"shown":{"skipped":0,"turns":1,"order":"newest"},"left":0,"next":null,"segmenter":"icu","ms":21}
{"k":"file","f":1,"p":"demo.jso","path":"test/fixtures/demo.jsonl","last":"2026-01-05T09:03:05.000Z"}
{"k":"hit","f":1,"ta":"demo.jso:T003","ch":"typed","at":[{"a":"demo.jso:L24","kind":"call","field":["message","content",0,"input","command"],"at":0,"w":[0,1]},{"a":"demo.jso:L25","kind":"result","field":["message","content",0,"content"],"at":17,"w":[1]},{"a":"demo.jso:L26","kind":"call","field":["message","content",0,"input","command"],"at":17,"w":[0,1]},{"a":"demo.jso:L27","kind":"result","field":["message","content",0,"content"],"at":17,"w":[1]},{"a":"demo.jso:L30","kind":"call","field":["message","content",0,"input","command"],"at":25,"w":[0,1]},{"a":"demo.jso:L31","kind":"result","field":["message","content",0,"content"],"at":5,"w":[1]}]}
```

and on stderr:

```
ltms search: 1 matching turn in 1 of 1 file (1 read, 0 failed); 1 shown.
```

Both words are in turn 3, the turn shown above: in the three `npm test` commands (`call`, both words: `w` is `[0,1]`) and in what they printed (`result`, which holds `test` only: `w` is `[1]`). The first line is always the coverage: what was searched, what was not, and how many turns matched. Then, newest session first (by the latest timestamp in each file), a line for each file with a hit, followed by its matching turns in their order, one line per turn: at most `--max` turns in all, after the first `--skip`. The coverage's `left` counts the matching turns after the ones printed, and `next` is the command that prints the next ones (the same search with `--skip` past those printed, and the same `--max`). stderr holds the notices about the query, the warnings, and one closing line with the totals; when no turn matched, it names the ways to find more (fewer words, `--kind all`, `--substring`) with the command.

To search one project's sessions, give its folder: `~/.claude/projects/` and the project's directory written as [Install](#install) says, as in `ltms search 'compaction summary' ~/.claude/projects/-home-me-my-app`. Given no path, `ltms search` prints that command for the current directory (or says that the current directory no longer exists). `ltms search --help` prints search's part of the help, with every field.

| option | meaning |
|---|---|
| `--kind <list>` | the kinds of text searched, separated by commas (or `--kind=<list>`), `all` for every kind; given twice, the kinds add up. Without it: every kind but `meta` and `attachment` |
| `--substring` | find each term inside longer words too, after the same folding: `cat` also finds `concatenate` |
| `--max <n>` | the matching turns printed: 20 unless set, every one with `0`; given twice, the last counts |
| `--skip <n>` | the matching turns passed over before printing: 0 unless set. The coverage's `next` gives it, so the next command prints the turns after those printed |
| `--count` | print the coverage line only |
| `--oldest` | oldest sessions first |

Under a directory, the files with nothing to search (empty, a workflow journal, no conversation records, no turn), the symbolic links met, the entries named `.jsonl` that are not regular files (a pipe, a socket), the directories met again (see [Limits of search](#limits-of-search)) and the files with warnings of their own are counted in one warning line, not reported one by one; it names up to four of the files with warnings of their own, each with its kinds of warning, and ends with the command that shows them. A file named on the command line keeps skeleton's warnings, worded for search. Options may come before or after the query; `--` ends them, for a query or a path that starts with `-`, and every command a message gives puts it there when one does. A path that does not exist and looks like a word is refused with the reason: the query comes first, as one argument. So is a query that names an existing path (one with a `/`, or ending in `.jsonl`) when no path argument names one, as when the query was left out; when a path argument does, the query is searched, with a notice that it is also a path. Exit status: 0 when every file was read (with hits or none), 1 when a file or a directory could not be read or was too large, 2 on a usage error.

#### Reading a hit

A hit names each record of the turn that holds a word of the query: its address `a`, the kind of its text, the key path of the first field of that kind holding a word (`field`), and the offset of the first match in that field's string (`at`). Hit records can be large (in the sample measured for the design, half of them were over 8 KB and a tenth over 74 KB). Rather than the whole line, print a window of 600 characters around the match, from the file's path, the line number in `a`, `field` and `at`:

```sh
node -e 'const [p,l,f,a]=process.argv.slice(1),F=JSON.parse(f),K=v=>v!==null&&typeof v=="object"?Object.keys(v):[],s=(v,i)=>i<F.length?F[i]=="(withheld)"?K(v).some(x=>s(v[x],i+1)):s(v?.[F[i]],i+1):typeof v=="string"&&v.length>a;let v=JSON.parse(fs.readFileSync(p,"utf8").split("\n")[l-1]),w;for(const [i,k] of F.entries()){if(k=="(withheld)"){w=K(v).filter(x=>s(v[x],i+1));break}v=v?.[k]}console.log(w?"keys here: "+JSON.stringify(w):typeof v!="string"?"not a string here":a>=v.length?"at is past the end of this field":v.slice(Math.max(0,a-300),+a+300))' test/fixtures/demo.jsonl 25 '["message","content",0,"content"]' 17
```

```
Exit code 1
FAIL test/add.test.js
  expected 4, received 5
```

The match itself can be invisible to `grep` on the raw line: it can differ in case or in accents, or be written there as a JSON escape. Where `field` holds `(withheld)` (a key below a tool's parameter or a system or attachment record's own keys, or one that fails the label rule), the command prints instead the keys at that place whose value leads, along the rest of `field`, to a string longer than `at` (`keys here: [...]`): put one in its place, and run it again. Where `field` leads to no string, it prints `not a string here`, and where the string is no longer than `at`, `at is past the end of this field`.

#### The kinds of text

| kind | text | searched without `--kind` |
|---|---|---|
| `input` | the record that opens a turn, on any channel (typed, sdk, a task, a loop, the parent agent, a peer), and a prompt typed while the model worked (a queued prompt) | yes |
| `summary` | a compaction summary | yes |
| `reply` | the assistant's text (an API error's text is `system`) | yes |
| `thinking` | thinking text (most thinking blocks hold only a signature) | yes |
| `call` | the string values of a tool's input, at any depth (its keys are not searched) | yes |
| `result` | the text of a tool's result | yes |
| `system` | every string value of a system record but its envelope (session id, directory, branch, version, time), its `subtype` and its `level` (names from a fixed list): hook summaries, API errors | yes |
| `meta` | other user text: the notes the harness writes in the user's place, command output, caveats | no |
| `attachment` | the string values of an attachment record's `attachment` object | no |

`meta` and `attachment` hold the harness's own text: the system prompt, skill listings, reminders. On the demo corpus of the design, 570 words of five letters or more occur in that text in 28 or more of its 31 sessions, and in the prompts, replies, calls and results of at most 3 sessions: searched by default, they would make a query for any of them match nearly every session (`deferred`, for one, matches 135 turns with `--kind all`, and 1 without). Name them to search them (`--kind meta`, `--kind all`); the coverage's `kindsOff` lists what was left out.

#### What is searched, and what is not

- A turn's records are the ones `ltms skeleton` shows for it: its prompt, the live-path records up to the next prompt, and the call and result records of each of its tool calls, wherever they sit (a parallel call's result is often off the live path). Live-path records before the first prompt are the first turn's; in a file with no turn, they are counted (`beforeFirstTurn`).
- A string that holds JSON escapes (a backslash and `n`, `t`, `r`, `b`, `f`, `"`, `/`, a backslash, or `u` and four hex digits) is searched as written and decoded: a word is found in either form, a phrase within one.
- Not searched, and counted in `notSearched`: rewound branches, the harness's structured copy of a result (`toolUseResult`), the inputs as the model wrote them (`wireToolInputs`), redacted thinking, images, records outside the conversation, replayed copies of records, lines that are not JSON objects, and records whose only text is of the kinds left out. Of a result written to a file (`<persisted-output>`), only the preview the transcript holds is searched.

#### Words, and what is folded

The query and the text are read by one function. Text is split into runs of letters, marks, digits and format characters; a run holding Chinese, Japanese, Thai, Lao, Khmer or Myanmar letters is first cut into words by the dictionary of Node's `Intl.Segmenter`. Each piece is then folded: compatibility forms to plain letters (full-width letters, ligatures), lower case, final sigma to sigma, accents and other marks removed (Hebrew points and Arabic vowel marks too), format characters and the Arabic tatweel removed, a zero-width space read as a space. What is left is cut into runs of letters and digits, and between two adjacent letters of different scripts (a Hebrew prefix letter glued to a Latin word is a word of its own; `v2` is one word). A word of the query matches a word of a field; a phrase (`"..."`, also in curly quotes), or a word that reads as several (`node:sqlite`, `2.1.314`), matches when its words stand adjacent and in order within one field. `--substring` reads each field folded the same way, without the dictionary and the script cut, every run of anything but letters and digits as one space, and finds each term inside it. On 120 known queries over 18 strings (English, Greek, Hebrew, Arabic, Chinese, Japanese, Thai and Korean text, code, and emoji; the tests run them), words mode does not find 27 and `--substring` 9; 3 of each are emoji, which read as nothing.

Nothing else is folded: no stems, no prefixes. In Hebrew, Arabic and Korean a word with letters attached is another word, and in a spaceless script a word the dictionary cuts otherwise is not found, so a query holding such letters draws a notice on stderr, with the `--substring` command:

```
ltms search: notice: 'בית' is in the Hebrew script, whose words take letters attached before or after them, and words mode finds whole words only: for example, בית does not find והבית. To find it inside longer words too: ltms search --substring 'בית' test/fixtures/demo.jsonl
```

With `gapScripts`, the coverage counts that script's letters in the text searched: the size of what the notice is about. If this Node's `Intl.Segmenter` cannot cut Thai and Chinese into words (it is tested at the start), the coverage says `"segmenter":"no-dictionary"`, a run of such text is read as one word, and a notice says so. A Node without `Intl` cannot run the search at all, and says so (exit 2); index, skeleton, stats, pin and skill do not need it.

#### The output's fields

The coverage line:

| field | meaning |
|---|---|
| `k` | always `"coverage"` |
| `query` | the terms searched for, as typed; a hit's `w` holds indices into this list. A term that reads as nothing (no letter or digit) is left out, with a notice |
| `mode` | either `"words"`, or `"substring"` with `--substring`: each term is then also found inside longer words (`cat` finds `concatenate`), and a notice on stderr says so |
| `kinds` | the kinds of text searched |
| `kindsOff` | the kinds left out |
| `files` | the files, by the counts below |
| `turns` | the turns in the files read, as skeleton numbers them |
| `records` | the records of those turns that were searched |
| `notSearched` | what was not searched, by the counts below |
| `hits` | what matched, by the counts below |
| `shown` | the matching turns passed over (`skipped`) and printed (`turns`), and their order (`order`: `"newest"` or `"oldest"`) |
| `left` | the matching turns after the ones printed |
| `next` | the command that prints the next ones (the same search with `--skip` past those printed, and the same `--max`), or `null` when none is left |
| `segmenter` | either `"icu"` (the dictionary cuts spaceless scripts into words), or `"no-dictionary"` |
| `gapScripts` | only for a query holding Hebrew, Arabic, Hangul, Han, Hiragana, Katakana, Thai, Lao, Khmer or Myanmar letters: that script's letters in the text searched |
| `ms` | the time the search took, in milliseconds |

In `files`:

| field | meaning |
|---|---|
| `given` | path arguments |
| `found` | the files named (whatever their name), the `.jsonl` files under the directories named, each file once by its real path; each path that does not exist; and each directory that could not be read |
| `read` | found minus failed: the files read, `notConversation` included |
| `failed` | what could not be read, each one reported on stderr: a path that does not exist, a directory that cannot be listed, a file too large (below), a file or a directory whose name is not valid UTF-8, a file that cannot be read or that stopped with an internal error |
| `notConversation` | files read that hold no turn: empty, a workflow journal, no conversation records, or no turn on the live path |
| `symlinks` | symbolic links met under the directories named, not followed (a link named on the command line is followed) |

In `notSearched`, records unless named:

| field | meaning |
|---|---|
| `offPath` | records on no turn: rewound branches |
| `toolUseResult` | turn records that carry the harness's structured copy of a result; the result's own text is searched |
| `wireInputs` | turn records that carry `wireToolInputs`, the inputs as the model wrote them; the inputs as run are searched |
| `redactedThinking` | redacted thinking blocks (blocks) |
| `sidecars` | records outside the conversation: last-prompt, queue-operation and the like |
| `images` | images in turn records (blocks) |
| `spilled` | turn records with a result written to a file: only its preview is searched |
| `replays` | later copies of a record already written |
| `beforeFirstTurn` | the live-path records of a file with no turn |
| `unreadableLines` | lines that are not a JSON object (lines) |
| `kindsOff` | turn records whose only text is of the kinds left out |

records + offPath + replays + beforeFirstTurn + sidecars + kindsOff = the records in the files read (the lines that are JSON objects), in every file. toolUseResult, wireInputs, redactedThinking, images and spilled are counted over the turns' records, searched or not, so they overlap the others.

In `hits`:

| field | meaning |
|---|---|
| `files` | files with a matching turn |
| `turns` | matching turns: the turns that hold every term |
| `records` | records with an entry in those turns |
| `byKind` | for each kind searched, the matching turns with an entry of that kind |

In `shown`:

| field | meaning |
|---|---|
| `skipped` | the matching turns passed over before those printed: `--skip`, or every matching turn when `--skip` is larger |
| `turns` | the matching turns printed: at most `--max` |
| `order` | either `"newest"`, or `"oldest"` with `--oldest` |

A file line, before its turns:

| field | meaning |
|---|---|
| `k` | always `"file"` |
| `f` | the file's number: 1, 2, ... in the order printed |
| `p` | its address prefix, as skeleton's |
| `path` | its path, as named or as found under a directory named |
| `last` | the latest timestamp among its records, which orders the files; `null` when there is none, and `(withheld)` when it is not an ISO 8601 time |

A hit line, one per matching turn:

| field | meaning |
|---|---|
| `k` | always `"hit"` |
| `f` | the number of its file's line |
| `ta` | the turn, as skeleton numbers it |
| `ch` | the channel of the turn's prompt, as skeleton's `ch` |
| `at` | one entry for each record and kind of text holding a term, in line order, below |

An entry of a hit's `at`:

| field | meaning |
|---|---|
| `a` | the record's address |
| `kind` | the kind of text |
| `field` | the key path of the first field of that kind that holds a term: key names and array indices. Keys are named down to a tool's parameter (the first level of its `input`) and a system or attachment record's own keys, each passing the label rule or printed `(withheld)`; a key below them is data a tool or the model wrote, and is `(withheld)` |
| `at` | the UTF-16 offset of the first match in that field's string, as `JSON.parse` reads it (a match in a decoded escape is given at the escape) |
| `w` | the terms found in that record's text of that kind, in any of its fields, as indices into `query` |

#### Limits of search

- Speed, measured on one machine (8 cores, Node 26), Node's start included, in two runs an hour and a half apart: 0.40 to 0.46 s for the 35 transcripts of the demo corpus (18.9 MB), 2.8 to 3.2 s for ten copies of it (189 MB), 0.9 to 1.0 s for one session of 43 MB: 40 to 65 MB a second. At that rate 6 GB of transcripts would take 1.5 to 2.5 minutes (arithmetic, not measured), around the default timeout of Claude Code's Bash tool (2 minutes): search the project's own folder rather than all of `~/.claude/projects/`, or give the command a longer timeout.
- Memory: the files are read one at a time, each one whole, and only the hits (addresses) are kept to the end. Measured on one session of 43 MB: 270 MB at its peak, 5.2 times the file's size over Node's own 50 MB (skeleton: 4.9 times).
- A file larger than a tenth of Node's heap limit is not read, because running out of memory cannot be caught and would end the search with every hit lost. With Node's default heap of about 2 GB the limit is about 210 MB; Node sizes its heap by the machine's memory or a container's. The file is reported and counted as failed, and the warning gives the command with more memory (`NODE_OPTIONS=--max-old-space-size=<MB>`), which raises the limit. Measured: a real session at the limit is read when Node's old space is 32 MB or more; at 16 MB it ran out of memory.
- A copy of the transcripts under the path searched doubles the hits: each session is found twice, once in each place.
- Symbolic links met under a directory are counted, not followed: a transcript reached only through a link is not searched unless the link is named on the command line.
- Under a directory given, each directory is read once, known by its device and inode: one met again (a bind mount of a directory inside itself shows the same device and inode, and would have its files read twice) is not read again, and the warning line counts it. Tested on Linux with a real bind mount in a user namespace (`unshare -rm`), and with a stubbed `stat`; not on macOS or Windows.
- A file or a directory whose name is not valid UTF-8 cannot be read by `ltms`, which takes paths as text: it is reported with the name's bytes written as `\xHH`, and counted as failed.

### `ltms pin <path>... --to <dir>`

Claude Code deletes old transcripts by itself. Its documentation, as read on 2026-11-08: "Claude Code deletes the files in the paths below once they're older than `cleanupPeriodDays`, as long as it can safely determine the retention period. The default is 30 days and the minimum is 1" ([Cleaned up automatically](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)). Those paths include each session's transcript, its subagents' transcripts and its `tool-results/`. The clock is a file's modification time, and a file under `tool-results/` goes by its own age even while its transcript lives (read in Claude Code 2.1.314's code, and seen on disk).

To keep transcripts longer, raise `cleanupPeriodDays` in your settings ("pick a large value such as `3650` for long retention", [settings reference](https://code.claude.com/docs/en/settings-reference#cleanupperioddays)). `ltms pin` keeps copies that the cleanup never touches, whatever that setting says, and a log they can be checked against:

```sh
ltms pin ~/.claude/projects --to ~/claude-pins                  # every project
ltms pin ~/.claude/projects/-home-me-my-app --to ~/claude-pins  # one project
ltms pin --check ~/claude-pins
```

**What it copies: the cleanup's own shape.** The root is `~/.claude/projects` (`$CLAUDE_CONFIG_DIR/projects` when that is set; `--root <dir>` names another), and every path given must be under it; a relative path starts from the current directory. In each project directory (a directory directly under the root), pin copies `<name>.jsonl`, Claude Code's own set-aside copies `<name>.jsonl.superseded-*`, and every file under `subagents/`, `tool-results/`, `workflows/` and `mcp-tasks/` of a session directory: one named by a UUID, or by a `<name>` whose `<name>.jsonl` is beside it. A `<session>.jsonl` given by itself brings its `<session>/`. Other files are counted (`notSessionShaped`), not copied; `memory/`, `.git` and symbolic links met under a path are counted, not entered. A project directory's name starts with `-`, so a relative one needs `--` before it: `ltms pin --to ~/claude-pins -- -home-me-my-app`.

**The pin directory.** pin refuses, with the reason and the next command, before it writes anything (exit 2): no `--to`; a `--to` inside Claude Code's config directory (its cleanup manages it), inside a path given or inside the root; a path inside `--to`; a path outside the root; a `--to` that is not a directory, or that holds files and no `PINS.log` (a pin starts in a new or empty directory, and pin never writes among files it did not make); a `PINS.log` that is a symbolic link or not a regular file (a FIFO), has another name (a hard link, under which every line appended later could be read), or does not open with its root line; and a root other than the one the pin's log records (a root whose recorded path now leads to this one, Claude Code's config directory moved to another disk with a symbolic link left at its path, is the same root).

- `<to>/<rel>`: the newest bytes of each file, where `<rel>` is its path under the root, with its source's modification time, so `ls -t` works in the pin. A `.jsonl` is copied up to its last new line: a line still being written waits for the next pin (`partial`), and a `.jsonl` with no new line yet is not copied at all (`notCopied`).
- A file whose copy is not a prefix of it was rewritten. Its old copy is kept first, by a hard link, as `<stem>.superseded-<sha12>.jsonl` (`<name>.superseded-<sha12>` for another file), named by the first 12 hex characters of its sha256. A kept copy is never overwritten: nothing is renamed onto its name, and a source at such a name is not pinned there (a failure, `kept-name`).
- `<to>/PINS.log`: JSON lines, only ever appended to. The first names the root; then one line per change, `new`, `grown`, `rewritten` (with `kept`), `recovered` or `takeover`, with the file's `rel`, its length and sha256, the version before it, the source's modification time, and `chain`, the sha256 of the line before it. It is not named `.jsonl`, so nothing reads it as a transcript.
- Files are `0600` (or the source's mode, when stricter); directories are `0700`.

Each file is read once, and its copy is written from the very bytes that were hashed: into a temp file, which is fsynced, then renamed over the copy. A file whose size and modification time are what its last line records is not read again. `--rehash` reads every file, and also reads each copy whose source still holds the version its last line records: a copy that holds other bytes (changed in place, at the same size or not) is written again from its source, with a `recovered` line, what it held first kept beside it as a file of its own, with its own `recovered` line (unless it is a `.jsonl` whose bytes do not end in a new line, which no pin writes). Before pin writes over a copy it reads it: bytes it did not expect there (a version a killed pin renamed in, another pin's) are recorded and kept. pin never writes through a symbolic link inside the pin directory: a file whose copy would go through one is a failure (`symlink-in-pin`), so every copy stays inside the pin, where its own scan finds it. `PINS.log`, the lock and a kept copy are read and appended to only as regular files: at one of those names, a symbolic link is never read or written through and a FIFO is never waited on (a failure, `not-a-regular-file`; `PINS.log`, before a pin starts, is a refusal). While a pin runs it holds `<to>/.ltms-pin.lock` (its pid, host and start time; on Linux also the boot, the PID namespace and the process's start). Another pin waits for it up to 30 s, then exits 1, naming the holder and the `rm` command; a lock left before this host's last boot, or whose pid no longer runs on this host (or runs another process), is taken over, and one held in another PID namespace on this host (a container) counts as running. Before each write, a pin checks that the lock is still its own and `PINS.log` the file it read: when not (the lock removed by hand, or another pin's), it stops before that write (a failure, `lock-lost` or `log-changed`) and leaves the other's lock. SIGINT, SIGTERM or SIGHUP stop a pin between two files, and it removes the lock. A pin that was killed is repaired by the next one, once it has read `PINS.log`: a temp file it left is removed when its copy, a kept copy of that file, or its source holds what the temp file holds, and is kept otherwise, as the kept copy of its own bytes with a `recovered` line (the source may have been rewritten since, and the temp file be the only copy of that version); a file named like a temp file that a line of `PINS.log` names is a copy, not a temp file; and each copy whose size is not the one its last line records (or beside which a kept copy waits that no line names) is read, and gets a `recovered` line when it holds other bytes. Under `--rehash`, a copy with no kept copy beside it, whose source is pinned in that run, gets none when that source cannot be read (the run fails on the file, and the copy is left as it is until a `--rehash` can read the source); when the copy no longer holds that version at its start, and its source still holds the version at its start (as whole lines, for a `.jsonl`); and when the copy is a `.jsonl` that holds the version at its start followed by bytes with no new line, which no pin wrote, since a pin copies a `.jsonl` up to a new line. In the last two, the run pins the source against that version: the copy is written again from it, or, when the source has been rewritten since, kept as the old copy of the rewrite; a copy holding its version and such bytes is first cut back to the version (also when its source holds no whole line, and nothing is copied), so those bytes are never recorded or kept. Under `--rehash`, a copy with no kept copy beside it also gets none when the run cannot read the way to its source: a directory on that way that it cannot list, or a path on it that it cannot look at (each a `walk` failure of the run). It is left as it is until a `--rehash` can read the source, as one whose source cannot be read is. A pin without `--rehash` records either one's bytes meanwhile, and a `--rehash` that can read the source then keeps them as the old copy of a rewrite (see Limits). A copy changed in place at the same size is not seen there: `--check` finds it, and `--rehash` writes it again.

**Output.** stdout is one line, then one line per failure. A first pin of the demo transcripts, copied under a stand-in `~/.claude` (paths shortened):

```
  {"k":"coverage","root":"/home/me/.claude/projects","to":"/home/me/claude-pins","files":{"seen":39,"new":39,"grown":0,"rewritten":0,"unchanged":0,"notCopied":0,"failed":0},"failures":0,"partial":0,"skipped":{"notSessionShaped":0,"symlinks":0,"memory":1,"git":0},"bytesCopied":18871673,"keptSourceGone":0,"lastLog":"2026-11-08T15:47:06.529Z","ms":234}
```

| field | meaning |
|---|---|
| `root`, `to` | the real paths of the root and of the pin directory |
| `files` | the counts, where `seen` = `new` + `grown` + `rewritten` + `unchanged` + `notCopied` + `failed`: the files of the cleanup's shape under the paths. `notCopied`: a `.jsonl` with no new line yet (empty, or its first line still being written), with nothing whole to copy. `failed`: a source file that could not be read, kept or written |
| `failures` | every failure line that follows: `failed` of them are source files, the rest the pin directory, its lock or its log, a path or a directory under it, or a copy that recovery could not read |
| `partial` | the `.jsonl` files with bytes after their last new line (or no new line yet), left for a later pin; they are counted in `files` too |
| `skipped` | found under the paths and not copied: `notSessionShaped`, `symlinks`, `memory`, `git` |
| `bytesCopied` | the bytes written into copies |
| `keptSourceGone` | pinned files under the paths whose source is gone: what only the pin now keeps |
| `lastLog` | when PINS.log's last line was written |
| `ms` | how long the run took, in milliseconds |

A failure line is `{"k":"failure","path","rel","op","code"}`: `op` is the step (`to`, `lock`, `log`, `walk`, `read`, `keep`, `write` or `recover`) and `code` the error code, or one of ltms's own (`symlink-in-pin`, `not-a-regular-file`, `kept-copy-differs`, `kept-name`, `name-not-allowed`, `lock-lost`, `log-changed`: [docs/library.md](https://github.com/long-term-memory-structure/long-term-memory-structure/blob/v0.2.0/docs/library.md#pinfailure) says what each means). `--list` adds one line per line appended to PINS.log for a file: `{"k":"pin","rel","how","bytes","prev","kept"}`, where `prev` is the length of the version before (`null` for a new file) and `kept`, after a rewrite, the old copy's `rel`. stderr says what recovery found and did, and closes with one line when something failed or nothing was found to pin.

**Checking a pin.** `ltms pin --check <dir>` writes nothing. A pin that is running is waited for first, as a pin waits for one (up to 30 s; then exit 1, as pin does), since a file it is writing would read as damage. It reads every version PINS.log records back from the copy that holds it (the file, or the kept copy a later line names), checks every line's `chain`, and counts the files under the root (the one PINS.log records, or `--root`) that the pin is missing or holds shorter than they are now (a `.jsonl` with no new line yet is not missing: pin does not copy it; one whose copy is a byte prefix of it, longer only by an unfinished line, is counted apart, `unfinished`, since pin copies whole lines only; one rewritten under an unfinished line is longer). That count, with the time of the last line, is how a pin that has stopped is seen. stdout is one line, then one line per finding:

```
  {"k":"check","dir":"/home/me/claude-pins","root":"/home/me/.claude/projects","lines":40,"versions":39,"files":39,"mismatches":0,"chainBreaks":0,"unreadableLines":0,"unlogged":0,"temps":0,"lock":null,"lastLog":"2026-11-08T15:47:06.529Z","staleness":{"root":"/home/me/.claude/projects","fromLog":true,"sources":39,"missing":0,"longer":0,"unfinished":0,"projectsNotPinned":0,"failed":0,"tooLarge":0},"ms":36}
```

`lines` counts PINS.log's lines, `versions` the versions they record, and `files` the copies read; `staleness` counts the `sources` under the root, those `missing` from the pin, those `longer` than their copy, those whose copy is a prefix of them, longer only by an unfinished line (`unfinished`), the project directories of which the pin holds nothing, the directories that could not be read (`failed`), and the sources larger than a pin reads (`tooLarge`: 2 GiB; every pin fails on each). The findings: `{"k":"mismatch","rel","copy","line","want","got"}` (a version the copy does not hold: `copy` is the copy read, `rel` itself or a kept copy, `line` its line in PINS.log, `got` what the copy holds, or `null` when it is missing, cannot be read, or is not a regular file), `{"k":"chain","line","want","got"}`, `{"k":"unreadable","line"}` (a line that is not a log line) and `{"k":"unlogged","rel"}` (a file in the pin that no line names; the next pin records it). After a mismatch in a current copy (not a kept one) whose source is there, under the root PINS.log records, as itself (a regular file of the cleanup's shape, reached through no symbolic link), the closing line gives the `--rehash` command for the projects of those copies, and for a file under `.git` or under `memory/` directly under a project directory, where a pin of its project does not go, the file itself (a file of the cleanup's shape given by its own path is pinned whatever directories it is under): it writes back into the current copies what their sources still hold, and `ltms pin --check`, run again, says what remains. The files missing from the pin or longer than their copies get the command that pins them, `ltms pin <root> --to <dir> --root <root>` from the root `PINS.log` records, when that is the root the check walked. Beside the `--rehash` command it gives none, and says to run the `--rehash` first, since a pin run before it may record a damaged copy as a version (see Limits). While `PINS.log` has another name (a hard link), which makes every pin into the directory a refusal, a notice says so, with the `find` command that names the others; no pin command is given, and nothing is said of what a next pin would do.

**At the end of every session.** A `SessionEnd` hook, with ltms installed globally (`npm install -g long-term-memory-structure`; npx may download it at the end of a session). In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "ltms pin --from-hook --to ~/claude-pins", "timeout": 60 }] }
    ]
  }
}
```

`--from-hook` reads the JSON that Claude Code gives a hook on standard input, and pins the directory of its `transcript_path`: that session's project directory. When standard input is a terminal or empty, is not JSON or not an object, or has no `transcript_path` string, it is a usage error (exit 2) that says which, and on `SessionEnd` Claude Code shows that message to the user. Claude Code gives `SessionEnd` hooks 1.5 s by default; a per-hook `timeout` raises that, "up to 60 seconds" ([hooks](https://code.claude.com/docs/en/hooks)). The hook runs only when a session ends: a session whose process is killed (SIGKILL, a crash, a power loss) never runs it.

**A cron line** catches what the hook misses. cron starts with a short `PATH` (`/usr/bin:/bin`) and none of your shell's variables, so name everything in full (`command -v ltms` gives ltms's path), and `CLAUDE_CONFIG_DIR` too if you set it. ltms starts with `#!/usr/bin/env node`, so the line's `PATH` must also hold node's directory (`dirname $(command -v node)` gives it; with nvm, Volta or a Node under `/usr/local`, cron's own `PATH` lacks it, and the line would fail with exit 127):

```
17 * * * * PATH=/usr/local/bin:/usr/bin:/bin CLAUDE_CONFIG_DIR=/home/me/.claude /usr/local/bin/ltms pin /home/me/.claude/projects --to /home/me/claude-pins >> /home/me/claude-pins.log 2>&1
```

**Exit status:** 0 when every file was pinned; 1 when a file or directory failed (each failure line names one), or another pin held the lock for the whole wait; 2 on a usage error or a refusal. `--check`: 0 when the pin holds what PINS.log records; 1 on a mismatch, a chain break, a line that is not a log line, a directory under the root that could not be read, a running pin that held the lock for the whole wait, a `PINS.log` with another name, which every pin refuses, or a source larger than a pin reads; 2 on a usage error or a directory that is not a pin. Unlogged files, temp files, a lock left by a pin that stopped, and missing sources are reported, and fail nothing.

**Limits.**
- Each file is read into memory whole, one file at a time. A source of 2 GiB or more is not read: every pin fails on it (`ERR_FS_FILE_TOO_LARGE`), as 0.2.0 did, and `--check` counts it (`tooLarge`) and exits 1. A source larger than the memory a pin may use (a container's limit, or cron's) ends every pin at that file, and the files after it in rel order are not pinned meanwhile; `--check` counts them missing or longer, and the takeover lines in `PINS.log` show the pins that were killed.
- The pin's file system must have hard links: the lock and the kept copies use them. FAT and exFAT have none, and pin fails there at the lock. Not measured.
- Nothing outside `projects/` is copied (`file-history/`, `todos/` and the rest), though the cleanup deletes some of it too.
- A project directory under the root that is a symbolic link (a project moved to another disk) is not pinned: a pin of the whole root counts it in `symlinks`, and a pin of it by name, or by the hook of a session in it, is refused, since its real path is outside the root. The refusal names where it leads, and the command that pins that directory into a pin of its own.
- A symbolic link inside the pin directory is never written through. A directory on the way to a copy that is one makes each file under it a failure, `symlink-in-pin`, at every pin, until the link is gone; that check is made before each write, so a link put in place during the write itself is not seen. `PINS.log`, the lock or a kept copy's name that is a link, a FIFO or anything else but a regular file is a failure, `not-a-regular-file` (`PINS.log`, before a pin starts, a refusal); the open itself also refuses a link and does not wait (`O_NOFOLLOW`, `O_NONBLOCK`) where Node defines them, which it does not on Windows. Tested on Linux.
- Whoever can write into the pin directory can replace pin's files there with their own (pin refuses a `PINS.log` that has another name, a hard link, but not a regular file of theirs put in its place, which would then receive every line appended later), so keep the directory closed to others, as pin makes it (`0700`).
- A copy that a pin found holding other bytes than its log line records gets a `recovered` line with the copy's modification time, so until its source changes, that file is read and hashed on every pin.
- Two pins that find the same dead lock at the same moment can both take it over (a window of microseconds); the one whose lock is not at the lock's name stops before its next write. That check is not one act with the write: a pin paused between them (a stop signal, a debugger) while another pin writes the same copy can still write over that version.
- A lock held in another PID namespace on this host (a container that shares the pin directory) counts as running, since its pid names nothing here: when its pin was killed, every pin waits for it and exits 1 until the lock is removed by hand (the `rm` its message gives); `--check` exits 1 meanwhile, naming it.
- On Windows, a rename that fails because another program holds the file is retried for about 2 s. Windows itself has not been tested.
- A `.jsonl` with no new line yet is not copied; it counts as `notCopied`, and as `partial` when it holds any bytes.
- A copy missing from the pin while its source has been rewritten cannot be kept: the version its last line records is lost, and a notice says so. `--check` then reports that line at every check, and while the source is there its closing line still gives the `--rehash` command, which writes back only what the source holds.
- `--rehash` cannot clear damage in a kept copy, which is never written again, and `--check` reports the versions such a copy no longer holds at every check, with no command. A pin keeps a damaged copy that is no prefix of its source as it is, as the old copy of a rewrite, when the source has been rewritten since the version the copy's last line records; and also when recovery has recorded the copy's bytes first, which a pin without `--rehash` does for a copy whose size is not that version's, and so does a pin with `--rehash` that does not pin that copy's source (one given other paths). The current copy is then written from the source: nothing the source holds is lost.
- Under `--rehash` too, a copy that holds its version followed by bytes that a pin could have written (whole lines of a `.jsonl`, or any bytes of a file copied whole) is recorded as it is, since those bytes can be a version that only the pin holds: a pin killed between the rename of a grown copy and its line leaves one. When its source does not hold them, the pin keeps them as the old copy of a rewrite, and `PINS.log` says `rewritten` though the source may not have changed. Bytes after the version of a `.jsonl` copy that hold no new line, which no pin wrote, are never recorded by a `--rehash` that pins its source. Of a `.jsonl` copy, bytes after the version that hold a new line but do not end in one are recorded too, since what they hold up to their last new line can be such a version.

### `ltms skill`

Prints `skills/ltms/SKILL.md`, a skill in the Agent Skills format (other agents read the format too, each from its own folder) that teaches an agent the loop: list the sessions with `index`, read one session's turns with `skeleton`, `search`, then read one address, a window at a time. It names this session's own transcript, `<project folder>/$CLAUDE_CODE_SESSION_ID.jsonl`. Install it with the line under [Install](#install).

- It spells every command `npx -y long-term-memory-structure@0.2 <command>`, pinned to the minor version whose fields it names, or `ltms <command>` where `ltms --version` prints 0.2.x; never `npx ltms`, a name this package does not hold.
- Its frontmatter pre-approves, for the turn that uses it, the four commands that only read: `index`, `skeleton`, `search` and `stats`, never `pin`.
- On stderr, `ltms skill` prints the line that installs it, under `CLAUDE_CONFIG_DIR` when that is set.

## What it reads

- `skeleton` and `stats`: only the files named on the command line. `search`: the files named and every `.jsonl` file under the directories named; symbolic links met there are not followed, and a directory met there twice (the same device and inode) is read once. `index`: the same, but below a directory named it does not read the files in a session's own directory or the set-aside copies of a session (it counts them, and lists the names in a session's directory to count its agent transcripts), and does not enter a directory that holds `PINS.log` (it names it). `skill`: its own `SKILL.md`. `pin`: the files of a transcript's shape under the paths it is given (with `--from-hook`, under the project directory of the transcript the hook names), and its own pin directory; `pin --check`: the pin directory, and the files under the root: their sizes, to count what the pin is missing; of a `.jsonl` longer than its copy, the bytes past its copy's length, to see whether a whole line was added, and, when none was, its first bytes, as many as its copy holds, to see whether its copy is a prefix of it; and whether the source of a damaged copy is there, as a regular file of the cleanup's shape reached through no symbolic link (not its bytes), to give the `--rehash` command.
- Only the live path of each session: the branch it ended on, as the transcript's own `last-prompt` record names it (a file without one is read along the branch of the last record written). The path is joined across compactions, and across API-error records that Claude Code writes late, after the retry that followed the error, and a record whose parent is not in the file is joined to the record written just before it. Branches that were rewound are not shown. Calls made in parallel by one response all belong to their turn, even when their results came back out of order; a response is known by its `requestId`, or by its `message.id` in versions that wrote none, and a response whose records fall in two turns gives its calls to the first.
- Compaction, as measured on Claude Code 2.1.270, 2.1.272 and 2.1.300: the file before a `/compact` is a byte-for-byte prefix of the file after it. The compaction appends a boundary record, which starts a new root and points back to the last record before it, and then the summary. ltms follows that pointer, so the turns before and after a compaction appear in order.
- The transcript format is internal to Claude Code and changes between versions. Records of a shape ltms does not know are passed over, not treated as errors.
- A file is read into memory whole: it takes about five to eight times the file's size (up to about nine for a file packed with very small tool calls). For a file over about 200 MB, give Node more memory, for example `NODE_OPTIONS=--max-old-space-size=4096`; a file over about 500 MB cannot be read at all (JavaScript's limit on a string's length).
- A line that is not a JSON object, or that is nested more than 1,000 levels deep, is skipped and reported on stderr. A file with nothing to show (empty, a workflow journal, no conversation records, no turns) is reported too, so a zero never reads as a clean result, and so are records whose parent links loop instead of reaching the start of the session, files in one run that share an address prefix (search tells them apart by `f` and index by `path`, and neither says anything), and assistant records with neither a `requestId` nor a string `message.id` (which records form one response is then read from their parent links). An internal error is reported by its kind and the place in ltms where it happened, never by its message, which could quote the transcript.

Exit status: 0 when every file was processed, 1 when a file could not be read or processed, 2 on a usage error.

## Privacy

- ltms reads local files only, writes only to stdout and stderr, except `pin`, which writes only into its `--to` directory, makes no network connections and collects no telemetry. It has no runtime dependencies.
- `pin`'s copies are the transcripts themselves, with everything in them: keep the pin directory as private as `~/.claude`. pin makes its files `0600` (or the source's mode, when stricter) and its directories `0700`. What it prints, like every command's output, holds paths, counts, lengths and hashes, not the content.
- The output contains no prompts, replies, tool inputs or tool outputs. It does contain a few short labels derived from them: the program a shell command runs (or a shell keyword), a file's extension (or its name, when it has none), a subagent type, a skill name, a tool's name, the channel a prompt came through, the name of a hook script that blocked a call, an error class, and the lengths of prompts and results.
- A label is printed only when it looks like one: at most 64 ASCII letters, digits and `. _ : + -` (a file's name or extension: without `:`; the shell's `[` and `[[` as they are). Anything else (free text, a quoted or computed command, a value that is not a string) prints as `(withheld)`, except that a hook name that does not qualify gives a plain `hook-block`. The shell command's label is read by the whitelist in [The Bash verb](#the-bash-verb): it is printed only when it and every word before it are words bash reads exactly as written, so an argument, a quoted string or a here-document is never taken for the program. The record types named in a warning pass the same label rule.
- A hash cannot be reversed, but it can confirm a guess: whoever can guess the exact bytes of an input or a result (a short command and its description, a one-line output) can hash the guess and compare. Treat the output as derived from your transcripts.
- index's lines hold counts, addresses, paths, and each session's first and last timestamps (printed only when they are ISO 8601 times, else `(withheld)`).
- A search hit says which records hold the words asked for, so, like a hash, it can confirm a guess: whoever can guess a word learns which turn of which session holds it. search's output also holds the key names of the fields that matched, down to a tool's parameter and a system or attachment record's own keys (each by the label rule; a key below them prints `(withheld)`), the offsets of the matches, the latest timestamp of each file with a hit, the query's own words, and the paths of the files with hits.
- The library (below) returns the transcript's content: its parser returns the records themselves, with every prompt, reply, tool input and tool output in them. The rules above are the command's, applied to what it prints; none of them applies to what the parser returns. The library's search applies the label rule itself, so its results hold no transcript text but the query's own words, the key names of the fields that matched, the channel, and each file's latest timestamp, as the file holds it (unchecked); the session index's results hold no transcript text but `first` and `last`, a session's first and latest timestamps, as the file holds them (unchecked); `pin`'s functions return paths, sizes, hashes and times, while the copies they write are the transcripts themselves.

## Library

The parser `ltms` is built on is exported as a library: plain functions over a transcript's text, with no dependencies and no Node imports, so they run unchanged in Node and in a browser. The package is ESM: `require()` loads it on Node 20.19 or newer in Node 20, 22.12 or newer in Node 22, and any Node from 23 on. Its type declarations ship with it.

- `long-term-memory-structure`: the parser (`parseTranscript`, `repairedLivePath`, `turnsOf`, and the types of what they return), the search functions that `ltms search` uses, and `indexTranscript`, the part of `ltms index`'s line that comes from a transcript.
- `long-term-memory-structure/pin`: the file I/O of `ltms pin`, for Node only.
- Every path that 0.0.5 resolved, such as `long-term-memory-structure/dist/parser.js`, still resolves.

This is how `ltms` reads a transcript:

```js
import { readFileSync } from 'node:fs';
import { parseTranscript, repairedLivePath, turnsOf } from 'long-term-memory-structure';

const t = parseTranscript(readFileSync(file, 'utf8'));
const turns = turnsOf(t, repairedLivePath(t).path);   // each turn: its prompt, its records, its tool calls
```

`turnsOf(t)` without the repaired path stops at the last compaction: on a demo project's 35 transcripts it gives 201 turns, where `ltms` counts 218. Every exported function, type and field is described in [docs/library.md](https://github.com/long-term-memory-structure/long-term-memory-structure/blob/v0.2.0/docs/library.md), with its meaning, its unit, and when it is absent.

## Status

Version 0.2.0. Early: the output format may change between versions.

## Development

```sh
npm install      # TypeScript and Node type definitions, for building only
npm run build    # compiles src/ to dist/
npm test         # runs the tests in test/ against dist/
```

The package's own tests pack it with `npm pack` and install the tarball offline into a temporary project, to check every import path and the installed command; they are skipped when `npm` is not on PATH. The tests that read TypeScript (the declarations, and the member comments in `src/`) use the `typescript` package, and are skipped without it.

`LTMS_HEAVY=1 npm test` also runs two tests that write files of about 125 MB, one file at a time (the second writes nine), and need about 3 GB of memory.

The test transcripts in `test/fixtures/` are synthetic, with invented text: some hand-written, the rest written by `node test/make-fixtures.mjs test/fixtures` (the output is the same on every run).

## License

MIT
