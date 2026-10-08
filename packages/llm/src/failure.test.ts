import { describe, expect, it } from 'vitest';
import {
  failureFromError,
  failureFromHttpStatus,
  isTransient,
  parseRetryAfterMs,
  safeErrorSummary,
  toRunFailure,
} from './failure.js';
import { fail } from './testing/builders.js';
import { LLM_FAILURE_CATEGORY_VALUES } from '@judge-copilot/schemas';

describe('HTTP status classification (default for adapters)', () => {
  it.each([
    [400, 'bad_request', 'not_sent'],
    [401, 'auth', 'not_sent'],
    [403, 'auth', 'not_sent'],
    [404, 'bad_request', 'not_sent'],
    [408, 'timeout', 'sent_unknown'],
    [413, 'bad_request', 'not_sent'],
    [422, 'bad_request', 'not_sent'],
    [429, 'rate_limited', 'not_sent'],
    [500, 'provider_unavailable', 'sent_unknown'],
    [502, 'provider_unavailable', 'sent_unknown'],
    [503, 'provider_unavailable', 'sent_unknown'],
    [529, 'provider_unavailable', 'sent_unknown'],
  ] as const)('%i → %s / %s', (status, category, sendState) => {
    expect(failureFromHttpStatus(status)).toEqual({ ok: false, category, sendState });
  });

  it('carries Retry-After for transient statuses only when it is plain seconds', () => {
    expect(failureFromHttpStatus(429, '30')).toMatchObject({ retryAfterMs: 30_000 });
    expect(failureFromHttpStatus(503, '2')).toMatchObject({ retryAfterMs: 2_000 });
    expect(failureFromHttpStatus(429, 'Wed, 21 Oct 2026 07:28:00 GMT')).not.toHaveProperty(
      'retryAfterMs',
    );
    expect(failureFromHttpStatus(400, '30')).not.toHaveProperty('retryAfterMs');
  });

  it.each(['-5', '1e3', '', '  ', 'abc', '99999999', '1.5'])(
    'ignores a malformed Retry-After %j',
    (header) => {
      expect(parseRetryAfterMs(header)).toBeUndefined();
    },
  );
  it('parses valid values and absent headers', () => {
    expect(parseRetryAfterMs(' 7 ')).toBe(7_000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});

describe('error normalization never exposes messages', () => {
  it('maps names and codes, and treats everything unrecognized as possibly billed', () => {
    const named = (name: string, code?: string) =>
      Object.assign(new Error('secret-message CANARY-XYZ'), { name, ...(code ? { code } : {}) });
    expect(failureFromError(named('AbortError'))).toEqual({
      ok: false,
      category: 'cancelled',
      sendState: 'sent_unknown',
    });
    expect(failureFromError(named('TimeoutError'))).toEqual({
      ok: false,
      category: 'timeout',
      sendState: 'sent_unknown',
    });
    expect(failureFromError(named('Error', 'ECONNREFUSED'))).toEqual({
      ok: false,
      category: 'provider_unavailable',
      sendState: 'not_sent',
    });
    expect(failureFromError(named('Error', 'ENOTFOUND'))).toMatchObject({ sendState: 'not_sent' });
    expect(failureFromError(named('Error', 'ECONNRESET'))).toEqual({
      ok: false,
      category: 'provider_unavailable',
      sendState: 'sent_unknown',
    });
    expect(failureFromError(named('Error', 'UND_ERR_SOCKET'))).toMatchObject({
      sendState: 'sent_unknown',
    });
    for (const value of ['text', 42, null, undefined, {}, []]) {
      expect(failureFromError(value)).toMatchObject({ ok: false, sendState: 'sent_unknown' });
    }
  });

  it('summarizes only a plain name and code', () => {
    const error = Object.assign(new Error('Authorization: Bearer CANARY-api-key-value'), {
      name: 'APIError',
      code: 'rate_limit',
      headers: { 'x-api-key': 'CANARY-SECRET' },
      request: { body: 'prompt' },
    });
    const summary = safeErrorSummary(error);
    expect(summary).toEqual({ name: 'APIError', code: 'rate_limit' });
    expect(JSON.stringify(summary)).not.toContain('SECRET');
    expect(
      safeErrorSummary(Object.assign(new Error('x'), { name: 'x'.repeat(100), code: 'has space' })),
    ).toEqual({ name: 'Error', code: null });
    expect(
      safeErrorSummary(
        Object.assign(new Error('x'), {
          name: 'Bearer CANARY-SECRET',
          code: 'CANARY-SECRET value',
        }),
      ),
    ).toEqual({ name: 'Error', code: null });
    expect(safeErrorSummary(null)).toEqual({ name: 'NonError', code: null });
  });
});

describe('run failure mapping', () => {
  it('maps every provider failure to a run failure category — and never to success', () => {
    const expected: Record<string, unknown> = {
      timeout: { state: 'failed', category: 'timeout' },
      rate_limited: { state: 'failed', category: 'provider_error' },
      provider_unavailable: { state: 'failed', category: 'provider_error' },
      refused: { state: 'failed', category: 'provider_error' },
      truncated: { state: 'failed', category: 'schema_validation_failed' },
      auth: { state: 'failed', category: 'provider_error' },
      bad_request: { state: 'failed', category: 'provider_error' },
      cancelled: { state: 'cancelled' },
      budget_exceeded: { state: 'failed', category: 'budget_exceeded' },
      replay_miss: { state: 'failed', category: 'provider_error' },
    };
    for (const category of LLM_FAILURE_CATEGORY_VALUES) {
      expect(toRunFailure(fail(category)), category).toEqual(expected[category]);
    }
  });

  it('treats a wall-clock denial as a timeout and every other denial as budget_exceeded', () => {
    expect(toRunFailure(fail('budget_exceeded', 'not_sent', { denial: 'wall_clock' }))).toEqual({
      state: 'failed',
      category: 'timeout',
    });
    for (const denial of [
      'calls',
      'input_tokens',
      'output_tokens',
      'cost',
      'per_call_input',
      'unpriced_model',
    ] as const) {
      expect(toRunFailure(fail('budget_exceeded', 'not_sent', { denial }))).toEqual({
        state: 'failed',
        category: 'budget_exceeded',
      });
    }
  });

  it('retries only transient categories', () => {
    expect(LLM_FAILURE_CATEGORY_VALUES.filter(isTransient)).toEqual([
      'timeout',
      'rate_limited',
      'provider_unavailable',
    ]);
  });
});
