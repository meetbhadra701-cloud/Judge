'use server';

import { redirect } from 'next/navigation';
import { apiRequest } from '../../../../lib/api';
import { runCorrection, type CorrectionField } from '../../../../lib/submission';
import { postedTrackKeys } from '../../../../lib/tracks';

export interface CorrectState {
  readonly attempt: number;
  readonly values: {
    readonly reason: string;
    readonly replace: boolean;
    readonly github: string;
    readonly devpost: string;
    readonly name: string;
    /** `null` until the form has been submitted once (the form then starts from the voided project's tracks). */
    readonly trackKeys: readonly string[] | null;
    readonly cancelPending: boolean;
  };
  readonly errors: Readonly<Partial<Record<CorrectionField, string>>>;
  readonly formError: string | null;
  readonly projectId: string | null;
  readonly outcomeUnknown: boolean;
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Voids the project (and, when asked, submits the corrected pair as a new project) in ONE atomic, idempotent API operation. Nothing is edited
 * or deleted. The key was generated when the form was rendered, so sending the same form again can only return the original result.
 */
export async function correctProjectAction(
  previous: CorrectState,
  formData: FormData,
): Promise<CorrectState> {
  const projectId = text(formData, 'projectId');
  const values = {
    reason: text(formData, 'reason'),
    replace: text(formData, 'replace') === 'yes',
    github: text(formData, 'github'),
    devpost: text(formData, 'devpost'),
    name: text(formData, 'name'),
    trackKeys: postedTrackKeys(formData.getAll('trackKeys')),
    cancelPending: text(formData, 'cancelPending') === 'yes',
  };
  const contextVersionId = text(formData, 'contextVersionId');
  const outcome = await runCorrection(
    apiRequest,
    projectId,
    // the track section exists only when the page offered tracks (its token travels with it)
    contextVersionId === '' ? { ...values, trackKeys: undefined } : { ...values, contextVersionId },
    text(formData, 'correctionKey'),
  );
  if (outcome.kind === 'done') {
    redirect(
      outcome.replacementProjectId === null
        ? `/projects/${encodeURIComponent(outcome.voidedProjectId)}`
        : `/projects/${encodeURIComponent(outcome.replacementProjectId)}/capture`,
    );
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
