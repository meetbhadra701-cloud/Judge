import { lockedContentHash } from '@judge-copilot/context';
import {
  FALLBACK_RUBRIC_VERSION,
  IDENTIFIER_PATTERN,
  type EventContextLockedSnapshot,
  type RubricDefinition,
  type ScoringIssue,
} from '@judge-copilot/schemas';
import { compareText } from '../canonical.js';
import { SCORING_PARAMETERS } from '../parameters.js';
import { FALLBACK_RUBRIC_DEFINITION, FALLBACK_TRACK_CRITERION_KEY } from './fallback.js';
import type { CriterionSpec, RubricSpec } from './spec.js';
import { validatePublishedWeights } from './weights.js';

/*
 * Rubric selection (docs/SCORING.md §2 and §12), conservative and with no automatic mixing:
 *
 *  - target `overall`: the locked context's official `overall` rubric, whole, if it has one;
 *    ONLY when it has none, the versioned fallback rubric. An invalid official rubric is
 *    RUBRIC_INVALID: never repaired, renormalized or replaced, and never a reason to fall back.
 *  - target `track`: the official rubric of that track, which the project must have declared;
 *    there is no fallback for a track.
 *
 * An official criterion is ONE atomic assessment unit (`official.<key>`, weight 1). No human-reviewed
 * sub-dimension mapping exists, so none is pretended. The 36-dimension decomposition is the
 * fallback's alone, and its Track criterion may be `not_applicable` (only there, only when the
 * project declared no tracks).
 */

export type ScoringTarget =
  { readonly kind: 'overall' } | { readonly kind: 'track'; readonly trackKey: string };

export interface SelectRubricInput {
  readonly locked: EventContextLockedSnapshot;
  readonly target: ScoringTarget;
  /** Track keys the project declared. TRUSTED project facts, never an assessor payload. */
  readonly declaredTrackKeys: readonly string[];
}

export type SelectRubricResult =
  | {
      readonly ok: true;
      readonly rubric: RubricSpec;
      /** Normalized: unique, sorted. */
      readonly declaredTrackKeys: readonly string[];
    }
  | { readonly ok: false; readonly issues: readonly ScoringIssue[] };

const IDENTIFIER = new RegExp(IDENTIFIER_PATTERN);

const issue = (code: ScoringIssue['code'], path: string, message: string): ScoringIssue => ({
  code,
  path,
  message,
});

export function selectRubric(input: SelectRubricInput): SelectRubricResult {
  const issues: ScoringIssue[] = [];

  const declared = new Set<string>();
  input.declaredTrackKeys.forEach((key, index) => {
    if (typeof key !== 'string' || !IDENTIFIER.test(key) || key.length > 100) {
      issues.push(
        issue('INVALID_INPUT', `declaredTrackKeys[${String(index)}]`, 'Not a valid track key'),
      );
    } else {
      declared.add(key);
    }
  });
  const declaredTrackKeys = [...declared].sort(compareText);

  // The snapshot must still hash to what was locked: the rubric is the frozen published one.
  const recomputed = lockedContentHash({
    document: input.locked.document,
    sources: input.locked.sources,
  });
  if (recomputed !== input.locked.lockedContentHash) {
    issues.push(
      issue(
        'LOCKED_CONTEXT_MISMATCH',
        'locked',
        'The locked Event Context content does not match its recorded content hash',
      ),
    );
  }
  if (issues.length > 0) return { ok: false, issues };

  const { rubrics } = input.locked.document;

  if (input.target.kind === 'track') {
    const { trackKey } = input.target;
    if (!declared.has(trackKey)) {
      return {
        ok: false,
        issues: [
          issue(
            'TARGET_TRACK_NOT_DECLARED',
            'target.trackKey',
            'The project did not declare this track',
          ),
        ],
      };
    }
    const matches = rubrics.filter(
      (rubric) => rubric.scope === 'track' && rubric.trackKey === trackKey,
    );
    const [only] = matches;
    if (!only) {
      return {
        ok: false,
        issues: [
          issue(
            'RUBRIC_NOT_FOUND',
            'target.trackKey',
            'The locked Event Context has no official rubric for this track',
          ),
        ],
      };
    }
    return buildOfficial(input.locked, only, matches.length, declaredTrackKeys);
  }

  const overall = rubrics.filter((rubric) => rubric.scope === 'overall');
  const [official] = overall;
  if (official) return buildOfficial(input.locked, official, overall.length, declaredTrackKeys);
  return { ok: true, rubric: buildFallback(input.locked, declaredTrackKeys), declaredTrackKeys };
}

function buildOfficial(
  locked: EventContextLockedSnapshot,
  rubric: RubricDefinition,
  matchCount: number,
  declaredTrackKeys: readonly string[],
): SelectRubricResult {
  const issues: ScoringIssue[] = [];
  const fail = (message: string, path = 'rubric') => {
    issues.push(issue('RUBRIC_INVALID', path, message));
  };

  if (matchCount > 1) fail('The locked Event Context has more than one rubric for this target');
  if (rubric.criteria.length === 0) fail('The official rubric has no criteria');
  if (
    !Number.isFinite(rubric.scaleMin) ||
    !Number.isFinite(rubric.scaleMax) ||
    !(rubric.scaleMin < rubric.scaleMax)
  ) {
    fail(
      'The official rubric scale must be finite with a minimum below its maximum',
      'rubric.scale',
    );
  }
  const keys = new Set<string>();
  rubric.criteria.forEach((criterion, index) => {
    if (keys.has(criterion.key)) {
      fail('Criterion keys must be unique', `rubric.criteria[${String(index)}].key`);
    }
    keys.add(criterion.key);
  });

  const weights = validatePublishedWeights(rubric.criteria.map((criterion) => criterion.weight));
  if (!weights.ok) for (const message of weights.messages) fail(message, 'rubric.criteria.weight');
  if (issues.length > 0 || !weights.ok) return { ok: false, issues };

  const criteria: CriterionSpec[] = rubric.criteria.map((criterion) => ({
    key: criterion.key,
    name: criterion.name,
    // Retained exactly as published (null when unweighted); never normalized.
    weight: criterion.weight,
    applicable: true,
    dimensions: [
      {
        id: `official.${criterion.key}`,
        key: criterion.key,
        name: criterion.name,
        weight: 1,
        needGroups: null,
      },
    ],
  }));

  return {
    ok: true,
    declaredTrackKeys,
    rubric: {
      source: 'official_event_context',
      rubricVersion: null,
      contextVersionId: locked.versionId,
      contextContentHash: locked.lockedContentHash,
      name: rubric.name,
      scope: rubric.scope,
      trackKey: rubric.trackKey,
      scale: { min: rubric.scaleMin, max: rubric.scaleMax },
      weightBasis: weights.weighted ? 'official' : 'unweighted_official',
      needsBasis: 'unspecified',
      criteria,
    },
  };
}

function buildFallback(
  locked: EventContextLockedSnapshot,
  declaredTrackKeys: readonly string[],
): RubricSpec {
  const criteria: CriterionSpec[] = FALLBACK_RUBRIC_DEFINITION.map((criterion) => ({
    key: criterion.key,
    name: criterion.name,
    weight: criterion.weightPercent / 100,
    // Only the fallback's Track criterion, and only when the project declared no tracks.
    applicable: criterion.key !== FALLBACK_TRACK_CRITERION_KEY || declaredTrackKeys.length > 0,
    dimensions: criterion.dimensions.map((dimension) => ({
      id: `${criterion.key}.${dimension.key}`,
      key: dimension.key,
      name: dimension.name,
      weight: dimension.weightPercent / 100,
      needGroups: dimension.needGroups,
    })),
  }));
  return {
    source: 'universal_fallback',
    rubricVersion: FALLBACK_RUBRIC_VERSION,
    contextVersionId: locked.versionId,
    contextContentHash: locked.lockedContentHash,
    name: 'Universal fallback rubric',
    scope: 'overall',
    trackKey: null,
    scale: { ...SCORING_PARAMETERS.fallbackScale },
    weightBasis: 'fallback',
    needsBasis: 'declared',
    criteria,
  };
}
