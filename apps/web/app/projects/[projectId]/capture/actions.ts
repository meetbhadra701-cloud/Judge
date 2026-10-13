'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { runCaptureRetry } from '../../../../lib/action-errors';
import { apiRequest } from '../../../../lib/api';
import { withSealedError } from '../../../../lib/flash';

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Retries ONE source's capture (a new immutable snapshot; the failed one stays on record). A capture that is already pending is not an
 * error: the page just shows it waiting (`runCaptureRetry`, covered by tests). Never requests an assessment.
 */
export async function retryCaptureAction(formData: FormData): Promise<void> {
  const projectId = text(formData, 'projectId');
  const sourceId = text(formData, 'sourceId');
  const page = `/projects/${encodeURIComponent(projectId)}/capture`;
  const outcome = await runCaptureRetry((path) => apiRequest('POST', path), projectId, sourceId);
  revalidatePath(page);
  if (outcome.kind === 'failed') redirect(withSealedError(page, outcome.message));
  redirect(page);
}
