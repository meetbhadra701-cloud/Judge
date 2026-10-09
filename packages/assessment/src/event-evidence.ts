import {
  EVIDENCE_GRAPH_LIMITS,
  isStorableGraphText,
  normalizeGraphText,
  type EventContextLockedSnapshot,
} from '@judge-copilot/schemas';
import { codePointCount } from './text.js';

/*
 * Event-Context REFERENCE evidence (design §4.7, D8). A model-free builder: only the following locked-document items become
 * evidence, reproduced as the locked words (NFC, graph-text normalized):
 *
 *   - each DECLARED track's definition (name and description);
 *   - rules and submission requirements whose certainty is `explicit` and that apply to the overall submission or to a declared track.
 *
 * `interpreted` and `unclear` statements are excluded and counted. These items say what the EVENT requires; they say nothing about
 * what the PROJECT does, so they are labelled `unverified`, carry version-level provenance only, and the judgment gates (G6) accept a
 * citation of one only as `indirect` / `generic` context. Citing them alone can never support a score (judgment.ts).
 */

export const EVENT_REFERENCE_BUILDER = 'event-reference/v1' as const;

export type EventReferenceKind = 'track_definition' | 'rule' | 'submission_requirement';

/**
 * What an Event-Context reference item IS, decided by code from the locked document (never by a model, never by a rule's wording):
 *   declared_track_definition   the name/description of a DECLARED track: the track's theme. It is not a requirement.
 *   track_specific_requirement  an EXPLICIT submission requirement tied to a DECLARED track.
 *   overall_rule                an EXPLICIT rule, or an explicit requirement with no track, that applies to every submission.
 */
export const REFERENCE_APPLICABILITY_VALUES = [
  'declared_track_definition',
  'track_specific_requirement',
  'overall_rule',
] as const;
export type EventReferenceApplicability = (typeof REFERENCE_APPLICABILITY_VALUES)[number];

export interface EventReferenceItem {
  /** Batch-local ref (stable: kind + ordinal). */
  readonly ref: string;
  readonly kind: EventReferenceKind;
  readonly applicability: EventReferenceApplicability;
  /** The declared track this item concerns, or null for the overall submission. */
  readonly trackKey: string | null;
  readonly text: string;
}

/**
 * The code-authored metadata of a reference item, keyed by the evidence record that carries its text. It is what lets a later step
 * decide applicability WITHOUT trusting a model's claim that a rule applies, and it is persisted with the extraction (P4).
 */
export interface EventReferenceMeta {
  readonly builder: typeof EVENT_REFERENCE_BUILDER;
  readonly kind: EventReferenceKind;
  readonly applicability: EventReferenceApplicability;
  readonly trackKey: string | null;
}

export const referenceMetaOf = (item: EventReferenceItem): EventReferenceMeta => ({
  builder: EVENT_REFERENCE_BUILDER,
  kind: item.kind,
  applicability: item.applicability,
  trackKey: item.trackKey,
});

/** Maps each planned/persisted reference evidence record (by its batch ref) to the metadata of the item it was built from. */
export function referenceMetaByEvidenceId(
  evidence: readonly { readonly id: string; readonly ref: string }[],
  items: readonly EventReferenceItem[],
): ReadonlyMap<string, EventReferenceMeta> {
  const byRef = new Map(items.map((item) => [item.ref, referenceMetaOf(item)]));
  const map = new Map<string, EventReferenceMeta>();
  for (const record of evidence) {
    const meta = byRef.get(record.ref);
    if (meta) map.set(record.id, meta);
  }
  return map;
}

export interface EventReferenceExclusion {
  readonly kind: EventReferenceKind;
  readonly code: 'not_explicit' | 'not_applicable_track' | 'too_long' | 'empty';
}

export interface EventReferenceResult {
  readonly contextVersionId: string;
  readonly items: readonly EventReferenceItem[];
  readonly exclusions: readonly EventReferenceExclusion[];
}

function usable(text: string): { text: string } | 'empty' | 'too_long' {
  const normalized = normalizeGraphText(text);
  if (normalized.length === 0 || !isStorableGraphText(normalized)) return 'empty';
  if (codePointCount(normalized) > EVIDENCE_GRAPH_LIMITS.evidenceTextMaxChars) return 'too_long';
  return { text: normalized };
}

export function buildEventReferenceItems(
  locked: EventContextLockedSnapshot,
  declaredTrackKeys: readonly string[],
): EventReferenceResult {
  const declared = new Set(declaredTrackKeys);
  const items: EventReferenceItem[] = [];
  const exclusions: EventReferenceExclusion[] = [];
  const counters: Record<EventReferenceKind, number> = {
    track_definition: 0,
    rule: 0,
    submission_requirement: 0,
  };
  const add = (
    kind: EventReferenceKind,
    applicability: EventReferenceApplicability,
    trackKey: string | null,
    raw: string,
  ) => {
    const built = usable(raw);
    if (built === 'empty' || built === 'too_long') {
      exclusions.push({ kind, code: built });
      return;
    }
    counters[kind] += 1;
    items.push({
      ref: `ctx-${kind.replaceAll('_', '-')}-${String(counters[kind])}`,
      kind,
      applicability,
      trackKey,
      text: built.text,
    });
  };

  const { document } = locked;
  for (const track of document.tracks) {
    if (!declared.has(track.key)) {
      exclusions.push({ kind: 'track_definition', code: 'not_applicable_track' });
      continue;
    }
    add(
      'track_definition',
      'declared_track_definition',
      track.key,
      track.description ? `${track.name}: ${track.description}` : track.name,
    );
  }
  for (const rule of document.rules) {
    if (rule.certainty !== 'explicit') {
      exclusions.push({ kind: 'rule', code: 'not_explicit' });
      continue;
    }
    add('rule', 'overall_rule', null, rule.statement);
  }
  for (const requirement of document.submissionRequirements) {
    if (requirement.trackKey !== null && !declared.has(requirement.trackKey)) {
      exclusions.push({ kind: 'submission_requirement', code: 'not_applicable_track' });
      continue;
    }
    if (requirement.certainty !== 'explicit') {
      exclusions.push({ kind: 'submission_requirement', code: 'not_explicit' });
      continue;
    }
    add(
      'submission_requirement',
      requirement.trackKey === null ? 'overall_rule' : 'track_specific_requirement',
      requirement.trackKey,
      requirement.statement,
    );
  }
  return { contextVersionId: locked.versionId, items, exclusions };
}
