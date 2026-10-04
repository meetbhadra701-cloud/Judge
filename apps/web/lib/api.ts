import { ApiErrorBody } from '@judge-copilot/schemas';

/** Server-side only: the browser never talks to the API directly. */
const API_URL = process.env['JUDGE_API_URL'] ?? 'http://127.0.0.1:3001';

export interface ApiIssue {
  path: string;
  message: string;
  code?: string;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; issues: ApiIssue[] };

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    return {
      ok: false,
      status: 503,
      code: 'API_UNREACHABLE',
      message: 'The Judge Copilot API is not reachable.',
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
  };
}

export function eventPath(eventId: string): string {
  return `/events/${encodeURIComponent(eventId)}`;
}

export function versionPath(eventId: string, versionId: string): string {
  return `${eventPath(eventId)}/context-versions/${encodeURIComponent(versionId)}`;
}
