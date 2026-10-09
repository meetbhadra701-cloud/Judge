import type {
  ContradictionDetectionOutput,
  ContradictionSideType,
  ModelUnknownType,
  UnknownIdentificationOutput,
} from '@judge-copilot/schemas';
import { shownHandles, type ClosedSet } from './closed-set.js';
import type { GateOutcome } from './extraction.js';
import type { Rejection } from './issues.js';
import { containsAccusation } from './neutral.js';

/*
 * Gates G4 (contradictions) and G5 (unknowns), design §4.6. Both carry model COMMENTARY for a human judge, so both pass the
 * neutral-language screen (invariant 25). `missing` unknowns are code-authored only (see source-gaps.ts); the output schema already
 * excludes the type and this module refuses it again.
 */

export const MAX_CONTRADICTIONS_PER_RUN = 20;
export const MAX_UNKNOWNS_PER_RUN = 20;

export interface CommentaryWorld {
  readonly claims: ReadonlySet<string>;
  readonly evidence: ReadonlySet<string>;
  /** Statement item handle -> the claims it is the statement of. */
  readonly statementOf: ReadonlyMap<string, readonly string[]>;
}

export interface ProposedContradiction {
  readonly sideA: { readonly type: ContradictionSideType; readonly handle: string };
  readonly sideB: { readonly type: ContradictionSideType; readonly handle: string };
  readonly description: string;
}

const sideKey = (side: { type: string; handle: string }): string => `${side.type}:${side.handle}`;

/** G4. */
export function gateContradictions(
  output: ContradictionDetectionOutput,
  world: CommentaryWorld,
  shown: Pick<ClosedSet, 'claims' | 'evidence'>,
  existing: readonly ProposedContradiction[] = [],
): GateOutcome<ProposedContradiction> {
  const shownClaims = shownHandles(shown, 'claims');
  const shownEvidence = shownHandles(shown, 'evidence');
  const accepted: ProposedContradiction[] = [];
  const rejected: Rejection[] = [];
  const pairs = new Set(existing.map((c) => [sideKey(c.sideA), sideKey(c.sideB)].sort().join('|')));
  output.contradictions.forEach((item, index) => {
    const code = ((): string | null => {
      for (const side of [item.sideA, item.sideB]) {
        const present =
          side.type === 'claim' ? world.claims.has(side.handle) : world.evidence.has(side.handle);
        if (!present) return 'unknown_side';
        // a real record that THIS call did not show cannot be a side of a contradiction found in it
        const wasShown =
          side.type === 'claim' ? shownClaims.has(side.handle) : shownEvidence.has(side.handle);
        if (!wasShown) return 'side_not_shown';
      }
      if (sideKey(item.sideA) === sideKey(item.sideB)) return 'same_side';
      // A claim and its own statement item are the same words: they cannot contradict each other.
      for (const [a, b] of [
        [item.sideA, item.sideB],
        [item.sideB, item.sideA],
      ] as const) {
        if (
          a.type === 'claim' &&
          b.type === 'evidence' &&
          world.statementOf.get(b.handle)?.includes(a.handle)
        ) {
          return 'own_statement_item';
        }
      }
      if (containsAccusation(item.description)) return 'accusatory_language';
      const key = [sideKey(item.sideA), sideKey(item.sideB)].sort().join('|');
      if (pairs.has(key)) return 'duplicate_contradiction';
      if (existing.length + accepted.length >= MAX_CONTRADICTIONS_PER_RUN) return 'over_cap';
      pairs.add(key);
      return null;
    })();
    if (code !== null) {
      rejected.push({ gate: 'G4', code, index, handle: item.sideA.handle });
      return;
    }
    accepted.push({ sideA: item.sideA, sideB: item.sideB, description: item.description });
  });
  return { accepted, rejected };
}

export interface ProposedUnknown {
  readonly unknownType: ModelUnknownType;
  readonly text: string;
  readonly claims: readonly string[];
  readonly evidence: readonly string[];
}

/** G5. */
export function gateUnknowns(
  output: UnknownIdentificationOutput,
  world: CommentaryWorld,
  shown: Pick<ClosedSet, 'claims' | 'evidence'>,
  existing: readonly ProposedUnknown[] = [],
): GateOutcome<ProposedUnknown> {
  const shownClaims = shownHandles(shown, 'claims');
  const shownEvidence = shownHandles(shown, 'evidence');
  const accepted: ProposedUnknown[] = [];
  const rejected: Rejection[] = [];
  output.unknowns.forEach((item, index) => {
    const code = ((): string | null => {
      if ((item.unknownType as string) === 'missing') return 'missing_is_code_authored';
      if (item.claims.some((handle) => !world.claims.has(handle))) return 'unknown_claim';
      if (item.evidence.some((handle) => !world.evidence.has(handle))) return 'unknown_evidence';
      if (item.claims.some((handle) => !shownClaims.has(handle))) return 'claim_not_shown';
      if (item.evidence.some((handle) => !shownEvidence.has(handle))) return 'evidence_not_shown';
      if (new Set(item.claims).size !== item.claims.length) return 'duplicate_reference';
      if (new Set(item.evidence).size !== item.evidence.length) return 'duplicate_reference';
      if (containsAccusation(item.text)) return 'accusatory_language';
      if (existing.length + accepted.length >= MAX_UNKNOWNS_PER_RUN) return 'over_cap';
      return null;
    })();
    if (code !== null) {
      rejected.push({ gate: 'G5', code, index });
      return;
    }
    accepted.push({
      unknownType: item.unknownType,
      text: item.text,
      claims: item.claims,
      evidence: item.evidence,
    });
  });
  return { accepted, rejected };
}
