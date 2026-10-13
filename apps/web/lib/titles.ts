import type { EventDetail, ProjectDetail } from '@judge-copilot/schemas';
import { apiRequest, eventPath, projectPath } from './api';

/*
 * Page titles (R7-6): every page has its own, naming what it shows, so a person with several tabs open, a screen-reader user and the browser
 * history can tell them apart. Names are untrusted text; they are only ever placed in a <title> (escaped by React) and cut to a readable length.
 */

const MAX_NAME = 80;

function clip(name: string): string {
  const single = name.replace(/\s+/g, ' ').trim();
  return single.length > MAX_NAME ? `${single.slice(0, MAX_NAME - 1)}…` : single;
}

/** `<what> · <hackathon name>`; just `<what>` when the hackathon cannot be read. */
export async function eventPageTitle(eventId: string, what?: string): Promise<string> {
  const result = await apiRequest<EventDetail>('GET', eventPath(eventId));
  const name = result.ok ? clip(result.data.event.name) : null;
  if (what === undefined) return name ?? 'Hackathon';
  return name === null ? what : `${what} · ${name}`;
}

/** `<what> · <project name>`; just `<what>` when the project cannot be read. */
export async function projectPageTitle(projectId: string, what?: string): Promise<string> {
  const result = await apiRequest<ProjectDetail>('GET', projectPath(projectId));
  const name = result.ok ? clip(result.data.name) : null;
  if (what === undefined) return name ?? 'Project';
  return name === null ? what : `${what} · ${name}`;
}
