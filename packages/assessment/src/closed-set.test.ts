import { describe, expect, it } from 'vitest';
import { ClosedSetRequiredError } from './closed-set.js';
import {
  gateFidelityCall,
  indexPassages,
  pendingReviews,
  resolveFidelity,
  type AdmittedClaim,
  type AdmittedEvidence,
  type FidelityCall,
} from './extraction.js';
import { gateJudgment } from './judgment.js';
import {
  pairsForVerification,
  resolveVerification,
  combineVerifications,
  gateRelations,
  type RelationWorld,
} from './relations.js';
import { gateContradictions, gateUnknowns, type CommentaryWorld } from './commentary.js';
import { gateClaims, gateEvidence } from './extraction.js';
import { gateCritic } from './critic.js';
import * as stage from './stage.js';
import { withoutCandidates } from './candidates.js';
import { extract } from './testing/pipeline.js';
import { build } from './testing/scoring.js';
import { artifact, hydroTrackArtifacts } from './testing/world.js';
import { buildPassages } from './windowing.js';

/*
 * F1 (P3 review): per-call closed-set enforcement. Every fixture below is a REAL, structurally valid record of the same extraction: the
 * point is that existing in the overall extraction is not enough; only what THIS call's prompt showed may be referenced.
 */

// A Devpost text long enough to need several passages, so "batch A" and "batch B" are real, distinct windows of one extraction.
const LINES = Array.from(
  { length: 160 },
  (_, i) => `Statement number ${String(i)} says the project does something specific and unique.`,
);
const MULTI = [
  artifact({
    sourceType: 'devpost',
    key: 'submission.txt',
    kind: 'submission_text',
    text: `${LINES.join('\n')}\n`,
  }),
  ...hydroTrackArtifacts().slice(1),
];
const { passages } = buildPassages(MULTI);
const index = indexPassages(passages);
const statementPassages = passages.filter((p) => p.route === 'statement');
const interpretPassages = passages.filter((p) => p.route === 'interpret');

const claimsJson = (passage: string, quote: string, ref = 'c1') => ({
  claims: [{ ref, text: quote, passage, quote }],
});
const quoteIn = (handle: string): string => {
  const passage = index.get(handle);
  const line = passage?.text.split('\n').find((l) => l.startsWith('Statement number')) ?? '';
  return line;
};

describe('F1: a passage that exists but was not shown in THIS call', () => {
  const [a, b] = statementPassages;
  if (!a || !b) throw new Error('fixture needs two statement passages');
  const quoteA = quoteIn(a.handle);

  it("ORIGINAL VULNERABILITY: validated against the whole world, the other batch's passage is accepted", () => {
    const everything = stage.validateClaimExtraction(claimsJson(a.handle, quoteA), index, {
      passages: statementPassages.map((p) => p.handle),
    });
    expect(everything.ok && everything.accepted).toHaveLength(1);
  });

  it('CORRECTED: the same output in a call that showed only batch B is rejected as passage_not_shown', () => {
    const result = stage.validateClaimExtraction(claimsJson(a.handle, quoteA), index, {
      passages: [b.handle],
    });
    expect(result.ok && result.accepted).toEqual([]);
    expect(result.ok && result.rejected.map((r) => [r.code, r.handle])).toEqual([
      ['passage_not_shown', a.handle],
    ]);
  });

  it('a valid record of the shown batch still passes', () => {
    const result = stage.validateClaimExtraction(claimsJson(b.handle, quoteIn(b.handle)), index, {
      passages: [b.handle],
    });
    expect(result.ok && result.accepted).toHaveLength(1);
  });

  it('distinguishes a real unshown passage from a nonexistent one', () => {
    const result = stage.validateClaimExtraction(
      {
        claims: [
          { ref: 'c1', text: quoteA, passage: a.handle, quote: quoteA },
          { ref: 'c2', text: quoteA, passage: 'P-9999', quote: quoteA },
        ],
      },
      index,
      { passages: [b.handle] },
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual([
      'passage_not_shown',
      'unknown_passage',
    ]);
  });

  it('applies to evidence interpretation too', () => {
    const [x, y] = interpretPassages;
    if (!x || !y) throw new Error('fixture needs two interpret passages');
    const quote = x.text.split('\n').find((l) => l.trim().length > 12) ?? '';
    const json = { evidence: [{ ref: 'e1', text: quote, passage: x.handle, quote }] };
    expect(
      stage.validateEvidenceInterpretation(json, index, { passages: [x.handle, y.handle] }).ok,
    ).toBe(true);
    const result = stage.validateEvidenceInterpretation(json, index, { passages: [y.handle] });
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual(['passage_not_shown']);
  });

  it("a local ref reused by a different call is not an authorization: handles come from the call's own closed set", () => {
    const first = stage.validateClaimExtraction(claimsJson(a.handle, quoteA, 'c1'), index, {
      passages: [a.handle],
    });
    const accepted = first.ok ? first.accepted : [];
    expect(accepted).toHaveLength(1);
    // call 2 reuses the model-local name "c1" AND the handle of the first call's passage, which call 2 did not show
    const second = stage.validateClaimExtraction(
      claimsJson(a.handle, quoteA, 'c1'),
      index,
      { passages: [b.handle] },
      { existing: accepted },
    );
    expect(second.ok && second.rejected.map((r) => r.code)).toEqual(['passage_not_shown']);
    // and a legitimately shown passage with the same local name yields a DISTINCT claim with the next handle
    const third = stage.validateClaimExtraction(
      claimsJson(b.handle, quoteIn(b.handle), 'c1'),
      index,
      { passages: [b.handle] },
      { existing: accepted },
    );
    expect(third.ok && third.accepted.map((c) => c.handle)).toEqual(['C-002']);
  });
});

describe('F1: relation matching, contradictions and unknowns across batches', () => {
  const ex = extract();
  const world: RelationWorld = ex.relationWorld;
  const commentary: CommentaryWorld = ex.commentaryWorld;
  const claimHandles = [...world.claims.keys()];
  const evidenceHandles = [...world.evidence.keys()];
  const [c1, c2] = claimHandles;
  const fact = ex.evidence[0]?.handle ?? '';
  const otherFact = ex.evidence[1]?.handle ?? '';
  if (!c1 || !c2) throw new Error('fixture');

  it('ORIGINAL VULNERABILITY vs CORRECTED: a real but unshown claim or evidence record is not an authorized relation endpoint', () => {
    const json = { relations: [{ claim: c2, evidence: fact, type: 'supports' }] };
    // the old behavior (the whole world is "shown") admits it
    expect(
      stage.validateRelationMatching(json, world, {
        claims: claimHandles,
        evidence: evidenceHandles,
      }).ok,
    ).toBe(true);
    const unshownClaim = stage.validateRelationMatching(json, world, {
      claims: [c1],
      evidence: evidenceHandles,
    });
    expect(unshownClaim.ok && unshownClaim.rejected.map((r) => r.code)).toEqual([
      'claim_not_shown',
    ]);
    const unshownEvidence = stage.validateRelationMatching(json, world, {
      claims: claimHandles,
      evidence: [otherFact],
    });
    expect(unshownEvidence.ok && unshownEvidence.rejected.map((r) => r.code)).toEqual([
      'evidence_not_shown',
    ]);
    const shown = stage.validateRelationMatching(json, world, { claims: [c2], evidence: [fact] });
    expect(shown.ok && shown.accepted).toHaveLength(1);
  });

  it('keeps unknown (nonexistent) distinct from real-but-unshown', () => {
    const result = stage.validateRelationMatching(
      {
        relations: [
          { claim: 'C-099', evidence: fact, type: 'supports' },
          { claim: c2, evidence: fact, type: 'supports' },
        ],
      },
      world,
      { claims: [c1], evidence: [fact] },
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual([
      'unknown_claim',
      'claim_not_shown',
    ]);
  });

  it('a contradiction side from another batch is rejected', () => {
    const json = {
      contradictions: [
        {
          sideA: { type: 'claim', handle: c2 },
          sideB: { type: 'evidence', handle: fact },
          description: 'The README and the code differ on offline mode.',
        },
      ],
    };
    expect(
      stage.validateContradictions(json, commentary, {
        claims: claimHandles,
        evidence: evidenceHandles,
      }).ok,
    ).toBe(true);
    const a = stage.validateContradictions(json, commentary, {
      claims: [c1],
      evidence: evidenceHandles,
    });
    expect(a.ok && a.rejected.map((r) => r.code)).toEqual(['side_not_shown']);
    const b = stage.validateContradictions(json, commentary, {
      claims: claimHandles,
      evidence: [otherFact],
    });
    expect(b.ok && b.rejected.map((r) => r.code)).toEqual(['side_not_shown']);
  });

  it('an unknown that references records of another batch is rejected', () => {
    const json = {
      unknowns: [
        {
          unknownType: 'unverifiable',
          text: 'Whether reminders fire on time cannot be checked.',
          claims: [c2],
          evidence: [fact],
        },
      ],
    };
    expect(
      stage.validateUnknowns(json, commentary, { claims: claimHandles, evidence: evidenceHandles })
        .ok,
    ).toBe(true);
    const a = stage.validateUnknowns(json, commentary, { claims: [c1], evidence: evidenceHandles });
    expect(a.ok && a.rejected.map((r) => r.code)).toEqual(['claim_not_shown']);
    const b = stage.validateUnknowns(json, commentary, {
      claims: claimHandles,
      evidence: [otherFact],
    });
    expect(b.ok && b.rejected.map((r) => r.code)).toEqual(['evidence_not_shown']);
  });
});

describe('F1: fidelity verdicts are per batch', () => {
  const ex = extract();
  // three pending paraphrases: two claims and one fact
  const pendingClaims: AdmittedClaim[] = ex.claims.map((c) => ({
    ...c,
    grounding: 'pending_review',
  }));
  const pendingEvidence: AdmittedEvidence[] = ex.evidence
    .slice(0, 1)
    .map((e) => ({ ...e, grounding: 'pending_review' }));
  const pending = pendingReviews(pendingClaims, pendingEvidence);
  const [h1, h2, h3] = pending.map((p) => p.handle);
  if (!h1 || !h2 || !h3) throw new Error('fixture');

  it('ORIGINAL VULNERABILITY vs CORRECTED: a verdict about a real pending item of ANOTHER batch is item_not_shown and admits nothing', () => {
    const forged = stage.validateFidelityReview(
      {
        verdicts: [
          { item: h1, verdict: 'faithful' },
          { item: h3, verdict: 'faithful' },
        ],
      },
      { items: [h3] },
      pending,
    );
    expect(forged.ok && forged.call.verdicts).toEqual([{ item: h3, verdict: 'faithful' }]);
    expect(forged.ok && forged.issues.map((i) => [i.code, i.handle])).toEqual([
      ['item_not_shown', h1],
    ]);
    // resolving with that call: h1 was never answered by a call that showed it, so it takes the downgrade path
    const callA: FidelityCall = { shown: [h1, h2], verdicts: [{ item: h2, verdict: 'faithful' }] };
    const callB = forged.ok ? forged.call : { shown: [], verdicts: [] };
    const result = resolveFidelity(pendingClaims, pendingEvidence, [callA, callB]);
    expect(result.claims.find((c) => c.handle === h1)?.grounding).toBe('exact_text');
    expect(result.dispositions.find((d) => d.handle === h1)?.disposition).toBe(
      'paraphrase_replaced_by_verbatim',
    );
    expect(result.claims.find((c) => c.handle === h2)?.grounding).toBe(
      'paraphrase_reviewed_faithful',
    );
  });

  it("a forged FidelityCall cannot smuggle a verdict: resolveFidelity re-checks every verdict against its own call's shown set", () => {
    const forged: FidelityCall = {
      shown: [h2],
      verdicts: [
        { item: h1, verdict: 'faithful' },
        { item: h2, verdict: 'faithful' },
      ],
    };
    const result = resolveFidelity(pendingClaims, pendingEvidence, [forged]);
    expect(result.issues.map((i) => [i.code, i.handle])).toContainEqual(['item_not_shown', h1]);
    expect(result.claims.find((c) => c.handle === h1)?.grounding).toBe('exact_text');
  });

  it('an item never shown by any call is never admitted as a paraphrase', () => {
    const result = resolveFidelity(pendingClaims, pendingEvidence, []);
    expect(result.issues.map((i) => i.code)).toEqual([
      'never_reviewed',
      'never_reviewed',
      'never_reviewed',
    ]);
    expect(result.claims.every((c) => c.grounding === 'exact_text')).toBe(true);
  });

  it('an item that is not pending at all is unknown, not merely unshown', () => {
    const call = gateFidelityCall(
      { verdicts: [{ item: 'C-099', verdict: 'faithful' }] },
      { items: [h1] },
      pending,
    );
    expect(call.issues.map((i) => i.code)).toEqual(['unknown_item', 'missing_verdict']);
  });

  it('valid shown verdicts across two batches resolve every item', () => {
    const a = gateFidelityCall(
      {
        verdicts: [
          { item: h1, verdict: 'faithful' },
          { item: h2, verdict: 'overstated' },
        ],
      },
      { items: [h1, h2] },
      pending,
    );
    const b = gateFidelityCall(
      { verdicts: [{ item: h3, verdict: 'faithful' }] },
      { items: [h3] },
      pending,
    );
    expect(a.issues).toEqual([]);
    expect(b.issues).toEqual([]);
    const result = resolveFidelity(pendingClaims, pendingEvidence, [a.call, b.call]);
    expect(result.issues).toEqual([]);
    expect(result.dispositions.map((d) => d.disposition)).toEqual([
      'paraphrase_reviewed_faithful',
      'paraphrase_replaced_by_verbatim',
      'paraphrase_reviewed_faithful',
    ]);
  });
});

describe('F1: relation verification is per batch', () => {
  const ex = extract();
  const proposed = [
    {
      claim: 'C-001',
      evidence: ex.evidence[0]?.handle ?? '',
      type: 'supports' as const,
      basis: 'independent_observation' as const,
    },
    {
      claim: 'C-002',
      evidence: ex.evidence[0]?.handle ?? '',
      type: 'supports' as const,
      basis: 'independent_observation' as const,
    },
    {
      claim: 'C-001',
      evidence: ex.evidence[1]?.handle ?? '',
      type: 'supports' as const,
      basis: 'independent_observation' as const,
    },
  ];
  const pairs = pairsForVerification(proposed, ex.relationWorld);

  it('ORIGINAL VULNERABILITY vs CORRECTED: a verdict for a real pair of another batch is pair_not_shown and cannot keep that relation', () => {
    const callB = stage.validateRelationVerification(
      {
        verdicts: [
          { pair: 'X-001', verdict: 'supports' },
          { pair: 'X-003', verdict: 'supports' },
        ],
      },
      pairs,
      { pairs: ['X-003'] },
    );
    expect(callB.ok && callB.issues.map((i) => [i.code, i.handle])).toEqual([
      ['pair_not_shown', 'X-001'],
    ]);
    expect(callB.ok && callB.judged).toEqual(['X-003']);
    expect(callB.ok && callB.kept.map((r) => r.evidence)).toEqual([ex.evidence[1]?.handle]);
    // batch A's own call never verified X-001 / X-002: after combining, they are dropped, not kept
    const callA = stage.validateRelationVerification(
      { verdicts: [{ pair: 'X-002', verdict: 'supports' }] },
      pairs,
      { pairs: ['X-001', 'X-002'] },
    );
    const combined = combineVerifications(pairs, [
      callA.ok ? callA : emptyResolution(),
      callB.ok ? callB : emptyResolution(),
    ]);
    expect(combined.kept.map((r) => r.claim + r.evidence)).toEqual(
      [proposed[1], proposed[2]].map((r) => (r?.claim ?? '') + (r?.evidence ?? '')),
    );
    expect(combined.dropped.map((d) => [d.pair, d.reason])).toEqual([['X-001', 'verdict_missing']]);
  });

  it('a pair that no call ever showed is dropped, never kept', () => {
    const combined = combineVerifications(pairs, []);
    expect(combined.kept).toEqual([]);
    expect(combined.dropped).toHaveLength(3);
    expect(combined.issues.map((i) => i.code)).toEqual([
      'never_verified',
      'never_verified',
      'never_verified',
    ]);
  });

  it('a conflicting verdict from a second call that also showed the pair wins over a keep (conservative)', () => {
    const keep = stage.validateRelationVerification(
      { verdicts: [{ pair: 'X-001', verdict: 'supports' }] },
      pairs,
      { pairs: ['X-001'] },
    );
    const drop = stage.validateRelationVerification(
      { verdicts: [{ pair: 'X-001', verdict: 'unrelated' }] },
      pairs,
      { pairs: ['X-001'] },
    );
    const combined = combineVerifications(pairs.slice(0, 1), [
      keep.ok ? keep : emptyResolution(),
      drop.ok ? drop : emptyResolution(),
    ]);
    expect(combined.kept).toEqual([]);
  });

  it('valid shown verdicts pass', () => {
    const call = stage.validateRelationVerification(
      { verdicts: pairs.map((p) => ({ pair: p.handle, verdict: 'supports' })) },
      pairs,
      { pairs: pairs.map((p) => p.handle) },
    );
    expect(call.ok && call.kept).toHaveLength(3);
  });

  it('resolveVerification judges only the pairs it was shown', () => {
    const only = resolveVerification(
      pairs,
      { verdicts: [{ pair: 'X-002', verdict: 'supports' }] },
      { pairs: ['X-002'] },
    );
    expect(only.judged).toEqual(['X-002']);
    expect(only.dropped).toEqual([]);
  });
});

function emptyResolution() {
  return { kept: [], dropped: [], issues: [], judged: [] };
}

describe('F1: assessor and critic closed sets', () => {
  const built = build();
  const unit = built.units[0];
  if (!unit) throw new Error('fixture');
  const first = unit.items[0]?.handle ?? '';
  const second = unit.items[1]?.handle ?? '';
  const scale = { min: 0, max: 10 };
  const output = (handle: string, dimensionId = unit.dimensionId) => ({
    dimensionId,
    outcome: { kind: 'scored', score: 6 },
    citations: [{ evidence: handle, directness: 'direct', specificity: 'exact', note: 'cited' }],
    rationale: 'Supported by the cited record.',
    limitations: [],
  });
  const codes = (json: unknown, u = unit, shown: { evidence: readonly string[]; unit: string }) => {
    const r = stage.validateDimensionAssessment(json, u, scale, shown);
    return r.ok ? [] : r.phase === 'shape' ? ['shape'] : r.issues.map((i) => i.code);
  };

  it('ORIGINAL VULNERABILITY vs CORRECTED: a candidate that is in the unit but was NOT in the prompt is not citable', () => {
    const everything = { evidence: unit.items.map((i) => i.handle), unit: unit.dimensionId };
    expect(codes(output(second), unit, everything)).toEqual([]);
    // the prompt showed only the first candidate (for example after the others were removed for a re-run)
    expect(codes(output(second), unit, { evidence: [first], unit: unit.dimensionId })).toEqual([
      'citation_not_shown',
    ]);
    expect(codes(output(first), unit, { evidence: [first], unit: unit.dimensionId })).toEqual([]);
  });

  it('a re-run unit built with withoutCandidates and the ORIGINAL unit object cannot be used to cite a removed item', () => {
    const reduced = withoutCandidates(unit, [second]);
    const shownByRerun = { evidence: reduced.items.map((i) => i.handle), unit: unit.dimensionId };
    expect(codes(output(second), reduced, shownByRerun)).toEqual(['unknown_citation_handle']);
    // the bypass: validating against the original (un-reduced) unit while the prompt showed the reduced set
    expect(codes(output(second), unit, shownByRerun)).toEqual(['citation_not_shown']);
  });

  it('a judgment must be about the unit the prompt asked about', () => {
    const shown = { evidence: unit.items.map((i) => i.handle), unit: 'official.usability' };
    expect(codes(output(first), unit, shown)).toEqual(['wrong_dimension']);
    expect(codes(output(first, 'official.usability'), unit, shown)).toEqual(['wrong_dimension']);
  });

  it('the critic may name only handles its own call showed, for the unit it was asked about', () => {
    const finding = {
      code: 'unsupported_judgment',
      severity: 'blocking',
      evidence: [second],
      note: 'Not supported by the record.',
    };
    const json = { unit: unit.dimensionId, findings: [finding] };
    expect(
      stage.validateCritic(json, { unit: unit.dimensionId, evidence: [first, second] }).ok,
    ).toBe(true);
    const narrow = stage.validateCritic(json, { unit: unit.dimensionId, evidence: [first] });
    expect('issues' in narrow ? narrow.issues.map((i) => i.code) : []).toEqual([
      'unknown_evidence_handle',
    ]);
    const wrongUnit = stage.validateCritic(json, {
      unit: 'official.usability',
      evidence: [first, second],
    });
    expect('issues' in wrongUnit && wrongUnit.issues.map((i) => i.code)).toEqual(['wrong_unit']);
  });

  it('valid shown records continue to pass', () => {
    const r = stage.validateDimensionAssessment(output(first), unit, scale, {
      evidence: unit.items.map((i) => i.handle),
      unit: unit.dimensionId,
    });
    expect(r.ok).toBe(true);
  });
});

describe('F1: the closed set cannot be omitted or malformed', () => {
  const ex = extract();
  const built = build();
  const unit = built.units[0];
  if (!unit) throw new Error('fixture');
  const bypass = (call: () => unknown) => () => {
    expect(call).toThrow(ClosedSetRequiredError);
  };
  const omitted = undefined as never;

  it('every gate and wrapper throws, never validating against the world, when the closed set is missing', () => {
    const claim = claimsJson('P-0001', 'Statement number 1 says something unique.');
    bypass(() => gateClaims({ claims: claim.claims }, index, omitted))();
    bypass(() => gateEvidence({ evidence: [] }, index, omitted))();
    bypass(() => gateFidelityCall({ verdicts: [] }, omitted, []))();
    bypass(() => gateRelations({ relations: [] }, ex.relationWorld, omitted))();
    bypass(() => resolveVerification([], { verdicts: [] }, omitted))();
    bypass(() => gateContradictions({ contradictions: [] }, ex.commentaryWorld, omitted))();
    bypass(() => gateUnknowns({ unknowns: [] }, ex.commentaryWorld, omitted))();
    bypass(() =>
      gateJudgment(
        {
          dimensionId: unit.dimensionId,
          outcome: { kind: 'insufficient_evidence' },
          citations: [],
          rationale: 'x',
          limitations: [],
        },
        unit,
        { min: 0, max: 10 },
        omitted,
      ),
    )();
    bypass(() => gateCritic({ unit: unit.dimensionId, findings: [] }, omitted))();
    // the wrappers (which run the strict schema first) behave the same
    bypass(() => stage.validateClaimExtraction({ claims: [] }, index, omitted))();
    bypass(() => stage.validateRelationMatching({ relations: [] }, ex.relationWorld, omitted))();
    bypass(() =>
      stage.validateDimensionAssessment(
        {
          dimensionId: unit.dimensionId,
          outcome: { kind: 'insufficient_evidence' },
          citations: [],
          rationale: 'x',
          limitations: [],
        },
        unit,
        { min: 0, max: 10 },
        omitted,
      ),
    )();
    bypass(() => stage.validateCritic({ unit: unit.dimensionId, findings: [] }, omitted))();
  });

  it('a closed set with a missing, non-array or non-string field is refused, not treated as empty or as everything', () => {
    for (const bad of [
      {},
      { passages: 'P-0001' },
      { passages: [1, 2] },
      { passages: null },
      null,
      'P-0001',
    ]) {
      expect(() => gateClaims({ claims: [] }, index, bad as never)).toThrow(ClosedSetRequiredError);
    }
    expect(() =>
      gateCritic({ unit: unit.dimensionId, findings: [] }, { evidence: [], unit: null }),
    ).toThrow(ClosedSetRequiredError);
    expect(() =>
      gateJudgment(
        {
          dimensionId: unit.dimensionId,
          outcome: { kind: 'insufficient_evidence' },
          citations: [],
          rationale: 'x',
          limitations: [],
        },
        unit,
        { min: 0, max: 10 },
        { evidence: [] } as never,
      ),
    ).toThrow(ClosedSetRequiredError);
  });

  it('an EMPTY closed set is legitimate and shows nothing: every reference is rejected', () => {
    const [a] = statementPassages;
    const result = stage.validateClaimExtraction(
      claimsJson(a?.handle ?? '', quoteIn(a?.handle ?? '')),
      index,
      { passages: [] },
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual(['passage_not_shown']);
  });
});
