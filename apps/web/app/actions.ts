'use server';

import type { ContextVersionDetail, EventRecord } from '@judge-copilot/schemas';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiRequest, eventPath, projectPath, versionPath, type ApiIssue } from '../lib/api';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function withError(path: string, message: string): string {
  return `${path}?error=${encodeURIComponent(message)}`;
}

function uiVersionPath(eventId: string, versionId: string): string {
  return `/events/${encodeURIComponent(eventId)}/versions/${encodeURIComponent(versionId)}`;
}

export async function createEventAction(formData: FormData): Promise<void> {
  const result = await apiRequest<EventRecord>('POST', '/events', {
    name: field(formData, 'name'),
    slug: field(formData, 'slug'),
  });
  if (!result.ok) {
    redirect(withError('/', result.message));
  }
  redirect(`/events/${encodeURIComponent(result.data.id)}`);
}

export async function createVersionAction(formData: FormData): Promise<void> {
  const eventId = field(formData, 'eventId');
  const changeReason = field(formData, 'changeReason').trim();
  const result = await apiRequest<ContextVersionDetail>(
    'POST',
    `${eventPath(eventId)}/context-versions`,
    changeReason ? { changeReason } : {},
  );
  if (!result.ok) {
    redirect(withError(`/events/${encodeURIComponent(eventId)}`, result.message));
  }
  redirect(uiVersionPath(eventId, result.data.id));
}

export async function addSourceAction(formData: FormData): Promise<void> {
  const eventId = field(formData, 'eventId');
  const versionId = field(formData, 'versionId');
  const url = field(formData, 'url').trim();
  const result = await apiRequest('POST', `${versionPath(eventId, versionId)}/sources`, {
    title: field(formData, 'title'),
    sourceType: field(formData, 'sourceType'),
    authority: field(formData, 'authority'),
    url: url || null,
    normalizedText: field(formData, 'normalizedText'),
  });
  const page = uiVersionPath(eventId, versionId);
  revalidatePath(page);
  redirect(result.ok ? page : withError(page, result.message));
}

export async function buildContextAction(formData: FormData): Promise<void> {
  const eventId = field(formData, 'eventId');
  const versionId = field(formData, 'versionId');
  // Replacing reviewed changes needs an explicit, separately submitted confirmation.
  const replaceHumanEdits = field(formData, 'replaceHumanEdits') === 'true';
  const result = await apiRequest('POST', `${versionPath(eventId, versionId)}/build`, {
    replaceHumanEdits,
  });
  const page = uiVersionPath(eventId, versionId);
  revalidatePath(page);
  redirect(result.ok ? page : withError(page, result.message));
}

export async function lockContextAction(formData: FormData): Promise<void> {
  const eventId = field(formData, 'eventId');
  const versionId = field(formData, 'versionId');
  const result = await apiRequest('POST', `${versionPath(eventId, versionId)}/lock`);
  const page = uiVersionPath(eventId, versionId);
  revalidatePath(page);
  redirect(result.ok ? page : withError(page, result.message));
}

export interface SaveDraftState {
  attempt: number;
  json: string | null;
  error: string | null;
  issues: ApiIssue[];
}

export async function saveDraftAction(
  previous: SaveDraftState,
  formData: FormData,
): Promise<SaveDraftState> {
  const eventId = field(formData, 'eventId');
  const versionId = field(formData, 'versionId');
  const json = field(formData, 'document');
  const summary = field(formData, 'summary').trim();
  const failed = (error: string, issues: ApiIssue[] = []): SaveDraftState => ({
    attempt: previous.attempt + 1,
    json,
    error,
    issues,
  });

  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    return failed('The document is not valid JSON.');
  }
  const result = await apiRequest('PATCH', versionPath(eventId, versionId), {
    document,
    summary: summary || null,
  });
  if (!result.ok) {
    return failed(result.message, result.issues);
  }
  const page = uiVersionPath(eventId, versionId);
  revalidatePath(page);
  redirect(page);
}

// -- M2: projects, declared sources and capture requests --------------------------------------

export async function createProjectAction(formData: FormData): Promise<void> {
  const eventId = field(formData, 'eventId');
  const teamName = field(formData, 'teamName').trim();
  const trackKeys = formData
    .getAll('trackKeys')
    .filter((value): value is string => typeof value === 'string');
  const result = await apiRequest<{ id: string }>('POST', `${eventPath(eventId)}/projects`, {
    name: field(formData, 'name'),
    teamName: teamName || null,
    trackKeys,
  });
  const page = `/events/${encodeURIComponent(eventId)}`;
  if (!result.ok) {
    redirect(withError(page, result.message));
  }
  redirect(`/projects/${encodeURIComponent(result.data.id)}`);
}

export async function addProjectSourceAction(formData: FormData): Promise<void> {
  const projectId = field(formData, 'projectId');
  const result = await apiRequest('POST', `${projectPath(projectId)}/sources`, {
    sourceType: field(formData, 'sourceType'),
    url: field(formData, 'url'),
  });
  const page = `/projects/${encodeURIComponent(projectId)}`;
  revalidatePath(page);
  redirect(result.ok ? page : withError(page, result.message));
}

export async function requestCaptureAction(formData: FormData): Promise<void> {
  const projectId = field(formData, 'projectId');
  const sourceId = field(formData, 'sourceId');
  const path = sourceId
    ? `${projectPath(projectId)}/sources/${encodeURIComponent(sourceId)}/captures`
    : `${projectPath(projectId)}/captures`;
  const result = await apiRequest('POST', path);
  const page = `/projects/${encodeURIComponent(projectId)}`;
  revalidatePath(page);
  redirect(result.ok ? page : withError(page, result.message));
}
