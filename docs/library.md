# The ltms library

`ltms` is built on a parser of Claude Code transcripts, and the package exports that parser as a library: plain functions over a transcript's text that return what the transcript records (its records, the tree their parent links make, the session's live path, its turns, its API requests and its tool calls), and where each record sits in the file. The parser has no dependencies and imports nothing from Node, so it runs unchanged in Node and in a browser. It reads only the string it is given.

The package has two entry points. [`long-term-memory-structure`](#long-term-memory-structure) holds the parser and the exact search that `ltms search` runs: functions over strings, with no Node imports. [`long-term-memory-structure/pin`](#long-term-memory-structurepin) holds the file I/O of `ltms pin`, for Node only: it copies transcripts where Claude Code's cleanup does not reach them, and checks the copies.

The package is ESM. `import` it on Node 20 or newer. `require()` loads it only on a Node that loads ES modules with `require()` by default: 20.19 or newer in Node 20, 22.12 or newer in Node 22, and every version from 23 on. Its type declarations ship with it, in `dist/*.d.ts`, and TypeScript finds those of both entry points under its `node10`, `node16`, `nodenext` and `bundler` module resolutions (`node10` reads `./pin`'s through `typesVersions`; measured with TypeScript 5.7.2).

The values the parser returns hold the transcript's text, prompts, replies, tool inputs and tool outputs included; the rule that keeps them out of what `ltms` prints is the command's, not the parser's. See [What the library returns](#what-the-library-returns), which also says what the search and pin return.

## The recipe

This is how `ltms` reads a transcript (`skeletonOf` in `src/cli.ts`):

```js
import { readFileSync } from 'node:fs';
import { parseTranscript, repairedLivePath, turnsOf } from 'long-term-memory-structure';

const t = parseTranscript(readFileSync(file, 'utf8'));
for (const turn of turnsOf(t, repairedLivePath(t).path)) {
  const line = t.positions[turn.prompt.index].line;   // 1-based: the L of the address <prefix>:L<line>
  for (const call of turn.toolCalls) {
    // call.name, call.input, call.isError; call.resultBlock is undefined when no result was recorded
  }
}
```

- **Pass the repaired path to `turnsOf`.** `turnsOf(t)` alone walks `livePath(t)`, which follows the parent links up from the session's head and stops at the last compaction boundary, since a boundary starts a new root. On the 35 transcripts of a demo project (31 sessions and 4 subagent transcripts, 18.9 MB), `turnsOf(t)` gives 201 turns and the recipe gives 218, the number `ltms stats` counts. The 4 files that come up short are the 4 with a compaction.
- **An address.** A node's `index` is its 0-based position in `t.records`, and `t.positions[node.index].line` is its 1-based line in the file.
- **A bad line does not stop the file.** A line that is not a JSON object is reported in `t.problems`, with its line number and byte offset, and the rest of the file is read.

## `long-term-memory-structure`

The entry point `.` (`dist/index.js`) exports 70 symbols: the parser's 47 (12 functions, a constant and 34 types) and search's 23 (5 functions, 3 constants and 15 types). Below, in four groups: the functions; what they return; the records as Claude Code writes them, which the library returns as they are; and the search.

### The functions

#### `parseTranscript(text, opts?)`

`parseTranscript(text: string, opts?: ParseOptions): Transcript`. It splits `text` into lines on `\n` only, parses each line with `JSON.parse`, and builds the rest from the records: the tree of parent links, the API requests, the tool calls and the counts. A line that is not a JSON object, or that is nested deeper than 1,000 levels, becomes a [`LineProblem`](#lineproblem) and is skipped; nothing is thrown for it. With `opts.repairNul`, a line holding NUL bytes is tried again with them stripped. Each record is the object `JSON.parse` returned for its line; an object in it that holds its own `toString` or `valueOf` key also gets a hidden string conversion (a symbol key, which `JSON.stringify` leaves out), so that turning it into a string cannot throw.

#### `repairedLivePath(t)`

`repairedLivePath(t: Transcript)`: the session's live path, repaired where the parent links misroute it, with every repair it made. It starts from `livePath(t)` and, in this order: extends a head pointer that names a node with children to that node's last-written descendant (`extension`); continues past a record whose parent is not in the file from the record written just before it (`bridges`), and past each compaction boundary from the last record before it (`compactions`); inserts, after a late-written record (an API error written after the retry that followed it), the branch its parent links route around (`splices`); and places a detached compaction's boundary and summary where they happened (`compactions`, `via: 'detached'`). The joined path is the session's history, not the model's context: after a compaction, the model saw the summary, not what came before it.

| member | meaning | when absent, null or empty |
|---|---|---|
| `path` | the repaired live path, its first node first: the nodes the session went through, across its compactions | `[]` when `livePath` finds no head (`from` is `'none'`) |
| `from` | how the head was found, as `livePath`'s `from` | never absent |
| `bridges` | one [`Bridge`](#bridge) per record the path was continued past in file order; listed in path order (by where each bridge joins the path: its via, then its orphan), the earliest first, as `compactions` | `[]` |
| `splices` | one [`Splice`](#splice) per late-written record, in path order | `[]` |
| `extension` | the [`Extension`](#extension) made for a head pointer that named a node with children | `null` when the head has no children, or there is no head |
| `compactions` | one [`CompactionJoin`](#compactionjoin) per compaction boundary joined, the earliest first | `[]` |

#### `turnsOf(t, path?)`

`turnsOf(t: Transcript, path?: TreeNode[]): Turn[]`: the turns along `path`. Without `path` it walks `livePath(t).path`, which stops at the last compaction: pass `repairedLivePath(t).path`, as [the recipe](#the-recipe) does. A turn opens at each node whose record [`isInputTurn`](#isinputturnr) accepts, and holds the path's nodes up to the next one; the nodes before the first one are in no turn. Each tool call is in at most one turn: the first turn holding a record of the call's API request. So the calls one response made in parallel stay together even when only some of their records are on the path, and a call none of whose request's records is on the path is in no turn.

#### `livePath(t)`

`livePath(t: Transcript)`: the path that ends at the session's head, by its parent links. The head is the node `t.liveLeafUuid` names, the session's own pointer; when that names no node, the last-written node with no children is taken instead, a guess. The walk up stops where the parent links stop: at a root (each compaction boundary is one), at a record whose parent is not in the file, or at a link that loops. [`repairedLivePath`](#repairedlivepatht) continues past each of these.

| member | meaning | when absent, null or empty |
|---|---|---|
| `path` | the nodes from the first one (a root, or a node whose parent is not in the file) down to the head, inclusive | `[]` when there is no head: the file has no node, or the pointer names none and every node has a child (a parentUuid cycle) |
| `from` | `'leafUuid'`: the session's pointer named the head; `'last-leaf'`: it named no node (no `last-prompt` record, or one naming a uuid not in the file), and the last-written node with no children was taken; `'none'`: no head | never absent |

#### `pathTo(t, uuid)`

`pathTo(t: Transcript, uuid: Uuid): TreeNode[]`: the nodes from the first one above `uuid` down to `uuid`, inclusive, by parent links. `[]` when `uuid` names no node. A parent link that loops ends the walk instead of repeating it.

#### `parseLines(text, opts?)`

`parseLines(text: string, opts?: ParseOptions)`: the line parser under `parseTranscript`. It splits on `\n` only (a `\r` before it stays in the line, and `JSON.parse` reads it as white space), passes over blank lines, and parses the others.

| member | meaning | when absent, null or empty |
|---|---|---|
| `records` | every line that parsed as a JSON object, in file order, as `JSON.parse` returned it (with its NUL bytes stripped, for a line `repairNul` repaired) | `[]` when no line parsed |
| `positions` | where each record sits in the file: one [`RecordPosition`](#recordposition) per record, in the same order | `[]` with `records` |
| `problems` | one [`LineProblem`](#lineproblem) per line skipped, and per line repaired | `[]` |
| `lines` | the number of lines that are not blank, parsed or not. A blank line holds nothing but white space, as `String.prototype.trim` reads it; a line of NUL bytes is not blank | 0 for an empty text |

#### `replayMask(records)`

`replayMask(records: CCRecord[]): boolean[]`: one boolean per record, `true` for a replay: a record with the envelope ([`hasEnvelope`](#hasenveloper)) whose uuid an earlier record in the array already carries. Claude Code writes such runs of earlier records again before a manual `/compact`, from the second one in a session on. A record without the envelope is never a replay: a repeated `last-prompt` record is a head that moved.

#### `hasEnvelope(r)`

`hasEnvelope(r: any)`: `true` when `r` is an object (not an array) with a string `uuid` and a `parentUuid` key, whatever its value. The first such record with a given uuid is a node of the tree, and a later one a replay; any other record is a sidecar.

#### `blocksOf(m)`

`blocksOf(m: Message | undefined | null): ContentBlock[]`: a message's content as blocks. A string content is one `text` block; an array keeps the items that are objects (not arrays, not `null`), in order; anything else, and a missing message, gives `[]`. Read `message.content` through it: it is sometimes a bare string.

#### `isToolResultRecord(r)`

`isToolResultRecord(r: any): boolean`: `true` when `r` is a `user` record that has a `toolUseResult` key, or whose first content block is a `tool_result`. A tool's result is written as a `user` record, so only this shape tells it from a prompt.

#### `inputChannel(r)`

`inputChannel(r: any): string | undefined`: the channel a `user` record's words came through. It names the channel, not who wrote the words: a program typing into the terminal through a pty is recorded exactly as a person typing. The first test that holds decides; "the text" is the record's text blocks joined, with the white space at its start removed.

- `undefined`: not a `user` record, or a tool result (`isToolResultRecord`).
- `harness:compact-summary` (`isCompactSummary` is `true`) and `harness:meta` (`isMeta` is `true`).
- `task`: a background task's notification (`origin.kind` is `task-notification`, or the text opens with `<task-notification>`).
- `loop`: a timer-fired `/loop` command (`queueSkipAttachments` is `true` and the text holds `<command-name>/loop</command-name>`).
- `harness:queued` (any other record with `queueSkipAttachments`), `harness:command-output` (the text opens with `<local-command-stdout>` or `<local-command-stderr>`), `harness:interrupt` (the text opens with `[Request interrupted by user`).
- `parent`: a sidechain's prompt from the agent that delegated to it (`isSidechain` is `true`, or `origin.kind` is `coordinator`).
- the record's own `origin.kind`, when it is a string other than `human` (for example `peer`, another agent's message).
- `typed` or `sdk`, from `promptSource`; without it, from `entrypoint`: `cli` gives `typed`, any other string `sdk`.
- `input`: no field says.

#### `isInputTurn(r)`

`isInputTurn(r: any): boolean`: `true` when `inputChannel(r)` is a channel that does not start with `harness:`. Such a record opens a turn.

#### `NOT_A_STRING`

The constant `'(not a string)'`. The census maps of [`TranscriptStats`](#transcriptstats) count a key that is not a string (in a crafted file, an array of numbers, say) under this name instead of turning it into a string, which could pass JavaScript's limit on a string's length (a key that is missing or `null` is not counted at all); [`Splice.lateType`](#splice) gives it for a late record whose type is not a string.

### What the functions return

A member copied from a record "as written" is declared with the type Claude Code writes there, and `undefined` where a record can lack it. A crafted or damaged file can hold another JSON value there, and the library passes it on as it is: in one of the tests' crafted files, `ToolCall.id` is the number `42`.

#### `Transcript`

What `parseTranscript` returns.

| member | meaning | when absent, null or empty |
|---|---|---|
| `fileKind` | what kind of file this was: read it before `roots`, since a zero there can be the right answer. See [`FileKind`](#filekind) | never absent |
| `records` | every record that parsed, in file order, replays included: nothing is dropped | `[]` when no line parsed |
| `positions` | where each record sits in the file, one [`RecordPosition`](#recordposition) per record, in the same order | `[]` with `records` |
| `nodes` | the tree's nodes by uuid: one [`TreeNode`](#treenode) per uuid, made from the first record written with it, records with the envelope only, in the order first written | an empty `Map` when no record has the envelope |
| `roots` | the nodes whose `parentUuid` is `null`, in file order: normally the session's first record, and one more for each compaction boundary | `[]` |
| `orphans` | the nodes whose `parentUuid` names no node in this file, in file order. Across files that is expected (a subagent's transcript is a file of its own); within one file it is a finding | `[]` |
| `sidecars` | the records without the envelope (`last-prompt`, `queue-operation`, `ai-title` and the like), in file order: counted, never in the tree | `[]` |
| `problems` | one [`LineProblem`](#lineproblem) per line skipped, and per line repaired | `[]` |
| `requests` | one [`ApiRequest`](#apirequest) per API response, in the order of their first records in the file | `[]` |
| `toolCalls` | one [`ToolCall`](#toolcall) per `tool_use` block id, in the order of the records that hold them, and within one record in block order. When two blocks carry one id, the later one is kept | `[]` |
| `liveLeafUuid` | the session's head pointer: the `leafUuid` of the last `last-prompt` record whose `leafUuid` is a string (the record is written again as the head moves) | `null` when no `last-prompt` record has a string `leafUuid` |
| `stats` | counts over the file: a [`TranscriptStats`](#transcriptstats) | never absent |

#### `TranscriptStats`

Counts over one file. Except for `lines`, `parsed`, `unparseable` and the two replay counts, every count is over first copies: a replayed record is counted once.

| member | meaning | when absent, null or empty |
|---|---|---|
| `lines` | the lines that are not blank, parsed or not (as `parseLines`' `lines`) | 0 for an empty file |
| `parsed` | the records parsed, `records.length`: replays and repaired lines included | 0 |
| `unparseable` | the lines skipped: the problems that are not repairs. A problem counts unless its reason is `json` and its message holds the word `REPAIRED`. `JSON.parse`'s message quotes part of the line for some errors, so a bad line that is only that word, or opens with it, is not counted either (measured on Node 20.20.2 and 26.12.1) | 0 |
| `byType` | records by their `type`, sidecars included. A record whose `type` is missing or `null` is not counted; any other `type` that is not a string counts under [`NOT_A_STRING`](#not_a_string). The next four maps read their keys by the same rule | `{}` |
| `byBlockType` | the content blocks of `assistant` and `user` records, by their `type`, as `blocksOf` reads them: a string content counts as one `text` block | `{}` |
| `byToolName` | the `tool_use` blocks of those records, by their `name` | `{}` |
| `byAttachmentType` | the `attachment` records, by `attachment.type` | `{}` |
| `bySystemSubtype` | the `system` records, by `subtype` | `{}` |
| `versions` | records by their `version`, the version of Claude Code that wrote them. A `version` that is empty, `0`, `false` or `null` is not counted | `{}` |
| `sessionIds` | the distinct `sessionId` values, in the order first seen, sidecars included. Any value but an empty one, `0`, `false` or `null` is kept as it is written: in a crafted file, a value that is not a string | `[]` |
| `isSidechain` | `true` or `false` when every record with a boolean `isSidechain` has that value; `'mixed'` when both occur | `null` when no record has a boolean `isSidechain` |
| `agentIds` | the distinct `agentId` values, by the same rule as `sessionIds` | `[]` |
| `branchPoints` | the nodes with more than one child: parallel tool calls, retries, hook records racing a result onto one parent, rarely a rewind | 0 |
| `inputTurns` | the records that open a turn ([`isInputTurn`](#isinputturnr)), on every branch, not only the live path: every input channel (typed, sdk, input, task, loop, parent and another agent's word), none of the `harness:` ones. A `user` record without the envelope that `isInputTurn` accepts is counted too, though it is in no tree and opens no turn of `turnsOf` | 0 |
| `toolResultRecords` | the records [`isToolResultRecord`](#istoolresultrecordr) accepts | 0 |
| `firstTimestamp` | the smallest `timestamp` among the records whose `timestamp` is a string, compared as strings (which orders ISO 8601 times written in one format and one time zone). An empty `timestamp` is read in file order: it replaces the one found before it and is replaced by the next, so the value is the smallest written after the last empty one, or `''` when the last string `timestamp` is empty | `null` when no record has a string `timestamp` |
| `lastTimestamp` | the largest `timestamp` among the records whose `timestamp` is a string, compared as strings: `''` only when every one of them is empty | `null` when no record has a string `timestamp` |
| `totalContextLoad` | the sum of every request's `contextLoad`, in tokens | 0 |
| `totalOutputTokens` | the sum of every request's `outputTokens`, in tokens | 0 |
| `replayedCopies` | the records with the envelope whose uuid an earlier record already carries: replays, not events | 0 |
| `replayedDiffering` | of those, the copies whose JSON is not the same as the first copy's (the fields seen to differ: `promptId`, `toolUseResult`, `slug`, `parentUuid`); a copy too long to write as JSON counts as differing | 0 |
| `requestKeyGuessed` | the `assistant` records with neither a non-empty string `requestId` nor a non-empty string `message.id`: which records form one response was read from their parent links (see [`ApiRequest.requestId`](#apirequest)). `ltms` warns when it is not 0 | 0, in every transcript Claude Code has been seen to write |

#### `TreeNode`

A node of the tree: a record with the envelope, by its uuid.

| member | meaning | when absent, null or empty |
|---|---|---|
| `uuid` | the record's `uuid` | never absent: a node is made only for a record with a string `uuid` |
| `parentUuid` | the record's `parentUuid`, as written | `null` for a root |
| `record` | the first record written with this uuid: the same object as `t.records[index]` | never absent |
| `children` | the nodes whose `parentUuid` is this uuid, in file order | `[]` for a leaf |
| `parent` | the node `parentUuid` names | `null` for a root, and for a node whose parent is not in the file |
| `index` | the 0-based position of the record's first copy in `t.records` (and `t.positions`), not a line number: its line is `t.positions[index].line` | never absent |
| `depth` | the number of parent links between this node and the root or orphan above it. Each compaction boundary is a root, so it counts within one stretch between compactions | 0 for a root and an orphan, and for a node on a parentUuid cycle or below one, which no walk from a root reaches |
| `copies` | how many records in the file carry this uuid: 1, or more where Claude Code wrote the record again (`stats.replayedCopies`) | never absent |

#### `RecordPosition`

Where a record sits in the file, so that an index can point back at its bytes.

| member | meaning | when absent, null or empty |
|---|---|---|
| `line` | the record's line, 1-based, counting every line, blank ones too | never absent |
| `offset` | the byte offset of the line's start: the length in UTF-8 of everything before it, each `\n` included. It is the offset in the file when the file was valid UTF-8 and read as `'utf8'` (checked on a line holding a 2-byte and a 4-byte character). Where `TextEncoder` does not exist, it is counted in UTF-16 code units instead | never absent |
| `bytes` | the line's length in UTF-8 bytes, without its `\n` (a `\r` before it is counted), by the same rule | never absent |

#### `LineProblem`

A line that was skipped, or repaired, with enough to find it in the file.

| member | meaning | when absent, null or empty |
|---|---|---|
| `line` | the line's number, 1-based, as `RecordPosition.line` | never absent |
| `offset` | the byte offset of the line's start, as `RecordPosition.offset`, so that `dd` can find it | never absent |
| `bytes` | the line's length in bytes, as `RecordPosition.bytes` | never absent |
| `reason` | `json`: not JSON, or (with `repairNul`) a line whose record was recovered, which is in `records` too; `not-object`: JSON, but an array, a string, a number, a boolean or `null`; `too-deep`: nested deeper than 1,000 levels of `[` and `{` outside strings; `empty-after-strip`: with `repairNul`, NUL bytes and white space only | never absent |
| `message` | for `json`, the message of `JSON.parse`'s error (which can quote the line's text), or `REPAIRED: NUL bytes stripped, record recovered`; for `not-object`, `top-level ` and the value's `typeof`, so a line holding `null` gives `top-level object`; for `too-deep`, `nested deeper than 1000 levels`, followed by ` once its NUL bytes are stripped` when the depth was found after stripping them; for `empty-after-strip`, `line was NUL padding only` | never absent |
| `sample` | the line's first 120 UTF-16 code units, written as a JSON string: quoted and escaped, so a NUL byte shows as `\u0000`, and a character outside the Basic Multilingual Plane cut at the 120th unit leaves its first half, written as an escape such as `\ud83d` | `''` for `empty-after-strip` |
| `hasNul` | `true` when the line holds a NUL byte (U+0000), the damage seen in practice: a run of NUL bytes before an intact record | never absent |

#### `ApiRequest`

One API response: the unit a request produced, and the thing to count. Claude Code writes each of a response's content blocks as an `assistant` record of its own, so a count of records counts blocks, not responses.

| member | meaning | when absent, null or empty |
|---|---|---|
| `requestId` | the key the records of the response were grouped by: the record's `requestId` when it is a non-empty string; else `msg:` and `message.id` when that is one; else (a record with neither) the key of its parent when its parent had neither too, or `uuid:` and its own uuid, or `line:` and its 0-based position in `records` | never absent |
| `messageId` | the `message.id` of the response's first record in file order (before the ordering of `records` below) | `undefined` when that record's message has no `id` |
| `model` | the `message.model` of that first record | `undefined` when it has none |
| `effort` | the `effort` of that first record (written from CLI 2.1.212 on) | `undefined` when it has none |
| `timestamp` | the `timestamp` of that first record | `undefined` when it has none |
| `records` | every `assistant` record of the response, replays left out: ordered by `apiBlockIndex` when every one of them has a numeric one (written from CLI 2.1.258 on), else in file order | never empty |
| `blocks` | the content blocks of `records`, in that order, as `blocksOf` reads them | `[]` when the records hold none |
| `usage` | the `usage` of the last record of the response that was charged (see `contextLoad`) | `undefined` when none was: no record carries a `usage`, or its `message.id` was charged already, in another response |
| `contextLoad` | `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` of each record charged, in tokens: what the next request must carry; output is charged apart. The same usage is written on every record of one response, so each `message.id` is charged once in the whole file, and a record with no `message.id` every time. The values are added as JavaScript adds them: a count written as a string makes the sum a string | 0 |
| `outputTokens` | `output_tokens` of each record charged, the same way | 0 |
| `thinkingTokens` | `output_tokens_details.thinking_tokens` of each record charged, the same way | 0 |

#### `ToolCall`

A `tool_use` block, with whatever came back for it, from both of the transcript's recordings of a result.

| member | meaning | when absent, null or empty |
|---|---|---|
| `id` | the `tool_use` block's id, as written | `undefined` when the block has none |
| `name` | the block's `name`, the tool's name, as written | `undefined` when the block has none |
| `input` | the block's `input`: the input as the harness normalized it, which ran, and which is not always what the model emitted (a leading `cd <cwd> && ` stripped from a Bash command, `replace_all: false` filled into an Edit, escape sequences decoded) | `undefined` when the block has none |
| `wireInput` | the input as the model emitted it: the calling record's `wireToolInputs[id]` (written from CLI 2.1.267 on) | `undefined` when the record holds no copy for this id: on an older transcript, absence is the format's age, not sameness |
| `wireDiffers` | `true` when `wireInput` exists and differs from `input`, key order aside; a value too long to write out counts as differing | `false` when there is no `wireInput`: never `undefined` |
| `caller` | the block's `caller`, as written: on nearly every block of newer versions, in no release note and no doc. Declared `unknown`, since it is not a string: Claude Code 2.1.319 writes an object, `{"type":"direct"}`, on each of the 1,346 `tool_use` blocks of the demo project's 31 session files | `undefined` on blocks from older versions |
| `callNode` | the node of the `assistant` record that holds the call | never absent |
| `resultNode` | the node of the `user` record that holds the call's result: the last one in file order, when several do | `undefined` when no result was recorded in this file, or when the record holding it has no envelope |
| `resultBlock` | the `tool_result` block of that record, the flattened recording: its `content` (a string, or an array of blocks) and `is_error` | `undefined` when no result was recorded |
| `toolUseResult` | the result record's top-level `toolUseResult`, the structured recording of the same result (stdout and stderr apart, the patch of an edit, the file before it; a string in the error form). Richer than `resultBlock`; the two can disagree | `undefined` when no result record has the key; a later result record without it leaves an earlier one's |
| `isError` | `true` when the result block's `is_error` is `true`, or the result record's `toolUseResult` is a string | `false` when no result was recorded |
| `spillFileHint` | `<session>/tool-results/<id>.txt`: where a large output is kept outside the transcript, with `<session>` written as it is, for the caller to fill in with the session's directory | `''` when the id is not a string |

#### `Turn`

What `turnsOf` returns, one per input turn.

| member | meaning | when absent, null or empty |
|---|---|---|
| `prompt` | the node that opens the turn: [`isInputTurn`](#isinputturnr) accepts its record | never absent |
| `records` | the path's nodes after the prompt, up to the next prompt | `[]` when the prompt is the path's last node, or the next node opens a turn too |
| `requests` | the [`ApiRequest`](#apirequest)s that have a record among `records`, in the order met | `[]` |
| `toolCalls` | the turn's tool calls, in the order of their calling records: every call of each request this turn is the first to hold, including calls whose own records are off the path (calls made in parallel whose results came back out of order) | `[]` |

#### `FileKind`

`'transcript' | 'journal' | 'empty' | 'unknown'`, the value of `Transcript.fileKind`: `transcript` when at least one record has the envelope; otherwise `empty` when no line parsed (an empty file, blank lines only, or only lines that are not JSON objects); otherwise `journal` when every record's `type` is `launched`, `started` or `result` (a workflow's `journal.jsonl`, under `<session>/subagents/workflows/`); otherwise `unknown`. A journal parses to an empty tree, and that is the right answer, not a failure: `fileKind` says which zero it is.

#### `ParseOptions`

The options of `parseTranscript` and `parseLines`.

| member | meaning | when absent, null or empty |
|---|---|---|
| `repairNul` | `true`: a line that does not parse and holds NUL bytes is parsed again with them stripped; a recovered record stays in `problems`, reported as repaired, and a line of NUL bytes and white space only is reported as `empty-after-strip`. Off by default, because a repair made silently cannot be told from clean data. `ltms` never sets it | `false` when absent |

#### `Bridge`

A record whose parent is not in the file, where `livePath` stopped; `repairedLivePath` continued from the record written before it. (The harness's record "The previous response failed to produce a valid tool call. Please retry" can name, as its parent, the response it discarded, which was never written.)

| member | meaning | when absent, null or empty |
|---|---|---|
| `orphan` | the node whose parent is not in the file | never absent |
| `via` | the node the path continues from: the nearest node written before the orphan that is not on the path already. File order stands in for the missing link, and `kind` says so | never absent |
| `missingParent` | the orphan's `parentUuid`, which no record in the file carries | never absent |
| `kind` | always `'file-order'` | never absent |

#### `Splice`

A record written late: at the end of a turn, but parented to the record before a request that failed and was retried, so that the parent links route the live path around the turn's retried branch; `repairedLivePath` inserts that branch after it. The branch is taken only when all of it was written before the late record and part of it is stamped after the late record's time.

| member | meaning | when absent, null or empty |
|---|---|---|
| `error` | the late-written record's node: an API error, a stop hook's summary, or, rarely, a user record | never absent |
| `fork` | the parent the late record and the inserted branch share | never absent |
| `branch` | the nodes inserted after `error`, its first node first: from a child of `fork` down to the last-written node below `fork`, outside `error`'s own branch, that was written before `error` | never empty |
| `kind` | always `'late-write'` | never absent |
| `lateType` | the late record's `type`, and `:` and its `subtype` when that is a non-empty string (`system:api_error`) | [`NOT_A_STRING`](#not_a_string) when the record's `type` is not a string |

#### `Extension`

A head pointer written before the session's last records: the node it names has children.

| member | meaning | when absent, null or empty |
|---|---|---|
| `leaf` | the node the head pointer names | never absent |
| `to` | the last-written node below `leaf`, where the path now ends | never absent |
| `records` | the number of nodes below `leaf`, each counted once | never absent |
| `kind` | always `'stale-head'` | never absent |

#### `CompactionJoin`

A compaction boundary the path was joined across: the model's context was replaced by a summary here.

| member | meaning | when absent, null or empty |
|---|---|---|
| `boundary` | the boundary's node: a root whose `logicalParentUuid` names a node in the file. Claude Code writes it as a `system` record of subtype `compact_boundary`; only a `detached` join requires that subtype | never absent |
| `logicalParent` | the node `logicalParentUuid` names: the last record before a full compaction; in a partial one (from the rewind menu), the record just before the prompt selected | never absent |
| `kind` | always `'compaction'` | never absent |
| `via` | the shape that carried the join: `logical-parent` (the logical parent was written before the boundary, and is not on the path yet); `preserved-head` (otherwise, as when the logical parent is the tail of the segment the compaction kept, written after the boundary: the path continues from `compactMetadata.preservedSegment.headUuid`, written before it); or `detached` (the boundary and its summary are a branch of their own, as written by CLI 2.1.295 and 2.1.300, and were placed into the path) | never absent |
| `joinedAt` | the node the path continues from before the boundary: the last-written node at or below the logical parent (for `preserved-head`, the preserved head) that was written before the boundary and is not on the path yet; for `detached`, the path node the boundary was placed after | never absent |
| `trigger` | the boundary's `compactMetadata.trigger`, as written (`manual` in every run [the compaction page](https://long-term-memory-structure.github.io/long-term-memory-structure/compaction.html) reports) | `null` when the boundary has none |
| `preTokens` | the boundary's `compactMetadata.preTokens`, as written (a `0` stays `0`): the token count before the compaction, as the compaction page reads it | `null` when the boundary has none |
| `postTokens` | the boundary's `compactMetadata.postTokens`, as written: the token count after it | `null` when the boundary has none |
| `durationMs` | the boundary's `compactMetadata.durationMs`, as written | `null` when the boundary has none |

### The records, as Claude Code writes them

The library returns each record as `JSON.parse` made it. These types describe the fields seen so far. Every vocabulary is open (`Open`), a field can be missing in a version that did not write it, and fields not named here are kept, under each record type's index signature. A field the parser reads says so; "not read" means the parser passes it through without reading it.

#### `Envelope`

The fields of every conversational record, in every version seen: the only part of a record that is safe to depend on.

| member | what it is |
|---|---|
| `uuid` | the record's id; a record with a string `uuid` and a `parentUuid` key is a node of the tree (`hasEnvelope`) |
| `parentUuid` | the uuid of the record before it; `null` on a root: the session's first record, and each compaction boundary |
| `sessionId` | the session's id; Claude Code names a session's transcript after it (counted in `stats.sessionIds`) |
| `timestamp` | the record's time, an ISO 8601 string; read for `firstTimestamp`, `lastTimestamp` and two repairs. A record can be written after records stamped later than it |
| `version` | the version of Claude Code that wrote the record (counted in `stats.versions`) |
| `cwd` | the working directory; not read |
| `gitBranch` | the git branch; not read |
| `userType` | not read |
| `entrypoint` | the entry point the record came through; `inputChannel` reads it when `promptSource` is absent: `cli` (the terminal) gives `typed`, any other string `sdk` |
| `isSidechain` | `true` on the records of a sidechain, a subagent's conversation, whose prompts `inputChannel` gives the channel `parent` (counted in `stats.isSidechain`) |
| `type` | the record's type: a [`RecordType`](#recordtype) |

#### `AssistantRecord`

One content block of a response: one response is written as several such records, which share `requestId`.

| member | what it is |
|---|---|
| `type` | `'assistant'` |
| `message` | the response's [`Message`](#message), holding this record's block |
| `requestId` | groups the blocks of one API response; absent on the oldest records |
| `effort` | added in CLI 2.1.212 |
| `apiBlockIndex` | added in CLI 2.1.258: block order WITHIN a request |
| `agentId` | counted in `stats.agentIds` |
| `attributionAgent` | undocumented; not read |
| `attributionSkill` | not read |
| `isApiErrorMessage` | not read |
| `error` | not read |
| `[k: string]` | every other field, as written (`wireToolInputs`, the inputs as the model emitted them, is read for `ToolCall.wireInput`) |

#### `UserRecord`

A prompt, a tool's result, or text the harness wrote: only its shape tells them apart (`inputChannel`, `isToolResultRecord`).

| member | what it is |
|---|---|
| `type` | `'user'` |
| `message` | the [`Message`](#message): a prompt's text, or `tool_result` blocks |
| `promptId` | user-only; assistant carries requestId instead |
| `sourceToolAssistantUUID` | on most tool results: links a result back to the calling block |
| `toolUseResult` | undocumented, present in every version seen, and richer than the `tool_result` content block: usually an object, a string in the error form (read for `ToolCall.toolUseResult` and `isError`) |
| `permissionMode` | not read |
| `promptSource` | read by `inputChannel`: `typed` or `sdk` is the prompt's channel |
| `origin` | a sibling of `message`, NOT inside it; `inputChannel` reads `origin.kind` |
| `isMeta` | `true` on text the harness wrote, which `inputChannel` gives `harness:meta` |
| `toolEndsTurn` | not read |
| `toolDenialKind` | not read |
| `agentId` | counted in `stats.agentIds` |
| `[k: string]` | every other field, as written (`isCompactSummary` and `queueSkipAttachments` are read by `inputChannel`) |

#### `AttachmentRecord`

Something the harness attached to the conversation, in the record's `attachment` object.

| member | what it is |
|---|---|
| `type` | `'attachment'` |
| `attachment` | the attachment itself |
| `attachment.type` | its kind, an open vocabulary (counted in `stats.byAttachmentType`) |
| `attachment.[k: string]` | its other fields, as written |
| `agentId` | counted in `stats.agentIds` |
| `rendered` | added in CLI 2.1.263 |
| `renderedInHumanTurn` | added in CLI 2.1.263; rare |
| `[k: string]` | every other field, as written |

#### `SystemRecord`

A record the harness wrote about the session: hook summaries, API errors, compaction boundaries and the like.

| member | what it is |
|---|---|
| `type` | `'system'` |
| `subtype` | its kind, an open vocabulary (counted in `stats.bySystemSubtype`); `compact_boundary` marks a compaction, and `api_error` and `stop_hook_summary` records can be written late (`Splice`) |
| `level` | not read |
| `hookCount` | not read |
| `hookInfos` | not read |
| `hookErrors` | not read |
| `hookAdditionalContext` | not read |
| `preventedContinuation` | not read |
| `stopReason` | not read |
| `hasOutput` | not read |
| `toolUseID` | not read |
| `[k: string]` | every other field, as written (`logicalParentUuid` and `compactMetadata`, on a compaction boundary, are read by `repairedLivePath`) |

#### `SidecarRecord`

A record with no envelope: no uuid, sometimes no timestamp, never a version. A fact about the session, not a node of the tree (`t.sidecars`).

| member | what it is |
|---|---|
| `type` | the record's type: `last-prompt` (its `leafUuid` is the session's head pointer, `liveLeafUuid`), `queue-operation`, `ai-title` and others |
| `sessionId` | the session's id (counted in `stats.sessionIds`) |
| `[k: string]` | every other field, as written |

#### `CCRecord`

`AssistantRecord | UserRecord | AttachmentRecord | SystemRecord | SidecarRecord`: any record of a transcript.

#### `Message`

`message.content` is usually an array of blocks and sometimes a bare string: read it through [`blocksOf`](#blocksofm).

| member | what it is |
|---|---|
| `id` | the response's id, shared by its records: the grouping key where `requestId` is absent, and the key that usage is charged once by |
| `role` | `assistant` or `user`; not read |
| `model` | the model that wrote the response (read for `ApiRequest.model`) |
| `content` | the blocks, or a bare string |
| `usage` | the response's token counts, a [`Usage`](#usage), repeated on each of its records |
| `stop_reason` | not read |
| `[k: string]` | every other field, as written |

#### `Usage`

| member | what it is |
|---|---|
| `input_tokens` | added into `ApiRequest.contextLoad` |
| `output_tokens` | added into `ApiRequest.outputTokens` |
| `cache_creation_input_tokens` | added into `ApiRequest.contextLoad` |
| `cache_read_input_tokens` | added into `ApiRequest.contextLoad` |
| `output_tokens_details` | the details of the output's count |
| `output_tokens_details.thinking_tokens` | added into `ApiRequest.thinkingTokens` |
| `output_tokens_details.[k: string]` | its other fields, as written |
| `[k: string]` | every other field, as written |

#### `ContentBlock`

`TextBlock | ThinkingBlock | RedactedBlock | ToolUseBlock | ToolResultBlock | ImageBlock`, or any other block: the vocabulary is open.

| member | what it is |
|---|---|
| `type` | the block's type: one of the six below, or another string |
| `[k: string]` | the fields of a block of another type, as written |

#### `TextBlock`

| member | what it is |
|---|---|
| `type` | `'text'` |
| `text` | the text; `inputChannel` reads a prompt's text blocks |

#### `ThinkingBlock`

| member | what it is |
|---|---|
| `type` | `'thinking'` |
| `thinking` | the thinking text; not read |
| `signature` | not read |

#### `RedactedBlock`

| member | what it is |
|---|---|
| `type` | `'redacted_thinking'` |
| `data` | not read |

#### `ToolUseBlock`

| member | what it is |
|---|---|
| `type` | `'tool_use'` |
| `id` | the call's id, which its result names (`ToolCall.id`) |
| `name` | the tool's name (`ToolCall.name`) |
| `input` | the input as the harness normalized it (`ToolCall.input`) |
| `caller` | present on nearly every tool_use block, in no release note and no doc; blocks without it come from older CLI versions (`ToolCall.caller`). Declared `unknown`: Claude Code 2.1.319 writes an object, `{"type":"direct"}` |

#### `ToolResultBlock`

| member | what it is |
|---|---|
| `type` | `'tool_result'` |
| `tool_use_id` | the id of the call it answers |
| `content` | the result: a string, or an array of blocks; not read by the parser (`ltms` hashes it) |
| `is_error` | `true` on a failed call (read for `ToolCall.isError`) |

#### `ImageBlock`

| member | what it is |
|---|---|
| `type` | `'image'` |
| `source` | the image; not read |

#### `BlockType`

`Open<'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'tool_result' | 'image'>`: the block types seen so far. No other declaration uses it.

#### `RecordType`

`Open<...>`: the 19 record types seen so far (`assistant`, `user`, `attachment`, `system`, and sidecars such as `last-prompt` and `queue-operation`, and the `launched`, `started` and `result` records of a workflow's journal). The next release can add one.

#### `Open`

`Open<T> = T | (string & {})`: a type that names the values seen so far and still accepts the one that arrives next release. Every vocabulary in this format is open.

#### `Uuid`

`string`: a record's id.

### Search

The exact search `ltms search` runs, as functions over strings: no Node imports, like the parser. It reads a transcript
as the recipe does (`parseTranscript`, `repairedLivePath`, `turnsOf`), so a turn holds exactly the records `ltms skeleton`
shows for it. The search reads the transcript's text, and what it returns points into it by key path and offset; the
values it returns hold no transcript text except the query's own terms, the field keys and channel that pass the
label rule, and `last`: the latest timestamp, as the transcript holds it, unchecked (`ltms` prints it only when it is an
ISO 8601 time).

```js
import { readFileSync } from 'node:fs';
import { parseTranscript, parseSearchQuery, searchTranscript } from 'long-term-memory-structure';

const t = parseTranscript(readFileSync(file, 'utf8'));
const r = searchTranscript(t, parseSearchQuery('"npm test" failed'), { prefix: 'demo.jso' });
for (const hit of r.turns) for (const e of hit.entries) {
  // e.a is <prefix>:L<line>; the match starts at e.at in the string at key path e.field of that line's record
}
```

#### `searchTranscript(input, query, options?)`

`searchTranscript(input: string | Transcript, query: SearchQuery, options?: SearchOptions): SearchResult`. `input` is the
file's text, or the `Transcript` `parseTranscript` made of it (the same result; passing the Transcript saves a second
parse). A turn's records are its prompt, its live-path records up to the next prompt, and the call and result records of
every call `turnsOf(t, repairedLivePath(t).path)` gives it, wherever they sit; a path record that is the call or the
result of a call given to another turn is that turn's; the path records before the first prompt are T001's (in a file
with no input turn they are counted as `beforeFirstTurn`). A turn matches when its records, in the kinds searched, hold
every term between them. Each record's text is read by kind ([`SearchKind`](#searchkind)); a string that holds JSON
escapes is read as written and with them decoded, escape by escape (a word in either form, a phrase within one). A
query with no terms matches nothing.

#### `parseSearchQuery(query, options?)`

`parseSearchQuery(query: string, options?: SearchQueryOptions): SearchQuery`. Words separated by white space, ANDed. A
`"` or a U+201C where a word starts opens a phrase, which ends at the matching `"` or U+201D, or runs to the end of the
query (`unbalanced`); a quote inside a word is part of the word. Each term is read by the same function as the text: in
words mode its tokens (several make it a phrase), in substring mode `normalizeForSearch` of it. A term that reads as
nothing is dropped.

#### `tokenizeForSearch(text, options?)`

`tokenizeForSearch(text: string, options?: { segmenter?: SearchSegmenter }): SearchToken[]`: words mode's tokens. The
text is split into runs of letters, marks, digits and format characters; a run holding a letter of a spaceless script
(Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar) is split by `Intl.Segmenter` (word granularity, the runtime's default
locale) on its NFC text; each piece is normalized (NFKD, lower case, final sigma to sigma, U+200B a break, marks, the
other format characters and U+0640 removed, then NFC) and split again into runs of letters and digits, and between two
adjacent letters whose Script values differ (Common and Inherited join either side).

| member | meaning | when absent, null or empty |
|---|---|---|
| `options.segmenter` | `icu` splits spaceless runs into dictionary words; `no-dictionary` leaves them whole | absent: what `checkSearchSupport()` found |

#### `normalizeForSearch(text)`

`normalizeForSearch(text: string): string`: the text as `--substring` reads it: its runs normalized as
`tokenizeForSearch` normalizes a piece, with no Segmenter and no script split, the runs of letters and digits joined by
one space (so every run of anything else is one space, and none is at either end). `''` when the text holds no letter or
digit.

#### `checkSearchSupport()`

`checkSearchSupport(): SearchSupport`: whether this runtime can run the search, and how it splits spaceless scripts.
Computed once, then returned again.

#### `SEARCH_KINDS`

Every [`SearchKind`](#searchkind), in the table's order: `input`, `summary`, `reply`, `thinking`, `call`, `result`,
`system`, `meta`, `attachment`. A record's entries in a hit, and `hits.byKind`, follow this order. Frozen.

#### `SEARCH_DEFAULT_KINDS`

The kinds searched when `options.kinds` is absent: every kind but `meta` and `attachment`, which hold the harness's own
text (the system prompt snapshot, skill listings, reminders). Frozen.

#### `SEARCH_GAP_SCRIPTS`

The scripts with a known gap, by their Unicode Script name, each with its gap: `clitics` (a word with an attached
prefix or particle is one token: Hebrew, Arabic, Hangul) or `spaceless` (no spaces between words: Han, Hiragana,
Katakana, Thai, Lao, Khmer, Myanmar). Frozen.

#### `SearchKind`

`'input' | 'summary' | 'reply' | 'thinking' | 'call' | 'result' | 'system' | 'meta' | 'attachment'`:
- `input`: the record that opens a turn, on any channel (`message.content`, a string or its text blocks), and the
  `prompt` of a `queued_command` attachment whose `commandMode` is `prompt` (a prompt typed while the model worked);
- `summary`: a compaction summary (`isCompactSummary`);
- `reply`: assistant text blocks, except an `isApiErrorMessage` record's, which are `system`;
- `thinking`: a thinking block's `thinking`;
- `call`: every string value of a `tool_use` block's `input`, recursively (keys are not searched);
- `result`: a `tool_result` block's text (a string, or its text blocks), and any other text of a tool-result record;
- `system`: every string value of a system record except its envelope keys, its `subtype` and its `level` (names from
  a fixed list, not text), recursively;
- `meta`: the text of every other user record: `isMeta` records, command output, interruptions;
- `attachment`: every string value of an attachment record's `attachment` object, recursively; never the envelope.

An object whose `type` is `image`, met anywhere, is counted in `notSearched.images` and not read.

#### `SearchMode`

`'words' | 'substring'`: `words`, a term matches a field holding its tokens (a phrase: its tokens adjacent and in order
within one field and one form); `substring`, a term matches a field whose `normalizeForSearch` reading holds it as a
substring (so `cat` finds `concatenate`).

#### `SearchSegmenter`

`'icu' | 'no-dictionary'`: `icu`, spaceless runs are split into the Segmenter's dictionary words; `no-dictionary`, they
stay whole.

#### `SearchToken`

| member | meaning | when absent, null or empty |
|---|---|---|
| `token` | the token, normalized | never empty |
| `at` | the UTF-16 offset, in the string read, of the first character the token came from (a character NFKD splits, such as U+00BD, can end one token and begin the next, both at its offset) | never absent |

#### `SearchTerm`

| member | meaning | when absent, null or empty |
|---|---|---|
| `text` | the term as typed, without a phrase's quotes | never empty |
| `quoted` | true when the term was written between quotes | never absent |
| `tokens` | words mode: the term's tokens; substring mode: one string, the term read by `normalizeForSearch` (trimmed) | never empty: a term that reads as nothing is dropped |
| `phrase` | true when the term is matched as a phrase: quoted, or of several tokens (in substring mode, holding a space) | never absent |
| `gapScripts` | the scripts of `SEARCH_GAP_SCRIPTS` the term holds letters of, in that list's order | `[]` |

#### `SearchQuery`

| member | meaning | when absent, null or empty |
|---|---|---|
| `terms` | the terms kept, in the order typed; a hit's `w` indexes this list | `[]` when every term read as nothing |
| `dropped` | the terms that read as nothing, as typed, in the order typed | `[]` |
| `unbalanced` | true when a phrase's opening quote has no closing one, so the phrase ran to the end of the query | never absent |
| `mode` | the [`SearchMode`](#searchmode) the terms were read in | never absent |
| `segmenter` | the [`SearchSegmenter`](#searchsegmenter) the terms were read with; the text is read with the same | never absent |
| `gapScripts` | the scripts of `SEARCH_GAP_SCRIPTS` the kept terms hold letters of, in that list's order | `[]` |

#### `SearchQueryOptions`

| member | meaning | when absent, null or empty |
|---|---|---|
| `mode` | how the terms are read | absent: `words` |
| `segmenter` | how spaceless runs are split | absent: what `checkSearchSupport()` found (`no-dictionary` when it found nothing usable) |

#### `SearchOptions`

| member | meaning | when absent, null or empty |
|---|---|---|
| `kinds` | the kinds searched | absent: `SEARCH_DEFAULT_KINDS` |
| `prefix` | the address prefix of `a` and `ta` (`ltms` passes the file name's first 8 characters, or `agent-` and 8) | absent or empty: addresses are `L<n>` and `T<nnn>` |

#### `SearchResult`

| member | meaning | when absent, null or empty |
|---|---|---|
| `turns` | the matching turns, one [`SearchTurnHit`](#searchturnhit) each, in path order | `[]` |
| `counts` | the file's [`SearchCounts`](#searchcounts) | never absent |
| `last` | the file's latest timestamp (`stats.lastTimestamp`: the greatest string `timestamp` of any record but a replay), as the transcript holds it: any string, unchecked | `null` when no record has a string timestamp |
| `fileKind` | the parser's [`FileKind`](#filekind) | never absent |

#### `SearchTurnHit`

| member | meaning | when absent, null or empty |
|---|---|---|
| `ta` | the turn's id, as `ltms skeleton` numbers it: `<prefix>:T<nnn>` | never absent |
| `ch` | the turn's channel, as `ltms skeleton` prints it (the label rule applied: `(withheld)` for one that does not pass, `none` for an empty one) | never absent |
| `entries` | one [`SearchEntry`](#searchentry) per record and kind holding a term: by line, then by kind in `SEARCH_KINDS` order | never empty |

#### `SearchEntry`

| member | meaning | when absent, null or empty |
|---|---|---|
| `a` | the record's address, `<prefix>:L<line>` (its 1-based line in the file) | never absent |
| `kind` | the [`SearchKind`](#searchkind) of the text | never absent |
| `field` | the key path, from the record, of the first field of this kind (content order, then key order) holding a term: key names and array indices. Keys are named down to a tool's parameter (the first level of its `input`), a system record's own keys and an attachment object's own keys, each passing the label rule (else `(withheld)`); a key below them is data a tool or the model wrote, and is `(withheld)` | never empty |
| `at` | the UTF-16 offset, in that field's string as written, of its earliest match; a match in the escape-decoded form is given at the offset of the escape or character it came from | never absent |
| `w` | the indices into `SearchQuery.terms` of the terms found in any field of this kind in this record, ascending | never empty |

#### `SearchCounts`

One file's counts. `parsed` = `searched` + `notSearched.offPath` + `notSearched.replays` + `notSearched.beforeFirstTurn` +
`notSearched.sidecars` + `notSearched.kindsOff`, in every file.

| member | meaning | when absent, null or empty |
|---|---|---|
| `parsed` | records the parser read: the lines that are JSON objects | `0` for an empty file |
| `turns` | the file's input turns: `ltms skeleton`'s turns | `0` |
| `searched` | the turn records not in `kindsOff` (a turn record holding no text at all is here: there was nothing in it to search) | `0` |
| `notSearched` | what was not searched: a [`SearchNotSearched`](#searchnotsearched) | never absent |
| `hits` | the matching turns, counted: a [`SearchHitCounts`](#searchhitcounts) | never absent |
| `gapScripts` | for each script in `SearchQuery.gapScripts`, its letters in the searched text, before normalization (a string holding escapes is counted in its decoded form) | `{}` when the query holds no letter of such a script |

#### `SearchNotSearched`

Counts of records unless named. `offPath`, `replays`, `beforeFirstTurn`, `sidecars` and `kindsOff` are the parts of
`parsed`; `toolUseResult`, `wireInputs`, `redactedThinking`, `images` and `spilled` are counted over the turn records,
whatever kinds are searched.

| member | meaning | when absent, null or empty |
|---|---|---|
| `offPath` | records in no turn: rewound branches, after the turn rule | `0` |
| `toolUseResult` | turn records carrying a `toolUseResult` (the structured copy of a result, not searched) | `0` |
| `wireInputs` | turn records carrying `wireToolInputs` (the inputs as the model wrote them, not searched) | `0` |
| `redactedThinking` | redacted thinking blocks in turn records (blocks) | `0` |
| `sidecars` | records with no envelope (`last-prompt`, `queue-operation`, `api-request` and the like) | `0` |
| `images` | images in turn records (blocks, and image objects met inside a searched value) | `0` |
| `spilled` | turn records holding a result whose text begins with `<persisted-output>` after leading white space: the output was written to a file, and only the preview in the transcript was searched | `0` |
| `replays` | later copies of a record already written (`stats.replayedCopies`) | `0` |
| `beforeFirstTurn` | the live path's records, in a file with no input turn | `0` |
| `unreadableLines` | lines that are not a JSON object, or are nested deeper than 1,000 levels (lines) | `0` |
| `kindsOff` | turn records holding text, all of it of kinds not searched | `0` |

#### `SearchHitCounts`

| member | meaning | when absent, null or empty |
|---|---|---|
| `turns` | the turns holding every term | `0` |
| `records` | the records with an entry in those turns | `0` |
| `byKind` | for each kind searched (in `SEARCH_KINDS` order), the matching turns with an entry of that kind | a `0` for each kind searched; a kind not searched has no key |

#### `SearchSupport`

| member | meaning | when absent, null or empty |
|---|---|---|
| `ok` | false when the search cannot run on this runtime; `missing` then says why | never absent |
| `segmenter` | `icu` when `Intl.Segmenter` splits a known Thai string and a known Chinese string, built from code points, into their known words; else `no-dictionary` | `null` when not `ok` |
| `missing` | what is missing: `Intl`, `unicode property escapes` or `String.prototype.normalize` | `null` when `ok` |

## `long-term-memory-structure/pin`

`import { pinPaths, checkPin, claudeConfigDir, isSweepShaped } from 'long-term-memory-structure/pin'`. Copies of Claude Code's transcripts that its cleanup does not sweep, with a log they can be checked against. This entry point reads and writes files (`node:fs`, `node:crypto`, `node:path`, `node:os`); the parser's entry point imports nothing from Node. Its results hold paths, sizes, hashes and times, never a transcript's text; `PINS.log` holds the same.

A pin directory holds `<to>/<rel>`, the newest bytes of each file (rel is its path under the root, `/`-separated), with its source's mtime; `<to>/<rel-kept>`, each older version, kept by a hard link when a file was rewritten; `<to>/PINS.log`, one JSON line per change (not named `.jsonl`, so nothing reads it as a transcript); and `<to>/.ltms-pin.lock` while a pin runs. Files are written with mode 0600 (or the source's, when stricter), directories with 0700.

### The functions

#### `pinPaths(paths, options)`

`pinPaths(paths: readonly string[], options: PinOptions): Promise<PinResult>`: copies the files of the cleanup sweep's own shape, under the given paths, into `options.to`, and appends one line per change to `<to>/PINS.log`. It resolves to a [`PinRefusal`](#pinrefusal) (nothing read or written), a [`PinBusy`](#pinbusy) (the lock stayed held for the whole wait) or a [`PinDone`](#pindone). What it pins, under each project directory (a directory directly under the root): `<name>.jsonl`, `<name>.jsonl.superseded-*` (Claude Code's own set-aside copies), and every file under `<dir>/subagents/`, `<dir>/tool-results/`, `<dir>/workflows/` and `<dir>/mcp-tasks/` of a session directory, one whose name is a UUID (in either case) or whose name plus `.jsonl` names a file beside it. A given `<sid>.jsonl` pins its `<sid>/` the same way. Any other file under a given path is counted, not copied. A path given is resolved against the current directory and followed when it is a symbolic link; symbolic links met under it, `memory/` directly under a project directory, and `.git` are counted and never followed. Each file is read once. A `.jsonl` is copied up to its last new line (one with no new line yet is not copied: `notCopied`), another file whole, and the copy is written from the very bytes that were hashed: to a temp file `.<name>.ltms-tmp-<pid>` in the copy's directory, with the source's mtime, fsynced, renamed over the copy, and the directory fsynced (not on win32, where a rename that fails with EPERM, EACCES or EBUSY is retried every 100 ms, up to 20 times). Before pinning, under the lock, it removes the temp files of a pin that did not finish, closes a log line cut short, and adds a `recovered` line for each file of the pin's shape that no line names, and for each copy that holds other bytes than its last line records among those it reads: a copy whose size is not the one its last line records, or beside which a kept copy of that version waits that no line names. A copy changed in place at the same size is read only with `rehash`, which writes it again from its source when that source still holds the version its last line records. With `rehash`, a copy that no longer holds that version at its start, beside which no kept copy waits, gets no `recovered` line when its source, among those this run pins, still holds the version at its start (as whole lines, for a `.jsonl`): the run writes it again from that source (a `recovered` line, or `grown` when the source has grown since), where a `recovered` line would make its bytes a version, against which the source reads as rewritten, and the run would keep them as the old copy. A copy that still holds the version at its start is recorded as before: past the version it can hold one that only the pin holds (a pin stopped between the rename of a grown copy and its line). A copy is never written through a symbolic link inside `to` (a failure, `symlink-in-pin`). `PINS.log`, the lock and a kept copy's name are read and appended to only as regular files: one that is a symbolic link, a FIFO or anything else is never read or written through, nor waited on (before the lock, `PINS.log` is a refusal, `log-unreadable`; after it, each is a failure, `not-a-regular-file`); the open itself refuses a link (`O_NOFOLLOW`) and does not wait (`O_NONBLOCK`) where the platform defines them, so one put in place between the check and the open is refused too. A `PINS.log` with another name (a hard link, which neither `lstat` nor `O_NOFOLLOW` sees: its link count, from the file read, is above 1) is refused before the lock too, `log-unreadable`. An error of one file is a failure in the result, and the run goes on; an error thrown by `onStep`, or a bug, is thrown on after the lock is removed. Its listeners for SIGINT, SIGTERM and SIGHUP are there from before it takes the lock until after it has removed it, so a signal never finds the lock without them: the signal stops it between two files, or ends its wait for the lock; it removes the lock and, when nothing else listens for that signal, raises it again, so the process ends by it.

#### `checkPin(dir, options?)`

`checkPin(dir: string, options?: PinCheckOptions): Promise<PinCheckResult>`: reads a pin back against its log, and its sources against the pin, and writes nothing. Each file line is checked against the copy that holds its version: the current file, or, when a later line for that rel names a kept copy, the first such kept copy. Each copy is read once, its sha256 taken at each logged length with `Hash.copy()`; the newest version a copy holds must be the whole copy. Each line's chain is checked against the bytes of the line before it. The staleness walks the root (the one given, else the one PINS.log records) with the selection `pinPaths` uses; of a `.jsonl` larger than its copy, it reads the bytes past the copy's length up to the first new line, and, when there is none, hashes its first bytes, as many as the copy holds, against the copy (`unfinished` or `longer`). A copy, `PINS.log` or the lock that is not a regular file is never read through or waited on: a copy is then read as missing, `PINS.log` is the refusal `not-a-pin`, and the lock gets a notice. A `PINS.log` with another name (`logNames`, its link count from the file read, above 1), which `pinPaths` refuses, gets a notice too. Before it reads anything, a lock held by a running pin is waited for, as `pinPaths` waits for one: a file that pin is writing would read as damage. It resolves to a [`PinRefusal`](#pinrefusal) (`not-a-pin`), a [`PinBusy`](#pinbusy) (the lock stayed held for the whole wait) or a [`PinCheckDone`](#pincheckdone).

#### `claudeConfigDir()`

`claudeConfigDir(): { path: string; fromEnv: boolean }`: Claude Code's config directory, as Claude Code reads it, read again at each call: `$CLAUDE_CONFIG_DIR`, or `<home>/.claude` (`os.homedir()`) when that is unset or empty. `pinPaths` uses it when `configDir` is absent, and `ltms pin` and `ltms search` use it: the rule is written once.

| member | meaning | when absent, null or empty |
|---|---|---|
| `path` | the directory: the variable's value as it is, or `<home>/.claude` | never empty |
| `fromEnv` | `true` when `$CLAUDE_CONFIG_DIR` gave it | `false` when the variable is unset or empty |

#### `isSweepShaped(root, rel)`

`isSweepShaped(root: string, rel: string): boolean`: whether `rel`, a path under `root` (`/`-separated), is of the cleanup sweep's own shape, which `pinPaths` copies: `<project>/<name>.jsonl`, `<project>/<name>.jsonl.superseded-*`, or a file under `subagents/`, `tool-results/`, `workflows/` or `mcp-tasks/` of a session directory `<project>/<dir>/`, one whose name is a UUID (in either case) or whose name plus `.jsonl` is a regular file beside it under `root` (`lstat`). Nothing else is looked at: not whether the file `rel` names is there, nor what it is. The rule is written once: `pinPaths` and `checkPin` select by it, and `ltms pin --check` asks it before it gives the `--rehash` command, which it gives only for a source a pin copies.

### What the functions take

#### `PinOptions`

The options of `pinPaths`. Relative paths resolve against the current directory.

| member | meaning | when absent, null or empty |
|---|---|---|
| `to` | the pin directory; made, with any missing parent, with mode 0700. One that exists must be a directory (`to-not-a-directory`), and one without `PINS.log` must hold nothing but a pin's own lock and temp files (`to-holds-files`) | refused (`no-to`) when absent or empty |
| `root` | the directory rels are measured from; every given path must be inside it | `<configDir>/projects` |
| `configDir` | Claude Code's config directory, which `to` may not be inside | `claudeConfigDir().path`: `$CLAUDE_CONFIG_DIR`, or `<home>/.claude` when that is unset or empty (as Claude Code reads it) |
| `rehash` | `true`: every file is read and hashed, even one whose size and mtime equal its last line; and each copy whose source still holds the version its last line records is read, and written again from that source (with a `recovered` line) when it holds other bytes | `false` |
| `lockWaitMs` | how long to wait for a lock held by a running pin, in ms | 30000; a value that is not a number of at least 0 counts as absent |
| `platform` | the platform whose rules apply: on `darwin` and `win32` paths are compared without case; on `win32` a rename that fails with EPERM, EACCES or EBUSY is retried, and no directory is fsynced | `process.platform` |
| `onStep` | called at each step of each file's write, with the [`PinStep`](#pinstep) and the rel; the tests use it to stop a pin at a chosen step. An error it throws is thrown on | not called |

#### `PinCheckOptions`

The options of `checkPin`.

| member | meaning | when absent, null or empty |
|---|---|---|
| `root` | the root to measure the staleness against | the root PINS.log's first line records; with neither, `staleness` is `null` |
| `lockWaitMs` | how long to wait for a lock held by a running pin before checking, in ms | 30000; a value that is not a number of at least 0 counts as absent |
| `platform` | as in [`PinOptions`](#pinoptions) | `process.platform` |

#### `PinStep`

`'stat' | 'linked' | 'temp-written' | 'renamed' | 'logged' | 'rename-retry'`, in the order of one file's write: `stat` after the source's lstat and before its read; `linked` after an old copy was kept (a rewrite only); `temp-written` after the temp file was written, given its mtime, fsynced and closed; `renamed` after the rename over the copy and the directory's fsync; `logged` after its line was appended and fsynced. `rename-retry` comes before each retry of a rename on win32.

### What the functions return

#### `PinResult`

`PinRefusal | PinBusy | PinDone`, the value of `pinPaths`, told apart by `k`.

#### `PinCheckResult`

`PinRefusal | PinBusy | PinCheckDone`, the value of `checkPin`, told apart by `k`.

#### `PinRefusal`

Nothing was read or written.

| member | meaning | when absent, null or empty |
|---|---|---|
| `k` | `'refused'` | never absent |
| `reason` | the [`PinRefusalReason`](#pinrefusalreason) | never absent |
| `message` | one sentence saying why, echoing each path as it was given, with its real path after it when that differs (a symbolic link on the way). It names no command: a caller adds its own next step | never empty |
| `recordedRoot` | on `root-differs`: the root PINS.log's first line records, as `pinPaths` read it, so a caller's next step can name it without reading the log again | `undefined` on the other reasons |

#### `PinRefusalReason`

`'no-to' | 'no-paths' | 'to-inside-config' | 'to-inside-path' | 'to-inside-root' | 'path-inside-to' | 'path-outside-root' | 'to-not-a-directory' | 'root-differs' | 'log-unreadable' | 'to-holds-files' | 'not-a-pin'`. `pinPaths` checks them in this order and reports the first: no `to`; no paths; `to` is Claude Code's config directory or inside it ("which its cleanup manages"); `to` is a given path or inside one; `to` is the root or inside it; a given path is inside `to`; a given path is outside the root; `to` exists and is not a directory (a file, a symbolic link that leads to nothing, a socket, a FIFO or a device); then `<to>/PINS.log`, when there is one: `log-unreadable` when it is a symbolic link or not a regular file (it is never read through, nor waited on), has another name (a hard link, under which every line appended later could be read), cannot be read, is empty, or does not open with its root line, and `root-differs` when the root it records is not this root; when there is none, `to-holds-files` when `to` holds anything but a pin's own lock and temp files (a pin stopped before it made its log leaves those). `not-a-pin` is `checkPin`'s: the directory holds no PINS.log that can be read. Every test is made on real paths: a path that does not exist yet is measured by the real path of its nearest existing ancestor. A is inside B when `path.relative(B, A)` is `''`, or its first segment is not `..` and it is not absolute (so a child named `..x` is inside, and a sibling that shares B's name as a prefix is not); on darwin and win32 the paths are compared without case.

#### `PinBusy`

The lock was held for the whole wait, by a pin that runs or one that cannot be seen to have stopped. `pinPaths` and `checkPin` both wait.

| member | meaning | when absent, null or empty |
|---|---|---|
| `k` | `'busy'` | never absent |
| `lock` | the lock file's path, `<to>/.ltms-pin.lock` | never absent |
| `holder` | the [`PinLockHolder`](#pinlockholder) the lock names | `null` when the lock cannot be read as one (it is then treated as held) |
| `otherHost` | `true` when the holder's host is not this one: whether that process runs cannot be seen from here, so it counts as running | `false` when `holder` is `null` |
| `waitedMs` | how long the pin waited, in ms | never absent |
| `message` | the holder's pid, host and start time, and the command that removes the lock: `rm '<lock>'` | never empty |

#### `PinDone`

A pin that ran.

| member | meaning | when absent, null or empty |
|---|---|---|
| `k` | `'pinned'` | never absent |
| `coverage` | the [`PinCoverage`](#pincoverage) | never absent |
| `failures` | one [`PinFailure`](#pinfailure) per file or directory that could not be read or written | `[]` |
| `lines` | every line this run appended to PINS.log, in order, each equal to the line as it parses: the root line when the log was made; a `recovered` line for a log line cut short; a `takeover` line; recovery's `recovered` lines for files; then one line per file written, in rel order (a file found holding other bytes than its line records gets a `recovered` line just before its own) | `[]` when nothing changed |
| `takeover` | the lock this run took over: its pid no longer ran on this host (`process.kill(pid, 0)` gave ESRCH), or it was this process's pid and this process had not taken it. PINS.log has a `takeover` line for it | `null` |
| `removedTemps` | the temp files of a pin that did not finish, removed before pinning | 0 |
| `notices` | sentences about what this run found and did besides pinning: a pin directory open to other users (its mode, and the `chmod` command), a takeover, temp files removed, a log line closed, recovered lines, copies written again (missing, or with `rehash` holding other bytes), versions lost (a copy missing while its source was rewritten), log lines that are not log lines, a stop by a signal, a log that could not be written | `[]` |
| `interrupted` | the signal (`SIGINT`, `SIGTERM` or `SIGHUP`) that stopped the run between two files, or during its wait for the lock; every file pinned before it is whole and logged. When nothing else listens for that signal, the process is ended by it, and the promise never settles | `null` |

#### `PinCoverage`

One run's counts: `files.seen` = `new` + `grown` + `rewritten` + `unchanged` + `notCopied` + `failed`.

| member | meaning | when absent, null or empty |
|---|---|---|
| `root` | the root's real path | never absent |
| `to` | the pin directory's real path | never absent |
| `files` | the files decided, by what happened to their copy | never absent |
| `files.seen` | the files of the sweep's shape under the given paths: the sum of the six below | 0 |
| `files.new` | copied for the first time | 0 |
| `files.grown` | the copy was a byte prefix of the file's new bytes, and was replaced by them | 0 |
| `files.rewritten` | the new bytes do not begin with the copy's: the old copy was kept, then replaced | 0 |
| `files.unchanged` | the copy already held the file's bytes: by the fast path (size and mtime equal to its last line, the copy in place: not read), or read and hashed. Also a copy written again from its unchanged source (with a `recovered` line): missing from the pin, or, with `rehash`, holding other bytes | 0 |
| `files.notCopied` | `.jsonl` files with no new line yet (empty, or their first line still being written): nothing whole to pin, so nothing is written | 0 |
| `files.failed` | the source files that could not be read, kept or written (failures with op `read`, `keep` or `write`), one each | 0 |
| `failures` | every failure of the run, the length of `failures`: `files.failed` of them are source files, the others the pin directory (`to`), its lock or its log, a given path or a directory under it (`walk`), or a file of the pin that recovery could not read or remove (`recover`), which are not counted in `files` | 0 |
| `partial` | `.jsonl` files whose bytes run past their last new line (or that have no new line yet): those bytes are left for a later pin. They are counted in `files` too. A file passed by the fast path ends where its last line says, at a new line, so it is never partial | 0 |
| `skipped` | what was found under the given paths and not copied | never absent |
| `skipped.notSessionShaped` | files not of the sweep's shape (our own `raw/` is passed over this way), and sockets, FIFOs and devices, which are never opened | 0 |
| `skipped.symlinks` | symbolic links met under the given paths, a given `<sid>.jsonl`'s `<sid>/` included; not followed | 0 |
| `skipped.memory` | `memory/` directories directly under a project directory; not entered | 0 |
| `skipped.git` | `.git` directories, at any depth; not entered | 0 |
| `bytesCopied` | the bytes written into copies (a kept copy is a link, and adds nothing) | 0 |
| `keptSourceGone` | pinned files under the given paths (a given `<sid>.jsonl` covers its `<sid>/`) whose source is gone: not found by this run's walk, and `lstat` gives ENOENT or ENOTDIR. What only the pin keeps. Kept copies are not counted; a source that cannot be looked at (EACCES) is not gone | 0 |
| `lastLog` | the `t` of PINS.log's last line after the run | `null` when no log could be read or made |
| `ms` | how long the run took, in ms | never absent |

#### `PinFailure`

A file or directory that could not be read or written. The run goes on, except after a failure to write PINS.log, where it stops.

| member | meaning | when absent, null or empty |
|---|---|---|
| `path` | the absolute path: the source (`read`), the copy (`write`, and `keep` when the copy cannot be read), the kept copy (`keep`), a directory under a given path, or a given path made absolute with `path.resolve` (`walk`), the pin's own file (`recover`), PINS.log (`log`), the lock (`lock`), or `to` (`to`) | never absent |
| `rel` | its rel | `null` for `to`, `lock`, `log`, and a temp file `recover` could not remove |
| `op` | the [`PinFailureOp`](#pinfailureop) | never absent |
| `code` | the error's code (`ENOENT`, `EACCES`, ...), or ltms's own: `kept-copy-differs` (the name the old copy is kept by already holds other bytes, so the copy is left as it was), `symlink-in-pin` (a directory between `to` and the copy is a symbolic link: pin does not write through it, so every copy stays where the pin's own scan finds it; checked before each write), `not-a-file` (the path stopped being a regular file after the walk), `not-a-regular-file` (`PINS.log`, the lock, a kept copy's name or a copy is a symbolic link, a FIFO or anything else but a regular file: pin neither reads nor writes through it, nor waits on it), `ERR_FS_FILE_TOO_LARGE` (the file cannot be held in one Buffer) | never absent |

#### `PinFailureOp`

`'to' | 'lock' | 'log' | 'walk' | 'read' | 'keep' | 'write' | 'recover'`: making the pin directory; taking the lock; reading or appending PINS.log; looking at a given path or listing a directory under it; reading a source; keeping an old copy; the temp file, the rename or the directory's fsync; reading a file of the pin, or removing a temp file, during recovery.

#### `PinLockHolder`

What `<to>/.ltms-pin.lock` holds, as JSON. The lock is written whole into a temp file and fsynced before it is linked to its name, so it is never seen empty.

| member | meaning | when absent, null or empty |
|---|---|---|
| `pid` | the process that holds the lock (a positive integer) | never absent |
| `host` | `os.hostname()` of that process | never absent |
| `started` | when it took the lock (ISO) | never absent |

#### `PinVersion`

One version of a file.

| member | meaning | when absent, null or empty |
|---|---|---|
| `bytes` | its length in bytes | never absent |
| `sha256` | the sha256 of those bytes, 64 lower-case hex characters | never absent |

#### `PinHow`

`'new' | 'grown' | 'rewritten' | 'recovered'`, what a file's line in PINS.log says happened: `new`, its first copy; `grown`, the old copy was a byte prefix of the new bytes; `rewritten`, anything else, the old copy kept first when it is in the pin (a copy missing from the pin cannot be kept: its version is lost, and a notice says so); `recovered`, a line that makes the log say what the pin holds: a copy that held other bytes than its last line records (a pin that stopped between a rename and its line), a file of the pin's shape no line named, a copy written again from its source, which still holds the version its last line records (the copy was missing, or, with `rehash`, held other bytes). A `recovered` line with `torn` names a log line cut short.

#### `PinLogLine`

One line of PINS.log. The first line is the root line; then file lines (`new`, `grown`, `rewritten`, `recovered`), `takeover` lines, and `recovered` lines for a cut line. A member a line does not have is absent from its JSON, never `null`.

| member | meaning | when absent, null or empty |
|---|---|---|
| `t` | when the line was written (ISO, to the ms) | never absent |
| `how` | `'root'`, `'takeover'`, or a [`PinHow`](#pinhow) | never absent |
| `rel` | a file's line: its path under the root, `/`-separated on every platform | absent on the other lines |
| `bytes` | a file's line: the length of the version it records (for a `.jsonl`, up to and including its last new line) | absent on the other lines |
| `sha256` | a file's line: the sha256 of that version | absent on the other lines |
| `prev` | a file's line: the version the log recorded last for that rel when this line was written | `null` on `new`, and on a `recovered` line for a file no line named; absent on the other lines |
| `kept` | on `rewritten`: the rel the old copy was kept by: `<stem>.superseded-<sha12>.jsonl` beside a `.jsonl`, `<name>.superseded-<sha12>` beside another file, sha12 being the first 12 hex characters of the sha256 of the old copy's bytes on disk. On a `recovered` line after a pin stopped inside a rewrite: the kept copy that holds the version the line before recorded. `checkPin` checks a rel's earlier lines against the first later `kept` | absent when nothing was kept |
| `mtime` | a file's line: the source's mtime as `lstat` gave it just before the read, as ISO 8601 to the nanosecond (`2026-11-08T13:57:08.261123456Z`); the fast path compares it exactly. On a `recovered` line for a file found in the pin, the copy's mtime: the copy's is set from the source's as a double, within a microsecond, so that file is read again on each pin until it changes | absent on the other lines |
| `root` | the root line: the real path of the root every rel is measured from | absent on the other lines |
| `ltms` | the root line: the version in the package's `package.json` | `null` when it cannot be read; absent on the other lines |
| `lock` | a `takeover` line: the [`PinLockHolder`](#pinlockholder) taken over, as its lock held it | absent on the other lines |
| `torn` | a `recovered` line for a line cut short: which line, and its length | absent on the other lines |
| `torn.line` | the cut line's number in PINS.log, 1-based; it was closed as it was, and this line follows it | never absent in `torn` |
| `torn.bytes` | the cut line's length in bytes | never absent in `torn` |
| `chain` | the sha256 of the bytes of the line before this one, without its new line | `null` on the first line |

#### `PinCheckDone`

A check that ran.

| member | meaning | when absent, null or empty |
|---|---|---|
| `k` | `'checked'` | never absent |
| `dir` | the pin directory's real path | never absent |
| `root` | the root PINS.log's first line records | `null` when line 1 is not a root line (a notice says so) |
| `lines` | the lines of PINS.log that end in a new line | 0 for an empty log |
| `logNames` | the names PINS.log has: its link count, from the file read (`fstat`). Above 1, a hard link, `pinPaths` refuses the log (`log-unreadable`), and a notice says so, with the `find` command that names the others | 1 |
| `versions` | the file lines checked | 0 |
| `files` | the copies read, each once | 0; a copy missing or unreadable is not counted |
| `mismatches` | one [`PinMismatch`](#pinmismatch) per file line whose version is not in the copy that holds it, in line order | `[]` |
| `chainBreaks` | one [`PinChainBreak`](#pinchainbreak) per line whose chain is not the sha256 of the line before it. A line that is not a log line is not checked, but the line after it is checked against its bytes | `[]` |
| `unreadableLines` | the numbers of the lines that are not log lines, a last line cut short (with no new line yet) included. A cut line that a `recovered` line names (`torn.line`) is not counted | `[]` |
| `unlogged` | the rels of files of the pin's shape that no line names, as its `rel` or its `kept`, sorted | `[]` |
| `temps` | temp files of a pin that did not finish (`.<name>.ltms-tmp-<pid>`); the lock's temp file of a pin waiting for the lock, whose pid runs on this host, is not counted | 0 |
| `lastLog` | the `t` of the last log line | `null` when no line is a log line |
| `staleness` | the [`PinStaleness`](#pinstaleness): how far the pin is behind its sources | `null` when no root is given and PINS.log records none |
| `lock` | what `<dir>/.ltms-pin.lock` holds after the check: a pin that stopped without removing it, or one that took the lock while the check ran (a notice says so; a running pin found at the start is waited for) | `null` when there is no lock, or it cannot be read as one (a notice says so) |
| `notices` | sentences about what the check found besides the lists above: a `PINS.log` with another name, which every pin is refused at (with the `find` command that names the others), no root line, a last line cut short, a lock that is not one (or is not a regular file, which every pin fails at: with the `ls -l` command that shows what it is), a pin that took the lock while the check ran | `[]` |
| `ms` | how long the check took, in ms | never absent |

#### `PinMismatch`

A file line whose version is not in the copy that holds it.

| member | meaning | when absent, null or empty |
|---|---|---|
| `rel` | the line's rel | never absent |
| `copy` | the rel of the copy read, which holds the line's version: `rel` itself, or the kept copy the first later line for `rel` names | never absent |
| `line` | the line's number in PINS.log, 1-based | never absent |
| `want` | the [`PinVersion`](#pinversion) the line records | never absent |
| `got` | what the copy holds: its first `want.bytes` bytes; or the whole copy, when it is shorter than that, or when the line is the newest one the copy holds and the copy is longer | `null` when the copy is missing, cannot be read, or is not a regular file |

#### `PinChainBreak`

| member | meaning | when absent, null or empty |
|---|---|---|
| `line` | the line's number in PINS.log, 1-based | never absent |
| `want` | the sha256 of the bytes of the line before it | `null` for line 1, whose chain must be `null` |
| `got` | the line's own `chain` | `null` when the line's chain is `null` |

#### `PinStaleness`

How far a pin is behind its sources: what a pin that has silently stopped looks like.

| member | meaning | when absent, null or empty |
|---|---|---|
| `root` | the real path of the root walked | never absent |
| `fromLog` | `true` when no root was given, and the root is the one PINS.log records | never absent |
| `sources` | the files of the sweep's shape under the root, selected as `pinPaths` selects them | 0 |
| `missing` | of those, the ones with no file at the same rel in the pin; a `.jsonl` with no new line yet, which a pin does not copy, is not counted | 0 |
| `longer` | of those, the ones larger than their copy, by size, except those counted in `unfinished` | 0 |
| `unfinished` | of those, the `.jsonl` files larger than their copy only by a line not yet finished: the copy is a byte prefix of the file (the sha256 of the file's first bytes, as many as the copy holds, is the copy's), and the file holds no new line past the copy's length, so a pin copies nothing of it. Not counted in `longer`; a file rewritten under an unfinished line is `longer` | 0 |
| `projectsNotPinned` | project directories under the root in which no log line's rel lies | 0 |
| `failed` | directories under the root that could not be read (the root itself, when it is missing) | 0 |

## What the library returns

- **The records, with the transcript's text in them.** Every record is the object `JSON.parse` made of its line: prompts, replies, thinking, tool inputs and results, attachments and compaction summaries are all in `records`, and in what is built from them (`TreeNode.record`, `ToolCall.input`, `wireInput`, `resultBlock` and `toolUseResult`, `ApiRequest.blocks`).
- **`LineProblem.sample` and `LineProblem.message` can hold a line's text.** The sample is the line's first 120 characters, by design; the message is `JSON.parse`'s, which quotes part of the line for some errors.
- **The census keys and the ids are the file's own strings.** The keys of `stats.byToolName`, `byType` and the other census maps, `ApiRequest.requestId`, `spillFileHint`, `sessionIds` and `agentIds` are copied from the file, and a crafted or damaged file can put any text there.
- **`ltms`'s output rule is the command's.** What `ltms` prints holds no prompt, reply, tool input or tool output; its labels pass the label rule; an internal error is reported by its kind and place, never its message. All of that is done in `src/cli.ts`, on what the library returns; none of it applies to what the parser's functions return. The search is the exception: it applies the label rule itself (a copy of `src/cli.ts`'s) to the two values a hit takes from the transcript, the channel and the keys of a field's path, so its results hold no transcript text but those, the query's own terms, and `last`, the file's latest timestamp as the transcript holds it, unchecked ([Search](#search)). Pin's results hold paths, sizes, hashes and times, never a transcript's text; the copies it writes are the transcripts themselves.
- **What each entry point reads.** `long-term-memory-structure` (the parser and the search) reads only the string it is given, or the `Transcript` made of it: it opens no file, makes no network connection, has no dependencies and imports nothing from Node. `long-term-memory-structure/pin` reads and writes files, through `node:fs`, `node:crypto`, `node:path` and `node:os`, and makes no network connection either.
