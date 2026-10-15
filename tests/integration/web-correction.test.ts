import { describe, expect, it } from 'vitest';
import { runSupplyContent } from '../../apps/web/lib/action-errors.js';
import {
  runCorrection,
  validateCorrection,
  voidedNotice,
  type ApiFn,
  type CorrectionInput,
} from '../../apps/web/lib/submission.js';

/* P6B-beta2: the pure rules and the request/answer handling of the void-and-replace form (apps/web/lib/submission.ts). */

const KEY = '0b9f6c1e-5b0e-4c27-9d6d-0a8e7d3f2a11';
const input = (overrides: Partial<CorrectionInput> = {}): CorrectionInput => ({
  reason: 'Wrong Devpost page',
  replace: true,
  github: 'https://github.com/Owner/Repo',
  devpost: 'https://devpost.com/software/right-one',
  name: '',
  ...overrides,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: unknown;
}
function recorder(answer: Awaited<ReturnType<ApiFn>>): { api: ApiFn; calls: Call[] } {
  const calls: Call[] = [];
  const api = ((method: string, path: string, body?: unknown, headers?: unknown) => {
    calls.push({ method, path, body, headers });
    return Promise.resolve(answer);
  }) as ApiFn;
  return { api, calls };
}
const refusal = (status: number, code: string, details?: Record<string, unknown>) => ({
  ok: false as const,
  status,
  code,
  message: `API said ${code}`,
  issues: [] as unknown[],
  details,
});

describe('validateCorrection', () => {
  it('requires a single-line reason of bounded length', () => {
    for (const reason of ['', '   ', 'two\nlines', 'nul\u0000', 'x'.repeat(1_001)]) {
      const checked = validateCorrection(input({ reason, replace: false }));
      expect('errors' in checked && checked.errors.reason, JSON.stringify(reason)).toBeTruthy();
    }
    expect(validateCorrection(input({ replace: false }))).toEqual({ ok: true });
  });

  it('validates the corrected links with the submission rules only when a replacement is requested', () => {
    expect(validateCorrection(input({ replace: false, github: 'garbage', devpost: '' }))).toEqual({
      ok: true,
    });
    const bad = validateCorrection(input({ github: 'https://gitlab.com/a/b', devpost: '' }));
    expect('errors' in bad && Object.keys(bad.errors).sort()).toEqual(['devpost', 'github']);
  });
});

describe('runCorrection', () => {
  it('sends ONE request with the form’s key and canonical links, and never a derived name', async () => {
    const { api, calls } = recorder({
      ok: true,
      data: { result: 'voided', project: { id: 'old' }, replacement: { project: { id: 'new' } } },
    } as never);
    const outcome = await runCorrection(api, 'old', input(), KEY);
    expect(outcome).toEqual({
      kind: 'done',
      result: 'voided',
      voidedProjectId: 'old',
      replacementProjectId: 'new',
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/projects/old/void',
        body: {
          reason: 'Wrong Devpost page',
          replacement: {
            githubUrl: 'https://github.com/owner/repo',
            devpostUrl: 'https://devpost.com/software/right-one',
          },
        },
        headers: { 'idempotency-key': KEY },
      },
    ]);
  });

  it('a void without a replacement sends no replacement', async () => {
    const { api, calls } = recorder({
      ok: true,
      data: { result: 'voided', project: { id: 'old' }, replacement: null },
    } as never);
    const outcome = await runCorrection(api, 'old', input({ replace: false }), KEY);
    expect(outcome).toMatchObject({ kind: 'done', replacementProjectId: null });
    expect(calls[0]?.body).toEqual({ reason: 'Wrong Devpost page' });
  });

  it('sends nothing for invalid input or an invalid key', async () => {
    const { api, calls } = recorder({ ok: true, data: {} } as never);
    expect(await runCorrection(api, 'p', input({ reason: '' }), KEY)).toMatchObject({
      kind: 'invalid',
    });
    expect(await runCorrection(api, 'p', input(), 'not-a-key')).toMatchObject({ kind: 'failed' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['PROJECT_ALREADY_VOIDED', 409, /already voided/],
    [
      'PROJECT_HAS_PENDING_WORK',
      409,
      /still pending.*NO worker is running.*never cancelled.*Nothing was changed/s,
    ],
    ['SUBMISSION_CONFLICT', 409, /Nothing was changed: the project is not voided/],
    ['IDEMPOTENCY_KEY_REUSED', 422, /different correction/],
  ])('%s is explained, with what happened to the data', async (code, status, message) => {
    const { api } = recorder(refusal(status, code, { projectId: 'other' }));
    const outcome = await runCorrection(api, 'p', input(), KEY);
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.message).toMatch(message);
    expect(outcome.kind === 'failed' && outcome.outcomeUnknown).toBeFalsy();
  });

  it('a request that never left says nothing was changed; one that may have been processed says the outcome is unknown and that resending is safe', async () => {
    const unreachable = await runCorrection(
      recorder(refusal(503, 'API_UNREACHABLE')).api,
      'p',
      input(),
      KEY,
    );
    expect(unreachable).toMatchObject({ kind: 'failed', outcomeUnknown: false });
    expect(unreachable.kind === 'failed' && unreachable.message).toMatch(/nothing was changed/);
    for (const answer of [
      refusal(503, 'API_NO_ANSWER'),
      refusal(500, 'INTERNAL_ERROR'),
      refusal(502, 'UNKNOWN_ERROR'),
    ]) {
      const lost = await runCorrection(recorder(answer).api, 'p', input(), KEY);
      expect(lost).toMatchObject({ kind: 'failed', outcomeUnknown: true });
      expect(lost.kind === 'failed' && lost.message).toMatch(/could not confirm/);
      expect(lost.kind === 'failed' && lost.message).toMatch(/same form again is safe/);
    }
  });
});

describe('voidedNotice', () => {
  const base = { voidedAt: 'x', voidedByActorId: 'a', reason: 'r', nameBefore: 'n' };
  it('says nothing for a live project and states what the void means for a voided one', () => {
    expect(voidedNotice({ voided: null })).toBeNull();
    expect(voidedNotice({ voided: { ...base, replacedByProjectId: null } })).toMatch(
      /nothing was replaced/,
    );
    expect(voidedNotice({ voided: { ...base, replacedByProjectId: 'p2' } })).toMatch(
      /replaced by a corrected submission/,
    );
  });
});

describe('the recovery flag reaches the API only when the organizer ticked it (P6B-beta3)', () => {
  it('sends cancelPendingWork: true when asked and omits it otherwise', async () => {
    const withFlag = recorder({ project: { id: 'p' }, replacement: null, result: 'voided' });
    await runCorrection(withFlag.api, 'p', { ...input(), cancelPending: true }, KEY);
    expect(JSON.stringify(withFlag.calls)).toContain('cancelPendingWork');
    const without = recorder({ project: { id: 'p' }, replacement: null, result: 'voided' });
    await runCorrection(without.api, 'p', input(), KEY);
    expect(JSON.stringify(without.calls)).not.toContain('cancelPendingWork');
  });
});

describe('runSupplyContent (P6B-beta3)', () => {
  const answer = (value: Awaited<ReturnType<Parameters<typeof runSupplyContent>[0]>>) =>
    (() => Promise.resolve(value)) as Parameters<typeof runSupplyContent>[0];

  it('refuses empty text locally without calling the API', async () => {
    let called = false;
    const outcome = await runSupplyContent(
      () => {
        called = true;
        return Promise.resolve({ ok: true });
      },
      'p',
      's',
      '   ',
    );
    expect(outcome).toEqual({ kind: 'failed', message: 'Paste the submission text first.' });
    expect(called).toBe(false);
  });

  it('distinguishes stored from unchanged, and keeps the API’s own words for a refusal', async () => {
    expect(
      await runSupplyContent(answer({ ok: true, data: { result: 'stored' } }), 'p', 's', 'text'),
    ).toEqual({ kind: 'stored' });
    expect(
      await runSupplyContent(answer({ ok: true, data: { result: 'unchanged' } }), 'p', 's', 'text'),
    ).toEqual({ kind: 'unchanged' });
    const refused = await runSupplyContent(
      answer({
        ok: false,
        status: 422,
        code: 'SUPPLIED_CONTENT_INVALID',
        message: 'The submission text is too short to be a submission',
      }),
      'p',
      's',
      'text',
    );
    expect(refused).toEqual({
      kind: 'failed',
      message: 'The submission text is too short to be a submission',
    });
  });

  it('says the outcome is unknown, and how to recover safely, when no usable answer arrived', async () => {
    const outcome = await runSupplyContent(
      answer({ ok: false, status: 502, code: 'API_NO_ANSWER', message: 'x' }),
      'p',
      's',
      'text',
    );
    expect(outcome.kind === 'failed' && outcome.message).toContain(
      'Sending the same text again is safe',
    );
  });
});
