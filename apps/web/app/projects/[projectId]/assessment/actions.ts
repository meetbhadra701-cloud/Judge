'use server';

import { randomUUID } from 'node:crypto';
import type { CreateAssessmentResponse, CreateQuestionSetResponse } from '@judge-copilot/schemas';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiRequest, projectPath } from '../../../../lib/api';
import {
  ASSESSMENT_REQUEST_RECOVERY,
  describeFailure,
  QUESTION_GENERATE_RECOVERY,
} from '../../../../lib/action-errors';
import { withSealedError } from '../../../../lib/flash';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Requests an assessment. The page renders a fresh `requestKey` into the form, so a double submit
 * of the SAME rendered form is the same logical request (the API replays it); a new page load is
 * a new request. Explicit reassessment is a deliberate, separately confirmed mode.
 */
export async function requestAssessmentAction(formData: FormData): Promise<void> {
  const projectId = field(formData, 'projectId');
  const requestKey = field(formData, 'requestKey') || randomUUID();
  const mode = field(formData, 'mode') === 'reassess' ? 'reassess' : 'assess';
  const page = `/projects/${encodeURIComponent(projectId)}/assessment`;
  const result = await apiRequest<CreateAssessmentResponse>(
    'POST',
    `${projectPath(projectId)}/assessments`,
    { mode },
    { 'idempotency-key': requestKey },
  );
  revalidatePath(page);
  if (!result.ok) {
    redirect(withSealedError(page, describeFailure(result, ASSESSMENT_REQUEST_RECOVERY)));
  }
  redirect(page);
}

/**
 * Generates the suggested interview questions of ONE assessment. The API is idempotent (the same assessment, policy, prompt and provider return the stored
 * set), so a double submit is harmless. The form carries no question, rank, count or provider: nothing the browser sends can shape the result.
 */
export async function generateQuestionsAction(formData: FormData): Promise<void> {
  const projectId = field(formData, 'projectId');
  const assessmentId = field(formData, 'assessmentId');
  const page = `/projects/${encodeURIComponent(projectId)}/assessment`;
  const result = await apiRequest<CreateQuestionSetResponse>(
    'POST',
    `${projectPath(projectId)}/assessments/${encodeURIComponent(assessmentId)}/question-sets`,
    {},
  );
  revalidatePath(page);
  if (!result.ok) {
    redirect(withSealedError(page, describeFailure(result, QUESTION_GENERATE_RECOVERY)));
  }
  redirect(`${page}?version=${encodeURIComponent(assessmentId)}#questions-heading`);
}
