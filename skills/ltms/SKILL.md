---
name: ltms
description: Find what an earlier Claude Code session did, or what this one did before a compaction, by file and line address, without loading whole transcripts (npm package long-term-memory-structure). Lists the sessions and the turns that hold given words. Use before asking the user to repeat something, or when a summary lacks a detail.
allowed-tools: Bash(npx -y long-term-memory-structure@0.2 index *) Bash(npx -y long-term-memory-structure@0.2 skeleton *) Bash(npx -y long-term-memory-structure@0.2 search *) Bash(npx -y long-term-memory-structure@0.2 stats *) Bash(ltms index *) Bash(ltms skeleton *) Bash(ltms search *) Bash(ltms stats *)
---

# ltms: list the sessions, find the turn, read the line

Claude Code writes each session to a transcript, `<session id>.jsonl`, in a project folder under
`~/.claude/projects/` (`$CLAUDE_CONFIG_DIR/projects/` when that is set). A compaction took details out of your context; the transcript keeps the records (a large tool
output only as a preview: the rest is in a file Claude Code deletes by its own age). ltms prints where things are, a
file and a line, never what they say.

Run it as `npx -y long-term-memory-structure@0.2 <command>`. Where `ltms --version` prints 0.2.x, `ltms <command>`
is the same and needs no network. The ltms commands it prints (`next`, and those in its messages) are spelled `ltms`:
where ltms is not installed, put `npx -y long-term-memory-structure@0.2` in its place. Never `npx ltms`: that name is
not this package.

## 1. List the sessions

```sh
npx -y long-term-memory-structure@0.2 index ~/.claude/projects/<project>
```

With no path, `index` prints this directory's project folder and the command to run. This session's own transcript
is `<project folder>/$CLAUDE_CODE_SESSION_ID.jsonl`.

The first line is the coverage: what was read, and what was not. Then one line per session, newest first by when it
started, 20 unless `--max` says otherwise: `first` and `last` (its first and last timestamps), `turns`, `calls`,
`failures`, `compactions` (for each, the address of its `boundary` and of the `summary` the model carried on from),
`agents` (how many agent transcripts are in its own directory, `<session id>/subagents/`; null when not known: give
that directory to `index` to list them), `firstPrompt`, `lastPrompt` and `lastReply` (addresses), and `path`.
The coverage line's `next` prints the next page. `--max 0` prints every session at once, but past about 90 lines the
Bash tool keeps only a preview: follow `next` instead.

## 2. One session's turns

```sh
npx -y long-term-memory-structure@0.2 skeleton <path>
```

One line per turn (`a`, the address of its prompt) and per tool call (`ok`; `ek`, the error class of a failed one;
`r`, the address of its result). A turn's replies are on the lines between its prompt and the next turn's prompt.

## 3. Search

```sh
npx -y long-term-memory-structure@0.2 search 'migration rollback' ~/.claude/projects/<project> --max 5
```

The query comes first, as one quoted argument; every word of it must be in the turn. The first line is the coverage.
Then, for each file with a hit, a `file` line (`f`, `path`), and one `hit` line per matching turn (its `f` is its file
line's): in `at`, each record that matched, by its address `a`, its `kind` (input, summary, reply, thinking, call,
result, system), its key path `field` and the offset `at`. Search reads the subagents' transcripts too (their prefix
is `agent-`). No hit is not proof of absence: try fewer words, `--substring`, or `--kind all` (which adds the
harness's own text, skill listings included, and so matches most sessions).

## 4. Read one address

`15b86237:L186` is line 186 of the file whose name starts with `15b86237`; the line that gave the address, or its
`file` line, holds its `path` (for `skeleton`, the path you gave it). A line can be hundreds of kilobytes, so read its text a window at a time:

```sh
node -e 'const[p,l,f=0,n=4000]=process.argv.slice(1),r=JSON.parse(fs.readFileSync(p,"utf8").split("\n")[l-1]),x=b=>typeof b=="string"?b:b?.type=="text"?b.text:b?.type=="thinking"?b.thinking:b?.type=="tool_use"?JSON.stringify(b.input):b?.type=="tool_result"?(typeof b.content=="string"?b.content:Array.isArray(b.content)?b.content.map(x).join("\n"):JSON.stringify(b.content??"")):"",c=r.message?.content,t=c===undefined?JSON.stringify(r):typeof c=="string"?c:c.map(x).join("\n");console.log(`[${r.type}, ${t.length} characters, from ${f}]`);console.log(t.slice(+f,+f+ +n))' <path> 186 0 4000
```

It prints the record's type and the length of its text, then 4000 characters of it from 0; give the next window's
start to read on. Read only the windows the task needs: a transcript holds everything that was said and run, secrets
included, and what you read enters your context.

## Rules

- On a large folder a command can run past the Bash tool's 2-minute timeout: name one project's folder, or give the
  command a longer timeout.
- Never write into `~/.claude/projects/`. Claude Code deletes transcripts after 30 days by default
  (`cleanupPeriodDays`); to keep them, the user runs `ltms pin` (`npx -y long-term-memory-structure@0.2 pin --help`).
