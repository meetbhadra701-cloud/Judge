'use server';

import { randomUUID } from 'node:crypto';
import type { CreateAssessmentResponse } from '@judge-copilot/schemas';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiRequest, projectPath } from '../../../../lib/api';

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
    redirect(`${page}?error=${encodeURIComponent(result.message)}`);
  }
  redirect(page);
}
