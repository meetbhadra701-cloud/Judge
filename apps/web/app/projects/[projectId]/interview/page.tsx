import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import type {
  AssessmentDetail,
  AssessmentListResponse,
  InterviewRecordsResponse,
  ProjectDetail,
  QuestionSetListResponse,
  QuestionSetView,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, projectPath } from '../../../../lib/api';
import { readOnlyReasonOf, type InterviewState } from '../../../../lib/interview-view';
import { projectPageTitle } from '../../../../lib/titles';
import { ErrorBanner } from '../../../components/ui';
import { InterviewPageView } from './view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const { projectId } = await params;
  return { title: await projectPageTitle(projectId, 'Interview Mode') };
}

export const dynamic = 'force-dynamic';

/**
 * Interview Mode (M7): where a judge, during the interview, reads each suggested question with the evidence it relates to, records what the team answered and
 * what the judge observed, and sees every saved record. This file only fetches; what is shown is decided in `view.tsx` from the API's verified read models. It
 * reads, evaluates and scores nothing and calls no model.
 */
export default async function InterviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ version?: string; set?: string }>;
}) {
  const { projectId } = await params;
  const { version, set: setParam } = await searchParams;
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
  const render = (state: InterviewState) => (
    <InterviewPageView
      projectId={projectId}
      projectName={project.data.name}
      state={state}
      keys={() => randomUUID()}
    />
  );
  if (!list.ok) return render({ kind: 'unavailable', message: list.message });
  const newestAssessment = list.data.assessments[0];
  const shown = list.data.assessments.find((item) => item.id === version) ?? newestAssessment;
  if (!shown) return render({ kind: 'no_assessment' });
  const detail = await apiRequest<AssessmentDetail>(
    'GET',
    `${base}/assessments/${encodeURIComponent(shown.id)}`,
  );
  if (!detail.ok) return render({ kind: 'unavailable', message: detail.message });
  if (!detail.data.verified) return render({ kind: 'unverified' });

  const sets = await apiRequest<QuestionSetListResponse>(
    'GET',
    `${base}/assessments/${encodeURIComponent(shown.id)}/question-sets`,
  );
  if (!sets.ok) return render({ kind: 'unavailable', message: sets.message });
  const newestSet = sets.data.sets[0];
  const chosen = sets.data.sets.find((item) => item.id === setParam) ?? newestSet;
  const [setView, interview] = await Promise.all([
    chosen
      ? apiRequest<QuestionSetView>('GET', `${base}/question-sets/${encodeURIComponent(chosen.id)}`)
      : Promise.resolve(null),
    apiRequest<InterviewRecordsResponse>(
      'GET',
      `${base}/assessments/${encodeURIComponent(shown.id)}/interview`,
    ),
  ]);
  if (setView && !setView.ok) return render({ kind: 'unavailable', message: setView.message });
  if (!interview.ok) return render({ kind: 'unavailable', message: interview.message });
  // the records are withheld (and the questions with them) when the assessment stops verifying
  if (!interview.data.assessmentVerified || (setView?.ok && !setView.data.assessmentVerified)) {
    return render({ kind: 'unverified' });
  }
  return render({
    kind: 'ready',
    assessmentId: shown.id,
    assessmentVersionNumber: detail.data.versionNumber,
    set: setView?.ok ? setView.data : null,
    records: interview.data,
    readOnlyReason: readOnlyReasonOf({
      voided: project.data.voided !== null || interview.data.voided,
      isNewestAssessment: shown.id === newestAssessment?.id,
      isNewestSet: chosen === undefined || chosen.id === newestSet?.id,
    }),
  });
}
