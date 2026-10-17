import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ apiRequest: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('../../../../lib/api', () => ({
  apiRequest: api.apiRequest,
  projectPath: (id: string) => `/projects/${id}`,
}));
vi.mock('next/cache', () => ({ revalidatePath: api.revalidatePath }));

import { EMPTY_INTERVIEW_FORM } from '../../../../lib/interview-form';
import { recordJudgeObservationAction, recordTeamAnswerAction } from './actions';

/*
 * M7: the two Interview Mode server actions. Each is ONE API request carrying the form's request key as its Idempotency-Key; the browser never names an actor, a project
 * (beyond the one in the URL), an assessment's owner or a time; a failed save returns what was typed with the same key.
 */

const KEY = '11111111-1111-4111-8111-111111111111';
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const answerFields = {
  projectId: 'p1',
  setId: 's1',
  questionId: 'q1',
  requestKey: KEY,
  text: 'We use mesh radio.',
};
const observationFields = {
  projectId: 'p1',
  assessmentId: 'a1',
  requestKey: KEY,
  subject: 'Demo',
  observed: 'Saw it.',
  outcome: 'confirmed',
};

beforeEach(() => {
  api.apiRequest.mockReset();
  api.revalidatePath.mockReset();
});

describe('recordTeamAnswerAction', () => {
  it('sends one POST to the question’s own path with the form’s key as the Idempotency-Key and ONLY the text in the body', async () => {
    api.apiRequest.mockResolvedValue({ ok: true, data: {} });
    const state = await recordTeamAnswerAction(EMPTY_INTERVIEW_FORM, form(answerFields));
    expect(api.apiRequest).toHaveBeenCalledTimes(1);
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      '/projects/p1/question-sets/s1/questions/q1/team-answers',
      { text: 'We use mesh radio.' },
      { 'idempotency-key': KEY },
    );
    expect(state).toMatchObject({ saved: true, error: null, values: { text: '' } });
    expect(api.revalidatePath).toHaveBeenCalledWith('/projects/p1/interview');
  });

  it('a correction names the record it replaces; a forged field in the form (an actor, a role, a time) never reaches the API', async () => {
    api.apiRequest.mockResolvedValue({ ok: true, data: {} });
    await recordTeamAnswerAction(
      EMPTY_INTERVIEW_FORM,
      form({
        ...answerFields,
        supersedesAnswerId: '22222222-2222-4222-8222-222222222222',
        recordedBy: 'someone',
        actorId: 'x',
        createdAt: '2001-01-01',
        role: 'organizer',
      }),
    );
    const body = api.apiRequest.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['supersedesAnswerId', 'text']);
  });

  it('a malformed key is replaced by a fresh one (the request is still idempotent per submission)', async () => {
    api.apiRequest.mockResolvedValue({ ok: true, data: {} });
    await recordTeamAnswerAction(
      EMPTY_INTERVIEW_FORM,
      form({ ...answerFields, requestKey: 'not-a-uuid' }),
    );
    const key = (api.apiRequest.mock.calls[0]?.[3] as Record<string, string>)['idempotency-key'];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(key).not.toBe('not-a-uuid');
  });

  it('a refusal of the content names the rule and keeps what was typed; nothing is revalidated', async () => {
    api.apiRequest.mockResolvedValue({
      ok: false,
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Invalid request body',
      issues: [{ path: 'text', message: 'The answer must not be empty' }],
    });
    const state = await recordTeamAnswerAction(
      EMPTY_INTERVIEW_FORM,
      form({ ...answerFields, text: '' }),
    );
    expect(state).toMatchObject({
      saved: false,
      error: 'The answer must not be empty',
      outcomeUnknown: false,
    });
    expect(api.revalidatePath).not.toHaveBeenCalled();
    const typed = await recordTeamAnswerAction(
      EMPTY_INTERVIEW_FORM,
      form({ ...answerFields, text: 'kept text' }),
    );
    expect(typed.values.text).toBe('kept text');
  });

  it('a lost answer says the outcome is unknown, keeps the text, and the next press carries the same key', async () => {
    api.apiRequest.mockResolvedValue({
      ok: false,
      status: 503,
      code: 'API_NO_ANSWER',
      message: 'x',
      issues: [],
    });
    const state = await recordTeamAnswerAction(EMPTY_INTERVIEW_FORM, form(answerFields));
    expect(state.error).toMatch(/could not confirm whether this was saved/i);
    expect(state.error).toMatch(/Saving again is safe/);
    expect(state).toMatchObject({
      outcomeUnknown: true,
      saved: false,
      values: { text: 'We use mesh radio.' },
    });
    await recordTeamAnswerAction(state, form(answerFields));
    const keys = api.apiRequest.mock.calls.map(
      (c) => (c[3] as Record<string, string>)['idempotency-key'],
    );
    expect(keys).toEqual([KEY, KEY]);
  });

  it('an unreachable API says nothing was sent; a typed refusal keeps the API’s own words (a voided project)', async () => {
    api.apiRequest.mockResolvedValueOnce({
      ok: false,
      status: 503,
      code: 'API_UNREACHABLE',
      message: 'The Judge Copilot API is not reachable. The request was not sent.',
      issues: [],
    });
    const unreachable = await recordTeamAnswerAction(EMPTY_INTERVIEW_FORM, form(answerFields));
    expect(unreachable).toMatchObject({
      error: 'The Judge Copilot API is not reachable. The request was not sent.',
      outcomeUnknown: false,
    });
    api.apiRequest.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: 'PROJECT_VOIDED',
      message: 'This project was voided by an organizer.',
      issues: [],
    });
    const voided = await recordTeamAnswerAction(EMPTY_INTERVIEW_FORM, form(answerFields));
    expect(voided).toMatchObject({
      error: 'This project was voided by an organizer.',
      outcomeUnknown: false,
    });
  });
});

describe('recordJudgeObservationAction', () => {
  it('sends one POST to the assessment’s observation path; a standalone observation names no question', async () => {
    api.apiRequest.mockResolvedValue({ ok: true, data: {} });
    const state = await recordJudgeObservationAction(EMPTY_INTERVIEW_FORM, form(observationFields));
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      '/projects/p1/assessments/a1/judge-observations',
      { subject: 'Demo', observed: 'Saw it.', outcome: 'confirmed' },
      { 'idempotency-key': KEY },
    );
    expect(state.saved).toBe(true);
  });

  it('links the question, the set and the answer when given, and the record it corrects; an unchosen outcome is sent as nothing, never guessed', async () => {
    api.apiRequest.mockResolvedValue({ ok: true, data: {} });
    await recordJudgeObservationAction(
      EMPTY_INTERVIEW_FORM,
      form({
        ...observationFields,
        setId: 's1',
        questionId: 'q1',
        teamAnswerId: 't1',
        supersedesObservationId: 'o0',
        actorId: 'x',
        recordedBy: 'y',
      }),
    );
    expect(api.apiRequest.mock.calls[0]?.[2]).toEqual({
      subject: 'Demo',
      observed: 'Saw it.',
      outcome: 'confirmed',
      questionSetId: 's1',
      questionId: 'q1',
      teamAnswerId: 't1',
      supersedesObservationId: 'o0',
    });
    api.apiRequest.mockClear();
    await recordJudgeObservationAction(
      EMPTY_INTERVIEW_FORM,
      form({ ...observationFields, outcome: '' }),
    );
    expect(api.apiRequest.mock.calls[0]?.[2]).toEqual({ subject: 'Demo', observed: 'Saw it.' });
  });

  it('a refusal names the rule and keeps every typed field and the chosen outcome', async () => {
    api.apiRequest.mockResolvedValue({
      ok: false,
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Invalid request body',
      issues: [{ path: 'outcome', message: 'Choose what the attempt showed' }],
    });
    const state = await recordJudgeObservationAction(
      EMPTY_INTERVIEW_FORM,
      form({ ...observationFields, outcome: '', teamAnswerId: 't1' }),
    );
    expect(state.error).toBe('Choose what the attempt showed');
    expect(state.values).toMatchObject({
      subject: 'Demo',
      observed: 'Saw it.',
      outcome: '',
      teamAnswerId: 't1',
    });
  });
});

describe('the server-action module', () => {
  it('is a "use server" file that exports only async functions (a constant exported from it breaks the client in production), and its state lives elsewhere', () => {
    const source = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
    expect(source.startsWith("'use server';")).toBe(true);
    const exported = [...source.matchAll(/^export (.+)$/gm)].map((m) =>
      (m[1] ?? '').replace(/\(.*$/, '').trim(),
    );
    expect(exported).toEqual([
      'async function recordTeamAnswerAction',
      'async function recordJudgeObservationAction',
    ]);
    expect(source).not.toMatch(/export (const|let|var|class|interface|type)\b/);
  });
});
