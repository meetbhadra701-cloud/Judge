import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import type { EventContextLockedSnapshot, EventDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, eventPath } from '../../../../lib/api';
import { ErrorBanner } from '../../../components/ui';
import { SubmitView } from './view';
import { eventPageTitle } from '../../../../lib/titles';
import { trackContextOf } from '../../../../lib/tracks';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ eventId: string }>;
}): Promise<Metadata> {
  const { eventId } = await params;
  return { title: await eventPageTitle(eventId, 'Submit a project') };
}

export const dynamic = 'force-dynamic';

/**
 * Step 1 of the project journey (P6B-alpha): hackathon → GitHub + Devpost links → capture → (separate, explicit) offline analysis.
 * This page only gathers the two links. Submitting reads nothing from them in the browser or in this server tier: a worker captures
 * the public pages later, through the SSRF-safe client, and nothing here starts an AI analysis.
 */
export default async function SubmitPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const result = await apiRequest<EventDetail>('GET', eventPath(eventId));
  if (!result.ok) {
    return (
      <main>
        <p>
          <Link href="/">← Events</Link>
        </p>
        <ErrorBanner message={result.message} />
      </main>
    );
  }
  const { event, versions, lockedVersionId } = result.data;
  const locked = lockedVersionId
    ? versions.find((version) => version.id === lockedVersionId)
    : null;
  const context = lockedVersionId
    ? await apiRequest<EventContextLockedSnapshot>('GET', `${eventPath(eventId)}/context`)
    : null;
  const rubric = context?.ok
    ? context.data.document.rubrics.find((candidate) => candidate.scope === 'overall')
    : undefined;

  return (
    <SubmitView
      event={event}
      locked={locked ?? null}
      rubric={rubric ? { name: rubric.name, criteriaCount: rubric.criteria.length } : null}
      trackContext={context?.ok ? trackContextOf(context.data) : null}
      submissionKey={randomUUID()}
    />
  );
}
