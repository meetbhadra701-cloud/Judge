'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiRequest, projectPath } from '../../../../lib/api';

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Retries ONE source's capture (a new immutable snapshot; the failed one stays on record). A capture that is already pending is not an
 * error: the page just shows it waiting. Never requests an assessment.
 */
export async function retryCaptureAction(formData: FormData): Promise<void> {
  const projectId = text(formData, 'projectId');
  const sourceId = text(formData, 'sourceId');
  const page = `/projects/${encodeURIComponent(projectId)}/capture`;
  const result = await apiRequest(
    'POST',
    `${projectPath(projectId)}/sources/${encodeURIComponent(sourceId)}/captures`,
  );
  revalidatePath(page);
  if (!result.ok && result.code !== 'CAPTURE_ALREADY_PENDING') {
    redirect(`${page}?error=${encodeURIComponent(result.message)}`);
  }
  redirect(page);
}
