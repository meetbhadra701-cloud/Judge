import type {
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
    rubric: { name: 'Official rubric', official: true },
    overall,
    criteria: [
      assessed
        ? {
            key: 'problem_fit',
            name: 'Problem fit',
            weight: 1,
            state: 'assessed',
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
  unknowns: UnknownsView | null = { items: [], hasMore: false },
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
    rubric: { name: 'Official rubric', official: true },
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
  const unknown = (id: string, text: string, unknownType: 'missing' | 'ambiguous' = 'missing') => ({
    id,
    projectId: 'p1',
    seq: 1,
    unknownType,
    text,
    claimIds: [],
    evidenceIds: [],
    createdByActorId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

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
        hasMore: true,
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
    expect(section).toContain('as text that is not verified');
    expect(section).toContain('More unknowns exist than are listed');
    expect(section).toContain('not part of this version');
  });

  it('renders unknown text as inert text and does not create unknowns of its own', () => {
    const html = render(scoredList, detail({}), {
      items: [unknown('u1', '<script>alert(1)</script>')],
      hasMore: false,
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const none = render(scoredList, detail({}), { items: [], hasMore: false });
    expect(none).toContain('No unknowns are recorded for this project.');
    expect(none).toContain('Every dimension had enough evidence for a number.');
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
