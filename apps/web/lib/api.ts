import { ApiErrorBody } from '@judge-copilot/schemas';

/** Server-side only: the browser never talks to the API directly. */
const API_URL = process.env['JUDGE_API_URL'] ?? 'http://127.0.0.1:3001';

/**
 * Bearer credential the server forwards to the API (M2). Server-side only: never sent to the
 * browser. Locally `dev-organizer` / `dev-judge` with the API's explicit `AUTH_MODE=dev`; in a
 * deployment, a token issued by the identity provider.
 */
function authHeader(): Record<string, string> {
  const token = process.env['JUDGE_API_TOKEN'];
  return token ? { authorization: `Bearer ${token}` } : {};
}

export interface ApiIssue {
  path: string;
  message: string;
  code?: string;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      issues: ApiIssue[];
      details?: Readonly<Record<string, unknown>> | undefined;
    };

/** How long the web tier waits for the API before it stops waiting (the API may still finish the work it was asked to do). */
export const API_TIMEOUT_MS = 30_000;

/**
 * Network error codes that mean the request never left this machine: the connection was never established. Anything NOT on this list (a reset
 * after sending, a timeout, an aborted stream, an unknown failure) leaves the outcome unknown, which is the safe default.
 */
const NEVER_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** `API_UNREACHABLE`: nothing was sent (safe to say "not saved"). `API_NO_ANSWER`: the request may have been processed although no answer arrived. */
export function classifyTransportFailure(error: unknown): 'API_UNREACHABLE' | 'API_NO_ANSWER' {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_SENT_CODES.has(code)) return 'API_UNREACHABLE';
  }
  return 'API_NO_ANSWER';
}

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: {
        ...authHeader(),
        ...extraHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (classifyTransportFailure(error) === 'API_UNREACHABLE') {
      return {
        ok: false,
        status: 503,
        code: 'API_UNREACHABLE',
        message: 'The Judge Copilot API is not reachable. The request was not sent.',
        issues: [],
      };
    }
    return {
      ok: false,
      status: 503,
      code: 'API_NO_ANSWER',
      message:
        method === 'GET'
          ? 'The Judge Copilot API did not answer.'
          : 'The request was sent but no answer arrived. It may or may not have been processed.',
      issues: [],
    };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return { ok: true, data: json as T };
  }
  const parsed = ApiErrorBody.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      status: response.status,
      code: 'UNKNOWN_ERROR',
      message: 'Unexpected API response.',
      issues: [],
    };
  }
  const issues = (parsed.data.error.details?.['issues'] ?? []) as ApiIssue[];
  return {
    ok: false,
    status: response.status,
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    issues: Array.isArray(issues) ? issues : [],
    details: parsed.data.error.details,
  };
}

export function eventPath(eventId: string): string {
  return `/events/${encodeURIComponent(eventId)}`;
}

export function versionPath(eventId: string, versionId: string): string {
  return `${eventPath(eventId)}/context-versions/${encodeURIComponent(versionId)}`;
}

export function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}
