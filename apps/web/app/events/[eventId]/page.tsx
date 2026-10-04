import type { EventDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, eventPath } from '../../../lib/api';
import { createVersionAction } from '../../actions';
import { ErrorBanner, formatDate, StatusBadge } from '../../components/ui';

export const dynamic = 'force-dynamic';

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { eventId } = await params;
  const { error } = await searchParams;
  const result = await apiRequest<EventDetail>('GET', eventPath(eventId));
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
  const { event, versions, lockedVersionId } = result.data;

  return (
    <main>
      <p>
        <Link href="/">← Events</Link>
      </p>
      <h1>{event.name}</h1>
      <p>
        <code>{event.slug}</code>
      </p>
      <ErrorBanner message={error} />

      <section>
        <h2>Event Context versions</h2>
        {versions.length === 0 ? (
          <p>No Event Context yet. Create a draft to add the official sources.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Created</th>
                <th>Locked</th>
                <th>Change reason</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id}>
                  <td>
                    <Link href={`/events/${event.id}/versions/${version.id}`}>
                      v{version.version}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={version.status} />
                  </td>
                  <td>{formatDate(version.createdAt)}</td>
                  <td>{formatDate(version.lockedAt)}</td>
                  <td>{version.changeReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>{lockedVersionId ? 'Create new version' : 'Create draft version'}</h2>
        {lockedVersionId ? (
          <p className="notice">
            The locked version is immutable. A new version starts as a copy of it (sources and
            context), and locking the new version supersedes the old one.
          </p>
        ) : null}
        <form action={createVersionAction} className="stack">
          <input type="hidden" name="eventId" value={event.id} />
          {lockedVersionId ? (
            <label>
              Change reason <textarea name="changeReason" required maxLength={1000} />
            </label>
          ) : null}
          <button type="submit">
            {lockedVersionId ? 'Create new version' : 'Create draft version'}
          </button>
        </form>
      </section>
    </main>
  );
}
