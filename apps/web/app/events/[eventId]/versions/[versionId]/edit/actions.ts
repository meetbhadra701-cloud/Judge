'use server';

import type { ContextVersionDetail } from '@judge-copilot/schemas';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiRequest, versionPath, type ApiIssue } from '../../../../../../lib/api';
import {
  documentFromModel,
  modelFromInput,
  type SourceOption,
} from '../../../../../../lib/context-editor';

export interface StructuredSaveState {
  readonly attempt: number;
  readonly error: string | null;
  readonly issues: readonly ApiIssue[];
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Saves the structured editor's document as the draft. The browser already checked it, but a form post can be made without the browser's
 * script, so the SAME rules run again here before the API (the authority) sees it: nothing is saved with an "official" statement that cites
 * no official source, and no document the editor could not have built is accepted from this route.
 */
export async function saveStructuredContextAction(
  previous: StructuredSaveState,
  formData: FormData,
): Promise<StructuredSaveState> {
  const eventId = field(formData, 'eventId');
  const versionId = field(formData, 'versionId');
  const summary = field(formData, 'summary').trim();
  const failed = (error: string, issues: readonly ApiIssue[] = []): StructuredSaveState => ({
    attempt: previous.attempt + 1,
    error,
    issues,
  });

  let document: unknown;
  try {
    document = JSON.parse(field(formData, 'document'));
  } catch {
    return failed('The form could not be read. Reload the page and try again; nothing was saved.');
  }

  const version = await apiRequest<ContextVersionDetail>('GET', versionPath(eventId, versionId));
  if (!version.ok) return failed(version.message);
  if (version.data.status !== 'draft') {
    return failed(
      `Version ${String(version.data.version)} is ${version.data.status} and cannot be edited. Create a new version instead.`,
    );
  }
  const sources: SourceOption[] = version.data.sources.map((source) => ({
    id: source.id,
    title: source.title,
    authority: source.authority,
  }));
  const rebuilt = documentFromModel(
    modelFromInput(document as Parameters<typeof modelFromInput>[0]),
    sources,
  );
  const blocking = rebuilt.issues.filter((entry) => entry.blocks === 'save');
  if (rebuilt.input === null || blocking.length > 0) {
    return failed(
      'The Event Context was not saved. Fix the items below and save again.',
      blocking.map((entry) => ({ path: entry.field, message: entry.message })),
    );
  }

  const result = await apiRequest('PATCH', versionPath(eventId, versionId), {
    document: rebuilt.input,
    summary: summary || null,
  });
  if (!result.ok) return failed(result.message, result.issues);
  const page = `/events/${encodeURIComponent(eventId)}/versions/${encodeURIComponent(versionId)}`;
  revalidatePath(page);
  redirect(page);
}
