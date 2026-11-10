// ============================================================================
//  session.ts: one transcript's facts for `ltms index`: when it ran, how many turns and tool calls it holds, and where
//  its prompts, its compaction summaries and its last reply are. Addresses and counts only, never a record's text.
//
//  Plain TypeScript with no dependencies and no Node imports, like parser.ts and search.ts, so it runs unchanged in
//  Node and in a browser.
// ============================================================================
/* eslint-disable @typescript-eslint/no-explicit-any */
import { blocksOf, isInputTurn, parseTranscript, repairedLivePath, turnsOf } from './parser.js';
const isBoundary = (r) => r?.type === 'system' && r.subtype === 'compact_boundary';
const isReply = (r) => r?.type === 'assistant' && r.isApiErrorMessage !== true && blocksOf(r.message).some((b) => b.type === 'text' && typeof b.text === 'string' && b.text !== '');
/** One transcript's index line, from its text or from a Transcript parseTranscript returned. */
export function indexTranscript(input, options = {}) {
    const t = typeof input === 'string' ? parseTranscript(input) : input;
    const at = (n) => `${options.prefix ? `${options.prefix}:` : ''}L${t.positions[n.index].line}`;
    const path = repairedLivePath(t).path;
    const turns = turnsOf(t, path);
    let calls = 0, failures = 0;
    for (const turn of turns)
        for (const c of turn.toolCalls) {
            calls++;
            if (c.resultBlock !== undefined && c.isError)
                failures++;
        }
    const compactions = [];
    for (let i = 0; i < path.length; i++) {
        if (!isBoundary(path[i].record))
            continue;
        let summary = null;
        for (let j = i + 1; j < path.length; j++) {
            const r = path[j].record;
            if (r.isCompactSummary === true) {
                summary = at(path[j]);
                break;
            }
            if (isInputTurn(r) || isBoundary(r))
                break;
        }
        compactions.push({ boundary: at(path[i]), summary });
    }
    let lastReply = null;
    for (let i = path.length - 1; i >= 0; i--)
        if (isReply(path[i].record)) {
            lastReply = at(path[i]);
            break;
        }
    return {
        first: t.stats.firstTimestamp, last: t.stats.lastTimestamp, turns: turns.length, calls, failures, compactions,
        firstPrompt: turns.length ? at(turns[0].prompt) : null, lastPrompt: turns.length ? at(turns[turns.length - 1].prompt) : null, lastReply,
    };
}
