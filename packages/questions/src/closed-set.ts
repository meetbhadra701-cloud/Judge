import type { QuestionReferenceView } from '@judge-copilot/schemas';
import type {
  UncertaintyInput,
  UncertaintyOpportunity,
  UncertaintyReport,
} from '@judge-copilot/uncertainty';

/*
 * The CLOSED SET a candidate-question stage may refer to (invariant 20). Code assigns every handle from the frozen analysis; a model sees handles and
 * never a persisted id, and an output that names a handle outside this set is rejected, never repaired.
 *
 *   O-001  an uncertainty opportunity          D-001  a rubric dimension
 *   C-001  a claim                              X-001  a recorded unknown
 *   E-001  an evidence item                     K-001  a recorded contradiction
 *   R-001  an official requirement              T-001  a declared track
 *   V-001  a coverage signal
 *
 * Handles are numbered in the deterministic order they first appear, so the same input always yields the same handles.
 */

export const HANDLE_LETTER = {
  opportunity: 'O',
  dimension: 'D',
  claim: 'C',
  unknown: 'X',
  evidence: 'E',
  contradiction: 'K',
  requirement: 'R',
  track: 'T',
  coverage: 'V',
} as const;

export type ReferenceType = keyof typeof HANDLE_LETTER;

const LETTER_TO_TYPE = new Map<string, ReferenceType>(
  (Object.entries(HANDLE_LETTER) as [ReferenceType, string][]).map(([type, letter]) => [
    letter,
    type,
  ]),
);

export interface ClosedSetOpportunity {
  readonly handle: string;
  readonly opportunity: UncertaintyOpportunity;
}

export interface ClosedSetDimension {
  readonly handle: string;
  readonly id: string;
  readonly name: string;
  readonly weightShareMilli: number;
}

export interface ClosedSetReference {
  readonly handle: string;
  readonly type: Exclude<ReferenceType, 'opportunity' | 'dimension'>;
  readonly id: string;
  readonly label: string;
  readonly verificationLevel: string | null;
}

export interface ClosedSet {
  readonly opportunities: readonly ClosedSetOpportunity[];
  readonly dimensions: readonly ClosedSetDimension[];
  readonly references: readonly ClosedSetReference[];
  readonly byHandle: ReadonlyMap<
    string,
    ClosedSetOpportunity | ClosedSetDimension | ClosedSetReference
  >;
}

export const handleOf = (type: ReferenceType, index: number): string =>
  `${HANDLE_LETTER[type]}-${String(index).padStart(3, '0')}`;

export function handleType(handle: string): ReferenceType | null {
  const match = /^([A-Z])-[0-9]{3,4}$/.exec(handle);
  return match?.[1] === undefined ? null : (LETTER_TO_TYPE.get(match[1]) ?? null);
}

const label = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

export function buildClosedSet(report: UncertaintyReport, input: UncertaintyInput): ClosedSet {
  const opportunities: ClosedSetOpportunity[] = report.opportunities.map((opportunity, index) => ({
    handle: handleOf('opportunity', index + 1),
    opportunity,
  }));
  const dimensions: ClosedSetDimension[] = report.dimensions.map((dimension, index) => ({
    handle: handleOf('dimension', index + 1),
    id: dimension.id,
    name: dimension.name,
    weightShareMilli: dimension.weightShareMilli,
  }));

  const claimById = new Map(input.claims.map((c) => [c.id, c] as const));
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e] as const));
  const unknownById = new Map(input.unknowns.map((u) => [u.id, u] as const));
  const contradictionById = new Map(input.contradictions.map((c) => [c.id, c] as const));
  const requirementById = new Map(input.requirements.map((r) => [r.id, r] as const));
  const trackByKey = new Map(input.tracks.declared.map((t) => [t.key, t] as const));

  const counters = new Map<ReferenceType, number>();
  const seen = new Set<string>();
  const references: ClosedSetReference[] = [];
  const push = (
    type: ClosedSetReference['type'],
    id: string,
    text: string,
    verificationLevel: string | null,
  ): void => {
    const key = `${type}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const next = (counters.get(type) ?? 0) + 1;
    counters.set(type, next);
    references.push({
      handle: handleOf(type, next),
      type,
      id,
      label: label(text),
      verificationLevel,
    });
  };

  for (const { opportunity } of opportunities) {
    for (const entry of opportunity.trail) {
      if (entry.type === 'dimension') continue; // dimensions have their own handles
      if (entry.type === 'claim') {
        const claim = claimById.get(entry.id);
        if (claim) push('claim', claim.id, claim.text, claim.verificationLevel);
      } else if (entry.type === 'evidence') {
        const item = evidenceById.get(entry.id);
        if (item) push('evidence', item.id, item.text, item.verificationLevel);
      } else if (entry.type === 'unknown') {
        const unknown = unknownById.get(entry.id);
        if (unknown) push('unknown', unknown.id, unknown.text, null);
      } else if (entry.type === 'contradiction') {
        const contradiction = contradictionById.get(entry.id);
        if (contradiction) push('contradiction', contradiction.id, contradiction.description, null);
      } else if (entry.type === 'requirement') {
        const requirement = requirementById.get(entry.id);
        if (requirement) push('requirement', requirement.id, requirement.text, null);
      } else if (entry.type === 'track') {
        const track = trackByKey.get(entry.id);
        if (track) push('track', track.key, track.name, null);
      } else {
        push('coverage', entry.id, entry.id.replaceAll('_', ' '), null);
      }
    }
  }

  const byHandle = new Map<
    string,
    ClosedSetOpportunity | ClosedSetDimension | ClosedSetReference
  >();
  for (const entry of [...opportunities, ...dimensions, ...references])
    byHandle.set(entry.handle, entry);
  return { opportunities, dimensions, references, byHandle };
}

/** The reference views of one opportunity's trail, resolved against the closed set (what a judge can read). */
export function referenceViewsOf(
  closed: ClosedSet,
  opportunity: UncertaintyOpportunity,
): QuestionReferenceView[] {
  const byKey = new Map<string, ClosedSetReference>(
    closed.references.map((r) => [`${r.type}:${r.id}`, r] as const),
  );
  const nameOf = new Map(closed.dimensions.map((d) => [d.id, d.name] as const));
  const views: QuestionReferenceView[] = [];
  const seen = new Set<string>();
  for (const entry of opportunity.trail) {
    const key = `${entry.type}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.type === 'dimension') {
      views.push({ type: 'dimension', id: entry.id, label: nameOf.get(entry.id) ?? entry.id });
      continue;
    }
    const resolved = byKey.get(key);
    if (resolved) {
      views.push({
        type: resolved.type,
        id: resolved.id,
        label: resolved.label,
        verificationLevel: resolved.verificationLevel,
      });
    }
  }
  return views;
}
