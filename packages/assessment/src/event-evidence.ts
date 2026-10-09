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

export interface EventReferenceItem {
  /** Batch-local ref (stable: kind + ordinal). */
  readonly ref: string;
  readonly kind: EventReferenceKind;
  /** The declared track this item concerns, or null for the overall submission. */
  readonly trackKey: string | null;
  readonly text: string;
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
  const add = (kind: EventReferenceKind, trackKey: string | null, raw: string) => {
    const built = usable(raw);
    if (built === 'empty' || built === 'too_long') {
      exclusions.push({ kind, code: built });
      return;
    }
    counters[kind] += 1;
    items.push({
      ref: `ctx-${kind.replaceAll('_', '-')}-${String(counters[kind])}`,
      kind,
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
      track.key,
      track.description ? `${track.name}: ${track.description}` : track.name,
    );
  }
  for (const rule of document.rules) {
    if (rule.certainty !== 'explicit') {
      exclusions.push({ kind: 'rule', code: 'not_explicit' });
      continue;
    }
    add('rule', null, rule.statement);
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
    add('submission_requirement', requirement.trackKey, requirement.statement);
  }
  return { contextVersionId: locked.versionId, items, exclusions };
}
