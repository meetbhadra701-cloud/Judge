import type {
  AssessmentRunFailureCategory,
  LlmFailureCategory,
  SendState,
} from '@judge-copilot/schemas';
import type { LlmFailure } from './types.js';

/*
 * Failure normalization. A provider or transport failure must never cross a package boundary as a raw SDK
 * error (docs/SECURITY.md §6): third-party errors carry request objects, headers (including API keys) and
 * response bodies. Adapters call these helpers; nothing here reads or returns an error message.
 */

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Only the error's name and code, and only when they look like plain identifiers. Never the message. */
export function safeErrorSummary(error: unknown): { name: string; code: string | null } {
  if (typeof error !== 'object' || error === null) return { name: 'NonError', code: null };
  const { name, code } = error as { name?: unknown; code?: unknown };
  return {
    name: typeof name === 'string' && SAFE_TOKEN.test(name) ? name : 'Error',
    code: typeof code === 'string' && SAFE_TOKEN.test(code) ? code : null,
  };
}

const NEVER_REACHED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Maps a thrown value to a failure. Connect-level errors happen before any request bytes are sent, so they are
 * `not_sent`. Everything else is `sent_unknown`: when unsure, spend is assumed possible.
 */
export function failureFromError(error: unknown): LlmFailure {
  const { name, code } = safeErrorSummary(error);
  if (name === 'AbortError') {
    return { ok: false, category: 'cancelled', sendState: 'sent_unknown' };
  }
  if (name === 'TimeoutError') {
    return { ok: false, category: 'timeout', sendState: 'sent_unknown' };
  }
  if (code !== null && NEVER_REACHED_CODES.has(code)) {
    return { ok: false, category: 'provider_unavailable', sendState: 'not_sent' };
  }
  return { ok: false, category: 'provider_unavailable', sendState: 'sent_unknown' };
}

/** Parses a `Retry-After` header (delta-seconds only; an HTTP date is ignored). */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined) return undefined;
  if (!/^\d{1,6}$/.test(header.trim())) return undefined;
  return Number(header.trim()) * 1_000;
}

/**
 * Default classification of an HTTP status for adapters. Definitive 4xx answers are rejected before any
 * generation (`not_sent`); 429 is a rate-limit rejection (`not_sent`); 5xx and 408 may have been processed
 * (`sent_unknown`). Adapters may refine this; they may not make it less conservative for 5xx.
 */
export function failureFromHttpStatus(
  status: number,
  retryAfterHeader?: string | null,
): LlmFailure {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  const withRetry = (failure: LlmFailure): LlmFailure =>
    retryAfterMs === undefined ? failure : { ...failure, retryAfterMs };
  if (status === 429) {
    return withRetry({ ok: false, category: 'rate_limited', sendState: 'not_sent' });
  }
  if (status === 401 || status === 403) {
    return { ok: false, category: 'auth', sendState: 'not_sent' };
  }
  if (status === 408) {
    return withRetry({ ok: false, category: 'timeout', sendState: 'sent_unknown' });
  }
  if (status >= 400 && status < 500) {
    return { ok: false, category: 'bad_request', sendState: 'not_sent' };
  }
  return withRetry({ ok: false, category: 'provider_unavailable', sendState: 'sent_unknown' });
}

export type RunFailure =
  | { readonly state: 'failed'; readonly category: AssessmentRunFailureCategory }
  | { readonly state: 'cancelled' };

/**
 * How a final provider failure ends an assessment run (docs/AI_PIPELINE.md §10): never with a score.
 * `cancelled` is a shutdown or user cancellation, not a failure. A wall-clock denial is a `timeout`.
 */
export function toRunFailure(failure: LlmFailure): RunFailure {
  const map: Record<LlmFailureCategory, AssessmentRunFailureCategory | 'cancelled'> = {
    timeout: 'timeout',
    rate_limited: 'provider_error',
    provider_unavailable: 'provider_error',
    refused: 'provider_error',
    truncated: 'schema_validation_failed',
    auth: 'provider_error',
    bad_request: 'provider_error',
    cancelled: 'cancelled',
    budget_exceeded: 'budget_exceeded',
    replay_miss: 'provider_error',
  };
  if (failure.category === 'budget_exceeded' && failure.denial === 'wall_clock') {
    return { state: 'failed', category: 'timeout' };
  }
  const mapped = map[failure.category];
  return mapped === 'cancelled' ? { state: 'cancelled' } : { state: 'failed', category: mapped };
}

/** Failures worth another attempt: the provider or network, not our request, our guard or the answer. */
export function isTransient(category: LlmFailureCategory): boolean {
  return (
    category === 'timeout' || category === 'rate_limited' || category === 'provider_unavailable'
  );
}

export type { SendState };
