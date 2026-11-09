export type Uuid = string;
/** Every vocabulary in this format is OPEN: new attachment types and new tool
 *  names keep arriving with new releases. `Open<T>` documents the values seen
 *  so far while still accepting the one that arrives next release. */
export type Open<T extends string> = T | (string & {});
export type RecordType = Open<'assistant' | 'user' | 'attachment' | 'system' | 'queue-operation' | 'last-prompt' | 'ai-title' | 'bridge-session' | 'atis-latch' | 'mode' | 'file-history-snapshot' | 'file-history-delta' | 'launched' | 'started' | 'result' | 'frame-link' | 'artifact-autoreact-ledger' | 'permission-mode' | 'artifact-comment-monitor'>;
/** The envelope: the keys present on every conversational record, in every
 *  version observed. This is the ONLY part of a record that is safe to
 *  depend on. */
export interface Envelope {
    uuid: Uuid;
    parentUuid: Uuid | null;
    sessionId: string;
    timestamp: string;
    version: string;
    cwd: string;
    gitBranch: string;
    userType: string;
    entrypoint: string;
    isSidechain: boolean;
    type: RecordType;
}
export type BlockType = Open<'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'tool_result' | 'image'>;
export interface TextBlock {
    type: 'text';
    text: string;
}
export interface ThinkingBlock {
    type: 'thinking';
    thinking?: string;
    signature?: string;
}
export interface RedactedBlock {
    type: 'redacted_thinking';
    data?: string;
}
/** `caller` is present on nearly every tool_use block and appears in no
 *  release note and no doc. Blocks without it come from older CLI versions.
 *  It is not a string: Claude Code 2.1.319 writes an object there, `{"type":"direct"}`. */
export interface ToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input?: Record<string, any>;
    caller?: unknown;
}
export interface ToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content?: string | any[];
    is_error?: boolean;
}
export interface ImageBlock {
    type: 'image';
    source?: any;
}
export type ContentBlock = TextBlock | ThinkingBlock | RedactedBlock | ToolUseBlock | ToolResultBlock | ImageBlock | {
    type: string;
    [k: string]: any;
};
export interface Usage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens_details?: {
        thinking_tokens?: number;
        [k: string]: any;
    };
    [k: string]: any;
}
/** `message.content` is normally an array of blocks and sometimes a BARE
 *  STRING. Anything that does `content.filter(...)` without checking crashes
 *  on those. */
export interface Message {
    id?: string;
    role?: 'assistant' | 'user' | string;
    model?: string;
    content: ContentBlock[] | string;
    usage?: Usage;
    stop_reason?: string | null;
    [k: string]: any;
}
export interface AssistantRecord extends Envelope {
    type: 'assistant';
    message: Message;
    /** groups the blocks of one API response; absent on the oldest records */
    requestId?: string;
    /** added in CLI 2.1.212 */
    effort?: string;
    /** added in CLI 2.1.258: block order WITHIN a request */
    apiBlockIndex?: number;
    agentId?: string;
    /** undocumented */
    attributionAgent?: string;
    attributionSkill?: string;
    isApiErrorMessage?: boolean;
    error?: any;
    [k: string]: any;
}
export interface UserRecord extends Envelope {
    type: 'user';
    message: Message;
    /** user-only; assistant carries requestId instead */
    promptId: string;
    /** on most tool results: links a result back to the calling block */
    sourceToolAssistantUUID?: string;
    /** Undocumented, present in every version observed, and RICHER than the
     *  tool_result content block. Usually an object; a string in the error form. */
    toolUseResult?: any;
    permissionMode?: string;
    promptSource?: string;
    /** a sibling of `message`, NOT inside it */
    origin?: any;
    isMeta?: boolean;
    toolEndsTurn?: boolean;
    toolDenialKind?: string;
    agentId?: string;
    [k: string]: any;
}
export interface AttachmentRecord extends Envelope {
    type: 'attachment';
    attachment: {
        type: Open<string>;
        [k: string]: any;
    };
    agentId?: string;
    /** added in CLI 2.1.263 */
    rendered?: any;
    /** added in CLI 2.1.263; rare */
    renderedInHumanTurn?: any;
    [k: string]: any;
}
export interface SystemRecord extends Envelope {
    type: 'system';
    subtype: Open<'stop_hook_summary' | 'api_error' | 'turn_duration' | 'model_refusal_fallback' | 'away_summary' | 'local_command'>;
    level?: string;
    hookCount?: number;
    hookInfos?: any;
    hookErrors?: any;
    hookAdditionalContext?: any;
    preventedContinuation?: boolean;
    stopReason?: string;
    hasOutput?: boolean;
    toolUseID?: string;
    [k: string]: any;
}
/** No envelope at all: no uuid, sometimes no timestamp, never a `version`.
 *  These are session-scoped facts, not conversation nodes. */
export interface SidecarRecord {
    type: RecordType;
    sessionId?: string;
    [k: string]: any;
}
export type CCRecord = AssistantRecord | UserRecord | AttachmentRecord | SystemRecord | SidecarRecord;
export interface LineProblem {
    /** 1-indexed line number as it appears in the file. */
    line: number;
    /** Byte offset of the line start, so you can go find it with `dd`. */
    offset: number;
    bytes: number;
    reason: 'json' | 'not-object' | 'empty-after-strip' | 'too-deep';
    message: string;
    /** First 120 chars, escaped: enough to recognise, short enough to print.
     *  A corruption seen in practice is a run of NUL bytes before an otherwise
     *  intact record; this makes it visible instead of silent. */
    sample: string;
    /** True when the line contains NUL bytes, the corruption signature seen in practice. */
    hasNul: boolean;
}
export interface TreeNode {
    uuid: Uuid;
    parentUuid: Uuid | null;
    record: CCRecord & Envelope;
    children: TreeNode[];
    parent: TreeNode | null;
    /** Position in the file, 0-indexed, of the FIRST copy. File order is not tree order; keep both. */
    index: number;
    depth: number;
    /** How many times this uuid was written. Normally 1; more in a session that was compacted
     *  several times, where the harness writes whole runs of earlier history again. */
    copies: number;
}
/** One API response: the unit that a single request actually produced.
 *  This, not the record, is the thing to count. */
export interface ApiRequest {
    requestId: string;
    messageId?: string;
    model?: string;
    effort?: string;
    timestamp: string | undefined;
    /** Every assistant record of this request, in `apiBlockIndex` order where the
     *  field exists (added in CLI 2.1.258), else file order. */
    records: AssistantRecord[];
    blocks: ContentBlock[];
    /** Charged ONCE. Summing the usage repeated on each record overcounts. */
    usage?: Usage;
    /** input + cache_creation + cache_read. What the NEXT turn must carry.
     *  Output is charged separately and is not part of it. */
    contextLoad: number;
    outputTokens: number;
    thinkingTokens: number;
}
/** A tool_use paired with whatever came back, from either representation. */
export interface ToolCall {
    id: string | undefined;
    name: string | undefined;
    /** The HARNESS-NORMALIZED input, which is not always what the model emitted. The emission is the record's
     *  `wireToolInputs[id]` (on records that carry it, one entry per tool_use in that record). The two often
     *  differ: a leading `cd <cwd> && ` stripped from Bash commands, `replace_all: false` filled into Edit,
     *  occasionally Write content altered. A view that shows `input` shows the harness's rewrite. Since this
     *  is what ran, it is the sensible default for a viewer, provided it MARKS the calls where the two
     *  differ so the emission stays reachable (`wireInput`, `wireDiffers`). */
    input?: Record<string, any>;
    /** The arguments as the MODEL EMITTED them (`wireToolInputs[id]` on the same record), when the record carries them.
     *  Undefined on older transcripts: the field arrived with the wire-inputs record shape, and absence is not sameness. */
    wireInput?: Record<string, any>;
    /** True iff both exist and differ (key order normalised away). Typical differences: a redundant `cd <cwd> && `
     *  stripped, `replace_all: false` filled in, and escape sequences DECODED: the wire copy holds the characters
     *  the model typed, `input` holds the character the tool received. Agent transcripts differ less often than
     *  main sessions. The wire copy arrived in CLI 2.1.267: on anything older, absence is the format's age, not
     *  sameness. */
    wireDiffers?: boolean;
    /** The tool_use block's `caller`, as written: an object in Claude Code 2.1.319 (see ToolUseBlock). */
    caller?: unknown;
    callNode: TreeNode;
    resultNode?: TreeNode;
    /** The flattened string form, from the tool_result content block. */
    resultBlock?: ToolResultBlock;
    /** The structured form. Richer. Prefer it when present, but LOOK at both:
     *  they are two recordings of one event and can disagree. */
    toolUseResult?: any;
    isError: boolean;
    /** Large outputs spill to <session>/tool-results/<id>.txt and are NOT in the
     *  JSONL. When the content looks truncated this is where the rest lives.
     *  Empty when the call's id is not a string. */
    spillFileHint: string;
}
/** There is more than one kind of .jsonl under a session directory, and only
 *  one of them is a conversation:
 *    - `transcript`: envelope-bearing records, one root each. The tree.
 *    - `journal`: <session>/subagents/workflows/wf_<id>/journal.jsonl, with
 *      ZERO envelope records: newer journals open with one `launched` record,
 *      and every other record is `started`/`result` carrying the
 *      content-addressed key `v2:<sha256>` that lets a workflow resume replay a
 *      completed agent instead of re-running it.
 *  A journal parses to an EMPTY forest, and that is the correct answer, not a
 *  failure; but a bare `roots: 0` cannot say which. Hence this field: the zero
 *  arrives with its explanation attached. */
export type FileKind = 'transcript' | 'journal' | 'empty' | 'unknown';
export interface Transcript {
    /** What kind of file this was. Read it before reading `roots`. */
    fileKind: FileKind;
    /** Every record, in file order, nothing dropped. */
    records: CCRecord[];
    /** Where each record sits in the file, parallel to `records`. */
    positions: RecordPosition[];
    /** Envelope-bearing records only, by uuid. */
    nodes: Map<Uuid, TreeNode>;
    /** parentUuid === null. Normally exactly one; each compaction boundary adds another. */
    roots: TreeNode[];
    /** parentUuid set but not present in THIS file. Expected across files (a
     *  subagent transcript is a separate file) and a real finding within one. */
    orphans: TreeNode[];
    /** No-envelope records. Counted, never in the forest. */
    sidecars: SidecarRecord[];
    problems: LineProblem[];
    requests: ApiRequest[];
    toolCalls: ToolCall[];
    /** From the LAST `last-prompt.leafUuid`. Null when no such record exists. */
    liveLeafUuid: Uuid | null;
    stats: TranscriptStats;
}
export interface TranscriptStats {
    lines: number;
    parsed: number;
    unparseable: number;
    byType: Record<string, number>;
    byBlockType: Record<string, number>;
    byToolName: Record<string, number>;
    byAttachmentType: Record<string, number>;
    bySystemSubtype: Record<string, number>;
    versions: Record<string, number>;
    sessionIds: string[];
    isSidechain: boolean | 'mixed' | null;
    agentIds: string[];
    /** Nodes with more than one child: parallel tool calls, retries, hook races, rarely a rewind. */
    branchPoints: number;
    /** Input turns: the records isInputTurn() accepts, anywhere in the file, not only on the live path: every input
     *  channel (typed, sdk, input, task, loop, parent, another agent's word; see inputChannel()); harness-written user
     *  records excluded. */
    inputTurns: number;
    toolResultRecords: number;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
    totalContextLoad: number;
    totalOutputTokens: number;
    /** Envelope records whose uuid was already written earlier in the file: REPLAYS, not events.
     *  Every count above is over first copies; `parsed` is still every line. Replays are written
     *  just before every manual /compact AFTER THE FIRST in a session: the history that earlier
     *  manual compactions summarized, written again. */
    replayedCopies: number;
    /** ...of which the bytes differ from the first copy (promptId, toolUseResult, slug, parentUuid). */
    replayedDiffering: number;
    /** Assistant records with neither a requestId nor a string message.id: which records form one response was read
     *  from their parent links (see buildRequests). 0 in every transcript Claude Code has been seen to write. */
    requestKeyGuessed: number;
}
/** The envelope test. A record is a tree node iff it has a uuid AND declares a
 *  parent slot. Both are present on every conversational record and absent on sidecars. */
export declare function hasEnvelope(r: any): r is CCRecord & Envelope;
/** Normalise `message.content`, which is normally an array and sometimes a
 *  bare string. Never call `.filter` on it without going through here. */
export declare function blocksOf(m: Message | undefined | null): ContentBlock[];
/** Trap 2. A tool result is `type:"user"`. Only the content shape separates it
 *  from a prompt. Getting this wrong makes every "turn" a tool result. */
export declare function isToolResultRecord(r: any): boolean;
/** WHICH CHANNEL a user record's words came through. Never "human": a program typing into the
 *  terminal UI through a pty is recorded with `origin.kind: "human"` and `promptSource: "typed"`,
 *  field for field identical to a person typing. The harness labels the CHANNEL, not the actor, so a
 *  decoder that says "human" asserts more than the record does. The simpler predicate
 *  (`user` and not tool_result and not isMeta) gives harness-written text a person's voice:
 *  compaction summaries and command records come out as prompts.
 *
 *  Input channels (a turn starts here): typed, sdk, parent (a sidechain's delegating agent), loop, task, input (no field says).
 *  Harness-written (`harness:<kind>`, never a turn): compact-summary, meta, queued,
 *  command-output, interrupt. No single marker covers them (some task notifications lack
 *  queueSkipAttachments; wakeup-fired `/loop` records lack `origin`), so the order below is a union of tests.
 *  `loop`: a timer-fired `/loop` command (the user's words, written once as the /loop arguments and
 *  delivered by the scheduler) OPENS a turn on its own channel; otherwise every wakeup would sit inside
 *  one long turn, although the UserPromptSubmit hook fires on each of them. The skill body injected
 *  after it stays harness:meta.
 *  Where `promptSource` is absent (command records, older versions) the channel follows the harness's own
 *  convention for that entrypoint: cli means typed, any other entrypoint means sdk. A typed `/exit` is
 *  input; its `<local-command-stdout>` is not. */
export declare function inputChannel(r: any): string | undefined;
/** A turn opens at input: any channel that is not harness-written. */
export declare function isInputTurn(r: any): boolean;
/** A census key, a type or an id that is not a string (crafted input only) is never turned into one: an array of
 *  millions of numbers would pass JavaScript's limit on a string's length and stop the file. Such a key is counted
 *  under this name instead. */
export declare const NOT_A_STRING = "(not a string)";
export interface ParseOptions {
    /** Strip NUL bytes and retry a failed line (the corruption seen in practice is a run of
     *  NUL bytes before an intact object). Default false: a repair that happens silently is
     *  indistinguishable from clean data. When true, the line STILL appears in `problems`:
     *  repaired, not hidden. */
    repairNul?: boolean;
}
/** Where a record physically sits, so an index can point back at the bytes rather
 *  than at a copy of them. Parallel to `records`, same length, same order. */
export interface RecordPosition {
    line: number;
    offset: number;
    bytes: number;
}
/** Split, parse, and REPORT. Never throws on bad input; a bad line becomes a
 *  LineProblem carrying its byte offset so the raw bytes remain reachable. */
export declare function parseLines(text: string, opts?: ParseOptions): {
    records: CCRecord[];
    positions: RecordPosition[];
    problems: LineProblem[];
    lines: number;
};
/** Parallel to `records`: true where the record is a REPLAY, an envelope record whose uuid was
 *  already written earlier in the file. Sidecars (no uuid) are never replays; a repeated
 *  `last-prompt` is a head that moved, an event of its own. */
export declare function replayMask(records: CCRecord[]): boolean[];
export declare function parseTranscript(text: string, opts?: ParseOptions): Transcript;
/** Root to node, inclusive. The path is the conversation; the tree is everything
 *  that was ever on the way there, including what was rewound past. */
export declare function pathTo(t: Transcript, uuid: Uuid): TreeNode[];
/** The conversation as it actually stood at the end.
 *  Primary: the `last-prompt.leafUuid` pointer. Fallback: the deepest leaf,
 *  stated as a fallback because it is a GUESS and the pointer is a FACT. */
export declare function livePath(t: Transcript): {
    path: TreeNode[];
    from: 'leafUuid' | 'last-leaf' | 'none';
};
/** THE LIVE PATH, REPAIRED. livePath() walks parentUuid up from the head pointer and labels the
 *  answer `from:'leafUuid'`, a FACT's provenance. Some harness behaviours make the parentUuid chain
 *  misroute while that label stays confident. This function repairs them and REPORTS every repair,
 *  by the rule `repairNul` follows: a repair that happens silently is indistinguishable from clean data.
 *
 *  (1) THE LATE-WRITTEN API ERROR: `splices`. When a request fails (ECONNRESET, for example) the
 *    harness retries and the turn goes on; only at its end is the `system:api_error` record written,
 *    parented to the pre-error tip, and the turn's closing record then chains onto the ERROR. The
 *    parentUuid tree routes the live path around the entire retried turn, so every assistant text
 *    block and tool call in it is invisible to a live-path reader. The branch that looks dead is
 *    the SUCCESSFUL continuation, not the failed attempt.
 *    Signature: the error record is written after every node of the other branch AND that branch
 *    runs past the error's own timestamp (it begins after it, or straddles it: the failing
 *    attempt's partial output with the retry chained on). The mirror case, a failed attempt wholly
 *    before a promptly written error, has not been observed; the second condition exists so that
 *    case, if it ever appears, is left alone rather than spliced.
 *    Repair: the error stays where the tree puts it, and the branch (from the fork to its
 *    last-written node) is inserted between the error and the error's descendants.
 *    The same shape occurs with `system:stop_hook_summary` and occasionally with a user record,
 *    so the splice keys on the SIGNATURE (happened before, written after all of a sibling branch
 *    that runs past it), and reports the late record's type.
 *
 *  (2) THE DISCARDED PARENT: `bridges`. The harness record "The previous response failed to produce
 *    a valid tool call. Please retry" can carry a parentUuid that names the discarded response,
 *    which was never written. livePath() stops at that orphan and loses everything before it.
 *    Repair: continue from the envelope node written immediately before the orphan (FILE ORDER:
 *    a proxy for the missing link, named as one).
 *
 *  (4) THE COMPACTION BOUNDARY: `compactions`. Each compaction writes a `system:compact_boundary`
 *    as a NEW ROOT (parentUuid null) carrying `logicalParentUuid` = the last node before it
 *    (equal to compactMetadata.preservedSegment.tailUuid), with the summary as its only child.
 *    livePath() stops at that root, so a view built on it opens at the last boundary, as if the
 *    file had dropped its beginning; the file still holds every message.
 *    Repair: at a root whose logicalParentUuid resolves, continue from the logical parent. With
 *    first-write-wins parents (see buildForest) each climb ends at the previous boundary.
 *    The joined path is the SESSION'S HISTORY, not the model's context: after a boundary the
 *    model sees the summary, not what precedes it. Each join is reported with its compactMetadata
 *    so a reader can tell the two apart.
 *
 *  (5) THE DETACHED COMPACTION: `compactions`, via 'detached' (seen from CLI 2.1.295 and 2.1.300).
 *    The boundary and its summary form a two-node root branch: the conversation does NOT continue
 *    below the summary. The /compact command's own records, stamped when it was typed (before the
 *    boundary), are written AFTER the summary and parented to the record before the command (which
 *    is also the boundary's logicalParentUuid), and the command's output ("Compacted") chains off
 *    them. The parent links run AROUND the pair, so no climb from the head ever meets it, and the
 *    boundary and the summary are missing from the path.
 *    Repair: a boundary root not on the path, whose logical parent is on it, is placed, with its
 *    subtree in file order, before the first path record after the logical parent that is stamped
 *    at or after the boundary: the order the events happened in (the command typed, the boundary
 *    and the summary written, "Compacted").
 *
 *  The independent check is the harness's OWN head pointer: every `last-prompt.leafUuid` the
 *  session ever wrote marks a node the head stood on, so each should lie on the true path. */
export interface Bridge {
    orphan: TreeNode;
    via: TreeNode;
    missingParent: Uuid;
    kind: 'file-order';
}
export interface Splice {
    error: TreeNode;
    fork: TreeNode;
    branch: TreeNode[];
    kind: 'late-write';
    lateType: string;
}
/** (3) the head pointer written before the session's last records; see below */
export interface Extension {
    leaf: TreeNode;
    to: TreeNode;
    records: number;
    kind: 'stale-head';
}
/** (4) a compaction boundary crossed: the model's context was replaced by a summary here */
export interface CompactionJoin {
    boundary: TreeNode;
    logicalParent: TreeNode;
    kind: 'compaction';
    /** which known shape carried the join, and the node it continued from; for 'detached' (see (5)), the path node
     *  the boundary was placed after */
    via: 'logical-parent' | 'preserved-head' | 'detached';
    joinedAt: TreeNode;
    trigger: string | null;
    preTokens: number | null;
    postTokens: number | null;
    durationMs: number | null;
}
export declare function repairedLivePath(t: Transcript): {
    path: TreeNode[];
    from: 'leafUuid' | 'last-leaf' | 'none';
    bridges: Bridge[];
    splices: Splice[];
    extension: Extension | null;
    compactions: CompactionJoin[];
};
/** Input turns with what followed, up to the next input turn.
 *  This is the unit a reader actually thinks in. */
export interface Turn {
    prompt: TreeNode;
    records: TreeNode[];
    requests: ApiRequest[];
    toolCalls: ToolCall[];
}
export declare function turnsOf(t: Transcript, path?: TreeNode[]): Turn[];
