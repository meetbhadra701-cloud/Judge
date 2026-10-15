import {
  CAPTURE_FAILURE_CATEGORY_VALUES,
  CAPTURE_PARTIAL_REASON_VALUES,
  SOURCE_SNAPSHOT_STATUS_VALUES,
  type ProjectSourceRecord,
  type SnapshotSummary,
} from '../../packages/schemas/src/index.js';
import { describe, expect, it } from 'vitest';
import {
  describeCapture,
  FAILURE_TEXT,
  overviewOf,
  PARTIAL_TEXT,
} from '../../apps/web/lib/capture-status.js';
import { deriveProjectName, validateSubmission } from '../../apps/web/lib/submission.js';

/* P6B-alpha: the pure rules of the submission form and of the capture-status wording. */

const GITHUB = 'https://github.com/Owner/Repo';
const DEVPOST = 'https://devpost.com/software/My-Project';

describe('validateSubmission', () => {
  it('accepts the two links, canonicalizes them and derives a deterministic name from the repository', () => {
    const result = validateSubmission({ github: ` ${GITHUB}/ `, devpost: DEVPOST, name: '' });
    expect(result).toMatchObject({
      ok: true,
      projectName: 'owner/repo',
      nameDerived: true,
    });
    if (!result.ok) return;
    expect(result.github.canonicalUrl).toBe('https://github.com/owner/repo');
    expect(result.devpost.canonicalUrl).toBe('https://devpost.com/software/my-project');
    expect(deriveProjectName(result.github)).toBe('owner/repo');
    // tolerated spellings of the same repository give the same name
    for (const spelling of [
      'https://github.com/owner/repo.git',
      'https://www.github.com/OWNER/repo?tab=readme#top',
    ]) {
      expect(validateSubmission({ github: spelling, devpost: DEVPOST, name: '' })).toMatchObject({
        ok: true,
        projectName: 'owner/repo',
      });
    }
  });

  it('a typed name overrides the derived one and is labelled as typed', () => {
    expect(
      validateSubmission({ github: GITHUB, devpost: DEVPOST, name: '  Team Atlas  ' }),
    ).toMatchObject({
      ok: true,
      projectName: 'Team Atlas',
      nameDerived: false,
    });
  });

  it.each([
    ['a name with a line break', 'Atlas\nteam'],
    ['a name with a control character', 'Atlas\u0007'],
    ['a name with a paragraph separator', 'Atlas team'],
    ['a name that is too long', 'x'.repeat(201)],
  ])('refuses %s', (_label, name) => {
    const result = validateSubmission({ github: GITHUB, devpost: DEVPOST, name });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.name?.length).toBeGreaterThan(10);
  });

  it('reports both bad fields at once, each with an actionable message that names the example', () => {
    const result = validateSubmission({
      github: 'not a url',
      devpost: 'https://example.com/x',
      name: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.github).toContain('https://github.com/owner/repository');
    expect(result.errors.devpost).toContain('https://devpost.com/software/project-name');
  });

  it('points a swapped link to the right field', () => {
    const result = validateSubmission({ github: DEVPOST, devpost: GITHUB, name: '' });
    expect(!result.ok && result.errors.github).toContain('Devpost field');
    expect(!result.ok && result.errors.devpost).toContain('GitHub field');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://github.com/a/b',
    'https://user:pass@github.com/a/b',
    'https://github.com:8443/a/b',
    'https://github.com/a',
    'https://github.com/a/b/c',
    'https://github.com/settings/profile',
    'https://github.com.attacker.example/a/b',
    'https://xn--gthub-bva.com/a/b',
    `https://github.com/${'a'.repeat(3000)}/b`,
    '//github.com/a/b',
    '',
  ])('refuses the hostile GitHub value %j', (value) => {
    const result = validateSubmission({ github: value, devpost: DEVPOST, name: '' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.github).toBeTruthy();
  });

  it('never returns a URL other than the canonical one it parsed (no raw input is passed on)', () => {
    const result = validateSubmission({
      github: 'https://GitHub.com/Owner/Repo.git?x=1#frag',
      devpost: DEVPOST,
      name: '',
    });
    expect(result.ok && result.github.canonicalUrl).toBe('https://github.com/owner/repo');
  });
});

describe('capture status wording', () => {
  const snapshot = (overrides: Partial<SnapshotSummary>): SnapshotSummary => ({
    id: 's',
    projectId: 'p',
    sourceId: 'src',
    captureNumber: 1,
    sourceType: 'github',
    sourceUrl: GITHUB,
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

  it('explains every failure category and every partial reason (exhaustive over the schema vocabularies)', () => {
    expect(Object.keys(FAILURE_TEXT).sort()).toEqual([...CAPTURE_FAILURE_CATEGORY_VALUES].sort());
    expect(Object.keys(PARTIAL_TEXT).sort()).toEqual([...CAPTURE_PARTIAL_REASON_VALUES].sort());
    for (const text of [...Object.values(FAILURE_TEXT), ...Object.values(PARTIAL_TEXT)]) {
      expect(text.length).toBeGreaterThan(8);
    }
  });

  it('describes every snapshot status and never implies an analysis or a verification', () => {
    for (const status of SOURCE_SNAPSHOT_STATUS_VALUES) {
      const view = describeCapture(
        snapshot({
          status,
          failureCategory: status === 'failed' || status === 'rejected' ? 'timeout' : null,
        }),
      );
      const everything = `${view.label} ${view.detail}`.toLowerCase();
      expect(everything).not.toMatch(/analy[sz]ed|verified|approved|score/);
    }
    expect(describeCapture(null).stage).toBe('not_requested');
  });

  it('a capture cancelled by a void says that nothing was read, and is not a retryable failure of the source', () => {
    const view = describeCapture(
      snapshot({
        status: 'failed',
        failureCategory: 'internal_error',
        failureReason: 'cancelled_by_void',
      }),
    );
    expect(view.label).toBe('CAPTURE CANCELLED');
    expect(view.detail).toContain('before any worker started it');
    expect(view.detail).toContain('Nothing was read');
    expect([view.retryable, view.hasContent]).toEqual([false, false]);
    // the same category without that reason is still the generic internal error
    expect(
      describeCapture(snapshot({ status: 'failed', failureCategory: 'internal_error' })).label,
    ).toBe('CAPTURE FAILED');
  });

  it('only a captured or partial snapshot has content; failed, refused, waiting and missing do not', () => {
    const content = (status: SnapshotSummary['status']) =>
      describeCapture(snapshot({ status })).hasContent;
    expect([content('captured'), content('partial')]).toEqual([true, true]);
    expect([content('pending'), content('failed'), content('rejected')]).toEqual([
      false,
      false,
      false,
    ]);
    expect(describeCapture(null).hasContent).toBe(false);
  });

  it('a captured source says it is not an analysis; a partial one says what is missing is not negative evidence', () => {
    expect(describeCapture(snapshot({ status: 'captured' })).detail).toContain('not an analysis');
    const partial = describeCapture(
      snapshot({ status: 'partial', partialReasons: ['commit_limit', 'file_count_limit'] }),
    );
    expect(partial.detail).toContain('not negative evidence');
    expect(partial.gaps).toEqual([PARTIAL_TEXT.commit_limit, PARTIAL_TEXT.file_count_limit]);
    expect(partial.retryable).toBe(true);
  });

  it('retry is offered for failed, refused, partial and never-requested sources, not for waiting or captured ones', () => {
    const retry = (status: SnapshotSummary['status']) =>
      describeCapture(snapshot({ status })).retryable;
    expect([retry('failed'), retry('rejected'), retry('partial')]).toEqual([true, true, true]);
    expect([retry('pending'), retry('captured')]).toEqual([false, false]);
    expect(describeCapture(null).retryable).toBe(true);
  });

  it('overviewOf summarizes a project from its sources', () => {
    const source = (latest: SnapshotSummary | null): ProjectSourceRecord => ({
      id: 'x',
      projectId: 'p',
      sourceType: 'github',
      url: GITHUB,
      position: 0,
      createdByActorId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      latestSnapshot: latest,
    });
    expect(overviewOf([])).toEqual({
      anyWaiting: false,
      anyFailed: false,
      anyContent: false,
      allContent: false,
    });
    expect(
      overviewOf([
        source(snapshot({ status: 'pending' })),
        source(snapshot({ status: 'captured' })),
      ]),
    ).toEqual({
      anyWaiting: true,
      anyFailed: false,
      anyContent: true,
      allContent: false,
    });
    expect(
      overviewOf([
        source(snapshot({ status: 'failed', failureCategory: 'timeout' })),
        source(snapshot({ status: 'captured' })),
      ]),
    ).toMatchObject({
      anyFailed: true,
      anyContent: true,
      allContent: false,
    });
    expect(
      overviewOf([
        source(snapshot({ status: 'captured' })),
        source(snapshot({ status: 'partial' })),
      ]).allContent,
    ).toBe(true);
  });
});
