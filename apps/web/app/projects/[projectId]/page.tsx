import type { Metadata } from 'next';
import {
  PROJECT_SOURCE_TYPE_VALUES,
  type ProjectDetail,
  type SnapshotSummary,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, projectPath } from '../../../lib/api';
import { openMessage } from '../../../lib/flash';
import { addProjectSourceAction, requestCaptureAction } from '../../actions';
import { ErrorBanner, formatDate, StatusBadge } from '../../components/ui';
import { voidedNotice } from '../../../lib/submission';
import { projectPageTitle } from '../../../lib/titles';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const { projectId } = await params;
  return { title: await projectPageTitle(projectId) };
}

export const dynamic = 'force-dynamic';

const SOURCE_LABELS: Record<(typeof PROJECT_SOURCE_TYPE_VALUES)[number], string> = {
  devpost: 'Devpost',
  github: 'GitHub',
  deployment: 'Deployment',
  video: 'Video',
};

/** Project page: declared tracks, declared sources, capture requests and snapshots (newest first). */
export default async function ProjectPage({
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
  const [result, snapshotsResult] = await Promise.all([
    apiRequest<ProjectDetail>('GET', projectPath(projectId)),
    apiRequest<{ snapshots: SnapshotSummary[] }>('GET', `${projectPath(projectId)}/snapshots`),
  ]);
  if (!result.ok) {
    return (
      <main>
        <p>
          <Link href="/">← Events</Link>
        </p>
        <ErrorBanner message={result.message} />
      </main>
    );
  }
  const project = result.data;
  const snapshots = snapshotsResult.ok ? snapshotsResult.data.snapshots : [];
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));

  return (
    <main>
      <p>
        <Link href={`/events/${project.eventId}`}>← Event</Link>
      </p>
      <h1>{project.name}</h1>
      {project.voided !== null ? (
        <section role="status" className="notice" data-testid="voided-project">
          <p>
            <strong>Voided.</strong> {voidedNotice(project)}
          </p>
          <p>
            Reason on record: <q>{project.voided.reason}</q>
          </p>
          {project.voided.replacedByProjectId !== null ? (
            <p>
              <Link href={`/projects/${project.voided.replacedByProjectId}`}>
                Open the replacement project →
              </Link>
            </p>
          ) : null}
        </section>
      ) : (
        <p>
          <Link href={`/projects/${project.id}/correct`}>Void and replace this submission →</Link>
        </p>
      )}
      <p>Team: {project.teamName ?? '—'}</p>
      <ErrorBanner message={error} />
      <p className="notice">
        Captured material is untrusted data. Snapshots are immutable; a new capture always creates a
        new snapshot. Nothing here is scored.
      </p>

      <p>
        <Link href={`/projects/${project.id}/evidence`}>Evidence graph (read-only) →</Link>
      </p>
      <p>
        <Link href={`/projects/${project.id}/assessment`}>
          Pre-interview assessment (advisory) →
        </Link>
      </p>

      <section>
        <h2>Declared tracks</h2>
        {project.tracks.length === 0 ? (
          <p>No tracks declared.</p>
        ) : (
          <ul>
            {project.tracks.map((track) => (
              <li key={track.id}>
                {track.trackName} <code>{track.trackKey}</code> — validated against Event Context v
                {track.contextVersion}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Sources</h2>
        {project.sources.length === 0 ? (
          <p>No sources declared yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>URL</th>
                <th>Latest snapshot</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.sources.map((source) => (
                <tr key={source.id}>
                  <td>{SOURCE_LABELS[source.sourceType]}</td>
                  <td>
                    <code>{source.url}</code>
                  </td>
                  <td>
                    {source.latestSnapshot ? (
                      <Link href={`/projects/${project.id}/snapshots/${source.latestSnapshot.id}`}>
                        #{source.latestSnapshot.captureNumber}{' '}
                        <StatusBadge status={source.latestSnapshot.status} />
                      </Link>
                    ) : (
                      'never captured'
                    )}
                  </td>
                  <td>
                    {project.voided === null ? (
                      <form action={requestCaptureAction}>
                        <input type="hidden" name="projectId" value={project.id} />
                        <input type="hidden" name="sourceId" value={source.id} />
                        <button type="submit">Request capture</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {project.sources.length > 0 && project.voided === null ? (
          <form action={requestCaptureAction}>
            <input type="hidden" name="projectId" value={project.id} />
            <button type="submit">Capture all sources</button>
          </form>
        ) : null}
        {project.voided === null ? (
          <form action={addProjectSourceAction} className="stack">
            <h3>Add source</h3>
            <input type="hidden" name="projectId" value={project.id} />
            <label>
              Type{' '}
              <select name="sourceType" required>
                {PROJECT_SOURCE_TYPE_VALUES.map((type) => (
                  <option key={type} value={type}>
                    {SOURCE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              URL <input name="url" type="url" required maxLength={2048} />
            </label>
            <button type="submit">Add source</button>
          </form>
        ) : null}
      </section>

      <section>
        <h2>Snapshots (newest first)</h2>
        {snapshots.length === 0 ? (
          <p>No captures requested yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>#</th>
                <th>Status</th>
                <th>Revision</th>
                <th>Requested</th>
                <th>Completed</th>
                <th>Artifacts</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>
                    {SOURCE_LABELS[snapshot.sourceType]}{' '}
                    <small>{sourceById.get(snapshot.sourceId)?.url}</small>
                  </td>
                  <td>
                    <Link href={`/projects/${project.id}/snapshots/${snapshot.id}`}>
                      {snapshot.captureNumber}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={snapshot.status} />
                    {snapshot.failureCategory ? <small> {snapshot.failureCategory}</small> : null}
                    {snapshot.partialReasons.length > 0 ? (
                      <small> {snapshot.partialReasons.join(', ')}</small>
                    ) : null}
                  </td>
                  <td>{snapshot.revision ? <code>{snapshot.revision.slice(0, 12)}</code> : '—'}</td>
                  <td>{formatDate(snapshot.requestedAt)}</td>
                  <td>{formatDate(snapshot.completedAt)}</td>
                  <td>{snapshot.artifactCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
