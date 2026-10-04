import {
  EventSourceAuthority,
  EventSourceType,
  type EventContextExtraction,
} from '@judge-copilot/schemas';
import { z } from 'zod';
import {
  ExtractorUnavailableError,
  type EventContextExtractionInput,
  type EventContextExtractor,
} from './extractor.js';
import { normalizeSourceText, sourceContentHash } from './hash.js';
import { remapSourceIds } from './references.js';

/**
 * A recorded extraction: synthetic sources plus the structured output an extractor produced for
 * them. Source references in `extraction` use the recording's `ref` names instead of UUIDs.
 */
export const ReplayRecording = z.object({
  name: z.string().min(1),
  description: z.string(),
  event: z.object({ name: z.string().min(1), slug: z.string().min(1) }),
  sources: z
    .array(
      z.object({
        ref: z.string().min(1),
        sourceType: EventSourceType,
        authority: EventSourceAuthority,
        title: z.string().min(1),
        url: z.string().nullable().default(null),
        normalizedText: z.string().min(1),
      }),
    )
    .min(1),
  /** Shaped like EventContextExtraction with `ref` names as source ids. Validated after replay. */
  extraction: z.unknown(),
});
export type ReplayRecording = z.infer<typeof ReplayRecording>;
export type ReplayRecordingInput = z.input<typeof ReplayRecording>;

/**
 * Deterministic replay of recorded extractions, for tests and local demos only.
 *
 * It matches the request's sources to a recording by exact (authority, normalized-content
 * SHA-256) pairs and returns that recording's output with refs mapped to the real source IDs.
 * It performs NO semantic analysis: sources that do not exactly match a recording fail with
 * ExtractorUnavailableError.
 */
export function createReplayExtractor(
  recordings: readonly ReplayRecordingInput[],
): EventContextExtractor {
  const indexed = recordings.map((raw) => {
    const recording = ReplayRecording.parse(raw);
    const refByPair = new Map<string, string>();
    for (const source of recording.sources) {
      const pair = pairKey(
        source.authority,
        sourceContentHash(normalizeSourceText(source.normalizedText)),
      );
      if (refByPair.has(pair)) {
        throw new Error(`Recording "${recording.name}" contains duplicate sources`);
      }
      refByPair.set(pair, source.ref);
    }
    return { recording, refByPair, key: [...refByPair.keys()].sort().join('|') };
  });

  return {
    name: 'replay',
    extract(input: EventContextExtractionInput): Promise<unknown> {
      const idByPair = new Map(
        input.sources.map((source) => [pairKey(source.authority, source.contentHash), source.id]),
      );
      const key = [...idByPair.keys()].sort().join('|');
      const match = indexed.find((candidate) => candidate.key === key);
      if (!match || idByPair.size !== input.sources.length) {
        return Promise.reject(
          new ExtractorUnavailableError('No recorded extraction exactly matches these sources'),
        );
      }
      const idByRef = new Map(
        [...match.refByPair].map(([pair, ref]) => [ref, idByPair.get(pair) ?? '']),
      );
      const output = remapSourceIds(match.recording.extraction, (ref) => {
        const id = idByRef.get(ref);
        if (!id) {
          throw new Error(
            `Recording "${match.recording.name}" references unknown source ref "${ref}"`,
          );
        }
        return id;
      });
      return Promise.resolve(output as EventContextExtraction);
    },
  };
}

function pairKey(authority: string, contentHash: string): string {
  return `${authority}:${contentHash}`;
}
