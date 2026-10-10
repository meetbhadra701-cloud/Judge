import { describe, expect, it } from 'vitest';
import {
  assertPairSet,
  combineVerifications,
  PairSetError,
  pairsForVerification,
  resolveVerification,
  type ProposedRelation,
  type VerificationPair,
  type VerificationResolution,
} from './relations.js';
import { extract } from './testing/pipeline.js';

/*
 * A2 (R3): pair handles are unique over the WHOLE verification set, every result is tied to the pair's identity (handle AND content) and
 * to the call's shown set, and combining never relies on object identity. A forged or stale result can neither keep nor drop anything.
 */

const ex = extract();
const relation = (claim: string, evidence: string): ProposedRelation => ({
  claim,
  evidence,
  type: 'supports',
  basis: 'independent_observation',
});
const e0 = ex.evidence[0]?.handle ?? '';
const e1 = ex.evidence[1]?.handle ?? '';
const batchA = [relation('C-001', e0), relation('C-002', e0)];
const batchB = [relation('C-001', e1), relation('C-002', e1)];
const all = pairsForVerification([...batchA, ...batchB], ex.relationWorld);
const handles = all.map((p) => p.handle);
const supports = (pair: string) => ({ pair, verdict: 'supports' as const });
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const call = (pairs: readonly VerificationPair[], verdicts: string[], shown: string[]) =>
  resolveVerification(pairs, { verdicts: verdicts.map(supports) }, { pairs: shown });

describe('A2: one numbering over the whole verification set', () => {
  it('the full set is numbered X-001..X-004 once; batches are slices of it', () => {
    expect(handles).toEqual(['X-001', 'X-002', 'X-003', 'X-004']);
    expect(new Set(all.map((p) => p.identity)).size).toBe(4);
  });

  it('ORIGINAL VULNERABILITY: batches numbered separately both start at X-001; the ambiguous set is refused before any verdict is read', () => {
    const colliding = [
      ...pairsForVerification(batchA, ex.relationWorld),
      ...pairsForVerification(batchB, ex.relationWorld),
    ];
    expect(colliding.map((p) => p.handle)).toEqual(['X-001', 'X-002', 'X-001', 'X-002']);
    expect(() => {
      assertPairSet(colliding);
    }).toThrow(PairSetError);
    expect(() => combineVerifications(colliding, [])).toThrow(PairSetError);
    expect(() => call(colliding, ['X-001'], ['X-001'])).toThrow(PairSetError);
    try {
      combineVerifications(colliding, []);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'duplicate_handle', handle: 'X-001' });
    }
  });

  it('a pair whose content no longer matches its identity is refused', () => {
    const tampered = all.map((p, i) => (i === 1 ? { ...p, claim: 'Other words entirely.' } : p));
    expect(() => {
      assertPairSet(tampered);
    }).toThrow(PairSetError);
    expect(() => combineVerifications(tampered, [])).toThrow(PairSetError);
    const swapped = all.map((p, i) =>
      i === 0 ? { ...p, relation: { ...p.relation, type: 'contradicts' as const } } : p,
    );
    expect(() => {
      assertPairSet(swapped);
    }).toThrow(PairSetError);
  });

  it('there is no way to restart numbering (no first-number parameter)', () => {
    expect(pairsForVerification.length).toBe(2);
  });
});

describe('A2: results are tied to the exact pair and to the call that showed it', () => {
  const callA = call(all, ['X-001', 'X-002'], ['X-001', 'X-002']);
  const callB = call(all, ['X-003'], ['X-003', 'X-004']); // X-004: shown, no verdict

  it('multiple batches combine; a shown pair without a verdict is dropped, a never-shown pair is dropped', () => {
    const combined = combineVerifications(all, [callA, callB]);
    expect(combined.keptPairs.map((p) => p.pair)).toEqual(['X-001', 'X-002', 'X-003']);
    expect(combined.dropped.map((d) => [d.pair, d.reason])).toEqual([['X-004', 'verdict_missing']]);
    const none = combineVerifications(all, [callA]);
    expect(none.kept).toHaveLength(2);
    expect(none.dropped.map((d) => d.pair)).toEqual(['X-003', 'X-004']);
    expect(none.issues.map((i) => i.code)).toContain('never_verified');
  });

  it('JSON-round-tripped resolutions combine exactly like the originals (no object identity)', () => {
    const direct = combineVerifications(all, [callA, callB]);
    const trip = combineVerifications(all, [json(callA), json(callB)]);
    expect(json(trip)).toEqual(json(direct));
    // and the relations returned are the set's own, not the resolution's copies
    expect(trip.kept[0]).toBe(all[0]?.relation);
  });

  it('missing verifier responses (a call that returned nothing) keep nothing', () => {
    expect(combineVerifications(all, []).kept).toEqual([]);
    const empty: VerificationResolution = {
      kept: [],
      keptPairs: [],
      dropped: [],
      issues: [],
      judged: [],
    };
    expect(combineVerifications(all, [empty, empty]).kept).toEqual([]);
  });

  it('cross-batch verdict reuse: a result produced for a different pair under the same handle cannot keep this one', () => {
    // the same handle X-001 once stood for a different relation (another run, another set)
    const otherSet = pairsForVerification(
      [relation('C-002', e1), relation('C-001', e0)],
      ex.relationWorld,
    );
    const stale = call(otherSet, ['X-001'], ['X-001']);
    expect(stale.keptPairs.map((p) => p.pair)).toEqual(['X-001']);
    const combined = combineVerifications(all, [json(stale)]);
    expect(combined.kept).toEqual([]);
    expect(combined.issues.map((i) => i.code)).toContain('resolution_pair_mismatch');
  });

  it('a forged resolution with a matching handle but no identity, or the wrong one, is ignored', () => {
    const forged: VerificationResolution = {
      kept: [],
      keptPairs: [{ pair: 'X-001', identity: 'f'.repeat(64) }],
      dropped: [],
      issues: [],
      judged: [{ pair: 'X-001', identity: 'f'.repeat(64) }],
    };
    const result = combineVerifications(all, [forged]);
    expect(result.kept).toEqual([]);
    expect(result.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['resolution_pair_mismatch', 'never_verified']),
    );
    const noIdentity = json(forged) as unknown as { keptPairs: { identity?: string }[] };
    for (const ref of noIdentity.keptPairs) delete ref.identity;
    expect(
      combineVerifications(all, [noIdentity as unknown as VerificationResolution]).kept,
    ).toEqual([]);
  });

  it('a keep that the same call never judged (a forged keep) is ignored', () => {
    const first = all[0];
    if (!first) throw new Error('fixture');
    const forged: VerificationResolution = {
      kept: [],
      keptPairs: [{ pair: first.handle, identity: first.identity }],
      dropped: [],
      issues: [],
      judged: [],
    };
    const result = combineVerifications(all, [forged]);
    expect(result.kept).toEqual([]);
    expect(result.issues.map((i) => i.code)).toContain('kept_without_judgment');
  });

  it('conservative drop wins: one call keeps, another call that showed the pair drops it', () => {
    const drop = resolveVerification(
      all,
      { verdicts: [{ pair: 'X-001', verdict: 'unrelated' }] },
      { pairs: ['X-001'] },
    );
    const combined = combineVerifications(all, [callA, drop]);
    expect(combined.kept.map((r) => r.evidence + r.claim)).not.toContain(e0 + 'C-001');
    expect(combined.dropped.map((d) => d.pair)).toContain('X-001');
  });

  it('a verdict for a pair the call did not show remains pair_not_shown', () => {
    const only = call(all, ['X-001', 'X-003'], ['X-003']);
    expect(only.issues.map((i) => [i.code, i.handle])).toEqual([['pair_not_shown', 'X-001']]);
    expect(only.keptPairs.map((p) => p.pair)).toEqual(['X-003']);
  });
});
