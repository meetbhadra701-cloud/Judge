import type { ArtifactDetail, SnapshotDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, projectPath } from '../../../../../lib/api';
import { ErrorBanner, formatDate, StatusBadge } from '../../../../components/ui';

export const dynamic = 'force-dynamic';

/**
 * Immutable snapshot view. Captured artifacts are shown as escaped plain text inside <pre>: code
 * is never highlighted-by-execution, and submitted HTML is never rendered as HTML.
 */
export default async function SnapshotPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; snapshotId: string }>;
  searchParams: Promise<{ artifact?: string }>;
}) {
  const { projectId, snapshotId } = await params;
  const { artifact: artifactId } = await searchParams;
  const base = `${projectPath(projectId)}/snapshots/${encodeURIComponent(snapshotId)}`;
  const result = await apiRequest<SnapshotDetail>('GET', base);
  if (!result.ok) {
    return (
      <main>
        <p>
          <Link href={`/projects/${projectId}`}>← Project</Link>
        </p>
        <ErrorBanner message={result.message} />
      </main>
    );
  }
  const snapshot = result.data;
  const selected = artifactId
    ? await apiRequest<ArtifactDetail>('GET', `${base}/artifacts/${encodeURIComponent(artifactId)}`)
    : null;

  return (
    <main>
      <p>
        <Link href={`/projects/${projectId}`}>← Project</Link>
      </p>
      <h1>
        Snapshot #{snapshot.captureNumber} <StatusBadge status={snapshot.status} />
      </h1>
      <table>
        <tbody>
          <tr>
            <th>Source type</th>
            <td>{snapshot.sourceType}</td>
          </tr>
          <tr>
            <th>Source URL</th>
            <td>
              <code>{snapshot.sourceUrl}</code>
            </td>
          </tr>
          <tr>
            <th>Revision</th>
            <td>{snapshot.revision ? <code>{snapshot.revision}</code> : '—'}</td>
          </tr>
          <tr>
            <th>Requested</th>
            <td>{formatDate(snapshot.requestedAt)}</td>
          </tr>
          <tr>
            <th>Captured</th>
            <td>{formatDate(snapshot.capturedAt)}</td>
          </tr>
          <tr>
            <th>Completed</th>
            <td>{formatDate(snapshot.completedAt)}</td>
          </tr>
          <tr>
            <th>Content hash</th>
            <td>{snapshot.contentHash ? <code>{snapshot.contentHash}</code> : '—'}</td>
          </tr>
          <tr>
            <th>Partial reasons</th>
            <td>{snapshot.partialReasons.join(', ') || '—'}</td>
          </tr>
          <tr>
            <th>Failure category</th>
            <td>{snapshot.failureCategory ?? '—'}</td>
          </tr>
          <tr>
            <th>Capture run</th>
            <td>
              {snapshot.run
                ? `${snapshot.run.state}${snapshot.run.failureCategory ? ` (${snapshot.run.failureCategory})` : ''}, attempts: ${String(snapshot.run.attemptCount)}`
                : '—'}
            </td>
          </tr>
        </tbody>
      </table>

      <section>
        <h2>Metadata</h2>
        <pre>{JSON.stringify(snapshot.metadata ?? snapshot.failureMetadata, null, 2)}</pre>
      </section>

      <section>
        <h2>Artifacts ({snapshot.artifacts.length})</h2>
        {snapshot.artifacts.length === 0 ? (
          <p>No artifacts.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Kind</th>
                <th>Bytes</th>
                <th>SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.artifacts.map((artifact) => (
                <tr key={artifact.id}>
                  <td>
                    <Link
                      href={`/projects/${projectId}/snapshots/${snapshotId}?artifact=${artifact.id}`}
                    >
                      {artifact.key}
                    </Link>
                  </td>
                  <td>{artifact.kind}</td>
                  <td>{artifact.byteLength}</td>
                  <td>
                    <code>{artifact.contentHash.slice(0, 16)}…</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected ? (
        <section>
          {selected.ok ? (
            <>
              <h2>{selected.data.key}</h2>
              <p className="notice">Untrusted captured text, shown verbatim as plain text.</p>
              <pre className="artifact">{selected.data.textContent}</pre>
            </>
          ) : (
            <ErrorBanner message={selected.message} />
          )}
        </section>
      ) : null}
    </main>
  );
}
