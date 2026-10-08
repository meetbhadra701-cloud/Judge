import type {
  EvidenceDirectness,
  EvidenceKind,
  EvidenceSpecificity,
  ScoreReport,
  VerificationLevel,
} from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { scoreProject } from './engine.js';
import { FALLBACK_RUBRIC_DEFINITION, FALLBACK_TRACK_CRITERION_KEY } from './rubric/fallback.js';
import {
  baseWorld,
  cite,
  fallbackDimensionIds,
  IDS,
  lockedSnapshot,
  makeContext,
  payload,
  seeded,
  uid,
} from './testing/builders.js';

/*
 * Metamorphic properties of scoring-engine/v1 over seeded random scenarios (a deterministic PRNG,
 * never Math.random). A scenario is plain data, so a mutation can change one thing and the report
 * before and after can be compared.
 *
 * The properties below are the corrected ones of the approved design (docs/milestones/M4-design.md
 * §9): missing evidence is never imputed or deducted; removing a scored dimension may change an
 * aggregate in EITHER direction (so monotonicity is deliberately NOT asserted); adding independent,
 * noncontradictory support never lowers confidence; contradictions may lower it; repeating the same
 * provenance never inflates support or confidence.
 */

type Origin = 'devpost' | 'github' | 'deployment' | 'video';
interface Ev {
  id: string;
  origin: Origin;
  kind: EvidenceKind;
  label: VerificationLevel;
  snapshotId: string;
  artifactId: string | null;
  span: [number, number] | null;
}
interface Cite {
  evidenceId: string;
  directness: EvidenceDirectness;
  specificity: EvidenceSpecificity;
}
interface Judged {
  dimensionId: string;
  score: number | null;
  citations: Cite[];
}
interface Scenario {
  evidence: Ev[];
  contradictions: { id: string; a: string; b: string }[];
  claims: { id: string; label: VerificationLevel; relatesTo: string[] }[];
  judged: Judged[];
}

const SNAPSHOT_OF: Record<Origin, string> = {
  devpost: IDS.devpost,
  github: IDS.github,
  deployment: IDS.deployment,
  video: IDS.video,
};
const ARTIFACTS = [IDS.code, IDS.code2, IDS.readme, IDS.meta];
/** Labels the database (and so the integrity validator) accepts per origin and kind. */
const VALID_LABELS: Record<string, VerificationLevel[]> = {
  'devpost:claim': ['unverified', 'team_claim'],
  'devpost:fact': ['unverified', 'team_claim'],
  'video:claim': ['unverified', 'team_claim'],
  'video:fact': ['unverified', 'team_claim'],
  'github:claim': ['unverified', 'team_claim'],
  'github:fact': ['unverified', 'repo_corroborated', 'machine_verified'],
  'deployment:claim': ['unverified', 'team_claim'],
  'deployment:fact': ['unverified', 'machine_verified'],
};

const DIRECTNESS: EvidenceDirectness[] = ['direct', 'adjacent', 'indirect'];
const SPECIFICITY: EvidenceSpecificity[] = ['exact', 'partial', 'generic'];
const pick = <T>(random: () => number, list: readonly T[]): T => {
  const value = list[Math.floor(random() * list.length)];
  if (value === undefined) throw new Error('empty');
  return value;
};

let serial = 0;
const newId = () => uid((serial += 1), 'e9000001');

/** Gives an item the anchors its label structurally requires (the database enforces the same). */
function anchored(ev: Ev, random: () => number): Ev {
  const out = { ...ev };
  if (out.origin === 'github' && out.kind === 'fact') {
    if (
      (out.label === 'repo_corroborated' || out.label === 'machine_verified') &&
      out.artifactId === null
    ) {
      out.artifactId = pick(random, ARTIFACTS);
    }
  }
  if (out.origin === 'deployment' && out.label === 'machine_verified')
    out.artifactId = IDS.response;
  if (out.label === 'machine_verified' && out.span === null) {
    const start = Math.floor(random() * 40);
    out.span = [start, start + 1 + Math.floor(random() * 20)];
  }
  return out;
}

function randomEvidence(random: () => number, snapshotId?: string): Ev {
  const origin = pick(random, ['devpost', 'github', 'deployment', 'video'] as const);
  const kind = pick(random, ['fact', 'claim'] as const);
  const allowed = VALID_LABELS[`${origin}:${kind}`] ?? ['unverified'];
  // An item in a FRESH snapshot has no artifact of its own, so it cannot carry an anchored label.
  const label = pick(
    random,
    snapshotId === undefined
      ? allowed
      : allowed.filter((l) => l !== 'repo_corroborated' && l !== 'machine_verified'),
  );
  const start = Math.floor(random() * 40);
  const withArtifact = snapshotId === undefined && origin === 'github' && random() < 0.7;
  return anchored(
    {
      id: newId(),
      origin,
      kind,
      label,
      snapshotId: snapshotId ?? SNAPSHOT_OF[origin],
      artifactId: withArtifact ? pick(random, ARTIFACTS) : null,
      span: withArtifact && random() < 0.5 ? [start, start + 1 + Math.floor(random() * 20)] : null,
    },
    random,
  );
}

function randomScenario(seed: number): Scenario {
  const random = seeded(seed);
  const evidence = Array.from({ length: 6 + Math.floor(random() * 10) }, () =>
    randomEvidence(random),
  );
  const judged = fallbackDimensionIds(false).map((dimensionId): Judged => {
    const insufficient = random() < 0.25;
    const count = Math.floor(random() * 4);
    const chosen = [...evidence].sort(() => random() - 0.5).slice(0, count);
    return {
      dimensionId,
      // Many decimals on purpose, so rounding behavior is observable.
      score: insufficient ? null : Math.round(random() * 1_000_000) / 100_000,
      citations: chosen.map((ev) => ({
        evidenceId: ev.id,
        directness: pick(random, DIRECTNESS),
        specificity: pick(random, SPECIFICITY),
      })),
    };
  });
  return { evidence, contradictions: [], claims: [], judged };
}

const clone = <T>(value: T): T => structuredClone(value);

function materialize(scenario: Scenario, shuffle?: () => number): ScoreReport {
  const g = baseWorld();
  const snapshots = new Set<string>(Object.values(SNAPSHOT_OF));
  for (const ev of scenario.evidence) {
    if (!snapshots.has(ev.snapshotId)) {
      g.snapshot(ev.snapshotId, ev.origin);
      snapshots.add(ev.snapshotId);
    }
  }
  const ordered = shuffle ? [...scenario.evidence].sort(() => shuffle() - 0.5) : scenario.evidence;
  for (const ev of ordered) {
    g.addEvidence({
      id: ev.id,
      origin: ev.origin,
      kind: ev.kind,
      label: ev.label,
      snapshotId: ev.snapshotId,
      artifactId: ev.artifactId,
      span: ev.span,
    });
  }
  for (const claim of scenario.claims) {
    g.addClaim({ id: claim.id, label: claim.label });
    for (const evidenceId of claim.relatesTo) g.relate(claim.id, evidenceId);
  }
  for (const c of scenario.contradictions) {
    g.contradict(c.id, { type: 'evidence', id: c.a }, { type: 'evidence', id: c.b });
  }
  const ctx = makeContext(g.build(), lockedSnapshot());
  const judgments = scenario.judged.map((j) => ({
    dimensionId: j.dimensionId,
    outcome:
      j.score === null
        ? ({ kind: 'insufficient_evidence' } as const)
        : ({ kind: 'scored', score: j.score } as const),
    citations: j.citations.map((c) => cite(c.evidenceId, c.directness, c.specificity)),
  }));
  const result = scoreProject(
    ctx,
    payload(...(shuffle ? [...judgments].sort(() => shuffle() - 0.5) : judgments)),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.report;
}

// -- Independent reference arithmetic (integer percent weights; shares the engine's code with nothing) ----

interface Reference {
  criterion: Map<string, { score: number | null; share: number }>;
  overall: { score: number | null; share: number };
}

function reference(scenario: Scenario): Reference {
  const scores = new Map(scenario.judged.map((j) => [j.dimensionId, j]));
  const criterion = new Map<string, { score: number | null; share: number }>();
  let overallNumerator = 0;
  let overallScoredPct = 0;
  let overallTotalPct = 0;
  for (const def of FALLBACK_RUBRIC_DEFINITION) {
    if (def.key === FALLBACK_TRACK_CRITERION_KEY) continue; // no declared tracks: not_applicable
    let num = 0;
    let assessedPct = 0;
    let assessedCount = 0;
    for (const dim of def.dimensions) {
      const j = scores.get(`${def.key}.${dim.key}`);
      // A dimension counts only with a score AND at least one usable cited item (fact/claim).
      const usable =
        j !== undefined &&
        j.score !== null &&
        j.citations.some((c) => {
          const ev = scenario.evidence.find((e) => e.id === c.evidenceId);
          return ev !== undefined && (ev.kind === 'fact' || ev.kind === 'claim');
        });
      if (usable && j.score !== null) {
        num += dim.weightPercent * j.score;
        assessedPct += dim.weightPercent;
        assessedCount += 1;
      }
    }
    const share = assessedPct / 100;
    const scored = assessedCount > 0 && share + 1e-9 >= 0.5;
    const value = scored ? num / assessedPct : null;
    criterion.set(def.key, { score: value, share });
    overallTotalPct += def.weightPercent;
    if (value !== null) {
      overallNumerator += def.weightPercent * value;
      overallScoredPct += def.weightPercent;
    }
  }
  const share = overallScoredPct / overallTotalPct;
  return {
    criterion,
    overall: {
      score:
        overallScoredPct > 0 && share + 1e-9 >= 0.6 ? overallNumerator / overallScoredPct : null,
      share,
    },
  };
}

/** True when `reported` is `exact` rounded to four decimals, allowing for ties decided by 1e-15 of noise. */
const rounds = (reported: number, exact: number) => Math.abs(reported - exact) <= 5e-5 + 1e-9;

/** Everything about a report that must not depend on evidence quality: scores, states, shares. */
function scoreView(report: ScoreReport) {
  return {
    dimensions: report.dimensions.map((d) => [d.id, d.state, 'score10' in d ? d.score10 : null]),
    criteria: report.criteria.map((c) => [
      c.key,
      c.state,
      'score10' in c ? c.score10 : null,
      'assessedWeightShare' in c ? c.assessedWeightShare : null,
    ]),
    overall: [report.overall.state, 'score10' in report.overall ? report.overall.score10 : null],
  };
}

const confidenceOf = (report: ScoreReport, id: string) => {
  const d = report.dimensions.find((entry) => entry.id === id);
  if (!d) throw new Error('missing dimension');
  return d.confidence;
};
const strengthOf = (report: ScoreReport, id: string) => {
  const d = report.dimensions.find((entry) => entry.id === id);
  return d && d.state === 'assessed' ? d.evidenceStrength : 0;
};
const coverageOf = (report: ScoreReport, id: string) => {
  const d = report.dimensions.find((entry) => entry.id === id);
  return d && d.needs.kind === 'declared' ? d.needs.coverage : 0;
};

const SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i);

describe('the generator itself', () => {
  it('produces valid, varied scenarios the engine accepts', () => {
    const states = new Set<string>();
    for (const seed of SEEDS) {
      const report = materialize(randomScenario(seed));
      states.add(report.overall.state);
    }
    expect(states.size).toBeGreaterThanOrEqual(2);
  });
});

describe('P1: classifying evidence differently never changes a score', () => {
  it('re-labeling evidence and re-classifying citations changes no score, state or share', () => {
    for (const seed of SEEDS) {
      const random = seeded(seed * 7 + 1);
      const scenario = randomScenario(seed);
      const before = materialize(scenario);
      const mutated = clone(scenario);
      for (const ev of mutated.evidence)
        ev.label = pick(random, VALID_LABELS[`${ev.origin}:${ev.kind}`] ?? ['unverified']);
      for (const j of mutated.judged) {
        for (const c of j.citations) {
          c.directness = pick(random, DIRECTNESS);
          c.specificity = pick(random, SPECIFICITY);
        }
      }
      mutated.evidence = mutated.evidence.map((ev) => anchored(ev, random));
      expect(scoreView(materialize(mutated)), `seed ${String(seed)}`).toEqual(scoreView(before));
    }
  });
});

describe('P2 / P3: missing evidence is never imputed or deducted; removing a scored dimension may move an aggregate either way', () => {
  it('every criterion and the overall equal an independent renormalized reference (never zero-filled)', () => {
    for (const seed of SEEDS) {
      const scenario = randomScenario(seed);
      const report = materialize(scenario);
      const expected = reference(scenario);
      for (const entry of report.criteria) {
        if (entry.state === 'not_applicable') continue;
        const ref = expected.criterion.get(entry.key);
        expect(ref, entry.key).toBeDefined();
        if (ref?.score === null || ref === undefined) {
          expect(entry.state, `${entry.key} seed ${String(seed)}`).toBe('insufficient_evidence');
          expect('score10' in entry).toBe(false);
        } else {
          expect(
            rounds('score10' in entry ? entry.score10 : Number.NaN, ref.score),
            `${entry.key} seed ${String(seed)}`,
          ).toBe(true);
        }
      }
      if (expected.overall.score === null) {
        expect(report.overall.state).toBe('insufficient_evidence');
      } else {
        expect(
          rounds(
            'score10' in report.overall ? report.overall.score10 : Number.NaN,
            expected.overall.score,
          ),
          `overall seed ${String(seed)}`,
        ).toBe(true);
      }
    }
  });

  it('removing one scored dimension changes the criterion exactly as renormalization says, in both directions', () => {
    let lowered = 0;
    let raised = 0;
    let unchanged = 0;
    for (const seed of SEEDS) {
      const scenario = randomScenario(seed);
      const before = materialize(scenario);
      for (const j of scenario.judged
        .filter((x) => x.score !== null && x.citations.length > 0)
        .slice(0, 6)) {
        const key = j.dimensionId.split('.')[0] ?? '';
        const after = clone(scenario);
        const target = after.judged.find((x) => x.dimensionId === j.dimensionId);
        if (target) target.score = null;
        const report = materialize(after);
        const b = before.criteria.find((c) => c.key === key);
        const a = report.criteria.find((c) => c.key === key);
        const refAfter = reference(after).criterion.get(key);
        if (refAfter?.score === null || refAfter === undefined) {
          expect(a?.state).toBe('insufficient_evidence');
        } else {
          expect(rounds(a && 'score10' in a ? a.score10 : Number.NaN, refAfter.score)).toBe(true);
        }
        if (b && a && 'score10' in b && 'score10' in a) {
          if (a.score10 < b.score10) lowered += 1;
          else if (a.score10 > b.score10) raised += 1;
          else unchanged += 1;
        }
      }
    }
    // Both directions genuinely occur: monotonicity must NOT be asserted.
    expect(lowered).toBeGreaterThan(20);
    expect(raised).toBeGreaterThan(20);
    expect(lowered + raised + unchanged).toBeGreaterThan(100);
  });

  it('an insufficient dimension never changes any OTHER criterion', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const scenario = randomScenario(seed);
      const before = materialize(scenario);
      const after = clone(scenario);
      const target = after.judged.find((x) => x.score !== null && x.citations.length > 0);
      if (!target) continue;
      target.score = null;
      const report = materialize(after);
      const key = target.dimensionId.split('.')[0];
      for (const c of before.criteria) {
        if (c.key === key) continue;
        expect(report.criteria.find((x) => x.key === c.key)).toEqual(c);
      }
    }
  });
});

describe('P4 / P5: adding evidence', () => {
  it('independent, noncontradictory supporting evidence never lowers confidence, strength or coverage, and never changes a score', () => {
    let raised = 0;
    for (const seed of SEEDS) {
      const random = seeded(seed * 13 + 5);
      const scenario = randomScenario(seed);
      const before = materialize(scenario);
      const assessedIds = new Set(
        before.dimensions.filter((d) => d.state === 'assessed').map((d) => d.id),
      );
      const pool = scenario.judged.filter((j) => assessedIds.has(j.dimensionId));
      if (pool.length === 0) continue;
      const target = pick(random, pool);
      // Independent: its own snapshot, so it shares no provenance group with anything.
      const added = randomEvidence(random, uid(Math.floor(random() * 1_000_000), 'f8000001'));
      const after = clone(scenario);
      after.evidence.push(added);
      after.judged
        .find((j) => j.dimensionId === target.dimensionId)
        ?.citations.push({
          evidenceId: added.id,
          directness: pick(random, DIRECTNESS),
          specificity: pick(random, SPECIFICITY),
        });
      const report = materialize(after);
      const id = target.dimensionId;
      expect(confidenceOf(report, id), `seed ${String(seed)}`).toBeGreaterThanOrEqual(
        confidenceOf(before, id),
      );
      expect(strengthOf(report, id)).toBeGreaterThanOrEqual(strengthOf(before, id));
      expect(coverageOf(report, id)).toBeGreaterThanOrEqual(coverageOf(before, id));
      expect(scoreView(report).dimensions).toEqual(scoreView(before).dimensions);
      expect(scoreView(report).criteria).toEqual(scoreView(before).criteria);
      expect(scoreView(report).overall).toEqual(scoreView(before).overall);
      // Aggregated confidence cannot fall either.
      const keyOf = id.split('.')[0];
      const cb = before.criteria.find((c) => c.key === keyOf);
      const ca = report.criteria.find((c) => c.key === keyOf);
      if (cb && ca && 'confidence' in cb && 'confidence' in ca) {
        expect(ca.confidence).toBeGreaterThanOrEqual(cb.confidence);
      }
      if (confidenceOf(report, id) > confidenceOf(before, id)) raised += 1;
    }
    expect(raised).toBeGreaterThan(10);
  });

  it('adding contradictory evidence may lower confidence, and never changes a score', () => {
    let lowered = 0;
    for (const seed of SEEDS) {
      const random = seeded(seed * 17 + 3);
      const scenario = randomScenario(seed);
      const before = materialize(scenario);
      const candidates = scenario.judged.filter(
        (j) =>
          j.score !== null &&
          j.citations.some((c) => scenario.evidence.find((e) => e.id === c.evidenceId)),
      );
      if (candidates.length === 0) continue;
      const target = pick(random, candidates);
      const cited = target.citations[0];
      if (!cited) continue;
      const other = randomEvidence(random);
      const after = clone(scenario);
      after.evidence.push(other);
      after.contradictions.push({ id: uid(seed, 'd9000001'), a: cited.evidenceId, b: other.id });
      const report = materialize(after);
      expect(confidenceOf(report, target.dimensionId)).toBeLessThanOrEqual(
        confidenceOf(before, target.dimensionId),
      );
      if (confidenceOf(report, target.dimensionId) < confidenceOf(before, target.dimensionId))
        lowered += 1;
      expect(scoreView(report)).toEqual(scoreView(before));
    }
    expect(lowered).toBeGreaterThan(10);
  });
});

describe('P6: repeating the same provenance never inflates support or confidence', () => {
  it('a duplicate record of a cited passage, however generously classified or labeled, adds nothing', () => {
    let exercised = 0;
    for (const seed of SEEDS) {
      const random = seeded(seed * 19 + 11);
      const scenario = randomScenario(seed);
      const before = materialize(scenario);
      const target = scenario.judged.find((j) => j.score !== null && j.citations.length > 0);
      const source =
        target?.citations[0] &&
        scenario.evidence.find((e) => e.id === target.citations[0]?.evidenceId);
      if (!target || !source || (source.kind !== 'fact' && source.kind !== 'claim')) continue;
      // Same snapshot, artifact and span (the same passage), with the most generous classification.
      const best = VALID_LABELS[`${source.origin}:${source.kind}`] ?? ['unverified'];
      const copy: Ev = anchored({ ...source, id: newId(), label: pick(random, best) }, random);
      const after = clone(scenario);
      after.evidence.push(copy);
      after.judged
        .find((j) => j.dimensionId === target.dimensionId)
        ?.citations.push({
          evidenceId: copy.id,
          directness: 'direct',
          specificity: 'exact',
        });
      const report = materialize(after);
      const id = target.dimensionId;
      if (copy.artifactId === source.artifactId) {
        exercised += 1;
        expect(strengthOf(report, id), `seed ${String(seed)}`).toBeLessThanOrEqual(
          strengthOf(before, id),
        );
        expect(confidenceOf(report, id)).toBeLessThanOrEqual(confidenceOf(before, id));
        expect(coverageOf(report, id)).toBe(coverageOf(before, id));
      }
      expect(scoreView(report)).toEqual(scoreView(before));
    }
    expect(exercised).toBeGreaterThan(30);
  });

  it('ten copies of one passage are one source', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const scenario = randomScenario(seed);
      const target = scenario.judged.find((j) => j.score !== null && j.citations.length > 0);
      const source =
        target?.citations[0] &&
        scenario.evidence.find((e) => e.id === target.citations[0]?.evidenceId);
      if (!target || !source || (source.kind !== 'fact' && source.kind !== 'claim')) continue;
      const after = clone(scenario);
      for (let i = 0; i < 10; i += 1) {
        const copy: Ev = { ...source, id: newId() };
        after.evidence.push(copy);
        after.judged
          .find((j) => j.dimensionId === target.dimensionId)
          ?.citations.push({ evidenceId: copy.id, directness: 'direct', specificity: 'exact' });
      }
      const before = materialize(scenario);
      const report = materialize(after);
      expect(strengthOf(report, target.dimensionId)).toBeLessThanOrEqual(
        strengthOf(before, target.dimensionId),
      );
    }
  });
});

describe('P7 / P8: labels never matter', () => {
  it('relabeling every claim changes no score, strength, coverage or confidence', () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const random = seeded(seed + 77);
      const scenario = randomScenario(seed);
      const withClaims = clone(scenario);
      const claimEvidence = withClaims.evidence.slice(0, 3).map((e) => e.id);
      withClaims.claims = [
        { id: uid(1, 'c9000001'), label: 'team_claim', relatesTo: claimEvidence },
        { id: uid(2, 'c9000001'), label: 'team_claim', relatesTo: claimEvidence.slice(0, 1) },
      ];
      const base = materialize(withClaims);
      const relabeled = clone(withClaims);
      for (const claim of relabeled.claims) {
        claim.label = pick(random, [
          'unverified',
          'team_claim',
          'repo_corroborated',
          'machine_verified',
          'judge_verified',
          'live_verified',
        ] as const);
      }
      const report = materialize(relabeled);
      expect(report.dimensions).toEqual(base.dimensions);
      expect(report.criteria).toEqual(base.criteria);
      expect(report.overall).toEqual(base.overall);
    }
  });

  it('relabeling GitHub or deployment evidence to a privileged level never raises strength', () => {
    for (const seed of SEEDS) {
      const scenario = randomScenario(seed);
      const before = materialize(scenario);
      const mutated = clone(scenario);
      // Only relabel items that already carry the anchors the label needs, so provenance (and so
      // grouping) is untouched: this property is about labels alone.
      for (const ev of mutated.evidence) {
        if (
          ev.kind === 'fact' &&
          (ev.origin === 'github' || ev.origin === 'deployment') &&
          ev.artifactId !== null &&
          ev.span !== null
        ) {
          ev.label = 'machine_verified';
        }
      }
      const report = materialize(mutated);
      for (const j of scenario.judged) {
        expect(
          strengthOf(report, j.dimensionId),
          `${j.dimensionId} seed ${String(seed)}`,
        ).toBeLessThanOrEqual(strengthOf(before, j.dimensionId) + 1e-12);
      }
      expect(scoreView(report)).toEqual(scoreView(before));
    }
  });
});

describe('P9 / P10: order independence and no rounding drift', () => {
  it('shuffling the graph insertion order, judgments and citations gives the same report', () => {
    for (const seed of SEEDS) {
      const scenario = randomScenario(seed);
      const a = materialize(scenario);
      const b = materialize(scenario, seeded(seed + 5));
      expect(b).toEqual(a);
    }
  });

  it('criteria and overall derive from UNROUNDED values: they differ from a recomputation off rounded dimensions', () => {
    let drift = 0;
    for (const seed of SEEDS) {
      const scenario = randomScenario(seed);
      const report = materialize(scenario);
      const expected = reference(scenario);
      for (const entry of report.criteria) {
        if (!('score10' in entry)) continue;
        const ref = expected.criterion.get(entry.key);
        if (ref?.score === null || ref === undefined) continue;
        expect(rounds(entry.score10, ref.score)).toBe(true);
        // What a (wrong) pipeline that reused rounded dimension scores would have reported.
        const def = FALLBACK_RUBRIC_DEFINITION.find((d) => d.key === entry.key);
        let num = 0;
        let w = 0;
        for (const dim of def?.dimensions ?? []) {
          const d = report.dimensions.find((x) => x.id === `${entry.key}.${dim.key}`);
          if (d && 'score10' in d) {
            num += dim.weightPercent * d.score10;
            w += dim.weightPercent;
          }
        }
        if (w > 0 && Math.abs(num / w - ref.score) > 0) drift += 1;
      }
    }
    // The generator uses 5-decimal scores, so rounded inputs genuinely differ: the engine does not use them.
    expect(drift).toBeGreaterThan(0);
  });
});

describe('P12: project isolation', () => {
  it("one project's graph never changes another project's report", () => {
    const a = randomScenario(2001);
    const b = randomScenario(2002);
    const alone = materialize(a);
    materialize(b); // B is scored in the same process, between two scorings of A
    const again = materialize(a);
    expect(again).toEqual(alone);
  });
});
