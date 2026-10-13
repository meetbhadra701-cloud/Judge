import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_REQUEST_RECOVERY,
  CAPTURE_RETRY_RECOVERY,
  describeFailure,
  outcomeIsUnknown,
  runCaptureRetry,
} from '../../apps/web/lib/action-errors.js';

/*
 * R7-12 (CAPTURE_ALREADY_PENDING is success, permanently) and R7-9 (a request with no usable answer is reported as "unknown", with a safe way
 * to recover, never as a plain failure).
 */

const refusal = (status: number, code: string, message = `API said ${code}`) =>
  Promise.resolve({ ok: false as const, status, code, message });

describe('runCaptureRetry', () => {
  it('reads CAPTURE_ALREADY_PENDING as "already waiting", not as a failure', async () => {
    const paths: string[] = [];
    const outcome = await runCaptureRetry(
      (path) => {
        paths.push(path);
        return refusal(409, 'CAPTURE_ALREADY_PENDING');
      },
      'p/1',
      's 2',
    );
    expect(outcome).toEqual({ kind: 'already_pending' });
    // identifiers are encoded into the path, never concatenated raw
    expect(paths).toEqual(['/projects/p%2F1/sources/s%202/captures']);
  });

  it('a request that was accepted is "requested"', async () => {
    expect(await runCaptureRetry(() => Promise.resolve({ ok: true as const }), 'p', 's')).toEqual({
      kind: 'requested',
    });
  });

  it.each([
    [404, 'SOURCE_NOT_FOUND'],
    [403, 'FORBIDDEN'],
    [401, 'UNAUTHENTICATED'],
    [409, 'SOMETHING_ELSE_409'],
  ])('a refusal (%d %s) keeps the API’s own words and is a failure', async (status, code) => {
    const outcome = await runCaptureRetry(() => refusal(status, code, 'Plain refusal.'), 'p', 's');
    expect(outcome).toEqual({ kind: 'failed', message: 'Plain refusal.' });
  });

  it.each([
    [503, 'API_UNREACHABLE'],
    [502, 'UNKNOWN_ERROR'],
    [500, 'INTERNAL'],
  ])(
    'no usable answer (%d %s) is reported as unknown, with the safe recovery',
    async (status, code) => {
      const outcome = await runCaptureRetry(() => refusal(status, code, 'raw'), 'p', 's');
      expect(outcome.kind).toBe('failed');
      const message = outcome.kind === 'failed' ? outcome.message : '';
      expect(message).toContain('could not confirm whether this was saved');
      expect(message).toContain(CAPTURE_RETRY_RECOVERY);
      expect(message).not.toContain('raw');
    },
  );
});

describe('describeFailure', () => {
  it('distinguishes a refusal from an unknown outcome', () => {
    expect(outcomeIsUnknown({ status: 409, code: 'X', message: 'm' })).toBe(false);
    expect(outcomeIsUnknown({ status: 503, code: 'API_UNREACHABLE', message: 'm' })).toBe(true);
    expect(outcomeIsUnknown({ status: 200, code: 'UNKNOWN_ERROR', message: 'm' })).toBe(true);
    expect(outcomeIsUnknown({ status: 500, code: 'Y', message: 'm' })).toBe(true);
    expect(describeFailure({ status: 422, code: 'V', message: 'Name is too long.' }, 'r')).toBe(
      'Name is too long.',
    );
    expect(describeFailure({ status: 503, code: 'API_UNREACHABLE', message: 'm' }, 'Do r.')).toBe(
      'We could not confirm whether this was saved, because no usable answer arrived. Do r.',
    );
  });

  it('the recovery advice only claims what the API guarantees', () => {
    expect(CAPTURE_RETRY_RECOVERY).toContain('at most one capture waiting');
    expect(ASSESSMENT_REQUEST_RECOVERY).toContain('only one assessment run active at a time');
    expect(ASSESSMENT_REQUEST_RECOVERY).toContain('unchanged material is never repeated');
  });
});
