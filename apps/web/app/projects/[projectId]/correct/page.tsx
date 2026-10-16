import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import type { ProjectDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, eventPath, projectPath } from '../../../../lib/api';
import { ErrorBanner } from '../../../components/ui';
import { projectPageTitle } from '../../../../lib/titles';
import { CorrectView } from './view';
import { trackContextOf } from '../../../../lib/tracks';
import type { EventContextLockedSnapshot } from '@judge-copilot/schemas';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const { projectId } = await params;
  return { title: await projectPageTitle(projectId, 'Void and replace') };
}

export const dynamic = 'force-dynamic';

/** Void-and-replace (P6B-beta2): the only way a submission's links are corrected. This page only gathers the decision; the API applies it. */
export default async function CorrectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
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
  // P6D: the replacement is a new submission and declares its own tracks, chosen against the CURRENT locked context
  const context = await apiRequest<EventContextLockedSnapshot>(
    'GET',
    `${eventPath(project.data.eventId)}/context`,
  );
  return (
    <CorrectView
      project={project.data}
      correctionKey={randomUUID()}
      trackContext={context.ok ? trackContextOf(context.data) : null}
    />
  );
}
