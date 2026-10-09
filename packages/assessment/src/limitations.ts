import type { EventContextLockedSnapshot } from '@judge-copilot/schemas';
import type { FidelityDisposition } from './extraction.js';
import type { Rejection } from './issues.js';
import type { DroppedRelation } from './relations.js';
import type { WindowingResult } from './windowing.js';

/*
 * Limitations (design §4.5 rule 7, §5.1, §9.3): everything the judge must be told about what the assessment did NOT see or did not
 * admit, as stable codes with counts and code-assigned handles. Built from the structured records of the earlier steps only; no
 * source text and no model text can enter a limitation. Dropping information in the optimistic direction (a contradiction or a
 * relation) is disclosed, never silent.
 */

export const EXTRACTION_LIMITATION_CODES = [
  'source_sampled',
  'item_rejected',
  'paraphrase_replaced_by_verbatim',
  'claim_dropped_unfaithful',
  'evidence_text_replaced_by_verbatim',
  'evidence_dropped_unfaithful',
  'relation_dropped_by_verifier',
  'contradiction_rejected',
  'unknown_rejected',
  'official_track_rubrics_not_assessed',
] as const;
export type ExtractionLimitationCode = (typeof EXTRACTION_LIMITATION_CODES)[number];

export interface Limitation {
  readonly code: ExtractionLimitationCode;
  readonly count: number;
  /** Code-assigned handles, rubric names or artifact keys (never model or source prose). */
  readonly subjects: readonly string[];
}

export interface LimitationInputs {
  readonly windowing?: WindowingResult;
  readonly fidelity?: readonly {
    readonly handle: string;
    readonly disposition: FidelityDisposition;
  }[];
  readonly rejections?: readonly Rejection[];
  readonly droppedRelations?: readonly DroppedRelation[];
  readonly locked?: EventContextLockedSnapshot;
}

const FIDELITY_LIMITATIONS: Partial<Record<FidelityDisposition, ExtractionLimitationCode>> = {
  paraphrase_replaced_by_verbatim: 'paraphrase_replaced_by_verbatim',
  claim_dropped_unfaithful: 'claim_dropped_unfaithful',
  evidence_text_replaced_by_verbatim: 'evidence_text_replaced_by_verbatim',
  evidence_dropped_unfaithful: 'evidence_dropped_unfaithful',
};

/** Names of the official TRACK rubrics of a locked context: they are not assessed in this milestone (D9: overall target only). */
export function unassessedTrackRubrics(locked: EventContextLockedSnapshot): string[] {
  return locked.document.rubrics
    .filter((rubric) => rubric.scope === 'track')
    .map((rubric) => rubric.name)
    .sort();
}

export function collectLimitations(inputs: LimitationInputs): Limitation[] {
  const buckets = new Map<ExtractionLimitationCode, string[]>();
  const add = (code: ExtractionLimitationCode, subject: string) => {
    const list = buckets.get(code);
    if (list) list.push(subject);
    else buckets.set(code, [subject]);
  };
  for (const bucket of inputs.windowing?.buckets ?? []) {
    if (bucket.sampled) add('source_sampled', bucket.bucket);
  }
  for (const entry of inputs.fidelity ?? []) {
    const code = FIDELITY_LIMITATIONS[entry.disposition];
    if (code) add(code, entry.handle);
  }
  for (const rejection of inputs.rejections ?? []) {
    if (rejection.gate === 'G4') add('contradiction_rejected', rejection.code);
    else if (rejection.gate === 'G5') add('unknown_rejected', rejection.code);
    else add('item_rejected', `${rejection.gate}:${rejection.code}`);
  }
  for (const dropped of inputs.droppedRelations ?? [])
    add('relation_dropped_by_verifier', dropped.pair);
  if (inputs.locked) {
    for (const name of unassessedTrackRubrics(inputs.locked))
      add('official_track_rubrics_not_assessed', name);
  }
  return EXTRACTION_LIMITATION_CODES.flatMap((code) => {
    const subjects = buckets.get(code);
    return subjects
      ? [{ code, count: subjects.length, subjects: [...new Set(subjects)].sort() }]
      : [];
  });
}
