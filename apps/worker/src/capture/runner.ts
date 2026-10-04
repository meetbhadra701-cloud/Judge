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
import type { CaptureClaim, CaptureQueue } from './queue.js';

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
  const { queue, adapters, logger } = options;
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
  const outcome = await queue.finalize(claim, {
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
