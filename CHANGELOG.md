# Changes

## 0.0.5

- The README has a new first section, Intent and tradeoffs: the intent of the design, its scope, and its objectives with the price of each.
- The README says that every call reads all of the context window again, where it said that every call re-sends it.
- The README says that `ok` is the status of the call as a whole: for a Bash command of several parts, the status the shell returned for the whole command (in `a; b`, that of `b`), so a part that failed before the last can read `true` (what it printed, if anything, is at the call's `r` address); and that for a command run in the background it is the status of its launch.
- Tests: the Bash verb at its limit (the program after 15 commands passed over, `(withheld)` after 16) for each separator the README names (a new line, `;`, `&&`) and each kind of command passed over (`cd DIR`, a command of assignments only); and the library's NUL repair, reachable only through its `repairNul` option, since the command does not set it (ltms skips a line holding NUL bytes and counts it on stderr).

## 0.0.4

- The name: the package is now `long-term-memory-structure`, published until 0.0.3 as `memobrain`. The command is `ltms`, and `npx long-term-memory-structure` runs it without installing. Messages on stderr start with `ltms` where they started with `memobrain` (`ltms skeleton: warning: ...`), and the usage text and `--help` name `ltms`. No output field changed. The repository is `long-term-memory-structure/long-term-memory-structure`; the test suite's variables are `LTMS_HEAVY` and `LTMS_CLI`.
- Library: a DETACHED compaction is joined. From CLI 2.1.295 the boundary and its summary are a two-node root branch, and the `/compact` command's own records (typed before the boundary, written after the summary) are parented around the pair, so the live path left both out. `repairedLivePath` now places the pair between the command and its output ("Compacted"), the order the events happened in, and reports the join in `compactions` with `via: 'detached'`. The skeleton's lines do not change: neither the boundary nor the summary is a turn or a call.

## 0.0.3

- Output changes, on crafted input only (on 2,539 real transcripts the output did not change, and neither did what the parser makes of them: the live path, its joins and repairs, requests, turns and counts):
  - a hook block names its script only where a command's script stands: the command itself, or the word right after an interpreter (`bash /x/gate.sh`), after any leading `env` and `NAME=value` words. Anywhere else the one word with a script extension may be an argument, and the class is a plain `hook-block` (`/h/guard /data/notes.py` named `notes`);
  - quotes and punctuation around a word no longer hide its script extension: a quoted hook and its argument give a plain `hook-block` (it named the argument), and a quoted hook alone is named;
  - a value that is not a string where a string belongs (a record's type, version, uuid or timestamp, a system record's subtype, an attachment's type, a block's type, a tool's name or id) is never turned into one, so it can no longer stop the file at JavaScript's limit on a string's length (eight routes in the parser did, and so did the label of a late-written record); in the library's counts such a key is `(not a string)`;
  - an assistant record with neither a `requestId` nor a string `message.id` joins the response of the record it hangs off, when that one had neither too, with a warning: a parallel call whose record is off the live path had dropped out of its turn;
  - thousands of compaction boundaries, or of records bridged in file order, are joined in linear time (20,000 boundaries took 31 seconds, and now take 0.4).
- New warnings on stderr: files in one run that share an address prefix, and records whose response was read from their parent links.
- An internal error is reported by its kind and, when it was raised in memobrain's own code, its file and line; never by its message, which could quote the transcript (a message running over several lines cannot pass a line of itself off as the place).
- Library: `stats.requestKeyGuessed` counts the assistant records whose response was read from parent links; `NOT_A_STRING` is exported; a call whose id is not a string has an empty `spillFileHint`.
- `--version` and `-v` work after a command, as `--help` does.
- The README says that Claude Code cuts a project folder's name at 200 characters.

## 0.0.2

- The README opens with why memobrain exists: compaction replaces the model's context with a summary, and the transcript on disk keeps every record.
- Output changes, on crafted input only (on 2,513 real transcripts the output did not change):
  - after `command` or `time`, a following `command` or `exec` is the shell's builtin, so the verb is the program after it (`command exec make` prints `make`; it printed `exec`);
  - `nice` with only its options after it prints `nice` (it printed `(withheld)`);
  - `time` right after the `time` keyword is the keyword again (`time time make` prints `make`);
  - a redirection right after a wrapper withholds the verb (`nohup >/dev/null make` printed `nohup`);
  - `env`'s assignments count toward the limit of 63 words before the program;
  - a hook block names its script only when exactly one word ends in a script extension, whatever the other word's characters;
  - a hook block whose bracketed command is longer than 300 characters is a `hook-block` (it was `other`);
  - a value too large to write as JSON prints `(too large)` in `in` and `out`, with a warning, where the file was dropped; three routes in the parser where such a value stopped the file are guarded too (crafted values can still stop a file through others);
  - a prompt's text block that is not a string counts as empty text;
  - the skeleton is written in chunks, so millions of call lines no longer pass JavaScript's string limit;
  - a `toString` or `valueOf` key written with escaped characters no longer stops the file.
- The README and `--help` define every value the output can hold.

## 0.0.1

- First release: `skeleton` and `stats`.
