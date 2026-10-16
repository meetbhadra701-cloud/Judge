import type {
  AssessmentCoverageSummary,
  AssessmentCoverageView,
  AssessmentDetail,
  AssessmentJudgmentView,
  AssessmentListResponse,
  AssessmentSummary,
  ScoreReport,
} from '@judge-copilot/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssessmentPageView, type UnknownsView } from './view';

/*
 * P6A-R1: the missing-number display invariant, checked on the RENDERED page (static markup of the real component, no network, no
 * browser). An assessment that is unverified or insufficient must show no number of any kind; a scored one shows what the verified
 * report says. Hostile inputs here are details a buggy or compromised API could return.
 */

const SECRET_RATIONALE = 'Rationale text that must stay hidden when unverified.';
const SECRET_EVIDENCE = 'Evidence text that must stay hidden when unverified.';

/** A verified record with no concern (the baseline of every other test on this page). */
const NO_CONCERN: AssessmentCoverageSummary = {
  status: 'recorded',
  verified: true,
  verdict: 'complete',
  concerns: [],
  partialCapture: false,
};
const coverageView = (overrides: Partial<AssessmentCoverageView> = {}): AssessmentCoverageView => ({
  status: 'recorded',
  verified: true,
  problems: [],
  recordSha256: 'a'.repeat(64),
  provenance: { method: 'recomputed_from_snapshots', budgets: 'pinned_by_extraction' },
  policy: {
    windowing: 'windowing/v1',
    selection: 'source-selection/v3',
    routing: 'source-routing/v1',
  },
  verdict: 'complete',
  concerns: [],
  relevance: 'not_established',
  roleBasis: 'path_only',
  measures: null,
  omittedComponents: [],
  documentation: [],
  snapshots: [],
  assessorNotices: [],
  artifactCount: 3,
  skippedCount: 0,
  componentsTruncated: false,
  ...overrides,
});

const summary = (overrides: Partial<AssessmentSummary> = {}): AssessmentSummary => ({
  id: 'a1',
  versionNumber: 1,
  runId: 'r1',
  createdAt: '2026-01-02T03:04:05.000Z',
  providerMode: 'replay',
  replayDemonstration: true,
  target: 'overall',
  overall: null,
  verified: true,
  coverage: NO_CONCERN,
  ...overrides,
});

const list = (assessments: AssessmentSummary[]): AssessmentListResponse => ({
  assessments,
  activeRun: null,
  latestRun: null,
  launch: { available: true, providerMode: 'replay', notice: 'Offline replay demonstration.' },
  notice:
    'AI estimate from the submitted material only. The human judge’s final score is separate and authoritative.',
});

const judgment = (overrides: Partial<AssessmentJudgmentView>): AssessmentJudgmentView => ({
  dimensionId: 'official.problem_fit',
  position: 0,
  outcomeKind: 'scored',
  score: 7,
  insufficiencyReason: null,
  disposition: 'scored',
  dispositionAttribution: 'scored',
  rationale: SECRET_RATIONALE,
  limitations: [],
  assessorAttempts: 1,
  criticAttempts: 1,
  criticReviewRequired: true,
  criticReviewed: true,
  semanticRelevance: 'not_verified',
  citations: [
    {
      evidenceId: 'e1',
      directness: 'direct',
      specificity: 'exact',
      note: 'cited as shown',
      evidence: {
        kind: 'fact',
        origin: 'github',
        verificationLevel: 'unverified',
        text: SECRET_EVIDENCE,
        excerpt: null,
        snapshotId: null,
        artifactId: null,
        span: null,
        contextVersionId: null,
      },
    },
  ],
  ...overrides,
});

const dimension = (id: string, assessed: boolean) =>
  assessed
    ? {
        id,
        criterionKey: 'problem_fit',
        name: 'Problem fit',
        weight: 1,
        state: 'assessed',
        scoreOnScale: 7,
        score10: 7,
        evidenceStrength: 0.35,
        confidence: 0.35,
      }
    : {
        id,
        criterionKey: 'problem_fit',
        name: 'Problem fit',
        weight: 1,
        state: 'insufficient_evidence',
        reason: 'no_usable_citation',
        confidence: 0,
      };

function reportWith(overall: unknown, assessed: boolean): ScoreReport {
  return {
    rubric: { name: 'Official rubric', official: true, scale: { min: 0, max: 10 } },
    overall,
    criteria: [
      assessed
        ? {
            key: 'problem_fit',
            name: 'Problem fit',
            weight: 1,
            state: 'assessed',
            scoreOnScale: 7,
            score10: 7,
            confidence: 0.35,
            coverage: null,
            assessedWeightShare: 1,
            citationPresenceShare: 1,
            dimensionIds: ['official.problem_fit'],
            missingDimensionIds: [],
          }
        : {
            key: 'problem_fit',
            name: 'Problem fit',
            weight: 1,
            state: 'insufficient_evidence',
            confidence: 0,
            coverage: null,
            assessedWeightShare: 0,
            citationPresenceShare: 0,
            dimensionIds: ['official.problem_fit'],
            missingDimensionIds: ['official.problem_fit'],
          },
    ],
    dimensions: [dimension('official.problem_fit', assessed)],
  } as unknown as ScoreReport;
}

const SCORED = {
  state: 'scored',
  weightBasis: 'official',
  scoreOnScale: 7,
  score10: 7,
  assessedWeightShare: 1,
  coverage: null,
  citationPresenceShare: 1,
  confidence: 0.35,
  missingCriterionKeys: [],
};
const PARTIAL = {
  ...SCORED,
  state: 'scored_partial',
  assessedWeightShare: 0.7,
  missingCriterionKeys: ['hard_part'],
};
const INSUFFICIENT = {
  state: 'insufficient_evidence',
  weightBasis: 'official',
  reason: 'assessed_weight_below_threshold',
  assessedWeightShare: 0,
  coverage: null,
  citationPresenceShare: 0,
  confidence: 0,
  missingCriterionKeys: ['problem_fit'],
};

const detail = (overrides: Partial<AssessmentDetail>): AssessmentDetail => ({
  id: 'a1',
  projectId: 'p1',
  runId: 'r1',
  versionNumber: 1,
  createdAt: '2026-01-02T03:04:05.000Z',
  providerMode: 'replay',
  replayDemonstration: true,
  target: 'overall',
  verified: true,
  verificationFailure: null,
  report: reportWith(SCORED, true),
  judgments: [judgment({})],
  limitations: [],
  coverage: coverageView(),
  pipeline: null,
  usage: {
    attemptsStarted: 1,
    settledCalls: 1,
    unknownCalls: 0,
    releasedCalls: 0,
    inputTokens: 10,
    outputTokens: 5,
    costNanoUsd: 1000,
  },
  notices: {
    advisory:
      'AI estimate from the submitted material only. The human judge’s final score is separate and authoritative.',
    semanticRelevance: 'not_verified',
    storedText: 'not_hash_covered',
    target: 'overall_rubric_only',
    replay: 'REPLAY DEMONSTRATION',
  },
  ...overrides,
});

function render(
  listValue: AssessmentListResponse,
  detailValue: AssessmentDetail | null,
  unknowns: UnknownsView | null = {
    items: [],
    currency: { upToDate: true, newerCaptures: [] },
    versionNumber: 1,
  },
): string {
  return renderToStaticMarkup(
    <AssessmentPageView
      unknowns={unknowns}
      projectId="p1"
      projectName="Project"
      list={listValue}
      detail={detailValue}
      detailError={undefined}
      error={undefined}
      requestKeys={{ assess: 'k1', reassess: 'k2' }}
      requestAction={() => undefined}
    />,
  );
}

/** Any rendering of a score: "7.0 / 10", a percentage of a score, or a bare "score" label. */
const NUMBER_OF_ANY_KIND = /\d+(\.\d+)?\s*\/\s*10/;

describe('assessment page: no number and no content unless the assessment verified', () => {
  const unverifiedList = list([summary({ verified: false })]);

  it('an unverified assessment (as the API returns it) renders only the notice, never a number or any content', () => {
    const html = render(
      unverifiedList,
      detail({
        verified: false,
        verificationFailure: 'judgment_mismatch_score',
        report: null,
        judgments: [],
        limitations: [],
      }),
    );
    expect(html).toContain('NOT VERIFIED');
    expect(html).toContain('failed an integrity check, so none of it is shown');
    expect(html).toContain('This assessment is withheld');
    expect(html).toContain('judgment_mismatch_score');
    expect(html).toContain('Advisory only');
    expect(html).not.toMatch(NUMBER_OF_ANY_KIND);
    for (const forbidden of [
      'Overall (version',
      'Criteria',
      'Dimensions',
      SECRET_RATIONALE,
      SECRET_EVIDENCE,
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('even a hostile detail that carries a report, scores, rationale and evidence text renders none of it when verified=false', () => {
    const html = render(
      unverifiedList,
      detail({
        verified: false,
        verificationFailure: 'jsonb_mirror',
        report: reportWith(SCORED, true),
      }),
    );
    expect(html).toContain('NOT VERIFIED');
    expect(html).not.toMatch(NUMBER_OF_ANY_KIND);
    expect(html).not.toContain('SCORED<');
    for (const forbidden of [SECRET_RATIONALE, SECRET_EVIDENCE, 'Overall (version', 'Criteria']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('a verified=true detail without a report is also treated as unverified (nothing to show is not a score of zero)', () => {
    const html = render(unverifiedList, detail({ verified: true, report: null }));
    expect(html).toContain('NOT VERIFIED');
    expect(html).not.toMatch(NUMBER_OF_ANY_KIND);
    expect(html).not.toContain(SECRET_RATIONALE);
  });

  it('a listed version that is not verified is labelled as such', () => {
    const html = render(
      list([summary({ id: 'a2', versionNumber: 2 }), summary({ verified: false })]),
      null,
    );
    expect(html).toContain('Version 1');
    expect(html).toContain('not verified');
  });
});

describe('assessment page: the missing-number display invariant', () => {
  it('an insufficient overall shows no number, says it is not a low score, and a dimension without evidence shows no number', () => {
    const html = render(
      list([summary({ overall: { state: 'insufficient_evidence', score10: null } })]),
      detail({
        report: reportWith(INSUFFICIENT, false),
        judgments: [
          judgment({
            outcomeKind: 'insufficient_evidence',
            score: null,
            insufficiencyReason: 'assessor_reported_insufficient',
            disposition: 'assessor_reported_insufficient',
            dispositionAttribution: 'insufficient_by_assessor',
            citations: [],
          }),
        ],
      }),
    );
    expect(html).toContain('INSUFFICIENT EVIDENCE');
    expect(html).toContain('this is not a low score');
    expect(html).toContain('no number is given');
    expect(html).toContain('insufficiency declared by the assessor (not independently reviewed)');
    expect(html).not.toMatch(NUMBER_OF_ANY_KIND);
    expect(html).not.toMatch(/\b0(\.0)?\s*\/\s*10/);
  });

  it('a scored assessment shows its verified number, the advisory notice and the not-verified relevance label', () => {
    const html = render(list([summary({ overall: { state: 'scored', score10: 7 } })]), detail({}));
    expect(html).toContain('SCORED');
    expect(html).toContain('7.0 / 10');
    expect(html).toContain('Advisory only');
    expect(html).toContain('relevance not verified');
    expect(html).toContain('Replay demonstration');
  });

  it('says that the rationale, notes and limitations are stored text that no hash covers, and that scores are shown at report precision', () => {
    const html = render(list([summary({ overall: { state: 'scored', score10: 7 } })]), detail({}));
    expect(html).toContain('stored text that no integrity hash covers');
    expect(html).toContain('not cryptographically authenticated');
    expect(html).toContain('stored text, not hash-verified');
    expect(html).toContain('a raw 7.33333 is reported, and shown, as 7.3333');
    expect(html).toContain('rounded half-up to whole numbers for');
  });

  it('a dimension whose judged value was not used says why and shows no number', () => {
    const html = render(
      list([summary({ overall: { state: 'insufficient_evidence', score10: null } })]),
      detail({
        report: {
          ...reportWith(INSUFFICIENT, false),
          dimensions: [
            { ...dimension('official.problem_fit', false), reason: 'no_usable_citation' },
          ],
        } as unknown as ScoreReport,
        judgments: [
          judgment({
            outcomeKind: 'insufficient_evidence',
            score: null,
            insufficiencyReason: 'no_usable_citation',
            dispositionAttribution: 'insufficient_by_code',
            citations: [],
          }),
        ],
      }),
    );
    expect(html).toContain('the scorer did not use it');
    expect(html).toContain('no number is given');
    expect(html).not.toMatch(NUMBER_OF_ANY_KIND);
  });

  it('D13: a dimension whose judged value was not used shows no `scored` disposition tag, only who decided', () => {
    const html = render(
      list([summary({ overall: { state: 'insufficient_evidence', score10: null } })]),
      detail({
        report: {
          ...reportWith(INSUFFICIENT, false),
          dimensions: [
            { ...dimension('official.problem_fit', false), reason: 'no_usable_citation' },
          ],
        } as unknown as ScoreReport,
        judgments: [
          judgment({
            outcomeKind: 'insufficient_evidence',
            score: null,
            insufficiencyReason: 'no_usable_citation',
            disposition: 'scored', // as stored: the assessor judged a value that M4 did not use
            dispositionAttribution: 'insufficient_by_code',
            citations: [],
          }),
        ],
      }),
    );
    expect(html).toContain('insufficiency found by deterministic code');
    expect(html).not.toContain('<span class="tag">scored</span>');
    expect(html).not.toMatch(/>scored</);
    expect(html).not.toMatch(NUMBER_OF_ANY_KIND);
  });

  it('a scored dimension still shows its stored disposition', () => {
    const html = render(list([summary({ overall: { state: 'scored', score10: 7 } })]), detail({}));
    expect(html).toContain('<span class="tag">scored</span>');
  });

  it('a partial assessment names the share assessed and the criteria that were not', () => {
    const html = render(
      list([summary({ overall: { state: 'scored_partial', score10: 7 } })]),
      detail({ report: reportWith(PARTIAL, true) }),
    );
    expect(html).toContain('PARTIALLY SCORED');
    expect(html).toContain('70%');
    expect(html).toContain('not assessed: hard_part');
  });
});

// -- P6B-alpha: relative highs and lows, unknowns, withheld guidance ---------------------------------------------------------------------

const assessedDimension = (id: string, name: string, score10: number, confidence = 0.35) => ({
  id,
  criterionKey: 'k',
  name,
  weight: 1,
  state: 'assessed',
  scoreOnScale: score10,
  score10,
  evidenceStrength: 0.35,
  confidence,
});
const missingDimension = (id: string, name: string, reason = 'assessor_reported_insufficient') => ({
  id,
  criterionKey: 'k',
  name,
  weight: 1,
  state: 'insufficient_evidence',
  reason,
  confidence: 0,
});

function reportOf(dimensions: unknown[], overall: unknown = SCORED): ScoreReport {
  return {
    rubric: { name: 'Official rubric', official: true, scale: { min: 0, max: 10 } },
    overall,
    criteria: [],
    dimensions,
  } as unknown as ScoreReport;
}

const judgmentOf = (dimensionId: string, overrides: Partial<AssessmentJudgmentView> = {}) =>
  judgment({ dimensionId, ...overrides });

describe('P6B-alpha: relative highs and lows (DG-5 safeguards)', () => {
  const scoredList = list([summary({ overall: { state: 'scored', score10: 7 } })]);

  it('names the highest and lowest assessed dimensions, labelled as relative, with evidence and limitations', () => {
    const html = render(
      scoredList,
      detail({
        report: reportOf([
          assessedDimension('d.a', 'Alpha', 9),
          assessedDimension('d.b', 'Beta', 6.5),
          assessedDimension('d.c', 'Gamma', 3.25),
        ]),
        judgments: [
          judgmentOf('d.a', { limitations: ['sampled_source'] }),
          judgmentOf('d.b'),
          judgmentOf('d.c'),
        ],
      }),
    );
    expect(html).toContain('data-testid="relative-section"');
    expect(html).toContain('Highest-scoring assessed dimension');
    expect(html).toContain('Lowest-scoring assessed dimension');
    expect(html).toContain('with each other only');
    expect(html).toContain('not necessarily strong');
    expect(html).toContain('not necessarily weak');
    // Alpha is the high, Gamma the low, Beta is neither; their verified numbers and evidence context are shown
    const relative = html.slice(
      html.indexOf('data-testid="relative-section"'),
      html.indexOf('<h2>Dimensions</h2>'),
    );
    expect(relative).toContain('Alpha');
    expect(relative).toContain('9.0 / 10');
    expect(relative).toContain('Gamma');
    expect(relative).toContain('3.25 / 10');
    expect(relative).not.toContain('Beta');
    expect(relative).toContain('limitations: sampled_source');
    expect(relative).toContain(SECRET_EVIDENCE);
    expect(relative).toContain('confidence index 35%');
  });

  it('lists every tied dimension at the top or bottom', () => {
    const html = render(
      scoredList,
      detail({
        report: reportOf([
          assessedDimension('d.a', 'Alpha', 8),
          assessedDimension('d.b', 'Beta', 8),
          assessedDimension('d.c', 'Gamma', 4),
        ]),
        judgments: [judgmentOf('d.a'), judgmentOf('d.b'), judgmentOf('d.c')],
      }),
    );
    expect(html).toContain('Highest-scoring assessed dimensions (tied)');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('Lowest-scoring assessed dimension<');
  });

  it('shows no high or low when all assessed dimensions are equal', () => {
    const html = render(
      scoredList,
      detail({
        report: reportOf([
          assessedDimension('d.a', 'Alpha', 7),
          assessedDimension('d.b', 'Beta', 7),
        ]),
        judgments: [judgmentOf('d.a'), judgmentOf('d.b')],
      }),
    );
    expect(html).toContain('data-testid="relative-equal"');
    expect(html).toContain('there is no highest or lowest');
    expect(html).not.toContain('Highest-scoring');
  });

  it('shows no comparison for a single assessed dimension, and never invents a low from a dimension without a number', () => {
    const html = render(
      list([summary({ overall: { state: 'scored_partial', score10: 7 } })]),
      detail({
        report: reportOf(
          [assessedDimension('d.a', 'Alpha', 7), missingDimension('d.b', 'Beta')],
          PARTIAL,
        ),
        judgments: [
          judgmentOf('d.a'),
          judgmentOf('d.b', {
            outcomeKind: 'insufficient_evidence',
            score: null,
            insufficiencyReason: 'assessor_reported_insufficient',
            dispositionAttribution: 'insufficient_by_assessor',
            citations: [],
          }),
        ],
      }),
    );
    expect(html).toContain('data-testid="relative-none"');
    expect(html).toContain('needs at least two assessed dimensions');
    expect(html).not.toContain('Lowest-scoring');
    expect(html).toContain('1 dimension had too little');
  });

  it('a partial report compares only the assessed dimensions and says how many were left out', () => {
    const html = render(
      list([summary({ overall: { state: 'scored_partial', score10: 7 } })]),
      detail({
        report: reportOf(
          [
            assessedDimension('d.a', 'Alpha', 9),
            assessedDimension('d.b', 'Beta', 5),
            missingDimension('d.c', 'Gamma'),
          ],
          PARTIAL,
        ),
        judgments: [
          judgmentOf('d.a'),
          judgmentOf('d.b'),
          judgmentOf('d.c', { outcomeKind: 'insufficient_evidence', score: null, citations: [] }),
        ],
      }),
    );
    const relative = html.slice(
      html.indexOf('data-testid="relative-section"'),
      html.indexOf('<h2>Dimensions</h2>'),
    );
    expect(relative).toContain('Alpha');
    expect(relative).toContain('Beta');
    expect(relative).not.toContain('Gamma');
    expect(relative).toContain('not part of this comparison');
    expect(relative).not.toMatch(/(?<![\d.])0(\.0)? \/ 10/);
  });

  it('is absent for an insufficient overall with no assessed dimension (a "no comparison" note, never a number)', () => {
    const html = render(
      list([summary({ overall: { state: 'insufficient_evidence', score10: null } })]),
      detail({
        report: reportOf(
          [missingDimension('d.a', 'Alpha'), missingDimension('d.b', 'Beta')],
          INSUFFICIENT,
        ),
        judgments: [
          judgmentOf('d.a', { outcomeKind: 'insufficient_evidence', score: null, citations: [] }),
        ],
      }),
    );
    expect(html).toContain('data-testid="relative-none"');
    expect(html).not.toMatch(NUMBER_OF_ANY_KIND);
  });

  it('is never rendered for an unverified assessment, even one that carries a report', () => {
    const html = render(
      list([summary({ verified: false })]),
      detail({
        verified: false,
        verificationFailure: 'jsonb_mirror',
        report: reportOf([
          assessedDimension('d.a', 'Alpha', 9),
          assessedDimension('d.b', 'Beta', 2),
        ]),
      }),
    );
    expect(html).not.toContain('relative-section');
    expect(html).not.toContain('unknowns-section');
    expect(html).not.toContain('Alpha');
  });
});

describe('P6B-alpha: unknowns and missing information', () => {
  const scoredList = list([summary({ overall: { state: 'scored', score10: 7 } })]);
  const unknown = (
    id: string,
    text: string,
    unknownType: 'missing' | 'ambiguous' = 'missing',
    occurrences = 1,
  ) => ({ id, seq: 1, unknownType, text, claimIds: [], evidenceIds: [], occurrences });

  it('lists dimensions without a number (with the reason), incomplete criteria, limitations and the recorded unknowns', () => {
    const html = render(
      list([summary({ overall: { state: 'scored_partial', score10: 7 } })]),
      detail({
        report: {
          ...reportOf(
            [
              assessedDimension('d.a', 'Alpha', 7),
              missingDimension('d.b', 'Beta', 'no_usable_citation'),
            ],
            PARTIAL,
          ),
          criteria: [
            {
              key: 'k1',
              name: 'Idea',
              weight: 1,
              state: 'partial',
              scoreOnScale: 7,
              score10: 7,
              confidence: 0.3,
              coverage: null,
              assessedWeightShare: 0.5,
              citationPresenceShare: 1,
              dimensionIds: ['d.a', 'd.b'],
              missingDimensionIds: ['d.b'],
            },
            {
              key: 'k2',
              name: 'Execution',
              weight: 1,
              state: 'insufficient_evidence',
              confidence: 0,
              coverage: null,
              assessedWeightShare: 0,
              citationPresenceShare: 0,
              dimensionIds: [],
              missingDimensionIds: [],
            },
          ],
        } as unknown as ScoreReport,
        limitations: [{ code: 'source_sampled', count: 1, subjects: ['devpost'] }],
        judgments: [
          judgmentOf('d.a'),
          judgmentOf('d.b', { outcomeKind: 'insufficient_evidence', score: null, citations: [] }),
        ],
      }),
      {
        items: [
          unknown('u1', 'No deployment link was found.'),
          unknown('u2', 'Team size is unclear.', 'ambiguous'),
        ],
        currency: { upToDate: true, newerCaptures: [] },
        versionNumber: 3,
      },
    );
    const section = html.slice(html.indexOf('data-testid="unknowns-section"'));
    expect(section).toContain('Missing information is not negative evidence');
    expect(section).toContain('Beta');
    expect(section).toContain('the scorer did not use it');
    expect(section).toContain('partly assessed (missing d.b)');
    expect(section).toContain('not assessed (insufficient evidence)');
    expect(section).toContain('source_sampled');
    expect(section).toContain('No deployment link was found.');
    expect(section).toContain('Team size is unclear.');
    expect(section).toContain('stored text that no integrity hash covers');
    expect(section).toContain('Gaps recorded for the material of version 3');
    expect(section).toContain('not a list of the project’s current gaps');
    expect(section).not.toContain('Newer captures exist');
    expect(section).toContain('not part of this version');
  });

  it('renders unknown text as inert text and does not create unknowns of its own', () => {
    const html = render(scoredList, detail({}), {
      items: [unknown('u1', '<script>alert(1)</script>')],
      currency: { upToDate: true, newerCaptures: [] },
      versionNumber: 1,
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const none = render(scoredList, detail({}), {
      items: [],
      currency: { upToDate: true, newerCaptures: [] },
      versionNumber: 1,
    });
    expect(none).toContain(
      'No unknowns were recorded for the material this assessment was scored from.',
    );
    expect(none).toContain('Every dimension had enough evidence for a number.');
  });

  it('says which captures are newer than the assessed material, so old gaps are never presented as current ones', () => {
    const html = render(scoredList, detail({}), {
      items: [unknown('u1', 'No deployment link was found.', 'missing', 2)],
      currency: {
        upToDate: false,
        newerCaptures: [
          {
            sourceId: 's1',
            sourceType: 'github',
            pinnedCaptureNumber: 1,
            newerCaptureNumber: 2,
            newerStatus: 'failed',
            newerAt: '2026-01-02T00:00:00.000Z',
          },
          {
            sourceId: 's2',
            sourceType: 'devpost',
            pinnedCaptureNumber: null,
            newerCaptureNumber: 1,
            newerStatus: 'captured',
            newerAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
      versionNumber: 1,
    });
    expect(html).toContain('data-testid="newer-captures"');
    expect(html).toContain('github capture #2 (failed; this assessment used #1)');
    expect(html).toContain(
      'devpost capture #1 (captured; this assessment used none of that source)',
    );
    expect(html).toContain('Request a new assessment to learn what is still unknown');
    expect(html).toContain('(recorded 2 times)');
  });

  it('says so when the unknowns could not be loaded', () => {
    expect(render(scoredList, detail({}), null)).toContain('could not be loaded');
  });
});

describe('P6B-alpha: preliminary and withheld presentation', () => {
  it('is titled and worded as a preliminary, advisory report', () => {
    const html = render(list([summary({ overall: { state: 'scored', score10: 7 } })]), detail({}));
    expect(html).toContain('<h1>Preliminary report</h1>');
    expect(html).toContain('Preliminary:');
    expect(html).toContain('Advisory only');
    expect(html).toContain('before any');
  });

  it('a withheld assessment shows guidance by failure code, no content, and no "show assessment" button, only Reassess', () => {
    const html = render(
      list([summary({ verified: false })]),
      detail({
        verified: false,
        verificationFailure: 'judgment_mismatch_score',
        report: null,
        judgments: [],
        limitations: [],
      }),
    );
    expect(html).toContain('This assessment is withheld');
    expect(html).toContain('judgment_mismatch_score');
    expect(html).toContain('stored score disagrees with the report');
    expect(html).toContain('is kept unchanged');
    expect(html).not.toContain('Show assessment for current material');
    expect(html).toContain('Reassess (creates a new version)');
    expect(html).not.toMatch(NUMBER_OF_ANY_KIND);
  });
});

// -- P6B-beta1: the rubric's own scale ---------------------------------------------------------------------------------------------------

/*
 * R7A saw a score on a native 1-5 rubric rendered "0.0 / 10" with no explanation. The stored report carries BOTH the value on the
 * rubric's scale (`scoreOnScale`) and its normalization (`score10`); the page prints both, labelled, and never computes either.
 */

type Scale = { min: number; max: number };
const normalize = (native: number, scale: Scale): number =>
  (10 * (native - scale.min)) / (scale.max - scale.min);

function scaledReport(
  scale: Scale,
  natives: readonly (number | null)[],
  overallNative: number | 'insufficient' = natives.find((n): n is number => n !== null) ??
    scale.min,
): ScoreReport {
  const dimensions = natives.map((native, index) =>
    native === null
      ? missingDimension(`d.${String(index)}`, `Dimension ${String(index)}`)
      : {
          ...assessedDimension(`d.${String(index)}`, `Dimension ${String(index)}`, 0),
          scoreOnScale: native,
          score10: normalize(native, scale),
        },
  );
  const overall =
    overallNative === 'insufficient'
      ? INSUFFICIENT
      : { ...SCORED, scoreOnScale: overallNative, score10: normalize(overallNative, scale) };
  return {
    rubric: { name: 'Organizer rubric', official: true, scale },
    overall,
    criteria: [
      {
        key: 'k',
        name: 'Criterion K',
        weight: 1,
        state: natives.some((n) => n === null) ? 'partial' : 'assessed',
        scoreOnScale: overallNative === 'insufficient' ? scale.min : overallNative,
        score10: normalize(overallNative === 'insufficient' ? scale.min : overallNative, scale),
        confidence: 0.3,
        coverage: null,
        assessedWeightShare: 1,
        citationPresenceShare: 1,
        dimensionIds: dimensions.map((d) => d.id),
        missingDimensionIds: dimensions.flatMap((d) => (d.state === 'assessed' ? [] : [d.id])),
      },
    ],
    dimensions,
  } as unknown as ScoreReport;
}

const renderScaled = (report: ScoreReport) =>
  render(
    list([summary({ overall: { state: 'scored', score10: 5 } })]),
    detail({ report, judgments: [] }),
  );

describe('P6B-beta1: scores are shown on the rubric’s own scale, with the normalization explained', () => {
  it('a 0-10 rubric keeps the plain "x / 10" form and has no scale note', () => {
    const html = renderScaled(scaledReport({ min: 0, max: 10 }, [7, 4], 5.5));
    expect(html).toContain('5.5 / 10');
    expect(html).not.toContain('on the rubric’s scale of');
    expect(html).not.toContain('data-testid="scale-note"');
  });

  it.each([
    [{ min: 1, max: 5 }, 1, '1.0 on the rubric’s scale of 1 to 5 (0.0 / 10 normalized)'],
    [{ min: 1, max: 5 }, 3, '3.0 on the rubric’s scale of 1 to 5 (5.0 / 10 normalized)'],
    [{ min: 1, max: 5 }, 5, '5.0 on the rubric’s scale of 1 to 5 (10.0 / 10 normalized)'],
    [{ min: 1, max: 5 }, 3.5, '3.5 on the rubric’s scale of 1 to 5 (6.25 / 10 normalized)'],
    [{ min: 1, max: 10 }, 1, '1.0 on the rubric’s scale of 1 to 10 (0.0 / 10 normalized)'],
    [{ min: 0, max: 5 }, 0, '0.0 on the rubric’s scale of 0 to 5 (0.0 / 10 normalized)'],
    [{ min: 0, max: 100 }, 50, '50.0 on the rubric’s scale of 0 to 100 (5.0 / 10 normalized)'],
    [{ min: -5, max: 5 }, 0, '0.0 on the rubric’s scale of -5 to 5 (5.0 / 10 normalized)'],
  ])(
    'scale %j, native %d: shows "%s" for the overall, a criterion and a dimension',
    (scale, native, expected) => {
      const html = renderScaled(scaledReport(scale, [native, native], native));
      // overall, the criterion row and each of the two dimensions
      expect(html.split(expected).length - 1).toBeGreaterThanOrEqual(4);
      expect(html).toContain('data-testid="scale-note"');
      expect(html).toContain(
        `from ${String(scale.min)} (lowest) to ${String(scale.max)} (highest)`,
      );
    },
  );

  it('says that the lowest value on the scale is a real low score, not missing evidence', () => {
    const html = renderScaled(scaledReport({ min: 1, max: 5 }, [1, 1], 1));
    const note = html.slice(html.indexOf('data-testid="scale-note"'));
    expect(note).toContain('is 0 and its highest');
    expect(note).toContain('a real, low score, not missing evidence');
    expect(note).toContain('a dimension without enough evidence has no number at all');
  });

  it('a partial report keeps the native form and still names what is missing; the insufficient dimension has no number of any kind', () => {
    const html = renderScaled(scaledReport({ min: 1, max: 5 }, [4, null], 4));
    expect(html).toContain('4.0 on the rubric’s scale of 1 to 5 (7.5 / 10 normalized)');
    expect(html).toContain('(partial; missing d.1)');
    const card = html.slice(html.indexOf('Dimension 1'));
    expect(card).toContain('no number is given');
    const insufficientCard = card.slice(0, card.indexOf('</div></div>') + 1 || undefined);
    expect(insufficientCard).not.toMatch(/normalized/);
  });

  it('an insufficient overall shows no number in either scale, only the scale note', () => {
    const html = renderScaled(scaledReport({ min: 1, max: 5 }, [null, null], 'insufficient'));
    expect(html).toContain('Insufficient evidence for an overall score');
    expect(html).not.toMatch(/Overall[^<]*<\/h2><p><strong>\d/);
    expect(html).toContain('data-testid="scale-note"');
  });

  it('the relative section prints both forms too, for a ranked pair and for equal scores', () => {
    const ranked = renderScaled(scaledReport({ min: 1, max: 5 }, [5, 1, 3], 3));
    const rankedSection = ranked.slice(ranked.indexOf('data-testid="relative-section"'));
    expect(rankedSection).toContain('5.0 on the rubric’s scale of 1 to 5 (10.0 / 10 normalized)');
    expect(rankedSection).toContain('1.0 on the rubric’s scale of 1 to 5 (0.0 / 10 normalized)');
    const equal = renderScaled(scaledReport({ min: 1, max: 5 }, [1, 1], 1));
    const equalSection = equal.slice(equal.indexOf('data-testid="relative-equal"'));
    expect(equalSection).toContain('1.0 on the rubric’s scale of 1 to 5 (0.0 / 10 normalized)');
    expect(equalSection).toContain('there is no highest or lowest');
  });

  it('prints the stored values as given: it neither recomputes nor re-rounds either figure', () => {
    // an oddly specific pair: if the page computed the normalization it would print 3.3333333, not the stored 3.3333
    const report = scaledReport({ min: 1, max: 4 }, [3], 3);
    (report.dimensions[0] as { score10: number }).score10 = 6.6667;
    const html = renderScaled(report);
    expect(html).toContain('3.0 on the rubric’s scale of 1 to 4 (6.6667 / 10 normalized)');
  });
});

describe('P6B-beta1: the report of a project that mixes several submissions carries the warning', () => {
  it('shows the notice above the report when one is given, and none otherwise', () => {
    const scoredList = list([summary({ overall: { state: 'scored', score10: 7 } })]);
    const withNotice = renderToStaticMarkup(
      <AssessmentPageView
        unknowns={null}
        projectId="p1"
        projectName="Project"
        integrityNotice="This project does not form a single submission: it declares 1 GitHub link and 2 Devpost links."
        list={scoredList}
        detail={detail({})}
        detailError={undefined}
        error={undefined}
        requestKeys={{ assess: 'k1', reassess: 'k2' }}
        requestAction={() => undefined}
      />,
    );
    expect(withNotice).toContain('data-testid="mixed-project"');
    expect(withNotice).toContain('does not form a single submission');
    expect(render(scoredList, detail({}))).not.toContain('mixed-project');
  });
});

// -- P6B-beta3-R1: source coverage is shown before any number, and "all dimensions scored" is never "all evidence examined" ------------

describe('P6B-beta3-R1: source coverage on the assessment page', () => {
  const PARTIAL_VIEW = coverageView({
    verdict: 'partial',
    concerns: ['implementation_components_unseen', 'documentation_category_unseen'],
    omittedComponents: [
      { component: 'packages/core', codePoints: 90_000, inspectedCodePoints: 0, stub: false },
      {
        component: '<img src=x onerror=alert(1)>',
        codePoints: 5_000,
        inspectedCodePoints: 100,
        stub: false,
      },
    ],
    snapshots: [
      {
        snapshotId: 's1',
        sourceType: 'github',
        status: 'partial',
        contentHash: 'b'.repeat(64),
        provenance: 'fetched',
        partialReasons: ['file_count_limit'],
      },
    ],
  });
  const renderWith = (coverage: AssessmentCoverageView, summaryCoverage = NO_CONCERN) =>
    render(list([summary({ coverage: summaryCoverage })]), detail({ coverage }));
  const sectionOf = (html: string): string => {
    const start = html.indexOf('data-testid="coverage-notice"');
    const end = html.indexOf('<h2>Overall');
    return html.slice(start, end);
  };

  it('puts a partial-coverage alert BEFORE the overall score, and says plainly that not all evidence was examined', () => {
    const html = renderWith(PARTIAL_VIEW);
    expect(html.indexOf('data-testid="coverage-notice"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="coverage-notice"')).toBeLessThan(html.indexOf('<h2>Overall'));
    const notice = sectionOf(html);
    expect(notice).toContain('PARTIAL SOURCE COVERAGE');
    expect(notice).toContain('role="alert"');
    expect(notice).toContain('it was not');
  });

  it('keeps statement A (dimensions scored) apart from statement B (evidence examined)', () => {
    const html = renderWith(PARTIAL_VIEW);
    expect(html).toContain('data-testid="coverage-a"');
    expect(html).toMatch(/rubric dimensions? received an advisory score/);
    expect(html).toContain('not a statement that all of the project’s evidence was examined');
    expect(html).not.toContain('all weighted dimensions assessed');
    expect(html).toMatch(/data-testid="overall-coverage">PARTIAL source coverage/);
  });

  it('names the components that were not fully examined, escapes hostile names, and lists what cannot be supported', () => {
    const html = renderWith(PARTIAL_VIEW);
    const omitted = html.slice(html.indexOf('data-testid="coverage-omitted"'));
    expect(omitted).toContain('packages/core');
    expect(omitted).toContain('0 of 90000 code points examined');
    expect(omitted).not.toContain('<img src=x');
    expect(omitted).toContain('&lt;img src=x');
    expect(html).toContain('data-testid="coverage-unsupported"');
    expect(html).toContain('Anything about the components that were not shown.');
    expect(html).toContain('missing evidence is not evidence against the project');
    expect(html).toContain('The github capture itself was partial (file_count_limit)');
  });

  it('tags each scored dimension when coverage is partial, and not otherwise', () => {
    expect(renderWith(PARTIAL_VIEW)).toContain('data-testid="dimension-partial-coverage"');
    expect(renderWith(coverageView())).not.toContain('data-testid="dimension-partial-coverage"');
  });

  it('a partial CAPTURE alone, with no selection concern, is still partial coverage', () => {
    const html = renderWith(
      coverageView({
        snapshots: PARTIAL_VIEW.snapshots,
        verdict: 'complete',
        concerns: [],
      }),
    );
    expect(sectionOf(html)).toContain('PARTIAL SOURCE COVERAGE');
    expect(html).toMatch(/data-testid="overall-coverage">PARTIAL source coverage/);
  });

  it('says how a verified record was checked, and that a refused run’s allowance is less firmly tied', () => {
    expect(renderWith(coverageView())).toContain(
      'running the selection again over the stored source text',
    );
    const refused = renderWith(
      coverageView({
        provenance: { method: 'recomputed_from_snapshots', budgets: 'allowed_set_only' },
      }),
    );
    expect(refused).toContain('only shown to be one the settings allow');
    const unverified = renderWith(
      coverageView({ verified: false, provenance: null, verdict: null }),
    );
    expect(unverified).not.toContain('data-testid="coverage-checked"');
  });

  it('a clean record says only that no path-based concern was found, and still disclaims relevance and sufficiency', () => {
    const html = renderWith(coverageView());
    const notice = sectionOf(html);
    expect(notice).toContain('No source-coverage concern was found by the path-based checks.');
    expect(notice).toContain('relevance and sufficiency of the examined text are not established');
    expect(notice).not.toContain('role="alert"');
    expect(notice).not.toContain('PARTIAL SOURCE COVERAGE');
  });

  it('an assessment from before coverage records is "not recorded": coverage UNKNOWN, never complete', () => {
    const html = renderWith(
      coverageView({ status: 'not_recorded', verified: false, verdict: null, recordSha256: null }),
    );
    const notice = sectionOf(html);
    expect(notice).toContain('Source coverage was not recorded for this assessment');
    expect(notice).toContain('role="alert"');
    expect(html).toMatch(/data-testid="overall-coverage">source coverage UNKNOWN/);
    expect(html).toContain('data-testid="dimension-partial-coverage"');
  });

  it('a record that failed its checks shows its failure codes and nothing derived from it', () => {
    const html = renderWith(
      coverageView({
        verified: false,
        verdict: null,
        problems: ['record_text_hash_mismatch', 'provenance_artifact_mismatch'],
        omittedComponents: [],
      }),
    );
    const notice = sectionOf(html);
    expect(notice).toContain('failed its integrity checks');
    expect(notice).toContain('record_text_hash_mismatch');
    expect(notice).toContain(
      'names files, hashes or sizes that are not those of the stored source',
    );
    expect(notice).not.toContain('No source-coverage concern');
  });

  it('qualifies the version list rows, so a number is never listed without its coverage', () => {
    const html = render(
      list([
        summary({
          id: 'a2',
          versionNumber: 2,
          coverage: {
            ...NO_CONCERN,
            verdict: 'partial',
            concerns: ['implementation_partially_seen'],
          },
        }),
        summary({
          id: 'a1',
          coverage: {
            status: 'not_recorded',
            verified: false,
            verdict: null,
            concerns: [],
            partialCapture: false,
          },
        }),
      ]),
      detail({ coverage: PARTIAL_VIEW }),
    );
    expect(html).toContain('partial source coverage');
    expect(html).toContain('source coverage not recorded');
  });

  it('an unverified assessment shows no coverage detail either (nothing derived from stored rows)', () => {
    const html = render(
      list([summary({ verified: false })]),
      detail({
        verified: false,
        verificationFailure: 'judgment_mismatch_score',
        report: null,
        judgments: [],
        coverage: PARTIAL_VIEW,
      }),
    );
    expect(html).not.toContain('data-testid="coverage-notice"');
    expect(html).not.toContain('packages/core');
  });

  it('a run refused at the coverage gate shows the coverage it was refused for', () => {
    const refused = {
      ...list([]),
      latestRun: {
        id: 'r9',
        projectId: 'p1',
        state: 'failed',
        mode: 'assess',
        failureCategory: 'source_unavailable',
        failureCode: 'source_coverage_insufficient',
        stageReached: 'select',
        providerMode: 'replay',
        replayDemonstration: true,
        createdAt: '2026-01-02T03:04:05.000Z',
        startedAt: '2026-01-02T03:04:05.000Z',
        finishedAt: '2026-01-02T03:04:06.000Z',
        assessmentId: null,
        usage: {
          attemptsStarted: 0,
          settledCalls: 0,
          unknownCalls: 0,
          releasedCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costNanoUsd: 0,
        },
        guard: {
          maxCalls: 1,
          maxInputTokens: 1,
          maxOutputTokens: 1,
          maxCostNanoUsd: 1,
          maxReservedInputTokensPerCall: 1,
          runWallClockMs: 1,
          priceTableId: 'p',
          notice: 'local_spending_guard_not_a_provider_billing_limit',
        },
        coverage: {
          status: 'recorded',
          verified: true,
          verdict: 'insufficient',
          concerns: ['no_implementation_shown'],
          partialCapture: false,
        },
      },
    } as AssessmentListResponse;
    const html = render(refused, null);
    expect(html).toContain('data-testid="run-coverage"');
    expect(html).toContain('insufficient');
    expect(html).toContain('no_implementation_shown');
  });
});
