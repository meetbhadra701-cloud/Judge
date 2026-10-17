'use server';

import { randomUUID } from 'node:crypto';
import type {
  RecordJudgeObservationResponse,
  RecordTeamAnswerResponse,
} from '@judge-copilot/schemas';
import { revalidatePath } from 'next/cache';
import { apiRequest, projectPath, type ApiResult } from '../../../../lib/api';
import { EMPTY_INTERVIEW_FORM, type InterviewFormState } from '../../../../lib/interview-form';
import {
  describeFailure,
  INTERVIEW_RECORD_RECOVERY,
  outcomeIsUnknown,
} from '../../../../lib/action-errors';

/*
 * The two writes of Interview Mode. Each is ONE API request carrying the page's request key as its Idempotency-Key, so pressing the button twice, or again after
 * an answer that never arrived, is the same logical request: the API saves it once. A failed save returns the typed text with the same key, so nothing typed is
 * lost and a retry cannot duplicate. The browser never sends an actor, a project, an assessment or a timestamp: the API takes the actor from the server-side
 * credential and derives everything else from the identifiers below, checked against the project.
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function answered<T>(
  previous: InterviewFormState,
  values: InterviewFormState['values'],
  result: ApiResult<T>,
  projectId: string,
): InterviewFormState {
  if (result.ok) {
    revalidatePath(`/projects/${encodeURIComponent(projectId)}/interview`);
    return { ...EMPTY_INTERVIEW_FORM, attempt: previous.attempt + 1, saved: true };
  }
  // a refusal of the request's own content names the rule (never the text); anything else keeps the API's words, or says the outcome is unknown
  const rule =
    result.status === 400 && result.issues.length > 0 ? result.issues[0]?.message : undefined;
  return {
    attempt: previous.attempt + 1,
    saved: false,
    error: rule ?? describeFailure(result, INTERVIEW_RECORD_RECOVERY),
    outcomeUnknown: rule === undefined && outcomeIsUnknown(result),
    values,
  };
}

/** Records the team's answer to ONE suggested question (or, with `supersedesAnswerId`, a correction of an earlier record of that answer). */
export async function recordTeamAnswerAction(
  previous: InterviewFormState,
  formData: FormData,
): Promise<InterviewFormState> {
  const projectId = field(formData, 'projectId');
  const setId = field(formData, 'setId');
  const questionId = field(formData, 'questionId');
  const supersedes = field(formData, 'supersedesAnswerId');
  const requestKey = UUID.test(field(formData, 'requestKey'))
    ? field(formData, 'requestKey')
    : randomUUID();
  const values = { ...EMPTY_INTERVIEW_FORM.values, text: field(formData, 'text') };
  const result = await apiRequest<RecordTeamAnswerResponse>(
    'POST',
    `${projectPath(projectId)}/question-sets/${encodeURIComponent(setId)}/questions/${encodeURIComponent(questionId)}/team-answers`,
    { text: values.text, ...(supersedes === '' ? {} : { supersedesAnswerId: supersedes }) },
    { 'idempotency-key': requestKey },
  );
  return answered(previous, values, result, projectId);
}

/** Records the judge's own observation of a live demonstration or verification attempt, linked to a question (and an answer) or standing alone. */
export async function recordJudgeObservationAction(
  previous: InterviewFormState,
  formData: FormData,
): Promise<InterviewFormState> {
  const projectId = field(formData, 'projectId');
  const assessmentId = field(formData, 'assessmentId');
  const setId = field(formData, 'setId');
  const questionId = field(formData, 'questionId');
  const supersedes = field(formData, 'supersedesObservationId');
  const requestKey = UUID.test(field(formData, 'requestKey'))
    ? field(formData, 'requestKey')
    : randomUUID();
  const values = {
    ...EMPTY_INTERVIEW_FORM.values,
    subject: field(formData, 'subject'),
    observed: field(formData, 'observed'),
    outcome: field(formData, 'outcome'),
    teamAnswerId: field(formData, 'teamAnswerId'),
  };
  const result = await apiRequest<RecordJudgeObservationResponse>(
    'POST',
    `${projectPath(projectId)}/assessments/${encodeURIComponent(assessmentId)}/judge-observations`,
    {
      subject: values.subject,
      observed: values.observed,
      // an unchosen outcome is sent as nothing, so the API names the missing choice instead of the browser guessing one
      ...(values.outcome === '' ? {} : { outcome: values.outcome }),
      ...(questionId === '' || setId === '' ? {} : { questionSetId: setId, questionId }),
      ...(values.teamAnswerId === '' ? {} : { teamAnswerId: values.teamAnswerId }),
      ...(supersedes === '' ? {} : { supersedesObservationId: supersedes }),
    },
    { 'idempotency-key': requestKey },
  );
  return answered(previous, values, result, projectId);
}
