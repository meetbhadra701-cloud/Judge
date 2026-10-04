import type {
  EventContextDocument,
  EventSourceAuthority,
  RubricDefinition,
} from '@judge-copilot/schemas';
import { resolveConflict } from './conflicts.js';
import { issue, type TypedIssue } from './errors.js';
import { listFacts } from './facts.js';
import { canonicalJson } from './hash.js';
import { collectSourceIds } from './references.js';

/** Source ID → authority for the sources of ONE context version. */
export type VersionSources = ReadonlyMap<string, EventSourceAuthority>;

/**
 * Official criterion weights must sum to 1.0 within this absolute tolerance. Weights are never
 * normalized or invented: a malformed official rubric is a validation error.
 */
export const RUBRIC_WEIGHT_SUM_TOLERANCE = 1e-6;

/**
 * Structural validation: everything a draft must satisfy to be stored. Does not check that
 * weights sum to 1 (a malformed official rubric may be stored as a draft so a human can see and
 * correct it), but no draft can ever be locked without passing `validateForLock`.
 */
export function validateDocument(
  document: EventContextDocument,
  sources: VersionSources,
): TypedIssue[] {
  const issues: TypedIssue[] = [];

  const unknown = [...collectSourceIds(document)].filter((id) => !sources.has(id));
  for (const id of unknown) {
    issues.push(
      issue(
        'UNKNOWN_SOURCE_REFERENCE',
        'document',
        `Source ${id} is not part of this context version`,
      ),
    );
  }

  const facts = listFacts(document);
  const seenIds = new Set<string>();
  for (const { path, fact } of [
    ...facts,
    ...document.conflicts.map((fact, i) => ({ path: `conflicts[${i}]`, fact })),
  ]) {
    if (seenIds.has(fact.id)) {
      issues.push(issue('DUPLICATE_FACT_ID', path, `Fact id ${fact.id} appears more than once`));
    }
    seenIds.add(fact.id);
  }

  for (const { path, fact } of facts) {
    if (
      fact.origin === 'source_derived' &&
      fact.sourceIds.length === 0 &&
      fact.certainty !== 'unclear'
    ) {
      issues.push(
        issue(
          'MISSING_PROVENANCE',
          path,
          'A source-derived fact must cite at least one source unless it is unclear',
        ),
      );
    }
  }

  const { startsAt, endsAt } = document.dates;
  if (startsAt.value && endsAt.value && Date.parse(endsAt.value) < Date.parse(startsAt.value)) {
    issues.push(
      issue('INVALID_DATE_ORDER', 'dates.endsAt', 'The event cannot end before it starts'),
    );
  }

  const trackKeys = new Set<string>();
  document.tracks.forEach((track, i) => {
    const path = `tracks[${i}]`;
    if (trackKeys.has(track.key)) {
      issues.push(
        issue('DUPLICATE_TRACK_KEY', path, `Track key "${track.key}" is used more than once`),
      );
    }
    trackKeys.add(track.key);
    if (track.origin === 'source_derived' && track.sourceIds.length === 0) {
      issues.push(issue('MISSING_PROVENANCE', path, 'A source-derived track must cite a source'));
    }
  });

  document.submissionRequirements.forEach((requirement, i) => {
    if (requirement.trackKey !== null && !trackKeys.has(requirement.trackKey)) {
      issues.push(
        issue(
          'UNKNOWN_TRACK_REFERENCE',
          `submissionRequirements[${i}].trackKey`,
          `Unknown track "${requirement.trackKey}"`,
        ),
      );
    }
  });

  const rubricIdentities = new Set<string>();
  document.rubrics.forEach((rubric, i) => {
    const path = `rubrics[${i}]`;
    issues.push(...validateRubricStructure(rubric, path, trackKeys));
    const identity = rubric.scope === 'overall' ? 'overall' : `track:${rubric.trackKey ?? ''}`;
    if (rubricIdentities.has(identity)) {
      issues.push(issue('DUPLICATE_RUBRIC', path, `More than one rubric for ${identity}`));
    }
    rubricIdentities.add(identity);
  });

  document.conflicts.forEach((conflict, i) => {
    const path = `conflicts[${i}]`;
    if (conflict.positions.some((position) => !sources.has(position.sourceId))) {
      return; // already reported as UNKNOWN_SOURCE_REFERENCE
    }
    const human =
      conflict.resolution.status === 'resolved_by_human'
        ? {
            prevailingSourceIds: conflict.resolution.prevailingSourceIds,
            note: conflict.resolution.note ?? '',
          }
        : null;
    const result = resolveConflict(conflict.positions, (id) => authorityOf(sources, id), human);
    if (!result.ok) {
      issues.push(issue('INVALID_CONFLICT', path, result.message));
    } else if (canonicalJson(result.resolution) !== canonicalJson(conflict.resolution)) {
      issues.push(
        issue(
          'INVALID_CONFLICT_RESOLUTION',
          `${path}.resolution`,
          'Conflict resolution does not follow source authority',
        ),
      );
    }
  });

  return issues;
}

/** Everything `validateDocument` checks, plus the rules that only gate locking. */
export function validateForLock(
  document: EventContextDocument | null,
  sources: VersionSources,
): TypedIssue[] {
  if (!document) {
    return [
      issue(
        'CONTEXT_CONTENT_MISSING',
        'document',
        'Build or author the Event Context before locking',
      ),
    ];
  }
  return [
    ...validateDocument(document, sources),
    ...document.rubrics.flatMap((rubric, i) => rubricWeightSumIssues(rubric, `rubrics[${i}]`)),
  ];
}

function validateRubricStructure(
  rubric: RubricDefinition,
  path: string,
  trackKeys: ReadonlySet<string>,
): TypedIssue[] {
  const issues: TypedIssue[] = [];

  if ((rubric.scope === 'overall') !== (rubric.trackKey === null)) {
    issues.push(
      issue(
        'INVALID_RUBRIC_SCOPE',
        path,
        'An overall rubric has no track; a track rubric must name its track',
      ),
    );
  } else if (rubric.trackKey !== null && !trackKeys.has(rubric.trackKey)) {
    issues.push(
      issue('UNKNOWN_TRACK_REFERENCE', `${path}.trackKey`, `Unknown track "${rubric.trackKey}"`),
    );
  }
  if (rubric.origin === 'source_derived' && rubric.sourceIds.length === 0) {
    issues.push(issue('MISSING_PROVENANCE', path, 'A source-derived rubric must cite a source'));
  }
  if (
    !Number.isFinite(rubric.scaleMin) ||
    !Number.isFinite(rubric.scaleMax) ||
    rubric.scaleMin >= rubric.scaleMax
  ) {
    issues.push(
      issue('INVALID_RUBRIC_SCALE', path, 'Rubric scale minimum must be below its maximum'),
    );
  }
  if (rubric.criteria.length === 0) {
    issues.push(issue('EMPTY_RUBRIC', path, 'A rubric needs at least one criterion'));
  }

  const keys = new Set<string>();
  rubric.criteria.forEach((criterion, j) => {
    const criterionPath = `${path}.criteria[${j}]`;
    if (keys.has(criterion.key)) {
      issues.push(
        issue(
          'DUPLICATE_CRITERION_KEY',
          `${criterionPath}.key`,
          `Criterion key "${criterion.key}" is used more than once in this rubric`,
        ),
      );
    }
    keys.add(criterion.key);
    if (criterion.origin === 'source_derived' && criterion.sourceIds.length === 0) {
      issues.push(
        issue('MISSING_PROVENANCE', criterionPath, 'A source-derived criterion must cite a source'),
      );
    }
    if (
      criterion.weight !== null &&
      !(Number.isFinite(criterion.weight) && criterion.weight > 0 && criterion.weight <= 1)
    ) {
      issues.push(
        issue(
          'INVALID_RUBRIC_WEIGHTS',
          `${criterionPath}.weight`,
          'A criterion weight must be greater than 0 and at most 1',
        ),
      );
    }
    const scores = new Set<number>();
    criterion.anchors.forEach((anchor, k) => {
      const anchorPath = `${criterionPath}.anchors[${k}]`;
      if (
        !Number.isFinite(anchor.score) ||
        anchor.score < rubric.scaleMin ||
        anchor.score > rubric.scaleMax
      ) {
        issues.push(
          issue('INVALID_RUBRIC_SCALE', anchorPath, 'Anchor score is outside the rubric scale'),
        );
      }
      if (scores.has(anchor.score)) {
        issues.push(issue('INVALID_RUBRIC_SCALE', anchorPath, 'Two anchors share the same score'));
      }
      scores.add(anchor.score);
    });
  });

  return issues;
}

/**
 * A rubric is either fully unweighted (all null — weights are not invented in M1) or fully
 * weighted with weights summing to 1 within RUBRIC_WEIGHT_SUM_TOLERANCE.
 */
export function rubricWeightSumIssues(rubric: RubricDefinition, path: string): TypedIssue[] {
  const weights = rubric.criteria.map((criterion) => criterion.weight);
  const weighted = weights.filter((weight): weight is number => weight !== null);
  if (weighted.length === 0) {
    return [];
  }
  if (weighted.length !== weights.length) {
    return [
      issue('INVALID_RUBRIC_WEIGHTS', path, 'Either every criterion has a weight or none does'),
    ];
  }
  const sum = weighted.reduce((total, weight) => total + weight, 0);
  if (Math.abs(sum - 1) > RUBRIC_WEIGHT_SUM_TOLERANCE) {
    return [
      issue(
        'INVALID_RUBRIC_WEIGHTS',
        path,
        `Criterion weights sum to ${String(Number(sum.toFixed(9)))}, not 1 (tolerance ${String(RUBRIC_WEIGHT_SUM_TOLERANCE)})`,
      ),
    ];
  }
  return [];
}

function authorityOf(sources: VersionSources, id: string): EventSourceAuthority {
  const authority = sources.get(id);
  if (authority === undefined) {
    throw new Error(`Unknown source ${id}`);
  }
  return authority;
}
