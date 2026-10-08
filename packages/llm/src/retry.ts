import type { Clock } from './clock.js';
import { isTransient } from './failure.js';
import type { LlmProvider, LlmResult, StructuredRequest } from './types.js';

/*
 * Bounded retry of TRANSIENT failures (design §9.4): at most `maxRetries` retries (3 attempts by default),
 * exponential backoff 2 s → 30 s with jitter, `Retry-After` honored up to a cap. Everything else (a refusal, a
 * truncation, an auth or request error, a spending-guard denial, a cancellation, a replay miss) is final.
 *
 * Retry sits OUTSIDE the budget wrapper, so every attempt is its own reserve → call → settle cycle: unplanned
 * retries consume the plan's headroom and can never cause a call beyond the guard.
 */

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A `Retry-After` longer than this is not waited for: the failure is returned as final. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
};

/** Hard ceiling on the retry count, whatever the configuration says. */
export const MAX_RETRIES_CEILING = 3;

export interface RetryDependencies {
  readonly clock: Clock;
  /** Uniform in [0, 1). Injected so backoff is deterministic in tests. */
  readonly random: () => number;
}

/** Delay before retry number `retryIndex` (1-based), with "equal jitter" in [0.5, 1) of the capped exponential. */
export function backoffDelayMs(
  policy: RetryPolicy,
  retryIndex: number,
  random: () => number,
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryIndex - 1));
  return Math.floor(exponential * (0.5 + random() * 0.5));
}

export function withRetry(
  inner: LlmProvider,
  policy: RetryPolicy,
  dependencies: RetryDependencies,
): LlmProvider {
  const maxRetries = Math.max(0, Math.min(policy.maxRetries, MAX_RETRIES_CEILING));
  return {
    id: inner.id,
    mode: inner.mode,
    async generate(request: StructuredRequest, signal: AbortSignal): Promise<LlmResult> {
      let result: LlmResult | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (signal.aborted) return { ok: false, category: 'cancelled', sendState: 'not_sent' };
        result = await inner.generate(request, signal);
        if (result.ok || !isTransient(result.category) || attempt === maxRetries) return result;
        if (result.retryAfterMs !== undefined && result.retryAfterMs > policy.maxRetryAfterMs) {
          return result;
        }
        const delay = Math.max(
          backoffDelayMs(policy, attempt + 1, dependencies.random),
          result.retryAfterMs ?? 0,
        );
        try {
          await dependencies.clock.sleep(delay, signal);
        } catch {
          return { ok: false, category: 'cancelled', sendState: 'not_sent' };
        }
      }
      // Unreachable: the loop always returns. Kept so the function is total without a non-null assertion.
      return result ?? { ok: false, category: 'provider_unavailable', sendState: 'not_sent' };
    },
  };
}
