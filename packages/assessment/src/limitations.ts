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
  // Coverage of the selected evidence (source-selection/v2): what exists in the captured repository but was NOT shown to any model stage.
  // Each is a fact about the selection; none says anything about the project. See ARCHITECTURE.md "Evidence coverage".
  'no_implementation_shown',
  'implementation_components_unseen',
  'implementation_partially_seen',
  'documentation_partially_seen',
  'configuration_partially_seen',
  'tests_partially_seen',
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

const SUBJECT_CAP = 25;
const unfinished = (status: string): boolean => status === 'partial' || status === 'unseen';

/** The coverage concerns as limitations, with the components or artifacts concerned (a bounded, sorted list; `count` is the true total). */
function addCoverage(
  windowing: WindowingResult,
  add: (code: ExtractionLimitationCode, subject: string) => void,
): void {
  const { components, artifacts, concerns } = windowing.coverage;
  const keys = (pick: (a: (typeof artifacts)[number]) => boolean): string[] =>
    artifacts.filter(pick).map((a) => a.artifactKey);
  const subjectsOf: Record<(typeof concerns)[number], readonly string[]> = {
    no_implementation_shown: ['source'],
    implementation_components_unseen: components
      .filter((c) => c.implementationFilesShown === 0)
      .map((c) => c.component),
    implementation_partially_seen: components
      .filter((c) => c.implementationCodePointsShown < c.implementationCodePoints)
      .map((c) => c.component),
    documentation_partially_seen: keys((a) => a.bucket === 'statement' && unfinished(a.status)),
    configuration_partially_seen: keys(
      (a) =>
        a.bucket === 'source' &&
        ['deployment', 'manifest', 'config'].includes(a.role) &&
        unfinished(a.status),
    ),
    tests_partially_seen: keys((a) => a.role === 'test' && unfinished(a.status)),
  };
  for (const concern of concerns) {
    const subjects = [...subjectsOf[concern]].sort();
    // the bounded list is what is stored; the count in the stored entry is the length of the list given to `add`, so the cap is applied by
    // `collectLimitations` after counting
    for (const subject of subjects) add(concern, subject);
    if (subjects.length === 0) add(concern, 'source');
  }
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
  if (inputs.windowing) addCoverage(inputs.windowing, add);
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
      ? [
          {
            code,
            count: subjects.length,
            subjects: [...new Set(subjects)].sort().slice(0, SUBJECT_CAP),
          },
        ]
      : [];
  });
}
