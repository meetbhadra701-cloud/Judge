import { blankDocumentInput } from '@judge-copilot/context';
import type { ContextVersionDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, versionPath } from '../../../../../../lib/api';
import { toEditableInput } from '../../../../../../lib/editable';
import { ErrorBanner } from '../../../../../components/ui';
import { EditDraftForm } from './edit-form';

export const dynamic = 'force-dynamic';

export default async function EditDraftPage({
  params,
}: {
  params: Promise<{ eventId: string; versionId: string }>;
}) {
  const { eventId, versionId } = await params;
  const result = await apiRequest<ContextVersionDetail>('GET', versionPath(eventId, versionId));
  const back = (
    <p>
      <Link href={`/events/${eventId}/versions/${versionId}`}>← Back to version</Link>
    </p>
  );
  if (!result.ok) {
    return (
      <main>
        {back}
        <ErrorBanner message={result.message} />
      </main>
    );
  }
  const version = result.data;
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
  const input = version.document ? toEditableInput(version.document) : blankDocumentInput();

  return (
    <main>
      {back}
      <h1>Edit draft v{version.version}</h1>
      <p className="notice">
        Edit the structured context as JSON. Keep each item&apos;s <code>id</code> and{' '}
        <code>sourceIds</code>: the server keeps source provenance, marks changed source-derived
        items as human-edited, and records new items (without an <code>id</code>) as human notes.
        Removing a source a source-derived item cites is rejected. Mark anything the official
        sources do not settle as <code>&quot;certainty&quot;: &quot;unclear&quot;</code>.
      </p>
      <p>
        Sources:{' '}
        {version.sources.map((source) => (
          <span key={source.id}>
            <code>{source.id}</code> = {source.title} ({source.authority}){' · '}
          </span>
        ))}
      </p>
      <EditDraftForm
        eventId={eventId}
        versionId={versionId}
        initialJson={JSON.stringify(input, null, 2)}
        initialSummary={version.summary ?? ''}
      />
    </main>
  );
}
