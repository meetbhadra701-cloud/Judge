/*
 * What to tell a person when an action's request failed (R7-9). The important distinction is whether the request MAY have been processed:
 * a refusal (4xx) means it was not; "no usable answer" (the API was unreachable, the connection dropped, a 5xx or an unreadable reply)
 * means it may have been. For that second case the message must say so and say how to recover safely, instead of reporting a plain failure
 * that invites a blind retry or a false belief that nothing happened.
 */

export interface FailedRequest {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** True when the server may have processed the request although no usable answer reached us. */
export function outcomeIsUnknown(failure: FailedRequest): boolean {
  // the connection was never established: the request did not leave this machine, so nothing was saved (lib/api.ts)
  if (failure.code === 'API_UNREACHABLE') return false;
  return (
    failure.code === 'API_NO_ANSWER' || failure.code === 'UNKNOWN_ERROR' || failure.status >= 500
  );
}

/**
 * The message to show. A known refusal keeps the API's own words; an unknown outcome says that it is unknown and what is safe to do next
 * (`recovery`, written by the caller for its own action, always starting from "Reload this page to see what was saved").
 */
export function describeFailure(failure: FailedRequest, recovery: string): string {
  if (outcomeIsUnknown(failure)) {
    return `We could not confirm whether this was saved, because no usable answer arrived. ${recovery}`;
  }
  return failure.message;
}

export const CAPTURE_RETRY_RECOVERY =
  'Reload this page to see what was saved. A source can have at most one capture waiting, so pressing Retry again is safe and never queues a second one.';

export const ASSESSMENT_REQUEST_RECOVERY =
  'Reload this page to see whether a run was started. A project can have only one assessment run active at a time, and an assessment of unchanged material is never repeated, so requesting again is safe.';

export const QUESTION_GENERATE_RECOVERY =
  'Reload this page to see whether the questions were saved. A set of questions for the same assessment is never created twice, so generating again is safe.';

export const INTERVIEW_RECORD_RECOVERY =
  'Reload this page to see what was saved. Saving again is safe: the same request is never recorded twice, and what you typed is still in the box.';

// -- Retrying one source's capture ------------------------------------------------------------------------------------------------------

type ApiAnswer = { ok: true } | ({ ok: false } & FailedRequest);

export type CaptureRetryOutcome =
  | { readonly kind: 'requested' }
  /** A capture of that source is already waiting. Not an error: the page simply shows it waiting. */
  | { readonly kind: 'already_pending' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Asks the API for a new capture attempt of ONE source. `CAPTURE_ALREADY_PENDING` (a double click, or another operator was faster) is the
 * API's way of saying the work is already queued: it must read as success, never as a failure banner. Anything else is reported, with
 * recovery advice when the outcome is unknown.
 */
export async function runCaptureRetry(
  request: (path: string) => Promise<ApiAnswer>,
  projectId: string,
  sourceId: string,
): Promise<CaptureRetryOutcome> {
  const result = await request(
    `/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/captures`,
  );
  if (result.ok) return { kind: 'requested' };
  if (result.code === 'CAPTURE_ALREADY_PENDING') return { kind: 'already_pending' };
  return { kind: 'failed', message: describeFailure(result, CAPTURE_RETRY_RECOVERY) };
}

// -- Supplying the Devpost submission text by hand (P6B-beta3) ---------------------------------------------------------------------------

export const SUPPLY_CONTENT_RECOVERY =
  'Reload the capture page to see whether the text was stored. Sending the same text again is safe: identical text is recognized and never stored twice.';

export type SupplyContentOutcome =
  | { readonly kind: 'stored' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Sends the text an organizer typed or pasted for a Devpost source. The text is data: it is sent as-is, and the API normalizes and bounds it (a person
 * is told why it was refused, never "internal error").
 */
export async function runSupplyContent(
  request: (path: string, body: unknown) => Promise<ApiAnswer & { readonly data?: unknown }>,
  projectId: string,
  sourceId: string,
  text: string,
): Promise<SupplyContentOutcome> {
  if (text.trim() === '') return { kind: 'failed', message: 'Paste the submission text first.' };
  const result = await request(
    `/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/supplied-content`,
    { text },
  );
  if (result.ok) {
    const answer = (result.data as { result?: unknown } | undefined)?.result;
    return answer === 'unchanged' ? { kind: 'unchanged' } : { kind: 'stored' };
  }
  return { kind: 'failed', message: describeFailure(result, SUPPLY_CONTENT_RECOVERY) };
}
