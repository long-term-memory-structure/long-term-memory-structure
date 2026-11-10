import type { Transcript } from './parser.js';
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
/** One transcript's index line, from its text or from a Transcript parseTranscript returned. */
export declare function indexTranscript(input: string | Transcript, options?: IndexOptions): TranscriptIndex;
