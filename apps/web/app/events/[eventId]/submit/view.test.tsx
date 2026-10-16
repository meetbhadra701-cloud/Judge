import type { EventDetail } from '@judge-copilot/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SubmitView } from './view';

vi.mock('./actions', () => ({ submitProjectAction: () => Promise.resolve() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
  redirect: () => undefined,
}));

/* P6B-alpha: the submit page rendered from plain data. */

const event = { id: 'e1', name: 'Demo Hackathon', slug: 'demo-hack', createdAt: '', updatedAt: '' };
const KEY = '0b9f6c1e-5b0e-4c27-9d6d-0a8e7d3f2a11';
const locked = {
  id: 'v2',
  version: 2,
  status: 'locked',
} as unknown as EventDetail['versions'][number];

describe('submit page', () => {
  it('names the active hackathon and the locked Event Context, and offers both link fields', () => {
    const html = renderToStaticMarkup(
      <SubmitView
        event={event as never}
        locked={locked}
        rubric={{ name: 'Official rubric', criteriaCount: 4 }}
        submissionKey={KEY}
      />,
    );
    expect(html).toContain('Demo Hackathon');
    expect(html).toContain('locked Event Context');
    expect(html).toContain('v2');
    expect(html).toContain('Official rubric');
    expect(html).toContain('4 criteria');
    expect(html).toContain('GitHub repository URL');
    expect(html).toContain('Devpost project URL');
    expect(html).toContain('name="github"');
    expect(html).toContain('name="devpost"');
    expect(html).toContain('Submit and start capture');
    // the request identity of THIS form travels with it, so a retry can only converge
    expect(html).toContain(`name="submissionKey" value="${KEY}"`);
  });

  it('states that this is a temporary offline workflow and that capture is not an AI analysis', () => {
    const html = renderToStaticMarkup(
      <SubmitView event={event as never} locked={locked} rubric={null} submissionKey={KEY} />,
    );
    expect(html).toContain('Temporary offline workflow');
    expect(html).toContain('not an AI analysis');
    expect(html).toContain('nothing here calls a live model');
    expect(html).toContain('offline on a demonstration provider');
    expect(html).not.toContain('recorded demonstration data only');
  });

  it('without a locked Event Context there is no form, only a way to set one up', () => {
    const html = renderToStaticMarkup(
      <SubmitView event={event as never} locked={null} rubric={null} submissionKey={KEY} />,
    );
    expect(html).toContain('no locked Event Context');
    expect(html).not.toContain('name="github"');
    expect(html).not.toContain('Submit and start capture');
    expect(html).toContain('href="/events/e1"');
  });

  const trackContext = {
    contextVersionId: '3f1c2d0e-0000-4000-8000-000000000001',
    hasEventWideReference: true,
    tracks: [
      { key: 'health', name: 'Health', description: 'Projects about health.' },
      { key: 'climate', name: 'Climate', description: null },
    ],
  };

  it('P6D: offers the locked context’s tracks as checkboxes and sends the version token back with the form', () => {
    const html = renderToStaticMarkup(
      <SubmitView
        event={event as never}
        locked={locked}
        rubric={null}
        trackContext={trackContext}
        submissionKey={KEY}
      />,
    );
    expect(html).toContain('Tracks this project competes in');
    expect(html).toContain('name="trackKeys" value="health"');
    expect(html).toContain('name="trackKeys" value="climate"');
    expect(html).toContain('Projects about health.');
    expect(html).toContain('name="contextVersionId" value="3f1c2d0e-0000-4000-8000-000000000001"');
    // an event-wide reference exists: no warning that a track is needed
    expect(html).not.toContain('Without a track the report cannot be requested');
  });

  it('P6D: when the context has only track-specific reference material the page says a track is needed, and that it cannot be added later', () => {
    const html = renderToStaticMarkup(
      <SubmitView
        event={event as never}
        locked={locked}
        rubric={null}
        trackContext={{ ...trackContext, hasEventWideReference: false }}
        submissionKey={KEY}
      />,
    );
    expect(html).toContain('Without a track the report cannot be requested');
    expect(html).toContain('a track cannot be added later');
  });

  it('P6D: an event with no tracks shows no track section at all', () => {
    const html = renderToStaticMarkup(
      <SubmitView
        event={event as never}
        locked={locked}
        rubric={null}
        trackContext={{ ...trackContext, tracks: [] }}
        submissionKey={KEY}
      />,
    );
    expect(html).not.toContain('Tracks this project competes in');
    expect(html).not.toContain('name="contextVersionId"');
  });

  it('renders hostile event names as inert text', () => {
    const html = renderToStaticMarkup(
      <SubmitView
        event={{ ...event, name: '<script>alert(1)</script>' } as never}
        locked={locked}
        rubric={null}
        submissionKey={KEY}
      />,
    );
    expect(html).not.toContain('<script>alert');
  });
});
