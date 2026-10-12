import type {
  AssessmentDetail,
  AssessmentJudgmentView,
  AssessmentListResponse,
  AssessmentSummary,
  ScoreReport,
} from '@judge-copilot/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssessmentPageView } from './view';

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
    target: 'overall_rubric_only',
    replay: 'REPLAY DEMONSTRATION',
  },
  ...overrides,
});

function render(listValue: AssessmentListResponse, detailValue: AssessmentDetail | null): string {
  return renderToStaticMarkup(
    <AssessmentPageView
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
    expect(html).toContain('could not be verified, so none of it is shown');
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
