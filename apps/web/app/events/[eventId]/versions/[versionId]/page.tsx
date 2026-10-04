import { SOURCE_AUTHORITY_PRECEDENCE } from '@judge-copilot/context';
import {
  EVENT_SOURCE_AUTHORITY_VALUES,
  EVENT_SOURCE_TYPE_VALUES,
  type ContextVersionDetail,
  type EventSourceRecord,
  type EventSourceSummary,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, versionPath } from '../../../../../lib/api';
import {
  addSourceAction,
  buildContextAction,
  createVersionAction,
  lockContextAction,
} from '../../../../actions';
import {
  ConflictView,
  ErrorBanner,
  FactView,
  formatDate,
  SourceNames,
  StatusBadge,
} from '../../../../components/ui';

export const dynamic = 'force-dynamic';

export default async function VersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string; versionId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { eventId, versionId } = await params;
  const { error } = await searchParams;
  const [detailResult, sourcesResult] = await Promise.all([
    apiRequest<ContextVersionDetail>('GET', versionPath(eventId, versionId)),
    apiRequest<{ sources: EventSourceRecord[] }>(
      'GET',
      `${versionPath(eventId, versionId)}/sources`,
    ),
  ]);
  if (!detailResult.ok) {
    return (
      <main>
        <p>
          <Link href={`/events/${eventId}`}>← Event</Link>
        </p>
        <ErrorBanner message={detailResult.message} />
      </main>
    );
  }
  const version = detailResult.data;
  const sourceTexts = sourcesResult.ok ? sourcesResult.data.sources : [];
  const sources = new Map<string, EventSourceSummary>(
    version.sources.map((source) => [source.id, source]),
  );
  const document = version.document;
  const isDraft = version.status === 'draft';
  const hidden = (
    <>
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="versionId" value={versionId} />
    </>
  );

  return (
    <main>
      <p>
        <Link href={`/events/${eventId}`}>← Event</Link>
      </p>
      <h1>
        Event Context v{version.version} <StatusBadge status={version.status} />
      </h1>
      {version.status === 'locked' ? (
        <p className="notice">
          <strong>LOCKED</strong> · version {version.version} · locked at{' '}
          {formatDate(version.lockedAt)} · content hash{' '}
          <code>{version.lockedContentHash?.slice(0, 16)}…</code> · integrity{' '}
          {version.integrity ?? 'n/a'}. This version is immutable; changes require a new version.
        </p>
      ) : null}
      {version.status === 'superseded' ? (
        <p className="notice">
          <strong>SUPERSEDED</strong> · version {version.version} · locked at{' '}
          {formatDate(version.lockedAt)} · integrity {version.integrity ?? 'n/a'}. Kept unchanged
          for any assessment that referenced it.
        </p>
      ) : null}
      {version.changeReason ? <p>Change reason: {version.changeReason}</p> : null}
      {version.summary ? <p>Summary: {version.summary}</p> : null}
      <ErrorBanner message={error} />

      <section>
        <h2>Sources ({version.sources.length})</h2>
        {sourceTexts.length === 0 ? <p>No sources yet.</p> : null}
        {sourceTexts.map((source) => (
          <details key={source.id}>
            <summary>
              {source.title} · <strong>{source.authority}</strong> ({source.authorityRank}) ·{' '}
              {source.sourceType}
              {source.url ? ` · ${source.url}` : ''} · sha256{' '}
              <code>{source.contentHash.slice(0, 12)}</code> · {source.textLength} chars
            </summary>
            <pre>{source.normalizedText}</pre>
          </details>
        ))}
      </section>

      {isDraft ? (
        <section>
          <h2>Add pasted-text source</h2>
          <form action={addSourceAction} className="stack">
            {hidden}
            <label>
              Title <input name="title" required maxLength={300} />
            </label>
            <label>
              Authority{' '}
              <select name="authority" required defaultValue="official_event_rules">
                {EVENT_SOURCE_AUTHORITY_VALUES.map((authority) => (
                  <option key={authority} value={authority}>
                    {authority} ({SOURCE_AUTHORITY_PRECEDENCE[authority]})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Source type{' '}
              <select name="sourceType" required defaultValue="pasted_text">
                {EVENT_SOURCE_TYPE_VALUES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label>
              URL (provenance only; never fetched) <input name="url" type="url" maxLength={2048} />
            </label>
            <label>
              Normalized text <textarea name="normalizedText" required rows={8} />
            </label>
            <button type="submit">Add source</button>
          </form>

          <h2>Build and lock</h2>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <form action={buildContextAction}>
              {hidden}
              <button type="submit">Build context from sources</button>
            </form>
            <Link href={`/events/${eventId}/versions/${versionId}/edit`}>Edit draft</Link>
            <form action={lockContextAction}>
              {hidden}
              <button type="submit" disabled={!version.lockReadiness?.ready}>
                Lock context
              </button>
            </form>
          </div>
          {version.lockReadiness && !version.lockReadiness.ready ? (
            <div className="error">
              <strong>Cannot lock yet:</strong>
              <ul>
                {version.lockReadiness.issues.map((issue) => (
                  <li key={`${issue.code}:${issue.path}`}>
                    <code>{issue.code}</code> {issue.path}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {version.status === 'locked' ? (
        <section>
          <h2>Create new version</h2>
          <form action={createVersionAction} className="stack">
            <input type="hidden" name="eventId" value={eventId} />
            <label>
              Change reason <textarea name="changeReason" required maxLength={1000} />
            </label>
            <button type="submit">Create new version</button>
          </form>
        </section>
      ) : null}

      <section>
        <h2>Unresolved and unclear items ({version.unresolved.length})</h2>
        {version.unresolved.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {version.unresolved.map((item) => (
              <li key={item.id}>
                <code>{item.path}</code> — {item.statement}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!document ? (
        <section>
          <h2>Context</h2>
          <p>Not built or authored yet.</p>
        </section>
      ) : (
        <>
          <section>
            <h2>Dates</h2>
            {Object.entries(document.dates).map(([key, fact]) => (
              <div key={key}>
                <strong>{key}</strong>: {formatDate(fact.value)}
                <FactView fact={fact} sources={sources} />
              </div>
            ))}
          </section>
          <section>
            <h2>Judging format</h2>
            <FactView fact={document.judgingFormat} sources={sources} />
          </section>
          <section>
            <h2>Prior-work policy</h2>
            <FactView
              fact={document.priorWorkPolicy}
              sources={sources}
              extra={<strong>[{document.priorWorkPolicy.stance}]</strong>}
            />
          </section>
          <section>
            <h2>Official rules ({document.rules.length})</h2>
            {document.rules.map((fact) => (
              <FactView key={fact.id} fact={fact} sources={sources} />
            ))}
          </section>
          <section>
            <h2>Submission requirements ({document.submissionRequirements.length})</h2>
            {document.submissionRequirements.map((fact) => (
              <FactView
                key={fact.id}
                fact={fact}
                sources={sources}
                extra={fact.trackKey ? <em>(track: {fact.trackKey})</em> : <em>(all projects)</em>}
              />
            ))}
          </section>
          <section>
            <h2>Organizer guidance ({document.organizerGuidance.length})</h2>
            {document.organizerGuidance.map((fact) => (
              <FactView key={fact.id} fact={fact} sources={sources} />
            ))}
          </section>
          <section>
            <h2>Conflicts between sources ({document.conflicts.length})</h2>
            {document.conflicts.map((conflict) => (
              <ConflictView key={conflict.id} conflict={conflict} sources={sources} />
            ))}
          </section>
          <section>
            <h2>Tracks ({document.tracks.length})</h2>
            <ul>
              {document.tracks.map((track) => (
                <li key={track.key}>
                  <strong>{track.name}</strong> <code>{track.key}</code> {track.description ?? ''}{' '}
                  {track.humanModified ? '(human-edited)' : ''}{' '}
                  <SourceNames ids={track.sourceIds} sources={sources} />
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Rubrics ({document.rubrics.length})</h2>
            {document.rubrics.map((rubric) => (
              <div key={`${rubric.scope}:${rubric.trackKey ?? ''}`}>
                <h3>
                  {rubric.name} —{' '}
                  {rubric.scope === 'overall' ? 'overall' : `track ${rubric.trackKey ?? ''}`} ·
                  scale {rubric.scaleMin}–{rubric.scaleMax}
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Criterion</th>
                      <th>Weight</th>
                      <th>Anchors</th>
                      <th>Provenance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rubric.criteria.map((criterion) => (
                      <tr key={criterion.key}>
                        <td>
                          <code>{criterion.key}</code>
                        </td>
                        <td>
                          {criterion.name}
                          <br />
                          <small>{criterion.description}</small>
                        </td>
                        <td>{criterion.weight === null ? 'unweighted' : criterion.weight}</td>
                        <td>
                          {criterion.anchors
                            .map((anchor) => `${String(anchor.score)}: ${anchor.description}`)
                            .join(' · ') || '—'}
                        </td>
                        <td>
                          {criterion.humanModified ? 'human-edited · ' : ''}
                          <SourceNames ids={criterion.sourceIds} sources={sources} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
