import { z } from 'zod';

/*
 * The COVERAGE RECORD (P6B-beta3-R1): what an assessment run's selection actually did, stored immutably so a historical assessment can be
 * reconstructed and checked. It is a bounded description, not a copy of the repository: per artifact it keeps identity, role, status and the shown
 * prefix (the first `passagesShown` passages, ending at `shownEnd`; the passages themselves are recomputed from the immutable snapshot artifact
 * whose SHA-256 is recorded). Authoritative bytes are the canonical JSON text; its SHA-256 is the record's content address.
 */

export const COVERAGE_RECORD_SCHEMA_ID = 'coverage-record/v1' as const;
/** Bounds of a stored record (the database also bounds its size). */
export const COVERAGE_RECORD_LIMITS = Object.freeze({
  artifacts: 2_000,
  skipped: 2_000,
  components: 500,
  snapshots: 50,
  subjects: 25,
});

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const COVERAGE_STATUS_VALUES = ['full', 'partial', 'unseen', 'duplicate'] as const;
export const COVERAGE_VERDICT_VALUES = ['complete', 'partial', 'insufficient'] as const;
export type CoverageVerdictValue = (typeof COVERAGE_VERDICT_VALUES)[number];

const RoleInventoryRecord = z.strictObject({
  files: Count,
  filesShown: Count,
  codePoints: Count,
  codePointsShown: Count,
});

export const CoverageArtifactRecord = z.strictObject({
  snapshotId: z.string().max(64),
  artifactId: z.string().max(64),
  key: z.string().max(1_024),
  sourceType: z.enum(['devpost', 'github', 'deployment', 'video']),
  bucket: z.enum(['statement', 'source', 'metadata']),
  role: z.string().max(32),
  component: z.string().max(300).nullable(),
  category: z.string().max(32).nullable(),
  status: z.enum(COVERAGE_STATUS_VALUES),
  totalCodePoints: Count,
  shownCodePoints: Count,
  passagesShown: Count,
  shownEnd: Count,
  /** The part never shown, as [start, end) in code points of the stored text; empty when everything eligible was shown. */
  unshown: z.array(z.tuple([Count, Count])).max(1),
  textSha256: Hex64,
  duplicateOf: z.string().max(1_024).nullable(),
  represented: z.boolean(),
  representedCodePoints: Count,
});
export type CoverageArtifactRecord = z.infer<typeof CoverageArtifactRecord>;

export const CoverageComponentRecord = z.strictObject({
  component: z.string().max(300),
  implementationFiles: Count,
  implementationFilesShown: Count,
  implementationFilesRepresented: Count,
  implementationCodePoints: Count,
  implementationCodePointsShown: Count,
  implementationCodePointsRepresented: Count,
  stub: z.boolean(),
});

export const CoverageMeasuresRecord = z.strictObject({
  fileRepresentation: z.strictObject({
    eligibleFiles: Count,
    withShownPassage: Count,
    representedByTwin: Count,
    unseen: Count,
  }),
  implementation: z.strictObject({
    files: Count,
    filesShown: Count,
    filesRepresented: Count,
    filesUnseen: Count,
    codePoints: Count,
    codePointsShown: Count,
    codePointsRepresented: Count,
    codePointsUnseen: Count,
    inspectedShare: z.number().min(0).max(1),
  }),
  components: z.strictObject({
    total: Count,
    meaningful: Count,
    stubs: Count,
    withShownFile: Count,
    meaningfulWithShownFile: Count,
  }),
  roles: z.record(z.string(), RoleInventoryRecord),
  generatedShareOfSourceInventory: z.number().min(0).max(1),
  documentation: z.array(
    z.strictObject({
      category: z.string().max(32),
      files: Count,
      filesShown: Count,
      filesRepresented: Count,
      codePoints: Count,
      codePointsShown: Count,
    }),
  ),
});

export const CoverageRecord = z.strictObject({
  schema: z.literal(COVERAGE_RECORD_SCHEMA_ID),
  policy: z.strictObject({
    windowing: z.string().max(64),
    selection: z.string().max(64),
    routing: z.string().max(64),
  }),
  budgets: z.strictObject({ statement: Count, source: Count, metadata: Count }),
  snapshots: z
    .array(
      z.strictObject({
        snapshotId: z.string().max(64),
        sourceType: z.enum(['devpost', 'github', 'deployment', 'video']),
        status: z.enum(['captured', 'partial']),
        contentHash: Hex64,
        provenance: z.enum(['fetched', 'organizer_supplied']),
        partialReasons: z.array(z.string().max(64)).max(32),
      }),
    )
    .max(COVERAGE_RECORD_LIMITS.snapshots),
  verdict: z.enum(COVERAGE_VERDICT_VALUES),
  concerns: z.array(z.string().max(64)).max(32),
  relevance: z.literal('not_established'),
  roleBasis: z.literal('path_only'),
  measures: CoverageMeasuresRecord,
  /** Largest first; at most COVERAGE_RECORD_LIMITS.components, with `componentsTruncated` saying whether more existed. */
  components: z.array(CoverageComponentRecord).max(COVERAGE_RECORD_LIMITS.components),
  componentsTruncated: z.boolean(),
  artifacts: z.array(CoverageArtifactRecord).max(COVERAGE_RECORD_LIMITS.artifacts),
  /** Artifacts routing deliberately did not show (listings, history, duplicates of a structured form...), with the stable reason. */
  skipped: z
    .array(
      z.strictObject({
        snapshotId: z.string().max(64),
        key: z.string().max(1_024),
        reason: z.string().max(64),
        totalCodePoints: Count,
      }),
    )
    .max(COVERAGE_RECORD_LIMITS.skipped),
  /** What reached the dimension assessors: the closed notices, and the limitations derived by code from this very record. */
  assessorInputs: z.strictObject({
    /** Buckets whose text exceeded the budget and was sampled (the input of the `source_sampled` limitation). */
    sampledBuckets: z.array(z.enum(['statement', 'source', 'metadata'])).max(3),
    notices: z.array(z.string().max(64)).max(16),
    limitations: z
      .array(
        z.strictObject({
          code: z.string().max(64),
          count: Count,
          subjects: z.array(z.string().max(1_100)).max(COVERAGE_RECORD_LIMITS.subjects),
        }),
      )
      .max(32),
  }),
});
export type CoverageRecord = z.infer<typeof CoverageRecord>;

/** Why a stored record is not trusted (stable codes). */
export const COVERAGE_PROBLEM_VALUES = [
  'record_text_hash_mismatch',
  'record_unreadable',
  'record_mirror_differs',
  'record_run_mismatch',
  'record_snapshots_mismatch',
  'record_inconsistent',
  'limitations_missing_from_assessment',
  // External provenance (P6B-beta3-R2): the record disagrees with the immutable evidence the run was pinned to, or that evidence cannot be read.
  'provenance_unavailable',
  'provenance_run_mismatch',
  'provenance_policy_mismatch',
  'provenance_budget_mismatch',
  'provenance_snapshot_mismatch',
  'provenance_artifact_mismatch',
  'provenance_selection_mismatch',
  'provenance_measures_mismatch',
  'provenance_limitations_mismatch',
] as const;
export type CoverageProblem = (typeof COVERAGE_PROBLEM_VALUES)[number];

/** What the API returns about coverage: a bounded, judge-readable summary of the verified record. */
export interface AssessmentCoverageView {
  /** `recorded`: a record exists and was checked. `not_recorded`: an assessment from before coverage records existed (coverage UNKNOWN, never "complete"). */
  readonly status: 'recorded' | 'not_recorded';
  readonly verified: boolean;
  readonly problems: readonly CoverageProblem[];
  readonly recordSha256: string | null;
  readonly policy: CoverageRecord['policy'] | null;
  readonly verdict: CoverageVerdictValue | null;
  readonly concerns: readonly string[];
  readonly relevance: 'not_established';
  readonly roleBasis: 'path_only';
  /**
   * How a verified record was checked against the immutable evidence. `recomputed_from_snapshots`: the selection was run again over the pinned
   * snapshots' stored text under the run's frozen configuration and equals the record exactly. `budgets`: whether the source budget was pinned by
   * the run's source extraction identity (`pinned_by_extraction`) or only shown to be one of the budgets the frozen configuration allows
   * (`allowed_set_only`: a run refused before any extraction exists). null when not verified.
   */
  readonly provenance: {
    readonly method: 'recomputed_from_snapshots';
    readonly budgets: 'pinned_by_extraction' | 'allowed_set_only';
  } | null;
  readonly measures: CoverageRecord['measures'] | null;
  /** The components that were not fully inspected, largest first (bounded). */
  readonly omittedComponents: readonly {
    readonly component: string;
    readonly codePoints: number;
    readonly inspectedCodePoints: number;
    readonly stub: boolean;
  }[];
  /** Documentation categories with how much of each was inspected. */
  readonly documentation: CoverageRecord['measures']['documentation'];
  readonly snapshots: CoverageRecord['snapshots'];
  readonly assessorNotices: readonly string[];
  readonly artifactCount: number;
  readonly skippedCount: number;
  readonly componentsTruncated: boolean;
}

/**
 * P6D: the source types every submission is expected to have (the pair the submission flow asks for). An assessment whose pinned captures do not
 * include one of them examined material from the others only; that is missing evidence (never a low score), and it is reported as such.
 */
export const EXPECTED_SOURCE_TYPES = ['github', 'devpost'] as const;
export type ExpectedSourceType = (typeof EXPECTED_SOURCE_TYPES)[number];

/** The expected source types with NO usable capture among the snapshots an assessment was pinned to. */
export function missingExpectedSources(
  snapshots: readonly { readonly sourceType: string }[],
): ExpectedSourceType[] {
  const present = new Set(snapshots.map((snapshot) => snapshot.sourceType));
  return EXPECTED_SOURCE_TYPES.filter((type) => !present.has(type));
}

/** The one-line account of coverage that travels with a list row or a run (the full view is on the assessment detail). */
export interface AssessmentCoverageSummary {
  readonly status: 'recorded' | 'not_recorded';
  /** false when the record failed its checks: nothing derived from it is shown. */
  readonly verified: boolean;
  readonly verdict: CoverageVerdictValue | null;
  readonly concerns: readonly string[];
  /** A pinned capture was itself partial (material beyond its limits was never obtained). */
  readonly partialCapture: boolean;
  /**
   * P6D: expected source types (GitHub, Devpost) that had no usable capture when the assessment was pinned (never captured, or the capture
   * failed). Empty when coverage is not verified: nothing is claimed about what an unverified record would say.
   */
  readonly missingSources: readonly ExpectedSourceType[];
}

/** The full stored record of one assessment, returned only when it passed verification. */
export interface AssessmentCoverageRecordResponse {
  readonly assessmentId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly view: AssessmentCoverageView;
  readonly record: CoverageRecord | null;
}
