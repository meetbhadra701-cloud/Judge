import type { ContextConflict, ContextFact, EventSourceSummary } from '@judge-copilot/schemas';
import type { ReactNode } from 'react';

/** All project- and source-supplied text is rendered as plain React text (escaped). */

export function ErrorBanner({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="error">
      {message}
    </p>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{status.toUpperCase()}</span>;
}

function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function SourceNames({
  ids,
  sources,
}: {
  ids: readonly string[];
  sources: ReadonlyMap<string, EventSourceSummary>;
}) {
  if (ids.length === 0) return <Tag tone="muted">no source</Tag>;
  return (
    <>
      {ids.map((id) => {
        const source = sources.get(id);
        return (
          <Tag key={id}>
            {source
              ? `${source.title} · ${source.authority} (${String(source.authorityRank)})`
              : id}
          </Tag>
        );
      })}
    </>
  );
}

export function FactView({
  fact,
  sources,
  extra,
}: {
  fact: ContextFact;
  sources: ReadonlyMap<string, EventSourceSummary>;
  extra?: ReactNode;
}) {
  return (
    <div className="fact">
      <div>
        {fact.statement} {extra}
      </div>
      <div className="meta">
        <Tag tone={fact.certainty === 'unclear' ? 'warn' : 'neutral'}>{fact.certainty}</Tag>
        <Tag tone={fact.origin === 'human' ? 'human' : 'neutral'}>
          {fact.origin === 'human' ? 'human note' : 'source-derived'}
        </Tag>
        {fact.humanModified ? <Tag tone="human">human-edited</Tag> : null}
        <SourceNames ids={fact.sourceIds} sources={sources} />
      </div>
    </div>
  );
}

export function ConflictView({
  conflict,
  sources,
}: {
  conflict: ContextConflict;
  sources: ReadonlyMap<string, EventSourceSummary>;
}) {
  const prevailing = new Set(conflict.resolution.prevailingSourceIds);
  return (
    <div className="fact">
      <div>
        <strong>{conflict.topic}</strong>: {conflict.description}
      </div>
      <div className="meta">
        <Tag tone={conflict.resolution.status === 'unresolved' ? 'warn' : 'neutral'}>
          {conflict.resolution.status.replaceAll('_', ' ')}
        </Tag>
        {conflict.resolution.note ? <Tag tone="human">note: {conflict.resolution.note}</Tag> : null}
      </div>
      <ul>
        {conflict.positions.map((position) => {
          const source = sources.get(position.sourceId);
          return (
            <li key={position.sourceId}>
              {prevailing.has(position.sourceId) ? (
                <Tag tone="ok">prevails</Tag>
              ) : (
                <Tag tone="muted">kept, overridden</Tag>
              )}{' '}
              “{position.statement}” —{' '}
              {source
                ? `${source.title} (${source.authority}, ${String(source.authorityRank)})`
                : position.sourceId}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function formatDate(value: string | null): string {
  return value
    ? new Date(value)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ' UTC')
    : '—';
}
