import type { CoverageRecord } from '@judge-copilot/schemas';
import { buildCoverageReport, type ArtifactCoverage, type CoverageRole } from '../coverage.js';
import { coverageLimitations } from '../coverage-limitations.js';
import type { ProseCategory } from '../selection-v3.js';
import type { SelectionPolicyId } from '../windowing.js';

/*
 * TEST SUPPORT: what an actor who can write a coverage record would do to make a forgery agree with ITSELF. After `change` edits the entries or
 * the snapshots, every derived field (measures, verdict, concerns, components, notices, limitations) is rebuilt with the public functions, so
 * the internal-integrity check of the R1 implementation accepts the result. The caller canonicalises and hashes it.
 */
/** Rewrites a record so that it is internally consistent after `change` (what a forger with the public functions would do). */
export function reforge(
  record: CoverageRecord,
  change: (r: CoverageRecord) => void,
): CoverageRecord {
  const forged = JSON.parse(JSON.stringify(record)) as CoverageRecord;
  change(forged);
  const entries: ArtifactCoverage[] = forged.artifacts.map((a) => ({
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
  const report = buildCoverageReport(entries, forged.policy.selection as SelectionPolicyId);
  forged.verdict = report.verdict;
  forged.concerns = [...report.concerns];
  forged.measures = JSON.parse(JSON.stringify(report.measures)) as CoverageRecord['measures'];
  forged.components = report.components.slice(0, forged.components.length).map((c) => ({ ...c }));
  const partial = forged.snapshots.some((s) => s.status === 'partial');
  forged.assessorInputs.notices = forged.assessorInputs.notices.filter(
    (n) => n !== 'partial_capture',
  );
  if (partial) forged.assessorInputs.notices.push('partial_capture');
  forged.assessorInputs.limitations = coverageLimitations(
    report,
    forged.assessorInputs.sampledBuckets,
    forged.snapshots,
  ).map((l) => ({ code: l.code, count: l.count, subjects: [...l.subjects] }));
  return forged;
}
