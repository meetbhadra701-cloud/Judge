import type { EventDetail, ProjectDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  captureFingerprint,
  describeCapture,
  overviewOf,
  sourceIntegrityNotice,
} from '../../../../lib/capture-status';
import { voidedNotice } from '../../../../lib/submission';
import { AutoRefresh } from './auto-refresh';
import { RetryButton } from './retry-button';

/* Presentation of the capture-progress page (P6B-alpha), separate from fetching so it can be rendered in a test with plain data. */

const TYPE_LABEL = {
  github: 'GitHub',
  devpost: 'Devpost',
  deployment: 'Deployment',
  video: 'Video',
} as const;

export interface CaptureViewProps {
  readonly project: ProjectDetail;
  readonly event: EventDetail | null;
  readonly error: string | undefined;
  readonly retryAction: (formData: FormData) => void | Promise<void>;
  /** Stores Devpost submission text an organizer typed or pasted (labelled organizer-supplied). Omitted: the form is not offered. */
  readonly supplyAction?: (formData: FormData) => void | Promise<void>;
}

export function CaptureView({
  project,
  event,
  error,
  retryAction,
  supplyAction,
}: CaptureViewProps): ReactNode {
  const overview = overviewOf(project.sources);
  // P6D: a source has CONTENT when its latest attempt holds some, or an earlier capture does (a failed retry never deletes it, and a report
  // uses the earlier one). "Supplied" counts organizer-typed text separately from text read from the source.
  const contentOf = (source: ProjectDetail['sources'][number]) =>
    describeCapture(source.latestSnapshot).hasContent
      ? source.latestSnapshot
      : (source.latestUsableSnapshot ?? null);
  const withContent = project.sources.filter((source) => contentOf(source) !== null);
  const contentCount = withContent.length;
  const suppliedCount = withContent.filter(
    (source) => contentOf(source)?.provenance === 'organizer_supplied',
  ).length;
  const withoutContentCount = project.sources.length - contentCount;
  const locked = event?.lockedVersionId
    ? event.versions.find((version) => version.id === event.lockedVersionId)
    : undefined;
  const voided = voidedNotice(project);
  return (
    <main>
      <p>
        <Link href={`/events/${project.eventId}/submit`}>← Submit another project</Link>
      </p>
      <h1>{project.name}</h1>
      {project.voided !== null && voided !== null ? (
        <section role="status" className="notice" data-testid="voided-project">
          <p>
            <strong>Voided.</strong> {voided}
          </p>
          <p>
            Reason on record: <q>{project.voided.reason}</q>
          </p>
          {project.voided.replacedByProjectId !== null ? (
            <p>
              <Link href={`/projects/${project.voided.replacedByProjectId}/capture`}>
                Open the replacement project →
              </Link>
            </p>
          ) : null}
        </section>
      ) : (
        <p>
          <Link href={`/projects/${project.id}/correct`} data-testid="correct-link">
            Wrong links? Void and replace this submission
          </Link>
        </p>
      )}
      <p data-testid="active-event">
        Hackathon: <strong>{event?.event.name ?? 'unknown'}</strong>
        {locked ? <> · locked Event Context v{locked.version}</> : null}
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {sourceIntegrityNotice(project.sources) !== null ? (
        <p role="alert" className="error" data-testid="mixed-project">
          {sourceIntegrityNotice(project.sources)}
        </p>
      ) : null}
      <AutoRefresh
        projectId={project.id}
        fingerprint={captureFingerprint(project)}
        active={overview.anyWaiting}
      />

      <p className="notice" role="note">
        <strong>Step 2 of 4: capture.</strong> A worker reads the public pages and stores them as
        immutable snapshots. This is <em>not</em> an AI analysis, and a captured source is not
        verified: it only means its text was saved. The preliminary report is a separate step.
      </p>

      <section aria-labelledby="sources-heading">
        <h2 id="sources-heading">Sources</h2>
        {project.sources.length === 0 ? (
          <p>No sources are declared for this project.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Link</th>
                <th>Capture</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.sources.map((source) => {
                const view = describeCapture(source.latestSnapshot);
                return (
                  <tr
                    key={source.id}
                    data-testid={`source-${source.sourceType}`}
                    data-stage={view.stage}
                  >
                    <td>{TYPE_LABEL[source.sourceType]}</td>
                    <td>
                      <code>{source.url}</code>
                    </td>
                    <td>
                      <strong>{view.label}</strong>
                      <br />
                      <small>{view.detail}</small>
                      {view.gaps.length > 0 ? (
                        <>
                          <br />
                          <small>Incomplete: {view.gaps.join('; ')}.</small>
                        </>
                      ) : null}
                      {(() => {
                        const earlier = describeCapture(source.latestSnapshot).hasContent
                          ? null
                          : (source.latestUsableSnapshot ?? null);
                        return earlier === null ? null : (
                          <>
                            <br />
                            <small data-testid={`earlier-capture-${source.sourceType}`}>
                              The latest attempt did not succeed, but{' '}
                              <strong>capture #{earlier.captureNumber}</strong> (
                              {earlier.status === 'partial' ? 'partial' : 'complete'}
                              {earlier.provenance === 'organizer_supplied'
                                ? ', text supplied by an organizer'
                                : ''}
                              ) is still stored and is the content a report uses. A failed retry
                              never removes it.
                              {earlier.revision ? (
                                <>
                                  {' '}
                                  Exact commit{' '}
                                  <code title={earlier.revision}>{earlier.revision}</code>.
                                </>
                              ) : null}
                            </small>
                          </>
                        );
                      })()}
                      {source.latestSnapshot?.revision ? (
                        <>
                          <br />
                          <small data-testid={`revision-${source.sourceType}`}>
                            Exact commit{' '}
                            <code title={source.latestSnapshot.revision}>
                              {source.latestSnapshot.revision}
                            </code>{' '}
                            — this snapshot never changes when the repository does.
                          </small>
                        </>
                      ) : null}
                      {source.latestSnapshot && source.latestSnapshot.captureNumber > 1 ? (
                        <>
                          <br />
                          <small>Attempt #{source.latestSnapshot.captureNumber}</small>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {view.retryable && project.voided === null ? (
                        <form action={retryAction}>
                          <input type="hidden" name="projectId" value={project.id} />
                          <input type="hidden" name="sourceId" value={source.id} />
                          <RetryButton
                            label={
                              view.stage === 'captured_partial' ? 'Capture again' : 'Retry capture'
                            }
                          />
                        </form>
                      ) : null}
                      {source.sourceType === 'devpost' &&
                      project.voided === null &&
                      supplyAction !== undefined &&
                      source.latestSnapshot?.status !== 'pending' ? (
                        <details data-testid="supply-content">
                          <summary>Provide the submission text yourself</summary>
                          <p>
                            <small>
                              If this deployment cannot fetch the Devpost page, paste the submission
                              text you can see. It is stored as an immutable snapshot labelled{' '}
                              <strong>organizer-supplied</strong>: it is not fetched from Devpost
                              and not checked against the page, and anything derived from it stays a
                              team claim.
                            </small>
                          </p>
                          <form action={supplyAction}>
                            <input type="hidden" name="projectId" value={project.id} />
                            <input type="hidden" name="sourceId" value={source.id} />
                            <label>
                              Submission text
                              <textarea
                                name="submissionText"
                                rows={8}
                                maxLength={250000}
                                required
                              />
                            </label>
                            <button type="submit">Store this text</button>
                          </form>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {overview.anyWaiting ? <p role="status">Waiting for the capture worker.</p> : null}
        {overview.anyFailed && withoutContentCount > 0 ? (
          <p role="alert" className="error">
            At least one source has no stored content. You can retry it, or continue: a missing
            source is missing evidence, never a negative judgment about the project.
          </p>
        ) : null}
        {overview.anyFailed && withoutContentCount === 0 ? (
          <p role="status" className="notice" data-testid="failed-retry-notice">
            The latest capture attempt of at least one source did not succeed, but earlier content
            of every source is still stored. You can retry again at any time.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="next-heading">
        <h2 id="next-heading">Next: preliminary report</h2>
        <p className="notice" role="note">
          <strong>Temporary offline workflow.</strong> The report runs offline: no live model is
          used and nothing is spent. Which offline mode is configured (recorded answers for the
          built-in synthetic demonstration project, or the scripted demonstrator whose scores are
          fixed placeholders) is stated at the top of the report page, and neither is an AI judgment
          of your project. It is advisory: the human judge’s final score is separate and
          authoritative. Starting it is a separate click on the next page.
        </p>
        {contentCount === 0 ? (
          <p data-testid="next-blocked">
            The report needs at least one source with stored content.{' '}
            {overview.anyWaiting ? 'Waiting for the capture first.' : 'Retry a capture above.'}
          </p>
        ) : (
          <p>
            <Link href={`/projects/${project.id}/assessment`} data-testid="next-report">
              Open the preliminary report page →
            </Link>{' '}
            <small>
              ({String(contentCount)} of {String(project.sources.length)} sources have stored
              content: {String(contentCount - suppliedCount)} captured from the source
              {suppliedCount > 0
                ? `, ${String(suppliedCount)} typed or pasted by an organizer`
                : ''}
              {withoutContentCount === 0 ? '' : '; the report will be based only on those'})
            </small>
          </p>
        )}
        <p>
          <small>
            Later steps (five questions, answers, final report) are not part of this version.{' '}
            <Link href={`/projects/${project.id}`}>All snapshots</Link>
          </small>
        </p>
      </section>
    </main>
  );
}
