import type { EventDetail, ProjectDetail, SnapshotSummary } from '@judge-copilot/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CaptureView } from './view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

/* P6B-alpha: the capture-progress page, rendered from plain data. Capturing is never presented as an analysis. */

const snapshot = (overrides: Partial<SnapshotSummary>): SnapshotSummary => ({
  id: 's1',
  projectId: 'p1',
  sourceId: 'src',
  captureNumber: 1,
  sourceType: 'github',
  sourceUrl: 'https://github.com/o/r',
  status: 'captured',
  revision: null,
  contentHash: null,
  partialReasons: [],
  failureCategory: null,
  requestedAt: '2026-01-01T00:00:00.000Z',
  capturedAt: null,
  completedAt: null,
  artifactCount: 0,
  artifactBytes: 0,
  ...overrides,
});

const source = (
  sourceType: 'github' | 'devpost',
  latest: SnapshotSummary | null,
  id = sourceType,
) => ({
  id,
  projectId: 'p1',
  sourceType,
  url: sourceType === 'github' ? 'https://github.com/o/r' : 'https://devpost.com/software/x',
  position: 0,
  createdByActorId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  latestSnapshot: latest,
});

const project = (sources: ProjectDetail['sources'], name = 'o/r'): ProjectDetail => ({
  id: 'p1',
  eventId: 'e1',
  name,
  teamName: null,
  createdByActorId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tracks: [],
  sources,
});

const event = {
  event: { id: 'e1', name: 'Demo Hackathon', slug: 'demo', createdAt: '', updatedAt: '' },
  versions: [{ id: 'v1', version: 3, status: 'locked' }],
  lockedVersionId: 'v1',
} as unknown as EventDetail;

const render = (p: ProjectDetail, error?: string) =>
  renderToStaticMarkup(
    <CaptureView project={p} event={event} error={error} retryAction={() => undefined} />,
  );

describe('capture progress page', () => {
  it('identifies the hackathon and the locked Event Context', () => {
    const html = render(project([source('github', snapshot({}))]));
    expect(html).toContain('Demo Hackathon');
    expect(html).toContain('locked Event Context v3');
  });

  it('waiting: says nothing was read yet, offers no retry, blocks the next step and refreshes itself', () => {
    const html = render(
      project([
        source('github', snapshot({ status: 'pending' })),
        source('devpost', snapshot({ status: 'pending', sourceType: 'devpost' })),
      ]),
    );
    expect(html).toContain('WAITING FOR THE CAPTURE WORKER');
    expect(html).toContain('Nothing has been read from this source yet');
    expect(html).not.toContain('Retry capture');
    expect(html).toContain('data-testid="next-blocked"');
    expect(html).not.toContain('data-testid="next-report"');
    expect(html).toContain('This page refreshes itself');
  });

  it('captured: says it is not an analysis and not verified, and links to the separate report step', () => {
    const html = render(
      project([
        source('github', snapshot({})),
        source('devpost', snapshot({ sourceType: 'devpost' })),
      ]),
    );
    expect(html).toContain('CAPTURED');
    expect(html).toContain('not an analysis');
    expect(html).toContain('not verified');
    expect(html).toContain('href="/projects/p1/assessment"');
    expect(html).toContain('Temporary offline workflow');
    expect(html).toContain('recorded demonstration data only');
    expect(html).toContain('separate click');
    expect(html).not.toMatch(/analysis (is )?complete/i);
  });

  it('one source failed: per-source failure, a retry for that source only, and the missing source is not a negative judgment', () => {
    const html = render(
      project([
        source('github', snapshot({ status: 'failed', failureCategory: 'not_found' })),
        source('devpost', snapshot({ sourceType: 'devpost' })),
      ]),
    );
    expect(html).toContain('CAPTURE FAILED');
    expect(html).toContain('Nothing was found at this address');
    expect(html.match(/Retry capture/g)).toHaveLength(1);
    expect(html).toContain('missing evidence, never a negative judgment');
    // the report remains reachable from the source that did capture, and says it will use only that
    expect(html).toContain('1 of 2 sources captured; the report will be based only on those');
  });

  it('partial: lists what is missing and offers to capture again', () => {
    const html = render(
      project([
        source('github', snapshot({ status: 'partial', partialReasons: ['commit_limit'] })),
      ]),
    );
    expect(html).toContain('CAPTURED (PARTIAL)');
    expect(html).toContain('only the most recent commits were read');
    expect(html).toContain('Capture again');
  });

  it('refused by the safety policy and never requested are both explained', () => {
    const html = render(
      project([
        source('github', snapshot({ status: 'rejected', failureCategory: 'ssrf_rejected' })),
        source('devpost', null),
      ]),
    );
    expect(html).toContain('CAPTURE REFUSED');
    expect(html).toContain('not a public web address');
    expect(html).toContain('NOT CAPTURED YET');
  });

  it('shows the attempt number of a retried capture', () => {
    expect(
      render(
        project([
          source(
            'github',
            snapshot({ status: 'failed', failureCategory: 'timeout', captureNumber: 3 }),
          ),
        ]),
      ),
    ).toContain('Attempt #3');
  });

  it('renders hostile project text as inert text', () => {
    const html = render(
      project([source('github', snapshot({}))], '<img src=x onerror=alert(1)>'),
      '<script>alert(1)</script>',
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('says the later steps are not part of this version', () => {
    expect(render(project([source('github', snapshot({}))]))).toContain(
      'five questions, answers, final report) are not part of this version',
    );
  });
});
