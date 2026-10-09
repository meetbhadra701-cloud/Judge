import type { EvidenceGraph, KnownEntities } from '@judge-copilot/evidence';
import { classifyRepositoryArtifact } from '@judge-copilot/evidence';
import type { EvidenceChannel, EvidenceRecord } from '@judge-copilot/schemas';
import type { RubricSpec } from '@judge-copilot/scoring';
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
  /** The evidence's event-context reference concerns this track, when it is one. */
  readonly projectDerived: boolean;
}

export interface UnitCandidates {
  readonly dimensionId: string;
  readonly criterionKey: string;
  readonly name: string;
  /** Declared need groups (fallback) or null (official: the rubric declares none). */
  readonly needGroups: readonly (readonly EvidenceChannel[])[] | null;
  readonly items: readonly CandidateItem[];
  readonly byHandle: ReadonlyMap<string, CandidateItem>;
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
}

export function buildCandidateSets(inputs: CandidateInputs): UnitCandidates[] {
  const { graph, known, rubric } = inputs;
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
      const references = usable.filter((record) => record.origin === 'event_context');
      const referenceSlots = Math.min(references.length, EVENT_REFERENCES_PER_UNIT);
      const chosen = [
        ...project.slice(0, CANDIDATES_PER_UNIT - referenceSlots).map((entry) => entry.record),
        ...references.slice(0, referenceSlots),
      ];
      const items: CandidateItem[] = chosen.map((record, index) => ({
        handle: evidenceHandle(index + 1),
        evidenceId: record.id,
        channel: channelOfEvidence(record, known),
        label: record.verificationLevel === 'team_claim' ? 'team_claim' : 'unverified',
        authorship: authorshipOf(record),
        text: record.text,
        excerpt: record.provenance.excerpt,
        projectDerived: record.origin !== 'event_context',
      }));
      units.push({
        dimensionId: dimension.id,
        criterionKey: criterion.key,
        name: dimension.name,
        needGroups: needs,
        items,
        byHandle: new Map(items.map((item) => [item.handle, item])),
      });
    }
  }
  return units;
}

// -- Deterministic pre-gates --------------------------------------------------------------------------------------------

export const FALLBACK_TRACK_PREFIX = 'track_prize_alignment.';

export const PRE_GATE_REASON_VALUES = [
  'no_candidate_evidence',
  'no_satisfiable_need',
  'no_official_requirement_available',
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
  if (
    unit.dimensionId.startsWith(FALLBACK_TRACK_PREFIX) &&
    !unit.items.some((item) => !item.projectDerived)
  ) {
    return 'no_official_requirement_available';
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
