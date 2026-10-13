import type { EventDetail, ProjectDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  captureFingerprint,
  describeCapture,
  overviewOf,
  sourceIntegrityNotice,
} from '../../../../lib/capture-status';
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
}

export function CaptureView({ project, event, error, retryAction }: CaptureViewProps): ReactNode {
  const overview = overviewOf(project.sources);
  const contentCount = project.sources.filter(
    (source) => describeCapture(source.latestSnapshot).hasContent,
  ).length;
  const locked = event?.lockedVersionId
    ? event.versions.find((version) => version.id === event.lockedVersionId)
    : undefined;
  return (
    <main>
      <p>
        <Link href={`/events/${project.eventId}/submit`}>← Submit another project</Link>
      </p>
      <h1>{project.name}</h1>
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
                      {source.latestSnapshot && source.latestSnapshot.captureNumber > 1 ? (
                        <>
                          <br />
                          <small>Attempt #{source.latestSnapshot.captureNumber}</small>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {view.retryable ? (
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {overview.anyWaiting ? <p role="status">Waiting for the capture worker.</p> : null}
        {overview.anyFailed ? (
          <p role="alert" className="error">
            At least one source could not be captured. You can retry it, or continue: a missing
            source is missing evidence, never a negative judgment about the project.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="next-heading">
        <h2 id="next-heading">Next: preliminary report</h2>
        <p className="notice" role="note">
          <strong>Temporary offline workflow.</strong> The report runs on recorded demonstration
          data only; no live model is used and nothing is spent. It is advisory: the human judge’s
          final score is separate and authoritative. Starting it is a separate click on the next
          page. Recorded answers exist only for the built-in synthetic demonstration project, so for
          the links you submitted the offline run is expected to end without a report, and the page
          will say why.
        </p>
        {contentCount === 0 ? (
          <p data-testid="next-blocked">
            The report needs at least one captured source.{' '}
            {overview.anyWaiting ? 'Waiting for the capture first.' : 'Retry a capture above.'}
          </p>
        ) : (
          <p>
            <Link href={`/projects/${project.id}/assessment`} data-testid="next-report">
              Open the preliminary report page →
            </Link>{' '}
            <small>
              ({String(contentCount)} of {String(project.sources.length)} sources captured
              {overview.allContent ? '' : '; the report will be based only on those'})
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
