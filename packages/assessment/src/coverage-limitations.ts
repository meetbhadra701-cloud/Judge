import { PROSE_CATEGORY_VALUES } from './selection-v3.js';
import { COVERAGE_POLICY, type CoverageConcern, type CoverageReport } from './coverage.js';

/*
 * The report limitations that follow from a selection outcome, DERIVED BY CODE from the coverage report and the pinned snapshots' own statuses.
 * Nothing here is written by, or asked of, a model: whether the assessor repeats a notice in its judgment is irrelevant to whether the judge is
 * told. The same function is what a verifier re-runs against a stored record, so a stored assessment that omits one of these is detectable.
 */

export const COVERAGE_LIMITATION_CODES = [
  'source_sampled',
  'partial_capture',
  'no_implementation_shown',
  'implementation_components_unseen',
  'implementation_partially_seen',
  'implementation_mostly_unseen',
  'dominant_component_unseen',
  'largest_components_unseen',
  'generated_volume_large',
  'duplicates_not_represented',
  'component_flood',
  'documentation_partially_seen',
  'documentation_category_unseen',
  'configuration_partially_seen',
  'tests_partially_seen',
] as const;
export type CoverageLimitationCode = (typeof COVERAGE_LIMITATION_CODES)[number];

export interface CoverageLimitation {
  readonly code: CoverageLimitationCode;
  /** The true number of subjects (the list below is bounded). */
  readonly count: number;
  readonly subjects: readonly string[];
}

export interface PinnedSnapshotStatus {
  readonly sourceType: string;
  readonly status: string;
  readonly partialReasons: readonly string[];
}

export const LIMITATION_SUBJECT_CAP = 25;

const unfinished = (status: string): boolean => status === 'partial' || status === 'unseen';

/**
 * `windowingBuckets`: which buckets were sampled (`source_sampled`, as before). Subjects of a coverage code are ordered by what matters to a
 * reader (components by implementation code points, descending; documents by category) and then bounded; `count` is the true total.
 */
export function coverageLimitations(
  report: CoverageReport | null,
  sampledBuckets: readonly string[],
  snapshots: readonly PinnedSnapshotStatus[],
): CoverageLimitation[] {
  const out: CoverageLimitation[] = [];
  const push = (code: CoverageLimitationCode, subjects: readonly string[]): void => {
    const unique = [...new Set(subjects)];
    out.push({
      code,
      count: unique.length === 0 ? 1 : unique.length,
      subjects: (unique.length === 0 ? ['source'] : unique).slice(0, LIMITATION_SUBJECT_CAP),
    });
  };
  if (sampledBuckets.length > 0) push('source_sampled', [...sampledBuckets].sort());
  const partial = snapshots
    .filter((s) => s.status === 'partial')
    .map((s) => `${s.sourceType}:${[...s.partialReasons].sort().join('+') || 'unspecified'}`)
    .sort();
  if (partial.length > 0) push('partial_capture', partial);

  if (report === null) return out;
  const { components, artifacts } = report;
  const inspected = (c: (typeof components)[number]): number =>
    c.implementationCodePointsShown + c.implementationCodePointsRepresented;
  const seen = (c: (typeof components)[number]): boolean =>
    c.implementationFilesShown > 0 || c.implementationFilesRepresented > 0;
  const subjectsOf: Record<CoverageConcern, () => readonly string[]> = {
    no_implementation_shown: () => [],
    implementation_components_unseen: () =>
      components.filter((c) => !seen(c)).map((c) => c.component),
    implementation_partially_seen: () =>
      components.filter((c) => inspected(c) < c.implementationCodePoints).map((c) => c.component),
    implementation_mostly_unseen: () => [],
    dominant_component_unseen: () =>
      components
        .filter(
          (c) =>
            c.implementationCodePoints >= 0.25 * report.measures.implementation.codePoints &&
            inspected(c) === 0,
        )
        .map((c) => c.component),
    largest_components_unseen: () =>
      components.slice(0, COVERAGE_POLICY.largestComponentsChecked).map((c) => c.component),
    generated_volume_large: () => [],
    duplicates_not_represented: () =>
      artifacts.filter((a) => a.status === 'duplicate' && !a.represented).map((a) => a.artifactKey),
    component_flood: () => [],
    documentation_partially_seen: () =>
      artifacts
        .filter((a) => a.bucket === 'statement' && unfinished(a.status))
        .sort(
          (a, b) =>
            PROSE_CATEGORY_VALUES.indexOf(a.category ?? 'other_docs') -
              PROSE_CATEGORY_VALUES.indexOf(b.category ?? 'other_docs') ||
            (a.artifactKey < b.artifactKey ? -1 : 1),
        )
        .map((a) => a.artifactKey),
    documentation_category_unseen: () =>
      report.measures.documentation
        .filter((c) => c.files > 0 && c.filesShown + c.filesRepresented === 0)
        .map((c) => c.category),
    configuration_partially_seen: () =>
      artifacts
        .filter(
          (a) =>
            a.bucket === 'source' &&
            ['deployment', 'manifest', 'config'].includes(a.role) &&
            unfinished(a.status),
        )
        .map((a) => a.artifactKey),
    tests_partially_seen: () =>
      artifacts.filter((a) => a.role === 'test' && unfinished(a.status)).map((a) => a.artifactKey),
  };
  for (const concern of report.concerns) push(concern, subjectsOf[concern]());
  return out;
}
