import type {
  ClaimRecord,
  ContradictionRecord,
  ContradictionSide,
  EvidenceRecord,
  GraphNodeRef,
  RelationRecord,
  UnknownRecord,
} from '@judge-copilot/schemas';
import { compareStrings } from './issues.js';

/*
 * The in-memory evidence graph of loaded records, with the indexes the queries use. Everything is
 * ordered by `seq` (the database insertion sequence), then by ID as a defensive tie-break, with
 * plain string comparison: never database locale, never hash-map iteration order.
 */

export interface EvidenceGraphRecords {
  claims: readonly ClaimRecord[];
  evidence: readonly EvidenceRecord[];
  relations: readonly RelationRecord[];
  unknowns: readonly UnknownRecord[];
  contradictions: readonly ContradictionRecord[];
}

export interface EvidenceGraph {
  readonly claims: ReadonlyMap<string, ClaimRecord>;
  readonly evidence: ReadonlyMap<string, EvidenceRecord>;
  readonly relations: ReadonlyMap<string, RelationRecord>;
  readonly unknowns: ReadonlyMap<string, UnknownRecord>;
  readonly contradictions: ReadonlyMap<string, ContradictionRecord>;
  /** All records, ordered. */
  readonly ordered: {
    readonly claims: readonly ClaimRecord[];
    readonly evidence: readonly EvidenceRecord[];
    readonly relations: readonly RelationRecord[];
    readonly unknowns: readonly UnknownRecord[];
    readonly contradictions: readonly ContradictionRecord[];
  };
  readonly relationsByClaim: ReadonlyMap<string, readonly RelationRecord[]>;
  readonly relationsByEvidence: ReadonlyMap<string, readonly RelationRecord[]>;
  readonly unknownsByClaim: ReadonlyMap<string, readonly UnknownRecord[]>;
  readonly unknownsByEvidence: ReadonlyMap<string, readonly UnknownRecord[]>;
  /** Keyed by `nodeKey` of a contradiction side. */
  readonly contradictionsByNode: ReadonlyMap<string, readonly ContradictionRecord[]>;
  /** Claims whose `supersedesId` is the key. A valid graph has at most one. */
  readonly successorsOf: ReadonlyMap<string, readonly ClaimRecord[]>;
}

export function compareBySeq<T extends { seq: number; id: string }>(a: T, b: T): number {
  return a.seq === b.seq ? compareStrings(a.id, b.id) : a.seq - b.seq;
}

function ordered<T extends { seq: number; id: string }>(records: readonly T[]): T[] {
  return [...records].sort(compareBySeq);
}

function byId<T extends { id: string }>(records: readonly T[]): Map<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

function group<T>(
  records: readonly T[],
  keysOf: (record: T) => readonly string[],
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const record of records) {
    for (const key of new Set(keysOf(record))) {
      const list = result.get(key);
      if (list) list.push(record);
      else result.set(key, [record]);
    }
  }
  return result;
}

export function nodeKey(node: GraphNodeRef | ContradictionSide): string {
  return `${node.type}:${node.id}`;
}

export function buildEvidenceGraph(records: EvidenceGraphRecords): EvidenceGraph {
  const claims = ordered(records.claims);
  const evidence = ordered(records.evidence);
  const relations = ordered(records.relations);
  const unknowns = ordered(records.unknowns);
  const contradictions = ordered(records.contradictions);
  return {
    claims: byId(claims),
    evidence: byId(evidence),
    relations: byId(relations),
    unknowns: byId(unknowns),
    contradictions: byId(contradictions),
    ordered: { claims, evidence, relations, unknowns, contradictions },
    relationsByClaim: group(relations, (relation) => [relation.claimId]),
    relationsByEvidence: group(relations, (relation) => [relation.evidenceId]),
    unknownsByClaim: group(unknowns, (unknown) => unknown.claimIds),
    unknownsByEvidence: group(unknowns, (unknown) => unknown.evidenceIds),
    contradictionsByNode: group(contradictions, (contradiction) => [
      nodeKey(contradiction.sideA),
      nodeKey(contradiction.sideB),
    ]),
    successorsOf: group(
      claims.filter((claim) => claim.supersedesId !== null),
      (claim) => (claim.supersedesId === null ? [] : [claim.supersedesId]),
    ),
  };
}

// -- Contradiction pairs -----------------------------------------------------------------------

/**
 * Canonical order of a contradiction's two sides: by `type:id` with plain string comparison
 * ("claim" sorts before "evidence"; IDs are lowercase hex). The database enforces the same order
 * with a CHECK, so (A, B) and (B, A) can never be two records.
 */
export function canonicalSides(
  a: ContradictionSide,
  b: ContradictionSide,
): [ContradictionSide, ContradictionSide] {
  return compareStrings(nodeKey(a), nodeKey(b)) <= 0 ? [a, b] : [b, a];
}

export function contradictionPairKey(a: ContradictionSide, b: ContradictionSide): string {
  const [first, second] = canonicalSides(a, b);
  return `${nodeKey(first)}|${nodeKey(second)}`;
}

export function relationPairKey(claimId: string, evidenceId: string): string {
  return `${claimId}:${evidenceId}`;
}
