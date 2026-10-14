import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import type { ProjectDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, projectPath } from '../../../../lib/api';
import { ErrorBanner } from '../../../components/ui';
import { projectPageTitle } from '../../../../lib/titles';
import { CorrectView } from './view';

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
  return <CorrectView project={project.data} correctionKey={randomUUID()} />;
}
