import { buildEventReferenceItems, referenceMetaOf } from '@judge-copilot/assessment';
import type { EventContextLockedSnapshot } from '@judge-copilot/schemas';
import type { ExtractionItemRow } from './extraction-store.js';

/*
 * R4 F8: whether a stored Event-Context extraction is EXACTLY the reference set the locked document defines for the tracks a run
 * declares. The expected set is recomputed here from the pinned locked document (the code-authored `buildEventReferenceItems`); nothing
 * of the extraction is trusted: not its metadata, not its text, not its count. An extraction built for more tracks (over-declared),
 * fewer tracks, other text or other classifications does not match. Used at extraction creation, at binding (before a run may use it)
 * and again by the input reader (defense in depth).
 */

/** Returns null when the extraction matches, otherwise a short reason (no content). */
export function referenceSetMismatch(input: {
  readonly locked: EventContextLockedSnapshot;
  readonly declaredTrackKeys: readonly string[];
  /** The extraction's items in (record type, ordinal) order. */
  readonly items: readonly ExtractionItemRow[];
  /** The stored text of every evidence record the extraction lists. */
  readonly textById: ReadonlyMap<string, string>;
}): string | null {
  const expected = buildEventReferenceItems(input.locked, input.declaredTrackKeys).items;
  const evidence = input.items.filter((item) => item.recordType === 'evidence');
  if (input.items.some((item) => item.recordType !== 'evidence')) return 'not_only_evidence';
  if (evidence.length !== expected.length) return 'member_count';
  for (const [index, item] of evidence.entries()) {
    const want = expected[index];
    if (!want || item.role !== 'event_reference' || !item.reference) return 'member_role';
    const meta = referenceMetaOf(want);
    if (input.textById.get(item.recordId) !== want.text) return `member_text@${String(index)}`;
    if (
      item.reference.kind !== meta.kind ||
      item.reference.applicability !== meta.applicability ||
      item.reference.trackKey !== meta.trackKey
    ) {
      return `member_metadata@${String(index)}`;
    }
  }
  return null;
}
