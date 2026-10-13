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
  /** True when the request may or may not have been saved: pressing the button again with the same form is the safe recovery. */
  readonly outcomeUnknown: boolean;
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * "Analyze Project": ONE atomic, idempotent API operation creates the project, declares both sources and requests both captures.
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
  // the key was generated when the form was rendered: a retry of THIS form can only converge on the project it created
  const outcome = await runSubmission(apiRequest, eventId, values, text(formData, 'submissionKey'));
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
      outcomeUnknown: false,
    };
  }
  return {
    attempt: previous.attempt + 1,
    values,
    errors: outcome.field ? { [outcome.field]: outcome.message } : {},
    formError: outcome.field ? null : outcome.message,
    projectId: outcome.projectId ?? null,
    outcomeUnknown: outcome.outcomeUnknown === true,
  };
}
