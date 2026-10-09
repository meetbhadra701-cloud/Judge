import {
  type EvidenceRelationType,
  type RelationMatchingOutput,
  type RelationVerificationOutput,
} from '@judge-copilot/schemas';
import { relationKindProblem } from '@judge-copilot/evidence';
import { pairHandle } from './handles.js';
import { issue, type DomainIssue, type Rejection } from './issues.js';
import type { GateOutcome } from './extraction.js';

/*
 * Gates G3 (relation matching) and G3b (relation verification), design §4.5 rule 4, §4.6.
 *
 * A model-proposed relation is a CANDIDATE. It reaches the graph only if an independent verifier call, shown just the pair, returns
 * the very verdict that was proposed. A relation that fails is DROPPED AND RECORDED; it is never turned into a contradiction (the
 * absence of support is not contradiction), and a model that disagrees with itself is not evidence of anything.
 */

export const MAX_RELATIONS_PER_CLAIM = 5;
export const MAX_RELATIONS_PER_RUN = 100;

/** How a kept relation is explained to the judge. `source_statement` is code-authored (see statements.ts). */
export type RelationBasis = 'source_statement' | 'independent_observation' | 'team_restatement';

export interface RelationClaim {
  readonly handle: string;
  readonly text: string;
}

export interface RelationEvidence {
  readonly handle: string;
  readonly kind: 'claim' | 'fact';
  readonly text: string;
  readonly excerpt: string;
  /** For a statement item: the claims it is the statement of (a claim never relates to its own statement item). */
  readonly statementOf: readonly string[];
}

export interface RelationWorld {
  readonly claims: ReadonlyMap<string, RelationClaim>;
  readonly evidence: ReadonlyMap<string, RelationEvidence>;
}

export interface ProposedRelation {
  readonly claim: string;
  readonly evidence: string;
  readonly type: EvidenceRelationType;
  readonly basis: Exclude<RelationBasis, 'source_statement'>;
}

/** G3. */
export function gateRelations(
  output: RelationMatchingOutput,
  world: RelationWorld,
  existing: readonly ProposedRelation[] = [],
): GateOutcome<ProposedRelation> {
  const accepted: ProposedRelation[] = [];
  const rejected: Rejection[] = [];
  const pairs = new Map<string, EvidenceRelationType>(
    existing.map((relation) => [`${relation.claim}|${relation.evidence}`, relation.type]),
  );
  const perClaim = new Map<string, number>();
  for (const relation of existing)
    perClaim.set(relation.claim, (perClaim.get(relation.claim) ?? 0) + 1);

  output.relations.forEach((item, index) => {
    const code = ((): string | null => {
      const claim = world.claims.get(item.claim);
      if (!claim) return 'unknown_claim';
      const evidence = world.evidence.get(item.evidence);
      if (!evidence) return 'unknown_evidence';
      if (evidence.statementOf.includes(claim.handle)) return 'own_statement_item';
      if (relationKindProblem(item.type, evidence.kind) !== null)
        return 'relation_kind_not_allowed';
      const key = `${item.claim}|${item.evidence}`;
      const previous = pairs.get(key);
      if (previous !== undefined)
        return previous === item.type ? 'duplicate_relation' : 'conflicting_relation';
      if (existing.length + accepted.length >= MAX_RELATIONS_PER_RUN) return 'over_cap';
      if ((perClaim.get(item.claim) ?? 0) >= MAX_RELATIONS_PER_CLAIM)
        return 'too_many_relations_for_claim';
      pairs.set(key, item.type);
      perClaim.set(item.claim, (perClaim.get(item.claim) ?? 0) + 1);
      return null;
    })();
    if (code !== null) {
      rejected.push({ gate: 'G3', code, index, handle: item.claim });
      return;
    }
    const evidence = world.evidence.get(item.evidence);
    accepted.push({
      claim: item.claim,
      evidence: item.evidence,
      type: item.type,
      // Agreement between two statements of the team is a restatement; only a fact from another authorship class is observation.
      basis: evidence?.kind === 'claim' ? 'team_restatement' : 'independent_observation',
    });
  });
  return { accepted, rejected };
}

/** What the verifier is shown for one pair; `handle` is the code-assigned pair handle. */
export interface VerificationPair {
  readonly handle: string;
  readonly relation: ProposedRelation;
  readonly claim: string;
  readonly evidence: string;
  readonly evidenceQuote: string;
}

export function pairsForVerification(
  relations: readonly ProposedRelation[],
  world: RelationWorld,
  firstNumber = 1,
): VerificationPair[] {
  return relations.map((relation, index) => {
    const claim = world.claims.get(relation.claim);
    const evidence = world.evidence.get(relation.evidence);
    if (!claim || !evidence)
      throw new Error('internal: a verified relation names an unknown record');
    return {
      handle: pairHandle(firstNumber + index),
      relation,
      claim: claim.text,
      evidence: evidence.text,
      evidenceQuote: evidence.excerpt,
    };
  });
}

export const RELATION_DROP_REASON_VALUES = [
  'verifier_unrelated',
  'verifier_cannot_tell',
  'verifier_opposite',
  'verdict_missing',
  'verdict_duplicated',
] as const;
export type RelationDropReason = (typeof RELATION_DROP_REASON_VALUES)[number];

export interface DroppedRelation {
  readonly pair: string;
  readonly reason: RelationDropReason;
  readonly relation: ProposedRelation;
}

export interface VerificationResolution {
  readonly kept: readonly ProposedRelation[];
  /** Recorded as `relation_dropped_by_verifier`. Never a contradiction. */
  readonly dropped: readonly DroppedRelation[];
  readonly issues: readonly DomainIssue[];
}

/** G3b. */
export function resolveVerification(
  pairs: readonly VerificationPair[],
  output: RelationVerificationOutput,
): VerificationResolution {
  const issues: DomainIssue[] = [];
  const known = new Set(pairs.map((pair) => pair.handle));
  const verdicts = new Map<string, string[]>();
  output.verdicts.forEach((entry, index) => {
    if (!known.has(entry.pair)) {
      issues.push(issue('G3b', 'unknown_pair', `verdicts[${String(index)}].pair`, entry.pair));
      return;
    }
    const list = verdicts.get(entry.pair);
    if (list) list.push(entry.verdict);
    else verdicts.set(entry.pair, [entry.verdict]);
  });
  const kept: ProposedRelation[] = [];
  const dropped: DroppedRelation[] = [];
  for (const pair of pairs) {
    const list = verdicts.get(pair.handle);
    let reason: RelationDropReason | null = null;
    if (!list) reason = 'verdict_missing';
    else if (list.length > 1) reason = 'verdict_duplicated';
    else if (list[0] === pair.relation.type) reason = null;
    else if (list[0] === 'unrelated') reason = 'verifier_unrelated';
    else if (list[0] === 'cannot_tell') reason = 'verifier_cannot_tell';
    else reason = 'verifier_opposite';
    if (reason === null) kept.push(pair.relation);
    else {
      dropped.push({ pair: pair.handle, reason, relation: pair.relation });
      if (reason === 'verdict_missing')
        issues.push(issue('G3b', 'missing_verdict', 'verdicts', pair.handle));
      if (reason === 'verdict_duplicated')
        issues.push(issue('G3b', 'duplicate_verdict', 'verdicts', pair.handle));
    }
  }
  return { kept, dropped, issues };
}
