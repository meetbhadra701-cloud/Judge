import type {
  EventContextLockedSnapshot,
  EventDetail,
  ProjectRecord,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, eventPath } from '../../../lib/api';
import { createProjectAction, createVersionAction } from '../../actions';
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
  const [projectsResult, contextResult] = await Promise.all([
    apiRequest<{ projects: ProjectRecord[] }>('GET', `${eventPath(eventId)}/projects`),
    lockedVersionId
      ? apiRequest<EventContextLockedSnapshot>('GET', `${eventPath(eventId)}/context`)
      : Promise.resolve(null),
  ]);
  const projectList = projectsResult.ok ? projectsResult.data.projects : [];
  const lockedTracks = contextResult?.ok ? contextResult.data.document.tracks : [];

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
        <h2>Projects</h2>
        {projectsResult.ok ? null : <ErrorBanner message={projectsResult.message} />}
        {projectList.length === 0 ? (
          <p>No projects yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Team</th>
                <th>Declared tracks</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {projectList.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link href={`/projects/${project.id}`}>{project.name}</Link>
                  </td>
                  <td>{project.teamName ?? '—'}</td>
                  <td>{project.tracks.map((track) => track.trackName).join(', ') || '—'}</td>
                  <td>{formatDate(project.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {lockedVersionId ? (
          <form action={createProjectAction} className="stack">
            <h3>Create project</h3>
            <input type="hidden" name="eventId" value={event.id} />
            <label>
              Name <input name="name" required maxLength={200} />
            </label>
            <label>
              Team name <input name="teamName" maxLength={200} />
            </label>
            {lockedTracks.length > 0 ? (
              <fieldset>
                <legend>Declared tracks (validated against the locked Event Context)</legend>
                {lockedTracks.map((track) => (
                  <label key={track.key} className="inline">
                    <input type="checkbox" name="trackKeys" value={track.key} /> {track.name}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <button type="submit">Create project</button>
          </form>
        ) : (
          <p className="notice">Lock an Event Context version before creating projects.</p>
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
