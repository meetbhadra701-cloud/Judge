import type { ProjectDetail } from '@judge-copilot/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CorrectView } from './view';

vi.mock('./actions', () => ({ correctProjectAction: () => Promise.resolve() }));
vi.mock('next/navigation', () => ({ redirect: () => undefined }));

/* P6B-beta2: the void-and-replace page, rendered from plain data. */

const KEY = '0b9f6c1e-5b0e-4c27-9d6d-0a8e7d3f2a11';
const project = (voided: ProjectDetail['voided']): ProjectDetail => ({
  id: 'p1',
  eventId: 'e1',
  name: 'o/r',
  teamName: null,
  createdByActorId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tracks: [],
  voided,
  sources: [
    {
      id: 's1',
      projectId: 'p1',
      sourceType: 'github',
      url: 'https://github.com/o/r',
      position: 0,
      createdByActorId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      latestSnapshot: null,
    },
  ],
});

describe('void-and-replace page', () => {
  it('says that nothing is edited or deleted, shows the current links, and carries the request identity of the form', () => {
    const html = renderToStaticMarkup(<CorrectView project={project(null)} correctionKey={KEY} />);
    expect(html).toContain('Nothing is edited or deleted');
    expect(html).toContain('https://github.com/o/r');
    expect(html).toContain(`name="correctionKey" value="${KEY}"`);
    expect(html).toContain('name="reason"');
    expect(html).toContain('name="github"');
    expect(html).toContain('name="devpost"');
    expect(html).toContain('cannot be undone');
  });

  it('an already voided project offers no form', () => {
    const html = renderToStaticMarkup(
      <CorrectView
        project={project({
          voidedAt: '2026-02-01T00:00:00.000Z',
          voidedByActorId: 'a1',
          reason: 'x',
          nameBefore: 'o/r',
          replacedByProjectId: null,
        })}
        correctionKey={KEY}
      />,
    );
    expect(html).toContain('data-testid="already-voided"');
    expect(html).not.toContain('name="reason"');
  });
});
