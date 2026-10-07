import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_KIND_VALUES,
  EVIDENCE_ORIGIN_VALUES,
  UNKNOWN_TYPE_VALUES,
  VERIFICATION_LEVEL_VALUES,
} from './enums.js';
import {
  ClaimInput,
  ContradictionInput,
  EVIDENCE_GRAPH_LIMITS,
  EVIDENCE_RELATION_TYPE_VALUES,
  EvidenceGraphBatchInput,
  EvidenceItemInput,
  EvidenceRelationInput,
  GRAPH_NODE_TYPE_VALUES,
  GraphRef,
  UnknownInput,
  normalizeClaimText,
  normalizeGraphText,
} from './evidence-graph.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('graph vocabularies', () => {
  it('reuses the architecture vocabularies and adds only supports/contradicts', () => {
    expect([...EVIDENCE_RELATION_TYPE_VALUES]).toEqual(['supports', 'contradicts']);
    expect([...GRAPH_NODE_TYPE_VALUES]).toEqual(['claim', 'evidence', 'unknown', 'contradiction']);
  });

  it('accepts every verification level, kind, origin and unknown type, and nothing else', () => {
    for (const verificationLevel of VERIFICATION_LEVEL_VALUES) {
      expect(ClaimInput.safeParse({ ref: 'c', text: 'x', verificationLevel }).success).toBe(true);
    }
    expect(
      ClaimInput.safeParse({ ref: 'c', text: 'x', verificationLevel: 'verified' }).success,
    ).toBe(false);
    for (const kind of EVIDENCE_KIND_VALUES) {
      for (const origin of EVIDENCE_ORIGIN_VALUES) {
        expect(
          EvidenceItemInput.safeParse({
            ref: 'e',
            kind,
            origin,
            verificationLevel: 'unverified',
            text: 't',
          }).success,
        ).toBe(true);
      }
    }
    expect(
      EvidenceItemInput.safeParse({
        ref: 'e',
        kind: 'opinion',
        origin: 'github',
        verificationLevel: 'unverified',
        text: 't',
      }).success,
    ).toBe(false);
    expect(
      EvidenceItemInput.safeParse({
        ref: 'e',
        kind: 'fact',
        origin: 'twitter',
        verificationLevel: 'unverified',
        text: 't',
      }).success,
    ).toBe(false);
    for (const unknownType of UNKNOWN_TYPE_VALUES) {
      expect(UnknownInput.safeParse({ unknownType, text: 't' }).success).toBe(true);
    }
    expect(UnknownInput.safeParse({ unknownType: 'bad', text: 't' }).success).toBe(false);
    for (const type of EVIDENCE_RELATION_TYPE_VALUES) {
      expect(
        EvidenceRelationInput.safeParse({ claim: { ref: 'c' }, evidence: { ref: 'e' }, type })
          .success,
      ).toBe(true);
    }
    expect(
      EvidenceRelationInput.safeParse({
        claim: { ref: 'c' },
        evidence: { ref: 'e' },
        type: 'weakens',
      }).success,
    ).toBe(false);
  });
});

describe('creation inputs never let a producer choose persisted IDs or provenance', () => {
  it('rejects an id, createdAt, actor, seq, origin override or score smuggled into any record', () => {
    for (const extra of [
      { id: ID },
      { createdAt: '2026-01-01T00:00:00Z' },
      { createdByActorId: ID },
      { seq: 1 },
      { projectId: ID },
      { score: 9 },
      { confidence: 0.9 },
      { weight: 1 },
    ]) {
      expect(
        ClaimInput.safeParse({ ref: 'c', text: 'x', verificationLevel: 'unverified', ...extra })
          .success,
        JSON.stringify(extra),
      ).toBe(false);
      expect(
        EvidenceItemInput.safeParse({
          ref: 'e',
          kind: 'fact',
          origin: 'github',
          verificationLevel: 'unverified',
          text: 't',
          ...extra,
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
      expect(
        UnknownInput.safeParse({ unknownType: 'missing', text: 't', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('keeps accusation, penalty and score fields out of contradictions', () => {
    const valid = {
      sideA: { type: 'claim', ref: 'a' },
      sideB: { type: 'claim', ref: 'b' },
      description: 'The README and the deployment differ.',
    };
    expect(ContradictionInput.safeParse(valid).success).toBe(true);
    for (const extra of [
      { isCheating: true },
      { cheating: true },
      { fraud: true },
      { penalty: 2 },
      { severity: 'high' },
      { score: -3 },
      { accusation: 'fraud' },
    ]) {
      expect(
        ContradictionInput.safeParse({ ...valid, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('rejects an id inside a ref position that also names a ref, and malformed refs', () => {
    expect(GraphRef.safeParse({ ref: 'c1' }).success).toBe(true);
    expect(GraphRef.safeParse({ id: ID }).success).toBe(true);
    expect(GraphRef.safeParse({ ref: 'c1', id: ID }).success).toBe(false);
    expect(GraphRef.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
    expect(GraphRef.safeParse({ ref: 'C1' }).success).toBe(false);
    expect(GraphRef.safeParse({ ref: '1c' }).success).toBe(false);
    expect(GraphRef.safeParse({ ref: 'x'.repeat(65) }).success).toBe(false);
  });

  it('canonicalizes UUIDs to lowercase so the same ID always compares equal', () => {
    expect(GraphRef.parse({ id: ID.toUpperCase() })).toEqual({ id: ID });
  });

  it('treats a well-formed UUID as merely well-formed: existence is decided elsewhere', () => {
    expect(GraphRef.safeParse({ id: 'deadbeef-dead-4ead-8ead-deadbeefdead' }).success).toBe(true);
  });
});

describe('bounds and normalization', () => {
  const claim = (text: string) =>
    ClaimInput.safeParse({ ref: 'c', text, verificationLevel: 'unverified' });

  it('bounds text and refuses empty, control and malformed text', () => {
    expect(claim('x'.repeat(EVIDENCE_GRAPH_LIMITS.claimTextMaxChars)).success).toBe(true);
    expect(claim('x'.repeat(EVIDENCE_GRAPH_LIMITS.claimTextMaxChars + 1)).success).toBe(false);
    expect(claim('   ').success).toBe(false);
    expect(claim('').success).toBe(false);
    expect(claim('null\u0000byte').success).toBe(false);
    expect(claim('bell\u0007').success).toBe(false);
    expect(claim('lone \ud800 surrogate').success).toBe(false);
    expect(claim('fine 🚀 emoji').success).toBe(true);
  });

  it('normalizes deterministically: NFC, trimmed, claims on a single line', () => {
    expect(normalizeGraphText('  é\r\nline  ')).toBe('é\nline');
    expect(normalizeClaimText('  The   API\n\tworks.  ')).toBe('The API works.');
    expect(claim('  The   API\n works. ').data?.text).toBe('The API works.');
    expect(normalizeGraphText(normalizeGraphText('  a\r\nb '))).toBe('a\nb');
  });

  it('bounds evidence spans, collection sizes and the batch', () => {
    expect(
      UnknownInput.safeParse({
        unknownType: 'missing',
        text: 't',
        claims: Array.from({ length: 51 }, () => ({ id: ID })),
      }).success,
    ).toBe(false);
    expect(EvidenceGraphBatchInput.safeParse({}).success).toBe(false); // must create something
    expect(
      EvidenceGraphBatchInput.safeParse({
        claims: Array.from({ length: 101 }, (_, i) => ({
          ref: `c${String(i)}`,
          text: 'x',
          verificationLevel: 'unverified',
        })),
      }).success,
    ).toBe(false);
    expect(
      EvidenceGraphBatchInput.safeParse({
        claims: [{ ref: 'c', text: 'x', verificationLevel: 'unverified' }],
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      EvidenceItemInput.safeParse({
        ref: 'e',
        kind: 'fact',
        origin: 'github',
        verificationLevel: 'unverified',
        text: 't',
        provenance: { span: { start: -1, end: 3 } },
      }).success,
    ).toBe(false);
  });

  it('applies defaults without letting a batch be silently empty', () => {
    const parsed = EvidenceGraphBatchInput.parse({
      unknowns: [{ unknownType: 'missing', text: 'gap' }],
    });
    expect(parsed.claims).toEqual([]);
    expect(parsed.unknowns[0]).toMatchObject({ claims: [], evidence: [] });
  });
});
