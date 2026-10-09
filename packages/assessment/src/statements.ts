import {
  EVIDENCE_GRAPH_LIMITS,
  isStorableGraphText,
  normalizeGraphText,
} from '@judge-copilot/schemas';
import type { AdmittedClaim, AdmittedEvidence } from './extraction.js';
import { evidenceHandle, handleNumber } from './handles.js';
import type { LocatedQuote } from './quote.js';
import type { RoutedSourceType } from './routing.js';
import { codePointCount } from './text.js';

/*
 * Citable team statements (design §4.2). M4 scores EVIDENCE ids, never claim ids, so a Devpost or README sentence is citable only
 * if it exists as an EvidenceItem. For every admitted claim code builds, in the same batch:
 *
 *   Claim            the assertion (text = verbatim or a reviewed paraphrase), label team_claim
 *   EvidenceItem     kind=claim, label team_claim, text = the VERBATIM quote (never the paraphrase), provenance from the located quote
 *   EvidenceRelation `supports` (claim -> that item), authored by code, basis `source_statement`
 *
 * The relation records that the statement EXISTS at that source. It is not corroboration and not truth: independent support is a
 * separate, model-proposed and independently verified relation of another basis. Several claims quoting the same words relate to
 * ONE item (one distinct (artifact, span) is one item), so M4's provenance grouping counts it once.
 */

export interface StatementItem {
  readonly handle: string;
  readonly sourceType: RoutedSourceType;
  readonly located: LocatedQuote;
  /** Verbatim words, normalized as graph text (the excerpt itself stays exact in the provenance). */
  readonly text: string;
  /** The claims this item is the statement of, in claim order. */
  readonly claimHandles: readonly string[];
}

export interface StatementResult {
  readonly items: readonly StatementItem[];
  /** Claims that could not get a statement item (their words cannot stand as evidence text) and are therefore not admitted. */
  readonly unstatable: readonly string[];
}

const spanKey = (located: LocatedQuote): string =>
  `${located.artifactId}\u0000${String(located.start)}\u0000${String(located.end)}`;

/** Handles continue after the highest evidence handle already used by interpreted evidence. */
export function buildStatementItems(
  claims: readonly AdmittedClaim[],
  interpreted: readonly AdmittedEvidence[],
): StatementResult {
  let counter = interpreted.reduce(
    (highest, item) => Math.max(highest, handleNumber(item.handle)),
    0,
  );
  const byKey = new Map<string, { item: StatementItem; claims: string[] }>();
  const order: string[] = [];
  const unstatable: string[] = [];
  for (const claim of claims) {
    const key = spanKey(claim.located);
    const existing = byKey.get(key);
    if (existing) {
      existing.claims.push(claim.handle);
      continue;
    }
    const text = normalizeGraphText(claim.located.excerpt);
    if (
      text.length === 0 ||
      codePointCount(text) > EVIDENCE_GRAPH_LIMITS.evidenceTextMaxChars ||
      !isStorableGraphText(text)
    ) {
      unstatable.push(claim.handle);
      continue;
    }
    counter += 1;
    byKey.set(key, {
      item: {
        handle: evidenceHandle(counter),
        sourceType: claim.sourceType,
        located: claim.located,
        text,
        claimHandles: [],
      },
      claims: [claim.handle],
    });
    order.push(key);
  }
  const items = order.flatMap((key) => {
    const entry = byKey.get(key);
    return entry ? [{ ...entry.item, claimHandles: entry.claims }] : [];
  });
  return { items, unstatable };
}
