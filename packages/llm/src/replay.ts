import { z } from 'zod';
import { computeRequestDigest } from './digest.js';
import { assertProviderAllowed } from './modes.js';
import type { LlmProvider, LlmResult, StructuredRequest } from './types.js';

/*
 * Deterministic OFFLINE replay (design §12.1). A recording is looked up by the FULL request digest, which commits
 * to every character the model would have seen, the schema and the generation settings. So an old recording is
 * never served for a changed evidence text, rubric, anchor, prompt, schema or model: that is a `replay_miss`.
 *
 * Fixtures are hand-authored SYNTHETIC outputs (they are not produced by any model) and the file says so. Replay
 * demonstrates the pipeline, validation, persistence and UI, never model quality.
 */

export const REPLAY_FIXTURE_VERSION = 'replay-fixtures/v1' as const;

const Usage = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
});

export const ReplayFixtureFile = z.strictObject({
  version: z.literal(REPLAY_FIXTURE_VERSION),
  /** Must be `true`: these outputs were written by hand, not produced by a model. */
  synthetic: z.literal(true),
  entries: z.array(
    z.strictObject({
      requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
      stage: z.string().min(1).max(64),
      note: z.string().max(300).optional(),
      output: z.unknown(),
      usage: Usage,
    }),
  ),
});
export type ReplayFixtureFile = z.infer<typeof ReplayFixtureFile>;

export interface ReplayProviderOptions {
  readonly fixtures: unknown;
  readonly nodeEnv?: string | undefined;
}

export class ReplayProvider implements LlmProvider {
  readonly id = 'replay';
  readonly mode = 'replay' as const;
  private readonly byDigest = new Map<string, ReplayFixtureFile['entries'][number]>();
  private readonly missedDigests: string[] = [];

  constructor(options: ReplayProviderOptions) {
    assertProviderAllowed('replay', options.nodeEnv);
    const parsed = ReplayFixtureFile.parse(options.fixtures);
    for (const entry of parsed.entries) {
      if (this.byDigest.has(entry.requestDigest)) {
        throw new Error(`duplicate replay fixture for request digest ${entry.requestDigest}`);
      }
      this.byDigest.set(entry.requestDigest, entry);
    }
  }

  /** Digests that were requested but not recorded, in order (for fixture authoring). */
  get misses(): readonly string[] {
    return this.missedDigests;
  }

  generate(request: StructuredRequest, signal: AbortSignal): Promise<LlmResult> {
    if (signal.aborted) {
      return Promise.resolve({ ok: false, category: 'cancelled', sendState: 'not_sent' });
    }
    const digest = computeRequestDigest(request);
    const entry = this.byDigest.get(digest);
    if (!entry) {
      this.missedDigests.push(digest);
      return Promise.resolve({ ok: false, category: 'replay_miss', sendState: 'not_sent' });
    }
    return Promise.resolve({
      ok: true,
      json: structuredClone(entry.output),
      usage: {
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
        ...(entry.usage.cacheReadTokens === undefined
          ? {}
          : { cacheReadTokens: entry.usage.cacheReadTokens }),
        ...(entry.usage.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: entry.usage.cacheWriteTokens }),
      },
      providerRequestId: null,
      servedModel: request.model,
    });
  }
}
