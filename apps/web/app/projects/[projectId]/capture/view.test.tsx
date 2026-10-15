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
  id: string = sourceType,
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
  voided: null,
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

  it('waiting: says nothing was read yet, offers no retry, blocks the next step and says how it checks for progress', () => {
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
    expect(html).toContain('This page checks for progress every 3 seconds, for up to 5 minutes.');
    expect(html).not.toContain('refreshes itself');
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

describe('P6B-beta1: a project that mixes several submissions is flagged, never presented as clean', () => {
  it('warns when a project declares two Devpost links (the flow before submission records), and says nothing was changed', () => {
    const html = render(
      project([
        source('github', snapshot({ status: 'captured' })),
        source('devpost', snapshot({ status: 'captured', sourceType: 'devpost' }), 'devpost-1'),
        source('devpost', snapshot({ status: 'captured', sourceType: 'devpost' }), 'devpost-2'),
      ]),
    );
    expect(html).toContain('data-testid="mixed-project"');
    expect(html).toContain('declares 1 GitHub link and 2 Devpost links');
    expect(html).toContain('do not rely on them');
    expect(html).toContain('Nothing was changed or deleted');
  });

  it('shows no warning for one GitHub link and one Devpost link, or for fewer', () => {
    const clean = render(
      project([
        source('github', snapshot({ status: 'captured' })),
        source('devpost', snapshot({ status: 'captured', sourceType: 'devpost' })),
      ]),
    );
    expect(clean).not.toContain('mixed-project');
    expect(render(project([source('github', snapshot({ status: 'captured' }))]))).not.toContain(
      'mixed-project',
    );
  });
});

describe('P6B-beta2: a voided project is presented as history, and a live one offers the correction', () => {
  const voidedProject = (replacedBy: string | null): ProjectDetail => ({
    ...project([source('github', snapshot({ status: 'failed', failureCategory: 'timeout' }))]),
    voided: {
      voidedAt: '2026-02-01T00:00:00.000Z',
      voidedByActorId: 'a1',
      reason: 'Pasted the wrong <b>Devpost</b> link',
      nameBefore: 'o/r',
      replacedByProjectId: replacedBy,
    },
  });

  it('shows the void notice and the reason as text, links to the replacement, and offers no retry', () => {
    const html = render(voidedProject('p2'));
    expect(html).toContain('data-testid="voided-project"');
    expect(html).toContain('kept as history');
    expect(html).toContain('replaced by a corrected submission');
    // the organizer's words are rendered as text, never as markup
    expect(html).toContain('Pasted the wrong &lt;b&gt;Devpost&lt;/b&gt; link');
    expect(html).not.toContain('<b>Devpost</b>');
    expect(html).toContain('href="/projects/p2/capture"');
    expect(html).not.toContain('Retry capture');
    expect(html).not.toContain('data-testid="correct-link"');
  });

  it('a void without a replacement says nothing replaced it', () => {
    const html = render(voidedProject(null));
    expect(html).toContain('nothing was replaced');
    expect(html).not.toContain('Open the replacement project');
  });

  it('a live project links to the void-and-replace page', () => {
    const html = render(project([source('github', snapshot({ status: 'captured' }))]));
    expect(html).toContain('href="/projects/p1/correct"');
    expect(html).not.toContain('data-testid="voided-project"');
  });
});

describe('organizer-supplied Devpost text (P6B-beta3)', () => {
  const renderWith = (p: ProjectDetail) =>
    renderToStaticMarkup(
      <CaptureView
        project={p}
        event={event}
        error={undefined}
        retryAction={() => undefined}
        supplyAction={() => undefined}
      />,
    );
  const failedDevpost = snapshot({
    status: 'failed',
    sourceType: 'devpost',
    failureCategory: 'connection_failure',
  });

  it('offers the form for a Devpost source only, says what the stored text will be, and never for a repository', () => {
    const html = renderWith(
      project([source('github', snapshot({})), source('devpost', failedDevpost)]),
    );
    expect(html).toContain('data-testid="supply-content"');
    expect(html).toContain('name="submissionText"');
    expect(html).toContain('organizer-supplied');
    expect(html).toContain('not fetched from');
    expect(html.match(/data-testid="supply-content"/g)).toHaveLength(1);
  });

  it('is not offered while a fetch is waiting, for a voided project, or when no action is wired', () => {
    const waiting = renderWith(
      project([source('devpost', snapshot({ status: 'pending', sourceType: 'devpost' }))]),
    );
    expect(waiting).not.toContain('supply-content');
    const voidedProject = {
      ...project([source('devpost', failedDevpost)]),
      voided: {
        voidedAt: '2026-01-02T00:00:00.000Z',
        voidedByActorId: null,
        reason: 'wrong',
        nameBefore: 'o/r',
        replacedByProjectId: null,
      },
    } as unknown as ProjectDetail;
    expect(renderWith(voidedProject)).not.toContain('supply-content');
    expect(render(project([source('devpost', failedDevpost)]))).not.toContain('supply-content');
  });

  it('labels a supplied snapshot as supplied, not as a Devpost capture', () => {
    const html = renderWith(
      project([
        source(
          'devpost',
          snapshot({
            status: 'captured',
            sourceType: 'devpost',
            provenance: 'organizer_supplied',
          }),
        ),
      ]),
    );
    expect(html).toContain('TEXT SUPPLIED BY AN ORGANIZER');
    expect(html).toContain('NOT fetched from the source');
    expect(html).not.toContain('>CAPTURED<');
  });
});
