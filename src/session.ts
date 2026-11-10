// ============================================================================
//  session.ts: one transcript's facts for `ltms index`: when it ran, how many turns and tool calls it holds, and where
//  its prompts, its compaction summaries and its last reply are. Addresses and counts only, never a record's text.
//
//  Plain TypeScript with no dependencies and no Node imports, like parser.ts and search.ts, so it runs unchanged in
//  Node and in a browser.
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

import { blocksOf, isInputTurn, parseTranscript, repairedLivePath, turnsOf } from './parser.js';
import type { Transcript, TreeNode } from './parser.js';

/** One compaction on the live path: where its boundary is, and where the summary the model carried on from is. */
export interface TranscriptCompaction {
  /** The address of the `system` record with subtype `compact_boundary`. */
  boundary: string;
  /** The address of the first record after the boundary on the live path, before the next turn's prompt, that is a
   *  compaction summary (`isCompactSummary` true); null when there is none. */
  summary: string | null;
}

/** What `ltms index` prints of one transcript, besides what it takes from the file system (its prefix, its path, and
 *  how many agent transcripts sit in its session's directory). */
export interface TranscriptIndex {
  /** TranscriptStats.firstTimestamp: the smallest string `timestamp` other than '', compared as strings; null when
   *  none. As the transcript holds it, unchecked (the CLI prints it only when it is an ISO 8601 time). */
  first: string | null;
  /** TranscriptStats.lastTimestamp: the largest, by the same rule. */
  last: string | null;
  /** The turns on the live path (turnsOf on repairedLivePath): skeleton's turn lines. */
  turns: number;
  /** The tool calls of those turns: skeleton's call lines. */
  calls: number;
  /** The calls whose result was recorded and is an error: skeleton's call lines with ok false. */
  failures: number;
  /** Every compaction boundary on the live path, joined or not, in path order. */
  compactions: TranscriptCompaction[];
  /** The address of the first turn's prompt; null when there is no turn. */
  firstPrompt: string | null;
  /** The address of the last turn's prompt; null when there is no turn. */
  lastPrompt: string | null;
  /** The address of the last assistant record on the live path that holds reply text, by search's rule for the kind
   *  reply: a text block whose text is a non-empty string, in a record that is not an API error message. null when
   *  there is none. */
  lastReply: string | null;
}

/** How indexTranscript writes addresses. */
export interface IndexOptions {
  /** The address prefix (the CLI's prefixOf(file)). Without one, addresses are `L<n>`. */
  prefix?: string;
}

const isBoundary = (r: any): boolean => r?.type === 'system' && r.subtype === 'compact_boundary';
const isReply = (r: any): boolean =>
  r?.type === 'assistant' && r.isApiErrorMessage !== true && blocksOf(r.message).some((b: any) => b.type === 'text' && typeof b.text === 'string' && b.text !== '');

/** One transcript's index line, from its text or from a Transcript parseTranscript returned. */
export function indexTranscript(input: string | Transcript, options: IndexOptions = {}): TranscriptIndex {
  const t = typeof input === 'string' ? parseTranscript(input) : input;
  const at = (n: TreeNode): string => `${options.prefix ? `${options.prefix}:` : ''}L${t.positions[n.index].line}`;
  const path = repairedLivePath(t).path;
  const turns = turnsOf(t, path);
  let calls = 0, failures = 0;
  for (const turn of turns) for (const c of turn.toolCalls) { calls++; if (c.resultBlock !== undefined && c.isError) failures++; }
  const compactions: TranscriptCompaction[] = [];
  for (let i = 0; i < path.length; i++) {
    if (!isBoundary(path[i].record)) continue;
    let summary: string | null = null;
    for (let j = i + 1; j < path.length; j++) {
      const r = path[j].record as any;
      if (r.isCompactSummary === true) { summary = at(path[j]); break; }
      if (isInputTurn(r) || isBoundary(r)) break;
    }
    compactions.push({ boundary: at(path[i]), summary });
  }
  let lastReply: string | null = null;
  for (let i = path.length - 1; i >= 0; i--) if (isReply(path[i].record)) { lastReply = at(path[i]); break; }
  return {
    first: t.stats.firstTimestamp, last: t.stats.lastTimestamp, turns: turns.length, calls, failures, compactions,
    firstPrompt: turns.length ? at(turns[0].prompt) : null, lastPrompt: turns.length ? at(turns[turns.length - 1].prompt) : null, lastReply,
  };
}
