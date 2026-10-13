import type { EventDetail, ProjectDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, eventPath, projectPath } from '../../../../lib/api';
import { ErrorBanner } from '../../../components/ui';
import { retryCaptureAction } from './actions';
import { CaptureView } from './view';

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
  const { error } = await searchParams;
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
