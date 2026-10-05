import {
  EVIDENCE_KIND_VALUES,
  EVIDENCE_ORIGIN_VALUES,
  VERIFICATION_LEVEL_VALUES,
  type EvidenceKind,
  type EvidenceOrigin,
  type VerificationLevel,
} from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import {
  allowedEvidenceCombinations,
  canEvidenceKindBeContradictionSide,
  canEvidenceKindTakePart,
  claimLevelJustification,
  DEFERRED_EVIDENCE_ORIGINS,
  evidenceAnchorRequirement,
  evidenceLevelsFor,
  isEvidenceVerificationAllowed,
  isOriginCreatableInM3,
  isVerificationTransitionAllowed,
  M3_EVIDENCE_ORIGINS,
  verificationTier,
} from './verification.js';

const LEVELS = VERIFICATION_LEVEL_VALUES;

describe('verification ladder', () => {
  it('follows docs/SCORING.md section 8, with contradicted off the ladder', () => {
    expect(LEVELS.map((level) => [level, verificationTier(level)])).toEqual([
      ['unverified', 0],
      ['team_claim', 1],
      ['repo_corroborated', 2],
      ['machine_verified', 2],
      ['judge_verified', 3],
      ['live_verified', 3],
      ['contradicted', null],
    ]);
  });
});

describe('claim verification transitions (complete 7 x 7 matrix)', () => {
  // Written out explicitly, independent of the implementation. Row = from, column = to, in
  // vocabulary order: unverified team_claim repo_corroborated machine_verified judge_verified
  // live_verified contradicted. 1 = allowed.
  const MATRIX: Record<VerificationLevel, string> = {
    unverified: '1111111',
    team_claim: '0111111',
    repo_corroborated: '0011111',
    machine_verified: '0011111',
    judge_verified: '0000111',
    live_verified: '0000111',
    contradicted: '1111111',
  };

  it('has an expectation for every pair', () => {
    expect(Object.keys(MATRIX)).toEqual([...LEVELS]);
  });

  for (const from of LEVELS) {
    for (const [index, to] of LEVELS.entries()) {
      const allowed = MATRIX[from].charAt(index) === '1';
      it(`${from} -> ${to} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        expect(isVerificationTransitionAllowed(from, to)).toBe(allowed);
      });
    }
  }

  it('never lets a claim silently lose verification, but lets it become (and stop being) contradicted', () => {
    expect(isVerificationTransitionAllowed('machine_verified', 'team_claim')).toBe(false);
    expect(isVerificationTransitionAllowed('live_verified', 'unverified')).toBe(false);
    expect(isVerificationTransitionAllowed('live_verified', 'contradicted')).toBe(true);
    expect(isVerificationTransitionAllowed('contradicted', 'unverified')).toBe(true);
  });
});

describe('evidence origin / kind / verification matrix', () => {
  const NONE: VerificationLevel[] = [];
  const NOTHING: VerificationLevel[] = ['unverified'];
  const TEAM: VerificationLevel[] = ['unverified', 'team_claim'];

  // Independent oracle of every (origin, kind) cell.
  const EXPECTED: Record<EvidenceOrigin, Record<EvidenceKind, VerificationLevel[]>> = {
    event_context: {
      fact: NOTHING,
      claim: NONE,
      absence: NOTHING,
      unknown: NOTHING,
      contradiction: NOTHING,
    },
    devpost: {
      fact: TEAM,
      claim: TEAM,
      absence: NOTHING,
      unknown: NOTHING,
      contradiction: NOTHING,
    },
    video: { fact: TEAM, claim: TEAM, absence: NOTHING, unknown: NOTHING, contradiction: NOTHING },
    github: {
      fact: ['unverified', 'repo_corroborated', 'machine_verified'],
      claim: TEAM,
      absence: NOTHING,
      unknown: NOTHING,
      contradiction: NOTHING,
    },
    deployment: {
      fact: ['unverified', 'machine_verified'],
      claim: TEAM,
      absence: NOTHING,
      unknown: NOTHING,
      contradiction: NOTHING,
    },
    team_answer: {
      fact: NONE,
      claim: TEAM,
      absence: NONE,
      unknown: NOTHING,
      contradiction: NOTHING,
    },
    judge_observation: {
      fact: ['judge_verified', 'live_verified'],
      claim: NONE,
      absence: ['judge_verified', 'live_verified'],
      unknown: NOTHING,
      contradiction: ['unverified', 'judge_verified'],
    },
  };

  for (const origin of EVIDENCE_ORIGIN_VALUES) {
    for (const kind of EVIDENCE_KIND_VALUES) {
      it(`${origin} ${kind} may carry exactly ${EXPECTED[origin][kind].join(', ') || 'nothing (the combination does not exist)'}`, () => {
        for (const level of LEVELS) {
          expect(isEvidenceVerificationAllowed(origin, kind, level)).toBe(
            EXPECTED[origin][kind].includes(level),
          );
        }
        expect([...evidenceLevelsFor(origin, kind)]).toEqual(EXPECTED[origin][kind]);
      });
    }
  }

  it('team statements stay team claims: project-authored prose never exceeds team_claim', () => {
    for (const origin of ['devpost', 'video', 'team_answer'] as const) {
      for (const kind of ['claim', 'fact'] as const) {
        for (const level of evidenceLevelsFor(origin, kind)) {
          expect(['unverified', 'team_claim']).toContain(level);
        }
      }
    }
    // README-like text on GitHub or a deployment is also only a claim.
    for (const origin of ['github', 'deployment'] as const) {
      expect([...evidenceLevelsFor(origin, 'claim')]).toEqual(['unverified', 'team_claim']);
    }
    expect(isEvidenceVerificationAllowed('devpost', 'claim', 'machine_verified')).toBe(false);
    expect(isEvidenceVerificationAllowed('devpost', 'fact', 'repo_corroborated')).toBe(false);
  });

  it('never allows contradicted on an evidence item', () => {
    for (const origin of EVIDENCE_ORIGIN_VALUES) {
      for (const kind of EVIDENCE_KIND_VALUES) {
        expect(isEvidenceVerificationAllowed(origin, kind, 'contradicted')).toBe(false);
      }
    }
  });

  it('keeps absence and unknown unverified (invariant 3) except for a judge looking in person', () => {
    for (const origin of M3_EVIDENCE_ORIGINS) {
      expect([...evidenceLevelsFor(origin, 'absence')]).toEqual(['unverified']);
      expect([...evidenceLevelsFor(origin, 'unknown')]).toEqual(['unverified']);
    }
  });

  it('generates only existing combinations for the database CHECK', () => {
    const all = allowedEvidenceCombinations(EVIDENCE_ORIGIN_VALUES, EVIDENCE_KIND_VALUES);
    expect(all.every((entry) => entry.levels.length > 0)).toBe(true);
    expect(all.some((entry) => entry.origin === 'event_context' && entry.kind === 'claim')).toBe(
      false,
    );
  });

  it('creates M3 evidence only for origins that have records to point at', () => {
    expect([...M3_EVIDENCE_ORIGINS]).toEqual([
      'event_context',
      'devpost',
      'github',
      'deployment',
      'video',
    ]);
    expect([...DEFERRED_EVIDENCE_ORIGINS]).toEqual(['team_answer', 'judge_observation']);
    for (const origin of EVIDENCE_ORIGIN_VALUES) {
      expect(isOriginCreatableInM3(origin)).toBe(
        !DEFERRED_EVIDENCE_ORIGINS.some((o) => o === origin),
      );
    }
  });
});

describe('anchors and justification', () => {
  it('requires artifact (and span for machine_verified) anchors', () => {
    expect(evidenceAnchorRequirement('machine_verified')).toEqual({ artifact: true, span: true });
    expect(evidenceAnchorRequirement('repo_corroborated')).toEqual({ artifact: true, span: false });
    for (const level of [
      'unverified',
      'team_claim',
      'judge_verified',
      'live_verified',
      'contradicted',
    ] as const) {
      expect(evidenceAnchorRequirement(level)).toEqual({ artifact: false, span: false });
    }
  });

  it('describes what each claim level needs; team statements need nothing', () => {
    expect(claimLevelJustification('unverified')).toEqual({ kind: 'none' });
    expect(claimLevelJustification('team_claim')).toEqual({ kind: 'none' });
    expect(claimLevelJustification('contradicted')).toEqual({ kind: 'contradiction_record' });
    const need = claimLevelJustification('machine_verified');
    if (need.kind !== 'supporting_evidence') throw new Error('expected supporting evidence');
    expect(
      need.accepts({ origin: 'deployment', kind: 'fact', verificationLevel: 'machine_verified' }),
    ).toBe(true);
    // Captured Devpost prose never justifies a verified claim.
    expect(
      need.accepts({ origin: 'devpost', kind: 'claim', verificationLevel: 'team_claim' }),
    ).toBe(false);
    expect(
      need.accepts({ origin: 'github', kind: 'fact', verificationLevel: 'repo_corroborated' }),
    ).toBe(false);
  });

  it('keeps judge verification unreachable without judge evidence', () => {
    for (const level of ['judge_verified', 'live_verified'] as const) {
      const need = claimLevelJustification(level);
      if (need.kind !== 'supporting_evidence') throw new Error('expected supporting evidence');
      for (const origin of M3_EVIDENCE_ORIGINS) {
        for (const verificationLevel of LEVELS) {
          expect(need.accepts({ origin, kind: 'fact', verificationLevel })).toBe(false);
        }
      }
    }
  });
});

describe('which evidence kinds may take part in relations and contradictions', () => {
  it('excludes absence and unknown: missing evidence is not negative evidence', () => {
    for (const kind of ['absence', 'unknown'] as const) {
      expect(canEvidenceKindTakePart('supports', kind)).toBe(false);
      expect(canEvidenceKindTakePart('contradicts', kind)).toBe(false);
      expect(canEvidenceKindBeContradictionSide(kind)).toBe(false);
    }
    for (const kind of ['fact', 'claim'] as const) {
      expect(canEvidenceKindTakePart('supports', kind)).toBe(true);
      expect(canEvidenceKindTakePart('contradicts', kind)).toBe(true);
      expect(canEvidenceKindBeContradictionSide(kind)).toBe(true);
    }
    expect(canEvidenceKindTakePart('supports', 'contradiction')).toBe(false);
    expect(canEvidenceKindTakePart('contradicts', 'contradiction')).toBe(true);
  });
});
