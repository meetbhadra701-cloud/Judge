import {
  parseDevpostProjectUrl,
  parseGithubRepositoryUrl,
  type DevpostProjectRef,
  type GithubRepositoryRef,
  type UrlRejectionReason,
} from '@judge-copilot/capture';
import {
  SOURCE_INGESTION_LIMITS,
  type EventDetail,
  type ProjectDetail,
  type SubmissionResult,
  type SubmitProjectResponse,
  type VoidProjectResponse,
} from '@judge-copilot/schemas';

/*
 * The pure rules of the project submission form (P6B-alpha). Nothing here performs a request. URL validation REUSES the declared-URL
 * policy of `@judge-copilot/capture` (the same functions the API applies when a source is declared), so the form explains a bad URL
 * before any request and cannot accept one the API would refuse. Whether a host may actually be contacted is NOT decided here: that is
 * the capture layer's SSRF policy (`safe-http`), at capture time. The web tier never fetches a submitted URL.
 */

export type SubmissionField = 'github' | 'devpost' | 'name';

export interface SubmissionInput {
  readonly github: string;
  readonly devpost: string;
  /** Optional override of the derived project name. */
  readonly name: string;
}

export type SubmissionValidation =
  | {
      readonly ok: true;
      readonly github: GithubRepositoryRef;
      readonly devpost: DevpostProjectRef;
      readonly projectName: string;
      /** True when the name was derived from the GitHub URL rather than typed. */
      readonly nameDerived: boolean;
    }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<SubmissionField, string>>> };

const EXAMPLE_GITHUB = 'https://github.com/owner/repository';
const EXAMPLE_DEVPOST = 'https://devpost.com/software/project-name';

/** Plain-language explanation of why a declared URL was refused, for the field it was typed into. */
export function describeUrlRejection(
  field: 'github' | 'devpost',
  reason: UrlRejectionReason,
  raw: string,
): string {
  const example = field === 'github' ? EXAMPLE_GITHUB : EXAMPLE_DEVPOST;
  const label = field === 'github' ? 'GitHub repository' : 'Devpost project';
  switch (reason) {
    case 'invalid_url':
      return `This is not a URL. Paste the full ${label} link, for example ${example}.`;
    case 'too_long':
      return `This URL is too long (the limit is ${String(SOURCE_INGESTION_LIMITS.urlMaxChars)} characters).`;
    case 'scheme_not_allowed':
      return `Only http(s) links are accepted. Paste the ${label} link, for example ${example}.`;
    case 'credentials_in_url':
      return 'Remove the user name and password from the URL: links with credentials are never accepted.';
    case 'unsupported_host': {
      const other =
        field === 'github' && /devpost\.com/i.test(raw)
          ? ' That looks like a Devpost link; it belongs in the Devpost field.'
          : field === 'devpost' && /github\.com/i.test(raw)
            ? ' That looks like a GitHub link; it belongs in the GitHub field.'
            : '';
      return `This is not a ${field === 'github' ? 'github.com' : 'devpost.com'} link.${other} Example: ${example}.`;
    }
    case 'unsupported_path':
      return field === 'github'
        ? `Paste the repository home page (${EXAMPLE_GITHUB}), not a file, branch, issue or user page.`
        : `Paste the public project page (${EXAMPLE_DEVPOST}), not a gallery, user or hackathon page.`;
  }
}

/** Control characters, line and paragraph separators never belong in a project name. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** The project name derived from the repository: `owner/repo`, lowercase, as parsed (deterministic, at most 140 characters). */
export function deriveProjectName(github: GithubRepositoryRef): string {
  return `${github.owner}/${github.repo}`;
}

export function validateSubmission(input: SubmissionInput): SubmissionValidation {
  const errors: Partial<Record<SubmissionField, string>> = {};
  const githubRaw = input.github.trim();
  const devpostRaw = input.devpost.trim();
  let github: GithubRepositoryRef | null = null;
  let devpost: DevpostProjectRef | null = null;

  if (githubRaw === '') {
    errors.github = `Enter the GitHub repository URL, for example ${EXAMPLE_GITHUB}.`;
  } else {
    const parsed = parseGithubRepositoryUrl(githubRaw);
    if (typeof parsed === 'string')
      errors.github = describeUrlRejection('github', parsed, githubRaw);
    else github = parsed;
  }
  if (devpostRaw === '') {
    errors.devpost = `Enter the Devpost project URL, for example ${EXAMPLE_DEVPOST}.`;
  } else {
    const parsed = parseDevpostProjectUrl(devpostRaw);
    if (typeof parsed === 'string')
      errors.devpost = describeUrlRejection('devpost', parsed, devpostRaw);
    else devpost = parsed;
  }

  const typedName = input.name.trim();
  if (typedName !== '') {
    if (typedName.length > SOURCE_INGESTION_LIMITS.projectNameMaxChars) {
      errors.name = `The name is too long (the limit is ${String(SOURCE_INGESTION_LIMITS.projectNameMaxChars)} characters).`;
    } else if (CONTROL.test(typedName)) {
      errors.name = 'The name must not contain control characters or line breaks.';
    }
  }

  if (Object.keys(errors).length > 0 || github === null || devpost === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    github,
    devpost,
    projectName: typedName === '' ? deriveProjectName(github) : typedName,
    nameDerived: typedName === '',
  };
}

// -- The submission flow ---------------------------------------------------------------------------------------------------------------

/*
 * "Analyze Project" (P6B-beta1). The whole submission is ONE server operation, `POST /events/:id/submissions` (header `Idempotency-Key`):
 * project, both source declarations and both capture requests are written atomically or not at all. This file only validates the form,
 * sends that one request and explains the answer. It never calls an assessment route, so submitting can never start a paid or live-model
 * run.
 *
 * Why this replaced the alpha orchestration (R7-1): the alpha flow composed project creation, source declaration and capture requests as
 * separate read-then-write calls and adopted an existing project by NAME. Two simultaneous submissions that shared a name could therefore
 * end up in one project holding both submissions' links. Identity is now the canonical (event, GitHub URL, Devpost URL) pair, enforced by
 * unique constraints in the database; a name is only a label; and retrying with the same key can only ever return the original result.
 *
 * The idempotency key is generated when the form is rendered and travels with the form, so a retry of the SAME form after a lost response
 * is safe: it converges on the project the first attempt created, or creates it once.
 */

/** Structurally the web tier's `ApiResult` (lib/api.ts): kept here so this file has no relative import and tests can import it as is. */
export type SubmissionApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      issues: unknown[];
      /** The error's client-safe `details` (for example the project that already uses a link). */
      details?: Readonly<Record<string, unknown>> | undefined;
    };

export type ApiFn = <T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
) => Promise<SubmissionApiResult<T>>;

export type SubmissionOutcome =
  | {
      readonly kind: 'invalid';
      readonly errors: Readonly<Partial<Record<SubmissionField, string>>>;
    }
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly field?: SubmissionField | undefined;
      /** A project the organizer can open: the one that already uses a link, or the one this form already created. */
      readonly projectId?: string | undefined;
      /**
       * True when the request may or may not have been saved (no usable answer arrived). Resubmitting the SAME form is the safe recovery:
       * it can never create a second project.
       */
      readonly outcomeUnknown?: boolean | undefined;
    }
  | {
      readonly kind: 'started';
      readonly projectId: string;
      readonly projectName: string;
      readonly result: SubmissionResult;
    };

const base = (eventId: string) => `/events/${encodeURIComponent(eventId)}`;

/** A key is a UUID, exactly as the API requires; anything else is not forwarded (the API would answer 400). */
export function isSubmissionKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Statuses after which the server may have processed the request although no usable answer reached us. */
function outcomeIsUnknown(status: number, code: string): boolean {
  if (code === 'API_UNREACHABLE') return false; // the connection was never established: nothing was sent, nothing was saved
  return code === 'API_NO_ANSWER' || code === 'UNKNOWN_ERROR' || status >= 500;
}

export async function runSubmission(
  api: ApiFn,
  eventId: string,
  input: SubmissionInput,
  idempotencyKey: string,
): Promise<SubmissionOutcome> {
  const checked = validateSubmission(input);
  if (!checked.ok) return { kind: 'invalid', errors: checked.errors };
  if (!isSubmissionKey(idempotencyKey)) {
    return {
      kind: 'failed',
      message: 'This form has expired. Reload the page and submit again; nothing was saved.',
    };
  }

  // the hackathon must exist and have a LOCKED Event Context (the API enforces it too; this gives the organizer a plain message)
  const event = await api<EventDetail>('GET', base(eventId));
  if (!event.ok) {
    return {
      kind: 'failed',
      message: event.status === 404 ? 'This hackathon does not exist.' : event.message,
      outcomeUnknown: false,
    };
  }
  if (event.data.lockedVersionId === null) {
    return {
      kind: 'failed',
      message:
        'This hackathon has no locked Event Context yet. Lock one first: projects are judged only against a locked context.',
    };
  }

  const response = await api<SubmitProjectResponse>(
    'POST',
    `${base(eventId)}/submissions`,
    {
      githubUrl: checked.github.canonicalUrl,
      devpostUrl: checked.devpost.canonicalUrl,
      // only a name the organizer typed is sent: a derived one is the server's decision
      ...(checked.nameDerived ? {} : { name: checked.projectName }),
    },
    { 'idempotency-key': idempotencyKey },
  );
  if (response.ok) {
    return {
      kind: 'started',
      projectId: response.data.project.id,
      projectName: response.data.project.name,
      result: response.data.result,
    };
  }
  return explainRefusal(response);
}

type Refusal = Extract<SubmissionApiResult<never>, { ok: false }>;

/** The project an error points at, when it carries one (`projectIds[0]` for a conflict, `projectId` for a reused key). */
function projectOf(refusal: Refusal): string | undefined {
  const ids = refusal.details?.['projectIds'];
  const first: unknown = Array.isArray(ids) ? ids[0] : refusal.details?.['projectId'];
  return typeof first === 'string' ? first : undefined;
}

function explainRefusal(refusal: Refusal): SubmissionOutcome {
  switch (refusal.code) {
    case 'SUBMISSION_CONFLICT':
      return {
        kind: 'failed',
        message:
          'Another project in this hackathon already uses this GitHub repository or Devpost page, with a different second link. Nothing was saved and nothing was merged. If it is the same project, use exactly the same two links; if the existing one is wrong, ask an organizer to review it.',
        projectId: projectOf(refusal),
      };
    case 'PROJECT_NAME_TAKEN':
      return {
        kind: 'failed',
        field: 'name',
        message:
          'A project with this name (ignoring capital letters) already exists in this hackathon. Nothing was saved. Enter a different project name.',
      };
    case 'IDEMPOTENCY_KEY_REUSED':
      return {
        kind: 'failed',
        message:
          'This form was already used to submit different links. Nothing new was saved. Reload the page to start a new submission.',
        projectId: projectOf(refusal),
      };
    case 'INVALID_SOURCE_URL':
      return {
        kind: 'failed',
        message:
          'The server did not accept one of the links. Check both links and try again. Nothing was saved.',
      };
    case 'NO_LOCKED_CONTEXT':
      return { kind: 'failed', message: 'This hackathon has no locked Event Context yet.' };
    case 'API_UNREACHABLE':
      return {
        kind: 'failed',
        outcomeUnknown: false,
        message:
          'The Judge Copilot API is not reachable, so the submission was not sent and nothing was saved. Try again in a moment.',
      };
    default:
      if (outcomeIsUnknown(refusal.status, refusal.code)) {
        return {
          kind: 'failed',
          outcomeUnknown: true,
          message:
            'We could not confirm whether the submission was saved: no usable answer arrived. Press the button again. Submitting the same form twice is safe and never creates a second project. If the problem continues, check the hackathon page for the project before retrying.',
        };
      }
      return { kind: 'failed', message: refusal.message };
  }
}

/*
 * Correcting an erroneous submission (P6B-beta2). A submission is never edited in place: an authorized organizer VOIDS the project (with a
 * reason that stays on record) and, in the same operation, submits the corrected GitHub + Devpost pair as a NEW project. The voided project
 * keeps everything that was captured and assessed for it; it only stops accepting new work. One server operation, one idempotency key
 * (generated when the form is rendered), so a retry after a lost answer can only return the original result.
 */

export const REASON_MAX_CHARS = 1_000;
const REASON_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export type CorrectionField = SubmissionField | 'reason';

export interface CorrectionInput {
  /** Why the project is being voided (organizer free text, a single line). */
  readonly reason: string;
  /** True: submit the corrected pair as a replacement. False: only void (the project stays on record, nothing replaces it). */
  readonly replace: boolean;
  readonly github: string;
  readonly devpost: string;
  readonly name: string;
  /** Also cancel this project's capture and assessment requests that no worker has started (recovery when no worker is running). */
  readonly cancelPending?: boolean;
}

export type CorrectionOutcome =
  | {
      readonly kind: 'invalid';
      readonly errors: Readonly<Partial<Record<CorrectionField, string>>>;
    }
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly field?: CorrectionField | undefined;
      readonly projectId?: string | undefined;
      /** True when the request may or may not have been applied: sending the SAME form again is the safe recovery. */
      readonly outcomeUnknown?: boolean | undefined;
    }
  | {
      readonly kind: 'done';
      readonly result: VoidProjectResponse['result'];
      readonly voidedProjectId: string;
      /** The corrected project, when there is one. */
      readonly replacementProjectId: string | null;
    };

export function validateCorrection(
  input: CorrectionInput,
): { readonly ok: true } | Extract<CorrectionOutcome, { kind: 'invalid' }> {
  const errors: Partial<Record<CorrectionField, string>> = {};
  const reason = input.reason.trim();
  if (reason === '')
    errors.reason = 'Say why this project is being voided. The reason stays on record.';
  else if (reason.length > REASON_MAX_CHARS)
    errors.reason = `The reason is too long (the limit is ${String(REASON_MAX_CHARS)} characters).`;
  else if (REASON_CONTROL.test(reason))
    errors.reason = 'The reason must be a single line without control characters.';
  if (input.replace) {
    const checked = validateSubmission({
      github: input.github,
      devpost: input.devpost,
      name: input.name,
    });
    if (!checked.ok) Object.assign(errors, checked.errors);
  }
  return Object.keys(errors).length > 0 ? { kind: 'invalid', errors } : { ok: true };
}

type CorrectionRefusal = Extract<SubmissionApiResult<never>, { ok: false }>;

function correctionProjectOf(refusal: CorrectionRefusal): string | undefined {
  const ids = refusal.details?.['projectIds'];
  const first: unknown = Array.isArray(ids) ? ids[0] : refusal.details?.['projectId'];
  return typeof first === 'string' ? first : undefined;
}

function explainCorrection(refusal: CorrectionRefusal): CorrectionOutcome {
  switch (refusal.code) {
    case 'PROJECT_ALREADY_VOIDED':
      return {
        kind: 'failed',
        message: 'This project was already voided. Nothing was changed.',
        projectId: correctionProjectOf(refusal),
      };
    case 'PROJECT_HAS_PENDING_WORK':
      return {
        kind: 'failed',
        message:
          'A capture or run of this project is still pending. If a worker is running, wait until it has finished (the capture page shows its progress) and try again. If NO worker is running, tick “Also cancel requests that have not been started” and send the form again: that cancels only requests no worker has started, and it is recorded. A request a worker has already started is never cancelled. Nothing was changed.',
      };
    case 'SUBMISSION_CONFLICT':
      return {
        kind: 'failed',
        message:
          'Another project in this hackathon already uses one of the corrected links, or already is the corrected submission. Nothing was changed: the project is not voided. Open that project instead, or choose different links.',
        projectId: correctionProjectOf(refusal),
      };
    case 'PROJECT_NAME_TAKEN':
      return {
        kind: 'failed',
        field: 'name',
        message:
          'A project with this name (ignoring capital letters) already exists in this hackathon. Nothing was changed. Enter a different project name.',
      };
    case 'IDEMPOTENCY_KEY_REUSED':
      return {
        kind: 'failed',
        message:
          'This form was already used for a different correction. Nothing new was changed. Reload the page to start again.',
        projectId: correctionProjectOf(refusal),
      };
    case 'INVALID_SOURCE_URL':
      return {
        kind: 'failed',
        message:
          'The server did not accept one of the corrected links. Check them. Nothing was changed.',
      };
    case 'PROJECT_NOT_FOUND':
      return { kind: 'failed', message: 'This project does not exist.' };
    case 'API_UNREACHABLE':
      return {
        kind: 'failed',
        outcomeUnknown: false,
        message:
          'The Judge Copilot API is not reachable, so the correction was not sent and nothing was changed. Try again in a moment.',
      };
    default:
      if (
        refusal.code === 'API_NO_ANSWER' ||
        refusal.code === 'UNKNOWN_ERROR' ||
        refusal.status >= 500
      ) {
        return {
          kind: 'failed',
          outcomeUnknown: true,
          message:
            'We could not confirm whether the correction was applied: no usable answer arrived. Reload the project page to see whether it is marked as voided. Sending this same form again is safe: it can only return the original result and never creates a second replacement.',
        };
      }
      return { kind: 'failed', message: refusal.message };
  }
}

export async function runCorrection(
  api: ApiFn,
  projectId: string,
  input: CorrectionInput,
  idempotencyKey: string,
): Promise<CorrectionOutcome> {
  const checked = validateCorrection(input);
  if (!('ok' in checked)) return checked;
  if (!isSubmissionKey(idempotencyKey)) {
    return {
      kind: 'failed',
      message: 'This form has expired. Reload the page and submit again; nothing was changed.',
    };
  }
  const submission = input.replace
    ? validateSubmission({ github: input.github, devpost: input.devpost, name: input.name })
    : null;
  if (submission && !submission.ok) return { kind: 'invalid', errors: submission.errors };
  const response = await api<VoidProjectResponse>(
    'POST',
    `/projects/${encodeURIComponent(projectId)}/void`,
    {
      reason: input.reason.trim(),
      ...(input.cancelPending === true ? { cancelPendingWork: true } : {}),
      ...(submission?.ok
        ? {
            replacement: {
              githubUrl: submission.github.canonicalUrl,
              devpostUrl: submission.devpost.canonicalUrl,
              // only a name the organizer typed is sent: a derived one is the server's decision
              ...(submission.nameDerived ? {} : { name: submission.projectName }),
            },
          }
        : {}),
    },
    { 'idempotency-key': idempotencyKey },
  );
  if (response.ok) {
    return {
      kind: 'done',
      result: response.data.result,
      voidedProjectId: response.data.project.id,
      replacementProjectId: response.data.replacement?.project.id ?? null,
    };
  }
  return explainCorrection(response);
}

/** Whether a project is shown as history: voided projects accept no new capture, source or assessment. */
export function isVoided(project: Pick<ProjectDetail, 'voided'>): boolean {
  return project.voided !== null;
}

/** The sentence every page shows for a voided project. The organizer's reason is untrusted text: it is rendered, never interpreted. */
export function voidedNotice(project: Pick<ProjectDetail, 'voided'>): string | null {
  const info = project.voided;
  if (info === null) return null;
  return info.replacedByProjectId === null
    ? 'This project was voided by an organizer. It is kept as history; no new capture, source or assessment can be started for it, and nothing was replaced.'
    : 'This project was voided by an organizer and replaced by a corrected submission. It is kept as history; no new capture, source or assessment can be started for it.';
}
