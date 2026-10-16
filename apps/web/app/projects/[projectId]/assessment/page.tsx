import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import type {
  AssessmentDetail,
  AssessmentListResponse,
  AssessmentUnknownsResponse,
  ProjectDetail,
  QuestionSetListResponse,
  QuestionSetView,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, projectPath } from '../../../../lib/api';
import { sourceIntegrityNotice } from '../../../../lib/capture-status';
import { openMessage } from '../../../../lib/flash';
import { ErrorBanner } from '../../../components/ui';
import { generateQuestionsAction, requestAssessmentAction } from './actions';
import { questionsPanelState } from '../../../../lib/questions-view';
import { AssessmentPageView } from './view';
import { projectPageTitle } from '../../../../lib/titles';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const { projectId } = await params;
  return { title: await projectPageTitle(projectId, 'Preliminary report') };
}

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
  const { error: sealedError, version } = await searchParams;
  // only a message this server sealed is shown; a hand-written ?error= link shows nothing (lib/flash.ts)
  const error = openMessage(sealedError) ?? undefined;
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
  // the unknowns of THIS assessment's own pinned extraction (never the project's later or earlier ones); only for a verified
  // assessment, loaded failure-tolerantly
  const unknownsResult =
    shown && detailResult?.ok && detailResult.data.verified
      ? await apiRequest<AssessmentUnknownsResponse>(
          'GET',
          `${base}/assessments/${encodeURIComponent(shown.id)}/unknowns`,
        )
      : null;
  // the Five Questions of THIS assessment (M6): the list, then the newest set; both tolerant of failure, and only for a verified assessment
  const verified = Boolean(shown && detailResult?.ok && detailResult.data.verified);
  const questionList =
    shown && verified
      ? await apiRequest<QuestionSetListResponse>(
          'GET',
          `${base}/assessments/${encodeURIComponent(shown.id)}/question-sets`,
        )
      : null;
  const newestSet = questionList?.ok ? questionList.data.sets[0] : undefined;
  const questionSet = newestSet
    ? await apiRequest<QuestionSetView>(
        'GET',
        `${base}/question-sets/${encodeURIComponent(newestSet.id)}`,
      )
    : null;
  const failure =
    questionList && !questionList.ok
      ? questionList.message
      : questionSet && !questionSet.ok
        ? questionSet.message
        : undefined;
  return (
    <AssessmentPageView
      projectId={projectId}
      projectName={project.data.name}
      integrityNotice={sourceIntegrityNotice(project.data.sources)}
      list={
        project.data.voided === null
          ? list.data
          : {
              ...list.data,
              // a voided project starts no new assessment (the API refuses it too); its earlier ones stay readable
              launch: {
                available: false,
                providerMode: null,
                notice:
                  'This project was voided by an organizer, so no new assessment can be requested for it. Its earlier assessments stay readable as history.',
              },
            }
      }
      detail={detailResult?.ok ? detailResult.data : null}
      detailError={detailResult && !detailResult.ok ? detailResult.message : undefined}
      error={error}
      unknowns={
        unknownsResult?.ok && unknownsResult.data.verified
          ? {
              items: unknownsResult.data.items,
              currency: unknownsResult.data.currency,
              versionNumber: unknownsResult.data.versionNumber,
            }
          : null
      }
      requestKeys={{ assess: randomUUID(), reassess: randomUUID() }}
      requestAction={requestAssessmentAction}
      questions={questionsPanelState({
        verified,
        list: questionList?.ok ? questionList.data : null,
        set: questionSet?.ok ? questionSet.data : null,
        error: failure,
        // a voided project, or a version that is not the newest, is read-only history
        canGenerate: project.data.voided === null && shown?.id === list.data.assessments[0]?.id,
      })}
      generateQuestionsAction={generateQuestionsAction}
    />
  );
}
