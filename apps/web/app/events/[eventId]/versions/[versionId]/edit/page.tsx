import type { Metadata } from 'next';
import type { ContextVersionDetail, EventRecord, EventSourceRecord } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, eventPath, versionPath } from '../../../../../../lib/api';
import { inputFromDocument, modelFromInput } from '../../../../../../lib/context-editor';
import { ErrorBanner } from '../../../../../components/ui';
import { eventPageTitle } from '../../../../../../lib/titles';
import { ContextEditor } from './context-editor';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ eventId: string }>;
}): Promise<Metadata> {
  const { eventId } = await params;
  return { title: await eventPageTitle(eventId, 'Edit Event Context') };
}

export const dynamic = 'force-dynamic';

/** The structured Event Context editor (P6D): forms for every field, no JSON and no identifiers. The raw editor lives at `./advanced`. */
export default async function EditContextPage({
  params,
}: {
  params: Promise<{ eventId: string; versionId: string }>;
}) {
  const { eventId, versionId } = await params;
  const [versionResult, sourcesResult, eventResult] = await Promise.all([
    apiRequest<ContextVersionDetail>('GET', versionPath(eventId, versionId)),
    apiRequest<{ sources: EventSourceRecord[] }>(
      'GET',
      `${versionPath(eventId, versionId)}/sources`,
    ),
    apiRequest<{ event: EventRecord }>('GET', eventPath(eventId)),
  ]);
  const back = (
    <p>
      <Link href={`/events/${eventId}/versions/${versionId}`}>← Back to version</Link>
    </p>
  );
  if (!versionResult.ok) {
    return (
      <main>
        {back}
        <ErrorBanner message={versionResult.message} />
      </main>
    );
  }
  const version = versionResult.data;
  if (version.status !== 'draft') {
    return (
      <main>
        {back}
        <ErrorBanner
          message={`Version ${String(version.version)} is ${version.status} and cannot be edited. Create a new version instead.`}
        />
      </main>
    );
  }
  const sourceTexts = sourcesResult.ok ? sourcesResult.data.sources : [];
  const initial = modelFromInput(
    version.document ? inputFromDocument(version.document) : null,
    version.summary ?? '',
  );

  return (
    <main>
      {back}
      <h1>Edit Event Context · draft v{version.version}</h1>
      <p>
        Fill in what the event’s official sources say. You can save at any time and come back; when
        you are done, review the result on the version page and lock it. A locked version cannot be
        changed.
      </p>
      <ContextEditor
        eventId={eventId}
        versionId={versionId}
        eventName={eventResult.ok ? eventResult.data.event.name : 'this event'}
        sources={version.sources.map((source) => ({
          id: source.id,
          title: source.title,
          authority: source.authority,
        }))}
        initial={initial}
        sourceTexts={sourceTexts.map((source) => ({
          id: source.id,
          title: source.title,
          text: source.normalizedText,
        }))}
      />
      <p>
        <small>
          Developers and recovery only: the{' '}
          <Link href={`/events/${eventId}/versions/${versionId}/edit/advanced`}>
            advanced editor
          </Link>{' '}
          edits the stored document directly.
        </small>
      </p>
    </main>
  );
}
