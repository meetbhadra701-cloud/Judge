import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type { PriceTable } from '@judge-copilot/schemas';
import type { RunBudget, Settlement } from './budget.js';
import type { Clock } from './clock.js';
import { computeRequestDigest } from './digest.js';
import { failureFromError } from './failure.js';
import { reservationBounds } from './pricing.js';
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from './retry.js';
import { withTimeout } from './timeout.js';
import type { LlmProvider, LlmResult, StructuredRequest } from './types.js';

/*
 * The spending-guard wrapper and the standard composition (design §12.1):
 *
 *     retry( budget( timeout( base ) ) )
 *
 * Each attempt reserves its worst case, runs under its own timeout, and settles. The wrapper never holds a
 * transaction or a lock while the model is called: the reserve and settle steps are short, separate operations.
 */

function responseHashOf(result: LlmResult): string | null {
  if (!result.ok) return null;
  try {
    return sha256Hex(canonicalJson(result.json));
  } catch {
    return null;
  }
}

function settlementFor(result: LlmResult): Settlement {
  if (result.ok) {
    return {
      kind: 'measured',
      usage: result.usage,
      outcomeCode: 'ok',
      responseHash: responseHashOf(result),
      responseJson: result.json,
    };
  }
  // The provider billed something despite failing (for example a truncated answer): measure it.
  if (result.usage) {
    return {
      kind: 'measured',
      usage: result.usage,
      outcomeCode: result.category,
      responseHash: null,
    };
  }
  // Provably never sent: free. Anything else may have cost money and stays counted at its full reservation.
  return result.sendState === 'not_sent'
    ? { kind: 'released', outcomeCode: result.category }
    : { kind: 'unknown', outcomeCode: result.category };
}

export function withBudget(inner: LlmProvider, budget: RunBudget, prices: PriceTable): LlmProvider {
  return {
    id: inner.id,
    mode: inner.mode,
    async generate(request: StructuredRequest, signal: AbortSignal): Promise<LlmResult> {
      if (signal.aborted) return { ok: false, category: 'cancelled', sendState: 'not_sent' };
      const bounds = reservationBounds(request, prices);
      if (!bounds) {
        return {
          ok: false,
          category: 'budget_exceeded',
          sendState: 'not_sent',
          denial: 'unpriced_model',
        };
      }
      const reservation = await budget.reserve({
        stage: request.stage,
        model: request.model,
        requestDigest: computeRequestDigest(request),
        bounds,
      });
      if (!reservation.ok) {
        return {
          ok: false,
          category: 'budget_exceeded',
          sendState: 'not_sent',
          denial: reservation.denial,
        };
      }
      let result: LlmResult;
      try {
        result = await inner.generate(request, signal);
      } catch (error) {
        result = failureFromError(error);
        // A throw gives no proof the request never left: never release on a throw.
        if (result.sendState === 'not_sent') result = { ...result, sendState: 'sent_unknown' };
      }
      await budget.settle(reservation.callId, settlementFor(result));
      return result;
    },
  };
}

export interface GuardedProviderOptions {
  readonly base: LlmProvider;
  readonly budget: RunBudget;
  readonly prices: PriceTable;
  readonly clock: Clock;
  readonly random: () => number;
  readonly retry?: RetryPolicy;
}

export function createGuardedProvider(options: GuardedProviderOptions): LlmProvider {
  return withRetry(
    withBudget(withTimeout(options.base, options.clock), options.budget, options.prices),
    options.retry ?? DEFAULT_RETRY_POLICY,
    { clock: options.clock, random: options.random },
  );
}
