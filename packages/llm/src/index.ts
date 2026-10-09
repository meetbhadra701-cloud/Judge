/*
 * @judge-copilot/llm — the provider-neutral structured-output interface (M5, phase P1).
 *
 * Layer 3 (adapter). P1 contains NO vendor SDK, NO network access, NO filesystem access, NO API key handling
 * and NO prompt: it is the interface, the request digest, timeout/cancellation, bounded retry, the local
 * spending guard, versioned prices, failure normalization, and the offline replay and scripted providers.
 * The Anthropic adapter arrives in P6, behind this interface, and only with the owner's authorization.
 */
export { AsyncMutex, InMemoryRunBudget, MAX_RECORDED_RESPONSE_BYTES } from './budget.js';
export type {
  BudgetSnapshot,
  InMemoryRunBudgetOptions,
  LedgerEntry,
  ReserveOutcome,
  ResponseRecordState,
  ReserveRequest,
  RunBudget,
  Settlement,
} from './budget.js';
export { ManualClock, systemClock } from './clock.js';
export type { Clock } from './clock.js';
export { computeRequestDigest, REQUEST_DIGEST_VERSION } from './digest.js';
export {
  failureFromError,
  failureFromHttpStatus,
  isTransient,
  parseRetryAfterMs,
  safeErrorSummary,
  toRunFailure,
} from './failure.js';
export type { RunFailure } from './failure.js';
export { createGuardedProvider, withBudget } from './guarded.js';
export type { GuardedProviderOptions } from './guarded.js';
export { jsonSchemaFor } from './json-schema.js';
export { assertProviderAllowed, ProviderNotAllowedError } from './modes.js';
export { MAX_MODEL_JSON_CHARS, parseModelJson } from './parse.js';
export type { ModelJsonResult } from './parse.js';
export {
  costNanoUsd,
  inputTokensOf,
  priceFor,
  RESERVATION_OVERHEAD_TOKENS,
  reservationBounds,
} from './pricing.js';
export type { ModelPrice, ReservationBounds } from './pricing.js';
export { PRICES_V1 } from './prices-v1.js';
export { REPLAY_FIXTURE_VERSION, ReplayFixtureFile, ReplayProvider } from './replay.js';
export type { ReplayProviderOptions } from './replay.js';
export { backoffDelayMs, DEFAULT_RETRY_POLICY, MAX_RETRIES_CEILING, withRetry } from './retry.js';
export type { RetryDependencies, RetryPolicy } from './retry.js';
export { ScriptedProvider } from './scripted.js';
export type { ScriptedStep } from './scripted.js';
export { withTimeout } from './timeout.js';
export type {
  GenerationSettings,
  LlmFailure,
  LlmProvider,
  LlmResult,
  LlmSuccess,
  StructuredRequest,
  Usage,
} from './types.js';
