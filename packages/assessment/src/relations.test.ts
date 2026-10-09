import { describe, expect, it } from 'vitest';
import { pairsForVerification, resolveVerification } from './relations.js';
import {
  validateContradictions,
  validateRelationMatching,
  validateRelationVerification,
  validateUnknowns,
} from './testing/calls.js';
import { extract } from './testing/pipeline.js';

const ex = extract();
const statementOf = (claim: string) =>
  ex.statements.find((s) => s.claimHandles.includes(claim))?.handle ?? '';
const FACT = ex.evidence[0]?.handle ?? '';

function relationOutput(
  items: { claim: string; evidence: string; type: 'supports' | 'contradicts' }[],
) {
  return { relations: items };
}
function accepted<T>(result: { ok: boolean } & Partial<{ accepted: readonly T[] }>): readonly T[] {
  if (!result.ok || result.accepted === undefined)
    throw new Error(`rejected: ${JSON.stringify(result)}`);
  return result.accepted;
}

describe('G3: relation matching', () => {
  it('admits a relation to an interpreted fact as independent_observation', () => {
    const [relation] = accepted(
      validateRelationMatching(
        relationOutput([{ claim: 'C-001', evidence: FACT, type: 'supports' }]),
        ex.relationWorld,
      ),
    );
    expect(relation).toEqual({
      claim: 'C-001',
      evidence: FACT,
      type: 'supports',
      basis: 'independent_observation',
    });
  });

  it("records agreement with another claim's statement as team_restatement, not independent", () => {
    const other = statementOf('C-002');
    const [relation] = accepted(
      validateRelationMatching(
        relationOutput([{ claim: 'C-001', evidence: other, type: 'supports' }]),
        ex.relationWorld,
      ),
    );
    expect(relation?.basis).toBe('team_restatement');
  });

  it("rejects unknown handles, a claim's OWN statement item, duplicates, conflicts and kind violations", () => {
    const own = statementOf('C-001');
    const result = validateRelationMatching(
      relationOutput([
        { claim: 'C-009', evidence: FACT, type: 'supports' },
        { claim: 'C-001', evidence: 'E-099', type: 'supports' },
        { claim: 'C-001', evidence: own, type: 'supports' },
        { claim: 'C-001', evidence: FACT, type: 'supports' },
        { claim: 'C-001', evidence: FACT, type: 'supports' },
        { claim: 'C-001', evidence: FACT, type: 'contradicts' },
      ]),
      ex.relationWorld,
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual([
      'unknown_claim',
      'unknown_evidence',
      'own_statement_item',
      'duplicate_relation',
      'conflicting_relation',
    ]);
    expect(result.ok && result.accepted).toHaveLength(1);
  });

  it('rejects a relation to evidence whose kind cannot take part (missing evidence is not negative evidence)', () => {
    const world = {
      ...ex.relationWorld,
      evidence: new Map([
        ...ex.relationWorld.evidence,
        [
          'E-050',
          {
            handle: 'E-050',
            kind: 'absence' as unknown as 'fact',
            text: 'x',
            excerpt: 'x',
            statementOf: [],
          },
        ],
      ]),
    };
    const result = validateRelationMatching(
      relationOutput([{ claim: 'C-001', evidence: 'E-050', type: 'supports' }]),
      world,
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual(['relation_kind_not_allowed']);
  });

  it('caps relations per claim at five', () => {
    const evidence = new Map(
      Array.from({ length: 8 }, (_, i) => {
        const handle = `E-${String(60 + i).padStart(3, '0')}`;
        return [
          handle,
          {
            handle,
            kind: 'fact' as const,
            text: `fact ${String(i)}`,
            excerpt: `fact ${String(i)}`,
            statementOf: [] as string[],
          },
        ] as const;
      }),
    );
    const world = { claims: ex.relationWorld.claims, evidence };
    const items = [...evidence.keys()].map((handle) => ({
      claim: 'C-001',
      evidence: handle,
      type: 'supports' as const,
    }));
    const result = validateRelationMatching(relationOutput(items), world);
    expect(result.ok && result.accepted).toHaveLength(5);
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual([
      'too_many_relations_for_claim',
      'too_many_relations_for_claim',
      'too_many_relations_for_claim',
    ]);
  });

  it('refuses a model-supplied relation basis or id (strict)', () => {
    const result = validateRelationMatching(
      {
        relations: [
          { claim: 'C-001', evidence: FACT, type: 'supports', basis: 'source_statement' },
        ],
      },
      ex.relationWorld,
    );
    expect(result.ok).toBe(false);
  });
});

describe('G3b: relation verification', () => {
  const proposed = accepted(
    validateRelationMatching(
      relationOutput([
        { claim: 'C-001', evidence: FACT, type: 'supports' },
        { claim: 'C-002', evidence: FACT, type: 'contradicts' },
      ]),
      ex.relationWorld,
    ),
  );
  const pairs = pairsForVerification(proposed, ex.relationWorld);

  it("shows the verifier each pair alone with code-assigned handles and the evidence's exact quote", () => {
    expect(pairs.map((p) => p.handle)).toEqual(['X-001', 'X-002']);
    expect(pairs[0]?.claim).toContain('HydroTrack sends a reminder');
    expect(pairs[0]?.evidenceQuote).toContain('RangeError');
  });

  it('keeps a relation only when the verdict equals the proposed type', () => {
    const result = validateRelationVerification(
      {
        verdicts: [
          { pair: 'X-001', verdict: 'supports' },
          { pair: 'X-002', verdict: 'contradicts' },
        ],
      },
      pairs,
    );
    expect(result.ok && result.kept).toHaveLength(2);
    expect(result.ok && result.dropped).toEqual([]);
  });

  it.each([
    ['unrelated', 'verifier_unrelated'],
    ['cannot_tell', 'verifier_cannot_tell'],
    ['contradicts', 'verifier_opposite'],
  ] as const)(
    'drops and RECORDS a %s verdict, and never turns it into a contradiction',
    (verdict, reason) => {
      const result = validateRelationVerification(
        {
          verdicts: [
            { pair: 'X-001', verdict },
            { pair: 'X-002', verdict: 'contradicts' },
          ],
        },
        pairs,
      );
      expect(result.ok && result.dropped.map((d) => [d.pair, d.reason])).toEqual([
        ['X-001', reason],
      ]);
      expect(result.ok && result.kept.map((r) => r.claim)).toEqual(['C-002']);
      // the result has no contradiction anywhere
      expect(JSON.stringify(result)).not.toContain('sideA');
    },
  );

  it('drops a missing or duplicated verdict and flags the protocol violation', () => {
    const result = resolveVerification(
      pairs,
      {
        verdicts: [
          { pair: 'X-001', verdict: 'supports' },
          { pair: 'X-001', verdict: 'supports' },
          { pair: 'X-077', verdict: 'supports' },
        ],
      },
      { pairs: pairs.map((p) => p.handle) },
    );
    expect(result.dropped.map((d) => [d.pair, d.reason])).toEqual([
      ['X-001', 'verdict_duplicated'],
      ['X-002', 'verdict_missing'],
    ]);
    expect(result.issues.map((i) => i.code).sort()).toEqual([
      'duplicate_verdict',
      'missing_verdict',
      'unknown_pair',
    ]);
  });

  it('a verifier that answers supports to everything cannot raise anything: it can only confirm a proposal', () => {
    const result = resolveVerification(
      pairs,
      {
        verdicts: [
          { pair: 'X-001', verdict: 'supports' },
          { pair: 'X-002', verdict: 'supports' },
        ],
      },
      { pairs: pairs.map((p) => p.handle) },
    );
    expect(result.kept.map((r) => [r.claim, r.type])).toEqual([['C-001', 'supports']]); // X-002 proposed contradicts
  });
});

describe('G4: contradictions', () => {
  const sides = (
    a: string,
    b: string,
    aType: 'claim' | 'evidence' = 'claim',
    bType: 'claim' | 'evidence' = 'evidence',
  ) => ({
    sideA: { type: aType, handle: a },
    sideB: { type: bType, handle: b },
  });
  const out = (...items: ReturnType<typeof sides>[]) => ({
    contradictions: items.map((s) => ({
      ...s,
      description: 'The README says offline, but the handler calls a remote API.',
    })),
  });

  it('admits a neutral contradiction between a claim and a fact', () => {
    const result = validateContradictions(out(sides('C-002', FACT)), ex.commentaryWorld);
    expect(result.ok && result.accepted).toHaveLength(1);
  });

  it('rejects unknown sides, identical sides, a claim against its own statement, accusations, duplicates (either order)', () => {
    const own = statementOf('C-001');
    const accuse = {
      contradictions: [
        { ...sides('C-001', FACT), description: 'They cheated on the offline claim.' },
      ],
    };
    const result = validateContradictions(
      {
        contradictions: [
          ...out(sides('C-009', FACT)).contradictions,
          ...out(sides('C-001', 'C-001', 'claim', 'claim')).contradictions,
          ...out(sides('C-001', own)).contradictions,
          ...accuse.contradictions,
          ...out(sides('C-001', FACT)).contradictions,
          ...out(sides(FACT, 'C-001', 'evidence', 'claim')).contradictions,
        ],
      },
      ex.commentaryWorld,
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual([
      'unknown_side',
      'same_side',
      'own_statement_item',
      'accusatory_language',
      'duplicate_contradiction',
    ]);
    expect(result.ok && result.accepted).toHaveLength(1);
  });

  it('shape: a mismatched handle prefix is a schema failure', () => {
    const bad = {
      contradictions: [
        {
          sideA: { type: 'claim', handle: 'E-001' },
          sideB: { type: 'claim', handle: 'C-001' },
          description: 'neutral difference',
        },
      ],
    };
    expect(validateContradictions(bad, ex.commentaryWorld).ok).toBe(false);
  });
});

describe('G5: unknowns', () => {
  const unknown = (extra: Record<string, unknown> = {}) => ({
    unknowns: [
      {
        unknownType: 'unverifiable',
        text: 'Whether the reminder fires on time cannot be checked from the material.',
        claims: ['C-001'],
        evidence: [FACT],
        ...extra,
      },
    ],
  });

  it('admits a typed unknown with known references', () => {
    expect(validateUnknowns(unknown(), ex.commentaryWorld).ok).toBe(true);
    const result = validateUnknowns(unknown(), ex.commentaryWorld);
    expect(result.ok && result.accepted).toHaveLength(1);
  });

  it('refuses a model-written missing unknown at the schema (absence is code-authored)', () => {
    expect(validateUnknowns(unknown({ unknownType: 'missing' }), ex.commentaryWorld).ok).toBe(
      false,
    );
  });

  it('rejects unknown references, duplicate references and accusatory text', () => {
    const result = validateUnknowns(
      {
        unknowns: [
          ...unknown({ claims: ['C-040'] }).unknowns,
          ...unknown({ evidence: ['E-077'] }).unknowns,
          ...unknown({ claims: ['C-001', 'C-001'] }).unknowns,
          ...unknown({ text: 'It is plagiarized, so nothing can be verified.' }).unknowns,
        ],
      },
      ex.commentaryWorld,
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual([
      'unknown_claim',
      'unknown_evidence',
      'duplicate_reference',
      'accusatory_language',
    ]);
  });
});
