import type { EvidenceGraph, KnownEntities } from '@judge-copilot/evidence';
import { classifyRepositoryArtifact } from '@judge-copilot/evidence';
import type { EvidenceChannel, EvidenceRecord } from '@judge-copilot/schemas';
import type { RubricSpec } from '@judge-copilot/scoring';
import type { EventReferenceApplicability, EventReferenceMeta } from './event-evidence.js';
import { evidenceHandle } from './handles.js';

/*
 * The closed candidate evidence set of ONE scoring unit (design §5.3). A model may cite only the handles it was shown for the unit;
 * the handles are numbered per unit in a fixed order (`E-001`...), so a prompt is a pure function of the unit's inputs and does not
 * depend on how the extraction numbered its records or on any persisted ID.
 *
 * Selection is deterministic and structural: usable kinds only (`fact`, `claim`); a stored label is shown only as `team_claim` or
 * `unverified` (Option B: any other stored label is never repeated to a model); order by the unit's declared need-group channels, then
 * by graph insertion order; capped at 60 with at most 8 slots for Event-Context reference items.
 */

export const CANDIDATES_PER_UNIT = 60;
export const EVENT_REFERENCES_PER_UNIT = 8;
export const CANDIDATE_POLICY = 'candidate-set/v1' as const;

export type Authorship = 'team_statement' | 'interpreted_fact' | 'event_reference';

export interface CandidateItem {
  /** Per-unit handle shown to the model. */
  readonly handle: string;
  /** The persisted evidence id (never shown to a model). */
  readonly evidenceId: string;
  readonly channel: EvidenceChannel;
  readonly label: 'unverified' | 'team_claim';
  readonly authorship: Authorship;
  readonly text: string;
  readonly excerpt: string | null;
  /** False for Event-Context reference items (they say what the EVENT requires, not what the project does). */
  readonly projectDerived: boolean;
  /** For a reference item: what it is and which declared track it concerns (code-authored; null for project evidence). */
  readonly reference: {
    readonly applicability: EventReferenceApplicability;
    readonly trackKey: string | null;
  } | null;
}

export interface UnitCandidates {
  readonly dimensionId: string;
  readonly criterionKey: string;
  readonly name: string;
  /** Declared need groups (fallback) or null (official: the rubric declares none). */
  readonly needGroups: readonly (readonly EvidenceChannel[])[] | null;
  readonly items: readonly CandidateItem[];
  readonly byHandle: ReadonlyMap<string, CandidateItem>;
  /**
   * What the reference cap did (R3 A3), so a requirement that EXISTS but was left out by the configured limit is never mistaken for a
   * requirement the event does not have. `omittedRequired` counts applicable references of a kind this unit needs that were not shown.
   */
  readonly referenceSelection: {
    readonly applicable: number;
    readonly included: number;
    readonly omittedRequired: number;
    readonly omittedOther: number;
  };
}

/** The channel of an evidence record: a structural derivation that mirrors M4's (cross-checked against the engine in tests). */
export function channelOfEvidence(record: EvidenceRecord, known: KnownEntities): EvidenceChannel {
  switch (record.origin) {
    case 'github': {
      const artifact =
        record.provenance.artifactId === null
          ? undefined
          : known.artifacts.get(record.provenance.artifactId);
      return artifact !== undefined &&
        classifyRepositoryArtifact({
          key: artifact.key,
          kind: artifact.kind,
          mediaType: artifact.mediaType,
        }) === 'source_code'
        ? 'source_code'
        : 'repository';
    }
    case 'devpost':
      return 'submission';
    case 'deployment':
      return 'deployment';
    case 'video':
      return 'video';
    case 'event_context':
      return 'event_context';
    case 'team_answer':
      return 'team_answer';
    case 'judge_observation':
      return 'judge_observation';
  }
}

function authorshipOf(record: EvidenceRecord): Authorship {
  if (record.origin === 'event_context') return 'event_reference';
  return record.kind === 'claim' ? 'team_statement' : 'interpreted_fact';
}

export interface CandidateInputs {
  readonly graph: EvidenceGraph;
  readonly known: KnownEntities;
  readonly rubric: RubricSpec;
  /** The project's DECLARED track keys (authoritative, from the stored selections): the only tracks a reference may concern. */
  readonly declaredTrackKeys: readonly string[];
  /**
   * Code-authored metadata of the Event-Context reference evidence, keyed by evidence id (`referenceMetaByEvidenceId`). An
   * `event_context` evidence record WITHOUT metadata, or whose metadata does not fit the declared tracks, is not shown at all: its
   * applicability cannot be established, and it is never guessed from its text.
   */
  readonly eventReferences: ReadonlyMap<string, EventReferenceMeta>;
  /** Test/configuration seam for the per-unit reference cap (default `EVENT_REFERENCES_PER_UNIT`). */
  readonly referenceCap?: number;
}

/** 0 when `applicability` is a kind the dimension REQUIRES (Track units only), else 1. */
function requiredRank(dimensionId: string, applicability: EventReferenceApplicability): number {
  const required = requiredReferenceKinds(dimensionId);
  return required?.includes(applicability) === true ? 0 : 1;
}

const REFERENCE_ORDER: Readonly<Record<EventReferenceApplicability, number>> = {
  declared_track_definition: 0,
  track_specific_requirement: 1,
  overall_rule: 2,
};

/** A reference applies only to a DECLARED track (or, for an overall rule, to every submission): decided here, from code-authored fields. */
function applicableReference(
  meta: EventReferenceMeta | undefined,
  declared: ReadonlySet<string>,
): CandidateItem['reference'] {
  if (!meta) return null;
  if (meta.applicability === 'overall_rule') {
    return meta.trackKey === null ? { applicability: meta.applicability, trackKey: null } : null;
  }
  return meta.trackKey !== null && declared.has(meta.trackKey)
    ? { applicability: meta.applicability, trackKey: meta.trackKey }
    : null;
}

export function buildCandidateSets(inputs: CandidateInputs): UnitCandidates[] {
  const { graph, known, rubric } = inputs;
  const declared = new Set(inputs.declaredTrackKeys);
  const usable = graph.ordered.evidence.filter(
    (record) => record.kind === 'fact' || record.kind === 'claim',
  );
  const units: UnitCandidates[] = [];
  for (const criterion of rubric.criteria) {
    if (!criterion.applicable) continue;
    for (const dimension of criterion.dimensions) {
      const needs = dimension.needGroups;
      const needRank = (channel: EvidenceChannel): number => {
        if (needs === null) return 0;
        const index = needs.findIndex((group) => group.includes(channel));
        return index < 0 ? needs.length : index;
      };
      const project = usable
        .filter((record) => record.origin !== 'event_context')
        .map((record, order) => ({
          record,
          order,
          rank: needRank(channelOfEvidence(record, known)),
        }))
        .sort((a, b) => a.rank - b.rank || a.order - b.order);
      const references = usable
        .filter((record) => record.origin === 'event_context')
        .flatMap((record, order) => {
          const reference = applicableReference(inputs.eventReferences.get(record.id), declared);
          return reference ? [{ record, order, reference }] : [];
        })
        // References the dimension REQUIRES come first (an eligibility unit: requirements before track descriptions), then by kind
        // (track definition, track-specific requirement, overall rule), so the cap never drops what the unit needs to be assessable.
        .sort(
          (a, b) =>
            requiredRank(dimension.id, a.reference.applicability) -
              requiredRank(dimension.id, b.reference.applicability) ||
            REFERENCE_ORDER[a.reference.applicability] -
              REFERENCE_ORDER[b.reference.applicability] ||
            a.order - b.order,
        );
      const referenceSlots = Math.min(
        references.length,
        inputs.referenceCap ?? EVENT_REFERENCES_PER_UNIT,
      );
      const omitted = references.slice(referenceSlots);
      const omittedRequired = omitted.filter(
        (entry) => requiredRank(dimension.id, entry.reference.applicability) === 0,
      ).length;
      const chosen = [
        ...project.slice(0, CANDIDATES_PER_UNIT - referenceSlots).map((entry) => ({
          record: entry.record,
          reference: null as CandidateItem['reference'],
        })),
        ...references
          .slice(0, referenceSlots)
          .map((entry) => ({ record: entry.record, reference: entry.reference })),
      ];
      const items: CandidateItem[] = chosen.map(({ record, reference }, index) => ({
        handle: evidenceHandle(index + 1),
        evidenceId: record.id,
        channel: channelOfEvidence(record, known),
        label: record.verificationLevel === 'team_claim' ? 'team_claim' : 'unverified',
        authorship: authorshipOf(record),
        text: record.text,
        excerpt: record.provenance.excerpt,
        projectDerived: record.origin !== 'event_context',
        reference,
      }));
      units.push({
        dimensionId: dimension.id,
        criterionKey: criterion.key,
        name: dimension.name,
        needGroups: needs,
        items,
        byHandle: new Map(items.map((item) => [item.handle, item])),
        referenceSelection: {
          applicable: references.length,
          included: referenceSlots,
          omittedRequired: requiredReferenceKinds(dimension.id) === null ? 0 : omittedRequired,
          omittedOther: omitted.length - omittedRequired,
        },
      });
    }
  }
  return units;
}

// -- Deterministic pre-gates --------------------------------------------------------------------------------------------

export const FALLBACK_TRACK_PREFIX = 'track_prize_alignment.';
/** The one Track dimension that is about an OFFICIAL eligibility or technology REQUIREMENT. */
export const TRACK_ELIGIBILITY_DIMENSION =
  'track_prize_alignment.official_eligibility_required_technology';

/**
 * Which kinds of reference a Track-alignment judgment must cite (design §4.7, review F2). Every Track unit needs APPLICABLE official
 * context: the declared track's definition or an explicit requirement for it. The eligibility / required-technology unit is about a
 * REQUIREMENT, so a track's theme description cannot stand in for it: it needs an explicit track-specific requirement or an explicit
 * overall rule. Returns null for a unit that is not a Track unit. Nothing is invented: a requirement the locked context does not state
 * simply is not available, and the unit is insufficient.
 */
export function requiredReferenceKinds(
  dimensionId: string,
): readonly EventReferenceApplicability[] | null {
  if (!dimensionId.startsWith(FALLBACK_TRACK_PREFIX)) return null;
  return dimensionId === TRACK_ELIGIBILITY_DIMENSION
    ? ['track_specific_requirement', 'overall_rule']
    : ['declared_track_definition', 'track_specific_requirement'];
}

export const PRE_GATE_REASON_VALUES = [
  'no_candidate_evidence',
  'no_satisfiable_need',
  'no_official_requirement_available',
  /** An applicable requirement exists but the configured reference cap left every one of them out: not a valid insufficiency. */
  'official_requirement_omitted_by_limit',
] as const;
export type PreGateReason = (typeof PRE_GATE_REASON_VALUES)[number];

/**
 * Decides, BEFORE any model call, whether a unit can be assessed at all (design §5.3). Returns the reason it cannot, or null.
 * Nothing here estimates quality; each rule is a structural fact about which material exists for the unit.
 */
export function preGate(unit: UnitCandidates): PreGateReason | null {
  const projectItems = unit.items.filter((item) => item.projectDerived);
  // A unit with nothing about the PROJECT is never asked to score: Event-Context rules alone are not project evidence.
  if (projectItems.length === 0) return 'no_candidate_evidence';
  if (unit.needGroups !== null) {
    const present = new Set(unit.items.map((item) => item.channel));
    if (!unit.needGroups.some((group) => group.some((channel) => present.has(channel)))) {
      return 'no_satisfiable_need';
    }
  }
  const required = requiredReferenceKinds(unit.dimensionId);
  if (
    required !== null &&
    !unit.items.some(
      (item) => item.reference !== null && required.includes(item.reference.applicability),
    )
  ) {
    return unit.referenceSelection.omittedRequired > 0
      ? 'official_requirement_omitted_by_limit'
      : 'no_official_requirement_available';
  }
  return null;
}

/**
 * The unit's candidate set for a RE-RUN after the critic reported `injection_suspected` on cited evidence (design §9.2): those items
 * are removed from what the assessor may cite (they stay in the graph). The remaining items KEEP their handles, so the re-run
 * feedback (codes and handles) still refers to what the assessor saw, and a removed handle can no longer be cited (G6).
 */
export function withoutCandidates(
  unit: UnitCandidates,
  removed: readonly string[],
): UnitCandidates {
  const drop = new Set(removed);
  const items = unit.items.filter((item) => !drop.has(item.handle));
  return { ...unit, items, byHandle: new Map(items.map((item) => [item.handle, item])) };
}
