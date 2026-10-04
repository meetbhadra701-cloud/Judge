import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_RUN_STATE_VALUES,
  AnalysisRunFailureCategory,
  AssessmentKind,
  DottedIdentifier,
  EVENT_CONTEXT_STATUS_VALUES,
  EventContextStatus,
  EvidenceKind,
  EvidenceOrigin,
  Identifier,
  QuestionMode,
  Ratio,
  Score10,
  Slug,
  SourceSnapshotStatus,
  UnknownType,
  Uuid,
  VerificationLevel,
} from './index.js';

describe('Score10', () => {
  it.each([0, 0.1, 5, 7.25, 10])('accepts %s', (value) => {
    expect(Score10.safeParse(value).success).toBe(true);
  });

  it.each([-0.01, -1, 10.01, 11, Number.NaN, Number.POSITIVE_INFINITY, '5', null])(
    'rejects %s',
    (value) => {
      expect(Score10.safeParse(value).success).toBe(false);
    },
  );
});

describe('Ratio', () => {
  it.each([0, 0.5, 1])('accepts %s', (value) => {
    expect(Ratio.safeParse(value).success).toBe(true);
  });

  it.each([-0.0001, 1.0001, 2, Number.NaN, Number.NEGATIVE_INFINITY, '0.5'])(
    'rejects %s',
    (value) => {
      expect(Ratio.safeParse(value).success).toBe(false);
    },
  );
});

describe('identifier primitives', () => {
  it('Uuid accepts a v4 UUID and rejects other strings', () => {
    expect(Uuid.safeParse('5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e').success).toBe(true);
    expect(Uuid.safeParse('not-a-uuid').success).toBe(false);
  });

  it('Slug enforces lowercase hyphenated form', () => {
    expect(Slug.safeParse('cruzhacks-2027').success).toBe(true);
    for (const bad of ['', 'CruzHacks', 'two--hyphens', '-leading', 'trailing-', 'has space']) {
      expect(Slug.safeParse(bad).success).toBe(false);
    }
  });

  it('Identifier and DottedIdentifier enforce snake_case segments', () => {
    expect(Identifier.safeParse('event_context_version').success).toBe(true);
    expect(Identifier.safeParse('EventContext').success).toBe(false);
    expect(Identifier.safeParse('1event').success).toBe(false);
    expect(DottedIdentifier.safeParse('event_context.locked').success).toBe(true);
    expect(DottedIdentifier.safeParse('event_context.').success).toBe(false);
    expect(DottedIdentifier.safeParse('event context.locked').success).toBe(false);
  });
});

describe('domain vocabularies', () => {
  it('EventContextStatus supports exactly the expected lifecycle states', () => {
    expect(EVENT_CONTEXT_STATUS_VALUES).toEqual(['draft', 'in_review', 'locked', 'superseded']);
    for (const status of EVENT_CONTEXT_STATUS_VALUES) {
      expect(EventContextStatus.parse(status)).toBe(status);
    }
    expect(EventContextStatus.safeParse('approved').success).toBe(false);
    expect(EventContextStatus.safeParse('LOCKED').success).toBe(false);
  });

  it('VerificationLevel matches the documented ladder', () => {
    expect(VerificationLevel.options).toEqual([
      'unverified',
      'team_claim',
      'repo_corroborated',
      'machine_verified',
      'judge_verified',
      'live_verified',
      'contradicted',
    ]);
    expect(VerificationLevel.safeParse('verified').success).toBe(false);
  });

  it('EvidenceKind, EvidenceOrigin, QuestionMode and UnknownType match the documented vocabularies', () => {
    expect(EvidenceKind.options).toEqual(['fact', 'claim', 'absence', 'unknown', 'contradiction']);
    expect(EvidenceOrigin.options).toEqual([
      'event_context',
      'devpost',
      'github',
      'deployment',
      'video',
      'team_answer',
      'judge_observation',
    ]);
    expect(QuestionMode.options).toEqual(['ask', 'clarify', 'show_me', 'demonstrate', 'verify']);
    expect(UnknownType.options).toEqual([
      'missing',
      'ambiguous',
      'contradictory',
      'unverifiable',
      'subjective',
      'eligibility',
    ]);
    expect(EvidenceOrigin.safeParse('twitter').success).toBe(false);
  });

  it('AssessmentKind has only the two AI assessment versions; the human final score is not one', () => {
    expect(AssessmentKind.options).toEqual(['pre_interview', 'post_interview']);
    expect(AssessmentKind.safeParse('final').success).toBe(false);
    expect(AssessmentKind.safeParse('human_final').success).toBe(false);
  });

  it('SourceSnapshotStatus and analysis run vocabularies reject unknown values', () => {
    expect(SourceSnapshotStatus.options).toEqual([
      'pending',
      'captured',
      'partial',
      'failed',
      'rejected',
    ]);
    expect(SourceSnapshotStatus.safeParse('done').success).toBe(false);
    // M2 added `pending` (queued capture work) ahead of `running`.
    expect(ANALYSIS_RUN_STATE_VALUES).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
      'cancelled',
    ]);
    expect(AnalysisRunFailureCategory.safeParse('insufficient_evidence').success).toBe(false);
  });
});
