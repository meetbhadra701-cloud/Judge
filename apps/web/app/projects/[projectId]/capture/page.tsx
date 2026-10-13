import type { Metadata } from 'next';
import type { EventDetail, ProjectDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, eventPath, projectPath } from '../../../../lib/api';
import { openMessage } from '../../../../lib/flash';
import { ErrorBanner } from '../../../components/ui';
import { retryCaptureAction } from './actions';
import { CaptureView } from './view';
import { projectPageTitle } from '../../../../lib/titles';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const { projectId } = await params;
  return { title: await projectPageTitle(projectId, 'Capture progress') };
}

export const dynamic = 'force-dynamic';

/** Capture progress for a submitted project: per-source status, failures, retries. Reads only; the worker does the capturing. */
export default async function CapturePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { projectId } = await params;
  const { error: sealedError } = await searchParams;
  // only a message this server sealed is shown; a hand-written ?error= link shows nothing (lib/flash.ts)
  const error = openMessage(sealedError) ?? undefined;
  const project = await apiRequest<ProjectDetail>('GET', projectPath(projectId));
  if (!project.ok) {
    return (
      <main>
        <p>
          <Link href="/">← Events</Link>
        </p>
        <ErrorBanner message={project.message} />
      </main>
    );
  }
  const event = await apiRequest<EventDetail>('GET', eventPath(project.data.eventId));
  return (
    <CaptureView
      project={project.data}
      event={event.ok ? event.data : null}
      error={error}
      retryAction={retryCaptureAction}
    />
  );
}
