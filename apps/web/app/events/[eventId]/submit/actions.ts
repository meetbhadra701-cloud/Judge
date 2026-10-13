'use server';

import { redirect } from 'next/navigation';
import { apiRequest } from '../../../../lib/api';
import { runSubmission, type SubmissionField } from '../../../../lib/submission';

export interface SubmitState {
  /** Incremented per submission so the form re-renders its messages. */
  readonly attempt: number;
  readonly values: { readonly github: string; readonly devpost: string; readonly name: string };
  readonly errors: Readonly<Partial<Record<SubmissionField, string>>>;
  readonly formError: string | null;
  /** The project that already exists after a partial failure, so nothing is lost by retrying. */
  readonly projectId: string | null;
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * "Start analysis": creates (or reuses) the project, declares the two sources and requests their captures through the existing API.
 * It never requests an assessment. The browser never sends a URL anywhere but here; this action never fetches one.
 */
export async function submitProjectAction(
  previous: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const eventId = text(formData, 'eventId');
  const values = {
    github: text(formData, 'github'),
    devpost: text(formData, 'devpost'),
    name: text(formData, 'name'),
  };
  const outcome = await runSubmission(apiRequest, eventId, values);
  if (outcome.kind === 'started') {
    redirect(`/projects/${encodeURIComponent(outcome.projectId)}/capture`);
  }
  if (outcome.kind === 'invalid') {
    return {
      attempt: previous.attempt + 1,
      values,
      errors: outcome.errors,
      formError: null,
      projectId: null,
    };
  }
  return {
    attempt: previous.attempt + 1,
    values,
    errors: outcome.field ? { [outcome.field]: outcome.message } : {},
    formError: outcome.field ? null : outcome.message,
    projectId: outcome.projectId ?? null,
  };
}
