import { randomUUID } from 'node:crypto';
import type {
  AssessmentDetail,
  AssessmentJudgmentView,
  AssessmentListResponse,
  AssessmentRunView,
  DimensionReport,
  ProjectDetail,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import {
  classifyPage,
  explainFailure,
  formatCostNanoUsd,
  formatRatio,
  formatScore10,
  runToExplain,
} from '../../../../lib/assessment-view';
import { apiRequest, projectPath } from '../../../../lib/api';
import { ErrorBanner, formatDate } from '../../../components/ui';
import { requestAssessmentAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Pre-interview assessment (M5 P6A). An AI ESTIMATE for the human judge, never the judge's score.
 * Every number shown comes from the verified stored report. A dimension or overall with
 * insufficient evidence has no number at all, and a failed or cancelled run is never shown as an
 * assessment. All project-derived text (rationales, citations, limitations) is rendered as plain
 * escaped React text.
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
  const back = (
    <p>
      <Link href={base}>← {project.data.name}</Link>
    </p>
  );
  if (!list.ok) {
    return (
      <main>
        {back}
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
  const detail = detailResult?.ok ? detailResult.data : null;
  const state = classifyPage(list.data, detail);
  const run = runToExplain(list.data);

  return (
    <main>
      {back}
      <h1>Pre-interview assessment</h1>
      <p className="notice" role="note">
        <strong>Advisory only.</strong> {list.data.notice} Nothing here is a final score.
      </p>
      <ErrorBanner message={error} />
      {detailResult && !detailResult.ok ? <ErrorBanner message={detailResult.message} /> : null}

      <p data-state={state}>
        <span className="badge">{STATE_LABELS[state]}</span>
      </p>

      {run ? <RunPanel run={run} /> : null}
      {state === 'none' ? (
        <p>No assessment has been requested for this project yet. Nothing has been scored.</p>
      ) : null}
      {state === 'unverified' ? (
        <p role="alert" className="error">
          The stored assessment could not be verified, so none of it is shown.
          {detail?.verificationFailure ? ` (${detail.verificationFailure})` : ''}
        </p>
      ) : null}
      {detail && state !== 'unverified' ? <AssessmentView detail={detail} /> : null}

      <Launch
        projectId={projectId}
        launch={list.data.launch}
        hasAssessment={list.data.assessments.length > 0}
        activeRun={list.data.activeRun !== null}
      />

      {list.data.assessments.length > 1 ? (
        <section>
          <h2>Versions</h2>
          <ul>
            {list.data.assessments.map((item) => (
              <li key={item.id}>
                <Link href={`${base}/assessment?version=${item.id}`}>
                  Version {item.versionNumber}
                </Link>{' '}
                · {formatDate(item.createdAt)}
                {item.replayDemonstration ? ' · replay demonstration' : ''}
                {item.verified ? '' : ' · not verified'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

const STATE_LABELS = {
  none: 'NO ASSESSMENT',
  in_progress: 'IN PROGRESS',
  run_failed: 'RUN DID NOT COMPLETE',
  unverified: 'NOT VERIFIED',
  scored: 'SCORED',
  scored_partial: 'PARTIALLY SCORED',
  insufficient_evidence: 'INSUFFICIENT EVIDENCE',
} as const;

function RunPanel({ run }: { run: AssessmentRunView }) {
  if (run.state === 'pending' || run.state === 'running') {
    return (
      <section>
        <h2>Run {run.state === 'pending' ? 'waiting for a worker' : 'in progress'}</h2>
        <p>
          Requested {formatDate(run.createdAt)}
          {run.stageReached ? ` · stage ${run.stageReached}` : ''}. Reload this page to refresh; no
          assessment exists until the run succeeds.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2>{run.state === 'cancelled' ? 'Run cancelled' : 'Run failed'}</h2>
      <p role="alert" className="error">
        {explainFailure(run)} No assessment was produced and no score is shown for this run.
      </p>
      <p>
        <small>
          {run.failureCategory ?? '—'}
          {run.failureCode ? ` · ${run.failureCode}` : ''}
          {run.stageReached ? ` · reached ${run.stageReached}` : ''} · finished{' '}
          {formatDate(run.finishedAt)}
        </small>
      </p>
    </section>
  );
}

function Launch({
  projectId,
  launch,
  hasAssessment,
  activeRun,
}: {
  projectId: string;
  launch: AssessmentListResponse['launch'];
  hasAssessment: boolean;
  activeRun: boolean;
}) {
  const requestKey = randomUUID();
  return (
    <section>
      <h2>Run assessment</h2>
      <p>{launch.notice}</p>
      {!launch.available ? (
        <p role="status">
          Assessments cannot be run here: no approved offline replay mode is configured (
          <code>ASSESSMENT_PROVIDER_NOT_CONFIGURED</code>).
        </p>
      ) : activeRun ? (
        <p>A run is already active for this project.</p>
      ) : (
        <>
          <form action={requestAssessmentAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="requestKey" value={requestKey} />
            <input type="hidden" name="mode" value="assess" />
            <button type="submit">
              {hasAssessment ? 'Show assessment for current material' : 'Run assessment'}
            </button>
          </form>
          {hasAssessment ? (
            <form action={requestAssessmentAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="requestKey" value={randomUUID()} />
              <input type="hidden" name="mode" value="reassess" />
              <button type="submit">Reassess (creates a new version)</button>
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}

function AssessmentView({ detail }: { detail: AssessmentDetail }) {
  const report = detail.report;
  if (!report) return null;
  const overall = report.overall;
  const judgmentByDimension = new Map(detail.judgments.map((j) => [j.dimensionId, j]));
  return (
    <>
      {detail.replayDemonstration ? (
        <p role="note" className="notice">
          <strong>Replay demonstration.</strong> {detail.notices.replay} These values come from
          recorded fixtures, not a live model, and say nothing about a real submission.
        </p>
      ) : null}
      <section>
        <h2>Overall (version {detail.versionNumber})</h2>
        {overall.state === 'scored' || overall.state === 'scored_partial' ? (
          <p>
            <strong>{formatScore10(overall.score10)} / 10</strong> ·{' '}
            {overall.state === 'scored_partial'
              ? `partial: based on ${formatRatio(overall.assessedWeightShare)} of the weight`
              : 'all weighted dimensions assessed'}{' '}
            · confidence index {formatRatio(overall.confidence)}
            {overall.coverage !== null ? ` · coverage ${formatRatio(overall.coverage)}` : ''}
            {overall.state === 'scored_partial' && overall.missingCriterionKeys.length > 0
              ? ` · not assessed: ${overall.missingCriterionKeys.join(', ')}`
              : ''}
          </p>
        ) : overall.state === 'insufficient_evidence' ? (
          <p>
            Insufficient evidence for an overall score. No number is given, and this is not a low
            score.
          </p>
        ) : (
          <p>
            No overall number is computed for an unweighted official rubric. Per-criterion results
            are shown below.
          </p>
        )}
        <p>
          <small>
            Rubric: {report.rubric.name} ({report.rubric.official ? 'official' : 'fallback'}).
            Confidence is an index, not a probability. Parameters are heuristic and uncalibrated.
            Assessment target: overall rubric only. Provider {detail.providerMode}.
          </small>
        </p>
      </section>

      <section>
        <h2>Criteria</h2>
        <table>
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Result</th>
              <th>Confidence</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {report.criteria.map((criterion) => (
              <tr key={criterion.key}>
                <td>{criterion.name}</td>
                {criterion.state === 'assessed' || criterion.state === 'partial' ? (
                  <>
                    <td>
                      {formatScore10(criterion.score10)} / 10
                      {criterion.state === 'partial'
                        ? ` (partial; missing ${criterion.missingDimensionIds.join(', ')})`
                        : ''}
                    </td>
                    <td>{formatRatio(criterion.confidence)}</td>
                    <td>{criterion.coverage === null ? '—' : formatRatio(criterion.coverage)}</td>
                  </>
                ) : criterion.state === 'insufficient_evidence' ? (
                  <td colSpan={3}>Insufficient evidence (no number)</td>
                ) : (
                  <td colSpan={3}>Not applicable ({criterion.reason})</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Dimensions</h2>
        {report.dimensions.map((dimension) => (
          <DimensionCard
            key={dimension.id}
            dimension={dimension}
            judgment={judgmentByDimension.get(dimension.id) ?? null}
          />
        ))}
      </section>

      {detail.limitations.length > 0 ? (
        <section>
          <h2>Limitations</h2>
          <ul>
            {detail.limitations.map((item) => (
              <li key={item.code}>
                <code>{item.code}</code> ×{item.count}
                {item.subjects.length > 0 ? ` — ${item.subjects.join(', ')}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>What this does not establish</h2>
        <ul>
          <li>
            Citation relevance is <strong>not verified</strong>: a cited item is not checked to
            support the claim it is attached to.
          </li>
          <li>Claim labels are never proof of truth; missing evidence is not negative evidence.</li>
          <li>Contradictions are only those recorded in the evidence graph.</li>
        </ul>
        <p>
          <small>
            Model usage (local counters): {detail.usage.settledCalls} settled call(s),{' '}
            {detail.usage.unknownCalls} unknown, {detail.usage.inputTokens} input /{' '}
            {detail.usage.outputTokens} output tokens, {formatCostNanoUsd(detail.usage.costNanoUsd)}
            .
          </small>
        </p>
      </section>
    </>
  );
}

function DimensionCard({
  dimension,
  judgment,
}: {
  dimension: DimensionReport;
  judgment: AssessmentJudgmentView | null;
}) {
  return (
    <div className="fact">
      <div>
        <strong>{dimension.name}</strong> <code>{dimension.id}</code>
      </div>
      <div>
        {dimension.state === 'assessed' ? (
          <>
            {formatScore10(dimension.score10)} / 10 · confidence {formatRatio(dimension.confidence)}{' '}
            · evidence strength {formatRatio(dimension.evidenceStrength)}
          </>
        ) : (
          <>Insufficient evidence ({dimension.reason}) — no number is given.</>
        )}
      </div>
      {judgment ? (
        <>
          <div className="meta">
            <span className="tag">{judgment.disposition}</span>
            {judgment.dispositionClass !== judgment.disposition ? (
              <span className="tag">{judgment.dispositionClass}</span>
            ) : null}
            {judgment.criticReviewRequired ? (
              <span className="tag">
                {judgment.criticReviewed ? 'critic reviewed' : 'critic pending'}
              </span>
            ) : null}
            <span className="tag tag-warn">relevance not verified</span>
          </div>
          {judgment.rationale ? <p>{judgment.rationale}</p> : null}
          {judgment.limitations.length > 0 ? (
            <ul>
              {judgment.limitations.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : null}
          {judgment.citations.length > 0 ? (
            <ul>
              {judgment.citations.map((citation) => (
                <li key={citation.evidenceId}>
                  <small>
                    {citation.evidence?.text ?? citation.evidenceId}
                    {citation.evidence
                      ? ` [${citation.evidence.kind} · ${citation.evidence.verificationLevel}]`
                      : ''}{' '}
                    — {citation.directness}, {citation.specificity}
                    {citation.note ? `: ${citation.note}` : ''}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              <small>No citations.</small>
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
