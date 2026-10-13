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
  type ProjectRecord,
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
 * The orchestration behind "Start analysis" (P6B-alpha, workstream B). It composes EXISTING API routes only: read the event, create the
 * project, declare the two sources, request their captures. It never calls an assessment route, so submitting can never start a paid or
 * live-model run: assessment stays a separate, explicit action on its own page.
 *
 * IDEMPOTENT BY CONSTRUCTION. Running the same submission twice (a double click, a retry after a failure half-way, two browser tabs)
 * converges on ONE project with ONE declaration per source and at most ONE pending capture per source, because every step
 * is a read-then-write that tolerates the API's own uniqueness answers:
 *
 *   project      POST; `PROJECT_NAME_TAKEN` -> find that project by name; reuse it only if its declared GitHub/Devpost sources agree with
 *                the submission, otherwise stop with a visible choice (a different project already uses this name)
 *   sources      skipped when already declared with the same canonical URL; `DUPLICATE_SOURCE` from a concurrent submit is success
 *   captures     requested only for a source with NO snapshot or whose latest snapshot FAILED/was REJECTED (a retry); never for a pending
 *                or content-bearing one; `CAPTURE_ALREADY_PENDING` from a concurrent submit is success
 *
 * The function receives the API as a parameter so tests can run it against a fake and against the real routes.
 */

/** Structurally the web tier's `ApiResult` (lib/api.ts): kept here so this file has no relative import and tests can import it as is. */
export type SubmissionApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; issues: unknown[] };

export type ApiFn = <T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
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
      /** Set when the project already exists, so the page can link to it (nothing is lost by retrying). */
      readonly projectId?: string | undefined;
    }
  | {
      readonly kind: 'started';
      readonly projectId: string;
      /** False when an existing project with the same sources was reused. */
      readonly created: boolean;
      readonly capturesRequested: number;
      /** Sources whose capture was left alone: pending, or already captured. */
      readonly capturesLeftAlone: number;
    };

const base = (eventId: string) => `/events/${encodeURIComponent(eventId)}`;
const projectBase = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function runSubmission(
  api: ApiFn,
  eventId: string,
  input: SubmissionInput,
): Promise<SubmissionOutcome> {
  const checked = validateSubmission(input);
  if (!checked.ok) return { kind: 'invalid', errors: checked.errors };

  // 1. the hackathon must exist and have a LOCKED Event Context (the API enforces it too; this gives the organizer a plain message)
  const event = await api<EventDetail>('GET', base(eventId));
  if (!event.ok) {
    return {
      kind: 'failed',
      message: event.status === 404 ? 'This hackathon does not exist.' : event.message,
    };
  }
  if (event.data.lockedVersionId === null) {
    return {
      kind: 'failed',
      message:
        'This hackathon has no locked Event Context yet. Lock one first: projects are judged only against a locked context.',
    };
  }

  // 2. the project: create it, or reuse the one a previous (or concurrent) submission created
  let projectId: string;
  let created = true;
  const createdProject = await api<ProjectRecord>('POST', `${base(eventId)}/projects`, {
    name: checked.projectName,
    teamName: null,
    trackKeys: [],
  });
  if (createdProject.ok) {
    projectId = createdProject.data.id;
  } else if (createdProject.code === 'PROJECT_NAME_TAKEN') {
    const listed = await api<{ projects: ProjectRecord[] }>('GET', `${base(eventId)}/projects`);
    if (!listed.ok) return { kind: 'failed', message: listed.message };
    const existing = listed.data.projects.find((project) =>
      sameName(project.name, checked.projectName),
    );
    if (!existing) {
      return {
        kind: 'failed',
        message: 'A project with this name exists but could not be found. Try again.',
      };
    }
    const detail = await api<ProjectDetail>('GET', projectBase(existing.id));
    if (!detail.ok) return { kind: 'failed', message: detail.message };
    const conflicting = detail.data.sources.some(
      (source) =>
        (source.sourceType === 'github' && source.url !== checked.github.canonicalUrl) ||
        (source.sourceType === 'devpost' && source.url !== checked.devpost.canonicalUrl),
    );
    if (conflicting) {
      return {
        kind: 'failed',
        field: 'name',
        projectId: existing.id,
        message: `A different project named “${existing.name}” already exists in this hackathon (with other GitHub/Devpost links). Open it, or enter another project name below.`,
      };
    }
    projectId = existing.id;
    created = false;
  } else if (createdProject.code === 'NO_LOCKED_CONTEXT') {
    return { kind: 'failed', message: 'This hackathon has no locked Event Context yet.' };
  } else {
    return { kind: 'failed', message: createdProject.message };
  }

  // 3. declare the two sources (skip what is already declared)
  const before = await api<ProjectDetail>('GET', projectBase(projectId));
  if (!before.ok) return { kind: 'failed', message: before.message, projectId };
  const declare: { sourceType: 'github' | 'devpost'; url: string; field: SubmissionField }[] = [
    { sourceType: 'github', url: checked.github.canonicalUrl, field: 'github' },
    { sourceType: 'devpost', url: checked.devpost.canonicalUrl, field: 'devpost' },
  ];
  for (const wanted of declare) {
    const already = before.data.sources.some(
      (source) => source.sourceType === wanted.sourceType && source.url === wanted.url,
    );
    if (already) continue;
    const added = await api('POST', `${projectBase(projectId)}/sources`, {
      sourceType: wanted.sourceType,
      url: wanted.url,
    });
    if (added.ok || added.code === 'DUPLICATE_SOURCE') continue;
    return {
      kind: 'failed',
      field: added.code === 'INVALID_SOURCE_URL' ? wanted.field : undefined,
      projectId,
      message:
        added.code === 'INVALID_SOURCE_URL'
          ? 'The server did not accept this URL for that source. Check the link and try again.'
          : `${added.message} The project was created; submitting again continues from here.`,
    };
  }

  // 4. request captures where they are missing or a previous attempt failed
  const after = await api<ProjectDetail>('GET', projectBase(projectId));
  if (!after.ok) return { kind: 'failed', message: after.message, projectId };
  let capturesRequested = 0;
  let capturesLeftAlone = 0;
  for (const wanted of declare) {
    const source = after.data.sources.find(
      (candidate) => candidate.sourceType === wanted.sourceType && candidate.url === wanted.url,
    );
    if (!source) {
      return {
        kind: 'failed',
        projectId,
        message: 'A declared source could not be found afterwards. Try again.',
      };
    }
    const latest = source.latestSnapshot;
    const needsCapture =
      latest === null || latest.status === 'failed' || latest.status === 'rejected';
    if (!needsCapture) {
      capturesLeftAlone += 1;
      continue;
    }
    const requested = await api(
      'POST',
      `${projectBase(projectId)}/sources/${encodeURIComponent(source.id)}/captures`,
    );
    if (requested.ok) {
      capturesRequested += 1;
    } else if (requested.code === 'CAPTURE_ALREADY_PENDING') {
      capturesLeftAlone += 1;
    } else {
      return {
        kind: 'failed',
        projectId,
        message: `${requested.message} The project and its sources exist; submitting again retries the capture.`,
      };
    }
  }
  return { kind: 'started', projectId, created, capturesRequested, capturesLeftAlone };
}
