import { randomUUID } from 'node:crypto';
import type {
  AssessmentDetail,
  AssessmentListResponse,
  ProjectDetail,
  UnknownsPage,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, projectPath } from '../../../../lib/api';
import { ErrorBanner } from '../../../components/ui';
import { requestAssessmentAction } from './actions';
import { AssessmentPageView } from './view';

export const dynamic = 'force-dynamic';

/**
 * Pre-interview assessment (M5 P6A). An AI ESTIMATE for the human judge, never the judge's score. This file only fetches; what is
 * shown, and what is never shown, is decided in `view.tsx` from the API's verified read model.
 */
export default async function AssessmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; version?: string }>;
}) {
  const { projectId } = await params;
  const { error, version } = await searchParams;
  const base = projectPath(projectId);
  const [project, list] = await Promise.all([
    apiRequest<ProjectDetail>('GET', base),
    apiRequest<AssessmentListResponse>('GET', `${base}/assessments`),
  ]);
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
  if (!list.ok) {
    return (
      <main>
        <p>
          <Link href={base}>← {project.data.name}</Link>
        </p>
        <h1>Pre-interview assessment</h1>
        <ErrorBanner message={list.message} />
      </main>
    );
  }
  const shown =
    list.data.assessments.find((item) => item.id === version) ?? list.data.assessments[0];
  const detailResult = shown
    ? await apiRequest<AssessmentDetail>(
        'GET',
        `${base}/assessments/${encodeURIComponent(shown.id)}`,
      )
    : null;
  // the project's recorded unknowns (evidence-graph route); only used for a verified assessment, loaded failure-tolerantly
  const unknownsResult =
    detailResult?.ok && detailResult.data.verified
      ? await apiRequest<UnknownsPage>('GET', `${base}/unknowns?limit=50`)
      : null;
  return (
    <AssessmentPageView
      projectId={projectId}
      projectName={project.data.name}
      list={list.data}
      detail={detailResult?.ok ? detailResult.data : null}
      detailError={detailResult && !detailResult.ok ? detailResult.message : undefined}
      error={error}
      unknowns={
        unknownsResult?.ok
          ? {
              items: unknownsResult.data.items,
              hasMore: unknownsResult.data.page.nextAfter !== null,
            }
          : null
      }
      requestKeys={{ assess: randomUUID(), reassess: randomUUID() }}
      requestAction={requestAssessmentAction}
    />
  );
}
