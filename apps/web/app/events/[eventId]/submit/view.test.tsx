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
    expect(html).toContain('Start analysis');
  });

  it('states that this is a temporary offline workflow and that capture is not an AI analysis', () => {
    const html = renderToStaticMarkup(
      <SubmitView event={event as never} locked={locked} rubric={null} />,
    );
    expect(html).toContain('Temporary offline workflow');
    expect(html).toContain('not an AI analysis');
    expect(html).toContain('nothing here calls a live model');
    expect(html).toContain('recorded demonstration data only');
  });

  it('without a locked Event Context there is no form, only a way to set one up', () => {
    const html = renderToStaticMarkup(
      <SubmitView event={event as never} locked={null} rubric={null} />,
    );
    expect(html).toContain('no locked Event Context');
    expect(html).not.toContain('name="github"');
    expect(html).not.toContain('Start analysis');
    expect(html).toContain('href="/events/e1"');
  });

  it('renders hostile event names as inert text', () => {
    const html = renderToStaticMarkup(
      <SubmitView
        event={{ ...event, name: '<script>alert(1)</script>' } as never}
        locked={locked}
        rubric={null}
      />,
    );
    expect(html).not.toContain('<script>alert');
  });
});
