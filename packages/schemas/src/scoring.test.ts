import { describe, expect, it } from 'vitest';
import {
  AssessedDimensionReport,
  AssessorJudgmentsInput,
  CONFIDENCE_BASIS_VALUES,
  CriterionReport,
  DimensionJudgment,
  DimensionReport,
  EVIDENCE_CHANNEL_VALUES,
  EVIDENCE_DIRECTNESS_VALUES,
  EVIDENCE_SPECIFICITY_VALUES,
  FALLBACK_RUBRIC_VERSION,
  InsufficientDimensionReport,
  OverallReport,
  SCORING_ENGINE_VERSION,
  ScoreReportNotices,
  ScoringOptions,
  UNOFFICIAL_PREVIEW_NOTICE,
  UnofficialPreview,
} from './scoring.js';

const ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const citation = { evidenceId: ID, directness: 'direct', specificity: 'exact' };
const judgments = (extra: Record<string, unknown> = {}) => ({
  engineVersion: SCORING_ENGINE_VERSION,
  judgments: [
    {
      dimensionId: 'official.innovation',
      outcome: { kind: 'scored', score: 7.5 },
      citations: [citation],
    },
  ],
  ...extra,
});

describe('scoring vocabularies', () => {
  it('pins the engine and fallback versions', () => {
    expect(SCORING_ENGINE_VERSION).toBe('scoring-engine/v1');
    expect(FALLBACK_RUBRIC_VERSION).toBe('fallback-rubric/v1');
  });

  it('has the approved closed vocabularies', () => {
    expect(EVIDENCE_DIRECTNESS_VALUES).toEqual(['direct', 'adjacent', 'indirect']);
    expect(EVIDENCE_SPECIFICITY_VALUES).toEqual(['exact', 'partial', 'generic']);
    expect(EVIDENCE_CHANNEL_VALUES).toEqual([
      'source_code',
      'repository',
      'submission',
      'deployment',
      'video',
      'event_context',
      'team_answer',
      'judge_observation',
    ]);
    expect(CONFIDENCE_BASIS_VALUES).toEqual(['declared_needs_coverage', 'citation_presence']);
  });
});

describe('AssessorJudgmentsInput (the only untrusted input)', () => {
  it('accepts a well-formed payload', () => {
    expect(AssessorJudgmentsInput.safeParse(judgments()).success).toBe(true);
    expect(
      AssessorJudgmentsInput.safeParse({
        engineVersion: SCORING_ENGINE_VERSION,
        judgments: [
          {
            dimensionId: 'official.innovation',
            outcome: { kind: 'insufficient_evidence' },
            citations: [],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['attestations', { attestations: [{ evidenceId: ID, level: 'machine_verified' }] }],
    ['trustedAttestations', { trustedAttestations: [ID] }],
    ['verificationOverride', { verificationOverride: 'live_verified' }],
    ['verificationLevels', { verificationLevels: { [ID]: 'judge_verified' } }],
    ['weights', { weights: { machine_verified: 1 } }],
    ['levelWeights', { levelWeights: { machine_verified: 0.9 } }],
    ['rubric', { rubric: { criteria: [] } }],
    ['declaredTrackKeys', { declaredTrackKeys: [] }],
    ['projectContext', { projectContext: { declaredTrackKeys: [] } }],
    ['unweightedPreview', { unweightedPreview: 'equal_weight' }],
    ['target', { target: { kind: 'overall' } }],
    ['score', { score: 10 }],
  ])('rejects a smuggled top-level "%s" field', (_name, extra) => {
    expect(AssessorJudgmentsInput.safeParse(judgments(extra)).success).toBe(false);
  });

  it.each([
    ['verificationLevel', { verificationLevel: 'machine_verified' }],
    ['strength', { strength: 1 }],
    ['weight', { weight: 1 }],
    ['attested', { attested: true }],
    ['score10', { score10: 10 }],
  ])('rejects a smuggled "%s" field on a judgment', (_name, extra) => {
    const payload = judgments();
    Object.assign(payload.judgments[0] ?? {}, extra);
    expect(AssessorJudgmentsInput.safeParse(payload).success).toBe(false);
  });

  it('rejects smuggled fields on a citation and on an outcome', () => {
    const base = judgments();
    expect(
      AssessorJudgmentsInput.safeParse({
        ...base,
        judgments: [
          {
            dimensionId: 'official.innovation',
            outcome: { kind: 'scored', score: 5 },
            citations: [{ ...citation, verificationLevel: 'live_verified' }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AssessorJudgmentsInput.safeParse({
        ...base,
        judgments: [
          {
            dimensionId: 'official.innovation',
            outcome: { kind: 'scored', score: 5, confidence: 1 },
            citations: [],
          },
        ],
      }).success,
    ).toBe(false);
    // An insufficient outcome carries no value at all.
    expect(
      AssessorJudgmentsInput.safeParse({
        ...base,
        judgments: [
          {
            dimensionId: 'official.innovation',
            outcome: { kind: 'insufficient_evidence', score: 0 },
            citations: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects non-finite scores, wrong versions, bad ids and unknown vocabulary values', () => {
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '7']) {
      expect(
        DimensionJudgment.safeParse({
          dimensionId: 'official.x',
          outcome: { kind: 'scored', score },
          citations: [],
        }).success,
        String(score),
      ).toBe(false);
    }
    expect(
      AssessorJudgmentsInput.safeParse({ ...judgments(), engineVersion: 'scoring-engine/v2' })
        .success,
    ).toBe(false);
    expect(
      DimensionJudgment.safeParse({
        dimensionId: 'Not An Identifier',
        outcome: { kind: 'insufficient_evidence' },
        citations: [],
      }).success,
    ).toBe(false);
    for (const bad of [
      { ...citation, evidenceId: 'not-a-uuid' },
      { ...citation, directness: 'adjacent-ish' },
      { ...citation, specificity: 'very' },
    ]) {
      expect(
        DimensionJudgment.safeParse({
          dimensionId: 'official.x',
          outcome: { kind: 'insufficient_evidence' },
          citations: [bad],
        }).success,
      ).toBe(false);
    }
  });

  it('bounds the number of judgments and citations', () => {
    const one = {
      dimensionId: 'official.x',
      outcome: { kind: 'insufficient_evidence' },
      citations: [],
    };
    expect(
      AssessorJudgmentsInput.safeParse({
        engineVersion: SCORING_ENGINE_VERSION,
        judgments: Array.from({ length: 501 }, () => one),
      }).success,
    ).toBe(false);
    expect(
      DimensionJudgment.safeParse({
        ...one,
        citations: Array.from({ length: 101 }, () => citation),
      }).success,
    ).toBe(false);
  });
});

describe('ScoringOptions', () => {
  it('only knows the explicit equal-weight preview request', () => {
    expect(ScoringOptions.safeParse({}).success).toBe(true);
    expect(ScoringOptions.safeParse({ unweightedPreview: 'equal_weight' }).success).toBe(true);
    expect(ScoringOptions.safeParse({ unweightedPreview: 'official' }).success).toBe(false);
    expect(ScoringOptions.safeParse({ weights: {} }).success).toBe(false);
  });
});

describe('report schemas', () => {
  const needs = { kind: 'declared', totalGroups: 2, satisfiedGroups: 1, coverage: 0.5 };
  const base = {
    id: 'official.innovation',
    criterionKey: 'innovation',
    name: 'Innovation',
    weight: 1,
    needs,
    citedEvidenceIds: [ID],
    contradictionIds: [],
    provenanceGroupCount: 1,
  };

  it('an insufficient dimension has no score field of any kind', () => {
    const insufficient = {
      ...base,
      state: 'insufficient_evidence',
      reason: 'no_usable_citation',
      confidence: 0,
    };
    expect(InsufficientDimensionReport.safeParse(insufficient).success).toBe(true);
    for (const field of ['score10', 'scoreOnScale', 'score', 'suppressedScore', 'judgedValue']) {
      expect(DimensionReport.safeParse({ ...insufficient, [field]: 3 }).success, field).toBe(false);
    }
    expect(
      InsufficientDimensionReport.safeParse({ ...insufficient, confidence: 0.2 }).success,
    ).toBe(false);
  });

  it('an assessed dimension needs its score and confidence basis', () => {
    const assessed = {
      ...base,
      state: 'assessed',
      scoreOnScale: 7,
      score10: 7,
      evidenceStrength: 0.6,
      strongestEvidenceIds: [ID],
      confidenceBasis: 'declared_needs_coverage',
      confidence: 0.3,
    };
    expect(AssessedDimensionReport.safeParse(assessed).success).toBe(true);
    expect(AssessedDimensionReport.safeParse({ ...assessed, score10: 11 }).success).toBe(false);
    expect(AssessedDimensionReport.safeParse({ ...assessed, confidence: 1.1 }).success).toBe(false);
  });

  it('distinguishes real coverage from the citation-presence flag', () => {
    expect(
      DimensionReport.safeParse({
        ...base,
        needs: { kind: 'unspecified', citationPresence: 1 },
        state: 'insufficient_evidence',
        reason: 'assessor_reported_insufficient',
        confidence: 0,
      }).success,
    ).toBe(true);
    // The flag cannot masquerade as coverage, and coverage cannot be attached to the flag.
    expect(
      DimensionReport.safeParse({
        ...base,
        needs: { kind: 'unspecified', citationPresence: 1, coverage: 1 },
        state: 'insufficient_evidence',
        reason: 'assessor_reported_insufficient',
        confidence: 0,
      }).success,
    ).toBe(false);
    expect(
      DimensionReport.safeParse({
        ...base,
        needs: { kind: 'unspecified', citationPresence: 0.5 },
        state: 'insufficient_evidence',
        reason: 'assessor_reported_insufficient',
        confidence: 0,
      }).success,
    ).toBe(false);
  });

  it('an insufficient or not_applicable criterion and overall carry no score', () => {
    const aggregate = {
      assessedWeightShare: 0.4,
      coverage: null,
      citationPresenceShare: 0.4,
      confidence: 0.1,
      dimensionIds: ['official.x'],
      missingDimensionIds: ['official.x'],
    };
    const criterion = {
      key: 'x',
      name: 'X',
      weight: 0.5,
      state: 'insufficient_evidence',
      ...aggregate,
    };
    expect(CriterionReport.safeParse(criterion).success).toBe(true);
    expect(CriterionReport.safeParse({ ...criterion, score10: 3 }).success).toBe(false);
    expect(
      CriterionReport.safeParse({
        key: 'track_prize_alignment',
        name: 'T',
        weight: 0.1,
        state: 'not_applicable',
        reason: 'no_declared_tracks',
      }).success,
    ).toBe(true);
    expect(
      OverallReport.safeParse({
        state: 'insufficient_evidence',
        weightBasis: 'official',
        reason: 'assessed_weight_below_threshold',
        assessedWeightShare: 0.4,
        coverage: null,
        citationPresenceShare: 0.4,
        confidence: 0.1,
        missingCriterionKeys: ['x'],
      }).success,
    ).toBe(true);
    expect(
      OverallReport.safeParse({
        state: 'insufficient_evidence',
        weightBasis: 'official',
        reason: 'assessed_weight_below_threshold',
        assessedWeightShare: 0.4,
        coverage: null,
        citationPresenceShare: 0.4,
        confidence: 0.1,
        missingCriterionKeys: ['x'],
        score10: 0,
      }).success,
    ).toBe(false);
  });

  it('an unweighted official rubric can only be not_computed, with no number', () => {
    expect(
      OverallReport.safeParse({
        state: 'not_computed',
        weightBasis: 'unweighted_official',
        reason: 'unweighted_official_rubric',
      }).success,
    ).toBe(true);
    expect(
      OverallReport.safeParse({
        state: 'not_computed',
        weightBasis: 'unweighted_official',
        reason: 'unweighted_official_rubric',
        score10: 7,
      }).success,
    ).toBe(false);
    // An unweighted rubric can never be reported as a scored official overall.
    expect(
      OverallReport.safeParse({
        state: 'scored',
        weightBasis: 'unweighted_official',
        scoreOnScale: 7,
        score10: 7,
        assessedWeightShare: 1,
        coverage: null,
        citationPresenceShare: 1,
        confidence: 0.5,
        missingCriterionKeys: [],
      }).success,
    ).toBe(false);
  });

  it('the unofficial preview is always labeled and can never claim to be official', () => {
    const preview = {
      kind: 'unofficial_equal_weight_preview',
      official: false,
      weightBasis: 'equal_assumed',
      notice: UNOFFICIAL_PREVIEW_NOTICE,
      state: 'scored_partial',
      scoreOnScale: 7,
      score10: 7,
      assessedWeightShare: 0.6667,
      coverage: null,
      citationPresenceShare: 0.6667,
      confidence: 0.3,
      missingCriterionKeys: ['c'],
    };
    expect(UnofficialPreview.safeParse(preview).success).toBe(true);
    expect(UnofficialPreview.safeParse({ ...preview, official: true }).success).toBe(false);
    expect(UnofficialPreview.safeParse({ ...preview, weightBasis: 'official' }).success).toBe(
      false,
    );
    expect(UnofficialPreview.safeParse({ ...preview, notice: 'Official score' }).success).toBe(
      false,
    );
    expect(UNOFFICIAL_PREVIEW_NOTICE).toContain('UNOFFICIAL');
  });

  it('fixes the notices that state what a report does not establish', () => {
    const notices = {
      contradictionCoverage: 'recorded_only',
      semanticRelevance: 'not_verified',
      claimLabels: 'never_proof_of_truth',
      parameterStatus: 'heuristic_not_calibrated',
      confidenceMeaning: 'index_not_probability',
    };
    expect(ScoreReportNotices.safeParse(notices).success).toBe(true);
    for (const key of Object.keys(notices)) {
      expect(ScoreReportNotices.safeParse({ ...notices, [key]: 'complete' }).success, key).toBe(
        false,
      );
    }
  });
});
