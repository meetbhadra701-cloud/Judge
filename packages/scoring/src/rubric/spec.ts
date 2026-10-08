import type {
  EvidenceChannel,
  NeedsBasis,
  RubricSource,
  RubricWeightBasis,
} from '@judge-copilot/schemas';

/*
 * The rubric the engine scores against, in a normalized form. It is built ONLY by trusted code from
 * a locked Event Context (official) or from the versioned fallback definition, and it is carried
 * inside a branded `TrustedScoringContext`; no assessor or model input can supply or alter one.
 */

/** A group of acceptable evidence channels; a need is satisfied by an item in any channel of it. */
export type NeedGroup = readonly EvidenceChannel[];

export interface DimensionSpec {
  /** `<criterion_key>.<dimension_key>` (fallback) or `official.<criterion_key>` (official). */
  readonly id: string;
  readonly key: string;
  readonly name: string;
  /** Weight within its criterion (always 1 for an official criterion, which is one atomic unit). */
  readonly weight: number;
  /** Declared evidence needs, or null where the rubric declares none (every official criterion). */
  readonly needGroups: readonly NeedGroup[] | null;
}

export interface CriterionSpec {
  readonly key: string;
  readonly name: string;
  /** The published weight, or null for an unweighted official rubric. */
  readonly weight: number | null;
  /** False only for the fallback Track criterion of a project with no declared tracks. */
  readonly applicable: boolean;
  readonly dimensions: readonly DimensionSpec[];
}

export interface RubricSpec {
  readonly source: RubricSource;
  readonly rubricVersion: string | null;
  readonly contextVersionId: string | null;
  readonly contextContentHash: string | null;
  readonly name: string;
  readonly scope: 'overall' | 'track';
  readonly trackKey: string | null;
  readonly scale: { readonly min: number; readonly max: number };
  readonly weightBasis: RubricWeightBasis;
  readonly needsBasis: NeedsBasis;
  readonly criteria: readonly CriterionSpec[];
}
