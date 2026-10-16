import { readFile } from 'node:fs/promises';
import {
  AssessmentInputReader,
  AssessmentRunStore,
  AssessmentStore,
  EvidenceGraphStore,
  GraphExtractionStore,
  type JudgeDatabase,
} from '@judge-copilot/database';
import {
  ReplayProvider,
  ScriptedProvider,
  systemClock,
  type LlmProvider,
  type RetryPolicy,
} from '@judge-copilot/llm';
import type { Logger } from '@judge-copilot/shared';
import type { WorkerEnv } from '../env.js';
import { demonstrationStep } from './demonstration-model.js';
import { createAssessmentLoop, type AssessmentLoop } from './loop.js';

/*
 * Composition of the assessment runtime (M5 P5). The only providers that exist are the offline ones: `ReplayProvider` over a
 * hand-authored fixture (refused in production by the llm package AND by the environment schema) and, in tests, `ScriptedProvider`.
 * There is no live adapter, no SDK and no credential here; a live provider arrives in P6 behind the same `LlmProvider` port.
 */

export interface AssessmentRuntimeOptions {
  readonly db: JudgeDatabase;
  readonly env: Pick<
    WorkerEnv,
    | 'ASSESSMENT_PROVIDER'
    | 'ASSESSMENT_REPLAY_FIXTURE'
    | 'ASSESSMENT_CONCURRENCY'
    | 'ASSESSMENT_POLL_INTERVAL_MS'
    | 'ASSESSMENT_LEASE_MS'
    | 'ASSESSMENT_PENDING_MAX_AGE_MS'
    | 'ASSESSMENT_SHUTDOWN_GRACE_MS'
    | 'DATABASE_URL'
    | 'GITHUB_TOKEN'
  >;
  readonly logger: Logger;
  /** Test seam: a provider supplied directly (the environment's provider selection is then ignored). */
  readonly provider?: LlmProvider;
  readonly retry?: RetryPolicy;
}

/** Secret values that must never appear in a prompt (any occurrence aborts the render). Short values are ignored by the renderer's rule. */
function secretValues(env: AssessmentRuntimeOptions['env']): string[] {
  return [env.DATABASE_URL, env.GITHUB_TOKEN].filter(
    (value): value is string => typeof value === 'string' && value.length >= 8,
  );
}

/** The assessment loop for this environment, or null when no provider is configured (the loop is then simply off). */
export async function createAssessmentRuntime(
  options: AssessmentRuntimeOptions,
): Promise<AssessmentLoop | null> {
  const { db, env, logger } = options;
  let provider = options.provider ?? null;
  if (provider === null) {
    if (env.ASSESSMENT_PROVIDER === 'none') return null;
    if (env.ASSESSMENT_PROVIDER === 'scripted') {
      // P6C: fixed placeholder answers for ANY captured project (no fixture, no model): see demonstration-model.ts
      provider = new ScriptedProvider([demonstrationStep], { repeatLast: true });
      logger.warn(
        { provider: provider.id, mode: provider.mode },
        'SCRIPTED DEMONSTRATION provider enabled: placeholder answers that do not read the project, not a model assessment',
      );
    } else {
      // 'replay': the fixture is hand-authored synthetic JSON, validated by the replay provider's own strict schema
      const fixtures: unknown = JSON.parse(
        await readFile(env.ASSESSMENT_REPLAY_FIXTURE ?? '', 'utf8'),
      );
      provider = new ReplayProvider({ fixtures });
      logger.warn(
        { provider: provider.id, mode: provider.mode },
        'offline assessment provider enabled: replayed synthetic outputs, not a model assessment',
      );
    }
  }
  const graphs = new EvidenceGraphStore({ db });
  const runs = new AssessmentRunStore({ db });
  return createAssessmentLoop({
    db,
    runs,
    logger,
    concurrency: env.ASSESSMENT_CONCURRENCY,
    pollIntervalMs: env.ASSESSMENT_POLL_INTERVAL_MS,
    pendingMaxAgeMs: env.ASSESSMENT_PENDING_MAX_AGE_MS,
    shutdownGraceMs: env.ASSESSMENT_SHUTDOWN_GRACE_MS,
    pipeline: {
      db,
      runs,
      extractions: new GraphExtractionStore(db, graphs),
      store: new AssessmentStore(db),
      reader: new AssessmentInputReader(db),
      provider,
      clock: systemClock,
      random: Math.random,
      logger,
      leaseMs: env.ASSESSMENT_LEASE_MS,
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      secrets: secretValues(env),
    },
  });
}
