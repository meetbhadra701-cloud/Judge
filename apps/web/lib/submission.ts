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
  type SubmissionResult,
  type SubmitProjectResponse,
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
  return code === 'API_UNREACHABLE' || code === 'UNKNOWN_ERROR' || status >= 500;
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
