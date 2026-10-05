import {
  failure,
  InvalidCaptureResultError,
  isContentResult,
  safeHost,
  validateCaptureResult,
  type CaptureResult,
  type ProjectSourceAdapter,
} from '@judge-copilot/capture';
import { TRANSIENT_CAPTURE_FAILURE_CATEGORIES } from '@judge-copilot/domain';
import type { ProjectSourceType } from '@judge-copilot/schemas';
import type { Logger } from '@judge-copilot/shared';
import type { CaptureClaim, CaptureQueue, FinalizeInput, FinalizeOutcome } from './queue.js';
import { safeErrorCode } from './safe-error.js';

export type FinalizeResult = FinalizeOutcome | 'emergency_finalized' | 'finalize_failed';

/**
 * Persists a capture result without ever letting a persistence error escape or be logged raw.
 *
 * `queue.finalize` is one transaction. If it throws (the database rejected something, the
 * connection dropped, ...), the transaction has rolled back and the worker still owns the lease, so
 * a second, minimal transaction records a sanitized `failed` / `internal_error` outcome
 * (`finalization_failed`, no captured content) instead of leaving the snapshot pending until the
 * lease expires. That second attempt is made once and is itself guarded: if it also fails, the
 * lease reaper remains the last resort. Only allow-listed fields (ids and a SQLSTATE) are logged,
 * because driver error messages embed the bound parameters, i.e. captured source text.
 */
export async function finalizeSafely(
  options: Pick<RunnerOptions, 'queue' | 'logger'>,
  claim: CaptureClaim,
  input: FinalizeInput,
): Promise<FinalizeResult> {
  const { queue, logger } = options;
  const log = { snapshotId: claim.snapshotId, runId: claim.runId, sourceType: claim.sourceType };
  try {
    return await queue.finalize(claim, input);
  } catch (error) {
    logger.error(
      { ...log, errorCode: safeErrorCode(error) },
      'capture finalization failed; recording a sanitized failure',
    );
  }
  try {
    const outcome = await queue.finalize(claim, {
      result: {
        status: 'failed',
        failure: failure('internal_error', {
          adapter: claim.sourceType,
          reason: 'finalization_failed',
        }),
      },
      attempts: input.attempts,
      capturedAt: input.capturedAt,
      ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
    });
    return outcome === 'finalized' ? 'emergency_finalized' : outcome;
  } catch (error) {
    logger.error(
      { ...log, errorCode: safeErrorCode(error) },
      'emergency capture finalization failed; the lease reaper will fail it',
    );
    return 'finalize_failed';
  }
}

export type AdapterRegistry = ReadonlyMap<ProjectSourceType, ProjectSourceAdapter>;

export interface RunnerOptions {
  readonly queue: CaptureQueue;
  readonly adapters: AdapterRegistry;
  readonly logger: Logger;
  /** Delay before the single retry of a transient failure. */
  readonly retryDelayMs?: number;
}

function isTransient(result: CaptureResult): boolean {
  return (
    !isContentResult(result) &&
    result.status === 'failed' &&
    (TRANSIENT_CAPTURE_FAILURE_CATEGORIES as readonly string[]).includes(result.failure.category)
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Executes one claimed capture. The adapter runs with no database transaction open; its result is
 * validated before finalization. Adapter exceptions never escape as raw errors: they become a
 * sanitized `internal_error`. A transient network failure is retried at most once; policy
 * rejections never are. A user-requested retry is always a new snapshot, never this one.
 */
export async function runCapture(
  options: RunnerOptions,
  claim: CaptureClaim,
  signal: AbortSignal,
): Promise<void> {
  const { adapters, logger } = options;
  const host = safeHost(claim.sourceUrl);
  const log = {
    snapshotId: claim.snapshotId,
    runId: claim.runId,
    sourceType: claim.sourceType,
    ...(host ? { host } : {}),
  };
  const started = Date.now();
  logger.info(log, 'capture started');

  const adapter = adapters.get(claim.sourceType);
  let result: CaptureResult;
  let attempts = 0;
  if (!adapter) {
    result = {
      status: 'rejected',
      failure: failure('unsupported_source', { reason: 'no_adapter' }),
    };
  } else {
    for (;;) {
      attempts += 1;
      try {
        result = validateCaptureResult(
          claim.sourceType,
          await adapter.capture({ sourceType: claim.sourceType, url: claim.sourceUrl, signal }),
        );
      } catch (error) {
        const reason =
          error instanceof InvalidCaptureResultError
            ? 'invalid_adapter_result'
            : 'adapter_exception';
        result = {
          status: 'failed',
          failure: failure('internal_error', { adapter: adapter.sourceType, reason }),
        };
      }
      if (attempts >= 2 || signal.aborted || !isTransient(result)) break;
      await delay(options.retryDelayMs ?? 500, signal);
    }
  }
  const capturedAt = new Date();
  const shutdown = signal.aborted;
  if (shutdown) {
    result = {
      status: 'failed',
      failure: failure('internal_error', { reason: 'worker_shutdown' }),
    };
  }
  const outcome = await finalizeSafely(options, claim, {
    result,
    attempts,
    capturedAt,
    cancelled: shutdown,
  });
  logger.info(
    {
      ...log,
      status: result.status,
      ...(isContentResult(result)
        ? { artifactCount: result.artifacts.length, partialReasons: result.partialReasons }
        : { failureCategory: result.failure.category }),
      attempts,
      elapsedMs: Date.now() - started,
      outcome,
    },
    'capture finished',
  );
}
