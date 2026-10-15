import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  COVERAGE_RECORD_LIMITS,
  COVERAGE_RECORD_SCHEMA_ID,
  CoverageRecord,
  type AssessmentCoverageView,
  type CoverageProblem,
} from '@judge-copilot/schemas';
import { buildCoverageReport, type ArtifactCoverage, type CoverageRole } from './coverage.js';
import { coverageLimitations } from './coverage-limitations.js';
import { SOURCE_ROUTING_POLICY, type RoutedSourceType } from './routing.js';
import type { ProseCategory } from './selection-v3.js';
import {
  SELECTION_POLICY_VALUES,
  type SelectionPolicyId,
  type WindowingBudgets,
  type WindowingResult,
} from './windowing.js';

/*
 * Building and CHECKING the stored coverage record (see packages/schemas/src/coverage.ts). The record is derived from the windowing result by code;
 * it is verified by re-deriving what can be re-derived from the record's own entries (measures, verdict, concerns, the limitations that reached the
 * assessors) and comparing: a record whose entries, verdict or limitations were altered no longer agrees with itself.
 */

export interface PinnedSnapshotFacts {
  readonly snapshotId: string;
  readonly sourceType: RoutedSourceType;
  readonly status: 'captured' | 'partial';
  readonly contentHash: string;
  readonly provenance: 'fetched' | 'organizer_supplied';
  readonly partialReasons: readonly string[];
}

export interface BuiltCoverageRecord {
  readonly record: CoverageRecord;
  /** The authoritative bytes. */
  readonly canonical: string;
  /** SHA-256 of `canonical`: the record's content address. */
  readonly sha256: string;
}

const ROUTING_REASONS_NOT_SKIPS = new Set(['budget_exhausted', 'duplicate_content']);

export function buildCoverageRecord(input: {
  readonly windowing: WindowingResult;
  readonly budgets: WindowingBudgets;
  readonly snapshots: readonly PinnedSnapshotFacts[];
  readonly notices: readonly string[];
}): BuiltCoverageRecord {
  const { windowing } = input;
  const report = windowing.coverage;
  const sampled = windowing.buckets.filter((b) => b.sampled).map((b) => b.bucket);
  const snapshots = [...input.snapshots].sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : 1));
  const components = report.components.slice(0, COVERAGE_RECORD_LIMITS.components);
  const record: CoverageRecord = {
    schema: COVERAGE_RECORD_SCHEMA_ID,
    policy: {
      windowing: windowing.policy.windowing,
      selection: windowing.policy.selection,
      routing: SOURCE_ROUTING_POLICY,
    },
    budgets: { ...input.budgets },
    snapshots: snapshots.map((s) => ({ ...s, partialReasons: [...s.partialReasons].sort() })),
    verdict: report.verdict,
    concerns: [...report.concerns],
    relevance: 'not_established',
    roleBasis: 'path_only',
    measures: JSON.parse(JSON.stringify(report.measures)) as CoverageRecord['measures'],
    components: components.map((c) => ({ ...c })),
    componentsTruncated: report.components.length > components.length,
    artifacts: report.artifacts.map((a) => ({
      snapshotId: a.snapshotId,
      artifactId: a.artifactId,
      key: a.artifactKey,
      sourceType: a.sourceType,
      bucket: a.bucket,
      role: a.role,
      component: a.component,
      category: a.category,
      status: a.status,
      totalCodePoints: a.totalCodePoints,
      shownCodePoints: a.shownCodePoints,
      passagesShown: a.passagesShown,
      shownEnd: a.shownEnd,
      unshown: a.unshownRanges.map((r) => [r.start, r.end] as [number, number]),
      textSha256: a.textSha256,
      duplicateOf: a.duplicateOf,
      represented: a.represented,
      representedCodePoints: a.representedCodePoints,
    })),
    skipped: windowing.omissions
      .filter((o) => !ROUTING_REASONS_NOT_SKIPS.has(o.reason))
      .map((o) => ({
        snapshotId: o.snapshotId,
        key: o.artifactKey,
        reason: o.reason,
        totalCodePoints: o.totalCodePoints,
      }))
      .slice(0, COVERAGE_RECORD_LIMITS.skipped),
    assessorInputs: {
      sampledBuckets: [...sampled].sort(),
      notices: [...input.notices],
      limitations: coverageLimitations(report, sampled, input.snapshots).map((l) => ({
        code: l.code,
        count: l.count,
        subjects: [...l.subjects],
      })),
    },
  };
  const parsed = CoverageRecord.parse(record);
  const canonical = canonicalJson(parsed);
  return { record: parsed, canonical, sha256: sha256Hex(canonical) };
}

/** The coverage report as the record's own entries imply it (ranges are not needed by any measure). */
function reportFromRecord(record: CoverageRecord): ReturnType<typeof buildCoverageReport> | null {
  if (!(SELECTION_POLICY_VALUES as readonly string[]).includes(record.policy.selection))
    return null;
  const entries: ArtifactCoverage[] = record.artifacts.map((a) => ({
    snapshotId: a.snapshotId,
    artifactId: a.artifactId,
    artifactKey: a.key,
    sourceType: a.sourceType,
    bucket: a.bucket,
    role: a.role as CoverageRole,
    component: a.component,
    category: a.category as ProseCategory | null,
    status: a.status,
    totalCodePoints: a.totalCodePoints,
    shownCodePoints: a.shownCodePoints,
    passagesShown: a.passagesShown,
    shownEnd: a.shownEnd,
    shownRanges: [],
    unshownRanges: a.unshown.map(([start, end]) => ({ start, end })),
    textSha256: a.textSha256,
    duplicateOf: a.duplicateOf,
    represented: a.represented,
    representedCodePoints: a.representedCodePoints,
  }));
  return buildCoverageReport(entries, record.policy.selection as SelectionPolicyId);
}

export interface CoverageVerification {
  readonly ok: boolean;
  readonly problems: readonly CoverageProblem[];
  /** The parsed record when it is readable (even if other checks failed); callers decide whether to show it. */
  readonly record: CoverageRecord | null;
}

export function verifyCoverageRecord(
  stored: {
    readonly canonical: string;
    readonly sha256: string;
    /** The queryable jsonb mirror. */
    readonly mirror: unknown;
  },
  expected: {
    readonly pinnedSnapshotIds: readonly string[];
    /** The assessment-level limitations as stored (null: not an assessment yet, e.g. a refused run, so this check is skipped). */
    readonly storedLimitations:
      readonly { code: string; count: number; subjects: readonly string[] }[] | null;
  },
): CoverageVerification {
  const problems = new Set<CoverageProblem>();
  if (sha256Hex(stored.canonical) !== stored.sha256) problems.add('record_text_hash_mismatch');
  let parsed: CoverageRecord | null = null;
  try {
    const result = CoverageRecord.safeParse(JSON.parse(stored.canonical));
    if (result.success && canonicalJson(result.data) === stored.canonical) parsed = result.data;
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    problems.add('record_unreadable');
    return { ok: false, problems: [...problems], record: null };
  }
  if (canonicalJson(stored.mirror) !== stored.canonical) problems.add('record_mirror_differs');

  const pinned = [...expected.pinnedSnapshotIds].sort().join(',');
  const recorded = parsed.snapshots
    .map((s) => s.snapshotId)
    .sort()
    .join(',');
  if (pinned !== recorded) problems.add('record_snapshots_mismatch');

  const report = reportFromRecord(parsed);
  if (report === null) {
    problems.add('record_inconsistent');
  } else {
    const consistent =
      report.verdict === parsed.verdict &&
      canonicalJson(report.concerns) === canonicalJson(parsed.concerns) &&
      canonicalJson(report.measures) === canonicalJson(parsed.measures) &&
      canonicalJson(report.components.slice(0, parsed.components.length)) ===
        canonicalJson(parsed.components) &&
      canonicalJson(
        coverageLimitations(report, parsed.assessorInputs.sampledBuckets, parsed.snapshots).map(
          (l) => ({
            code: l.code,
            count: l.count,
            subjects: [...l.subjects],
          }),
        ),
      ) === canonicalJson(parsed.assessorInputs.limitations);
    if (!consistent) problems.add('record_inconsistent');
  }

  if (expected.storedLimitations !== null) {
    const stored = new Map(
      expected.storedLimitations.map((l) => [
        l.code,
        canonicalJson({ count: l.count, subjects: [...l.subjects] }),
      ]),
    );
    for (const required of parsed.assessorInputs.limitations) {
      const same =
        stored.get(required.code) ===
        canonicalJson({ count: required.count, subjects: required.subjects });
      if (!same) problems.add('limitations_missing_from_assessment');
    }
  }
  return { ok: problems.size === 0, problems: [...problems], record: parsed };
}

export const COVERAGE_VIEW_OMITTED_COMPONENTS = 25;

/** The judge-readable summary of a verified record. A record that failed verification shows NOTHING derived from it. */
export function coverageViewOf(
  verification: CoverageVerification | null,
  recordSha256: string | null,
): AssessmentCoverageView {
  const base = {
    relevance: 'not_established',
    roleBasis: 'path_only',
  } as const;
  if (verification === null) {
    return {
      ...base,
      status: 'not_recorded',
      verified: false,
      problems: [],
      recordSha256: null,
      policy: null,
      verdict: null,
      concerns: [],
      measures: null,
      omittedComponents: [],
      documentation: [],
      snapshots: [],
      assessorNotices: [],
      artifactCount: 0,
      skippedCount: 0,
      componentsTruncated: false,
    };
  }
  const record = verification.ok ? verification.record : null;
  if (record === null) {
    return {
      ...base,
      status: 'recorded',
      verified: false,
      problems: verification.problems,
      recordSha256,
      policy: null,
      verdict: null,
      concerns: [],
      measures: null,
      omittedComponents: [],
      documentation: [],
      snapshots: [],
      assessorNotices: [],
      artifactCount: 0,
      skippedCount: 0,
      componentsTruncated: false,
    };
  }
  return {
    ...base,
    status: 'recorded',
    verified: true,
    problems: [],
    recordSha256,
    policy: record.policy,
    verdict: record.verdict,
    concerns: record.concerns,
    measures: record.measures,
    omittedComponents: record.components
      .filter(
        (c) =>
          c.implementationCodePointsShown + c.implementationCodePointsRepresented <
          c.implementationCodePoints,
      )
      .slice(0, COVERAGE_VIEW_OMITTED_COMPONENTS)
      .map((c) => ({
        component: c.component,
        codePoints: c.implementationCodePoints,
        inspectedCodePoints:
          c.implementationCodePointsShown + c.implementationCodePointsRepresented,
        stub: c.stub,
      })),
    documentation: record.measures.documentation,
    snapshots: record.snapshots,
    assessorNotices: record.assessorInputs.notices,
    artifactCount: record.artifacts.length,
    skippedCount: record.skipped.length,
    componentsTruncated: record.componentsTruncated,
  };
}
