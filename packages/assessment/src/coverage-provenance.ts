import { canonicalJson } from '@judge-copilot/context';
import type { CoverageProblem, CoverageRecord } from '@judge-copilot/schemas';
import { buildCoverageRecord } from './coverage-record.js';
import { extractionConfigHash, ladder, type EffectivePlan } from './extraction-plan.js';
import type { AssessmentPipelineConfig } from './pipeline-config.js';
import type { RoutedSourceType } from './routing.js';
import { runNotices } from './run-notices.js';
import {
  buildPassages,
  SELECTION_POLICY_VALUES,
  type SourceArtifact,
  type WindowingBudgets,
} from './windowing.js';

/*
 * EXTERNAL PROVENANCE of a coverage record (P6B-beta3-R2). `verifyCoverageRecord` proves only that a record agrees with ITSELF: a forger who
 * writes a consistent set of entries, a matching verdict, the right hashes and the right limitations passes it. A record is trustworthy only
 * if it agrees with evidence the record's author does not control. This module compares it with exactly that:
 *
 *   TRUSTED INPUTS (loaded by the caller from persisted, immutable rows -- never from the record):
 *     - the run's frozen pipeline configuration (policies, base windowing budgets, prompts...);
 *     - the snapshots the run was pinned to: project, source type, status, content hash, provenance, partial-capture reasons;
 *     - every artifact of those snapshots: id, key, kind, media type and stored text (the database itself enforces content_hash = SHA-256 of the
 *       text and byte_length, so the hash and length of an artifact are properties of the row, not claims);
 *     - the config hash of the run's bound SOURCE extraction, when it has one.
 *
 *   TWO STAGES.
 *     1. `checkCoverageIdentity` needs no text: every artifact the record names must be a real artifact of a pinned snapshot, with the recorded
 *        key, SHA-256 and length; the snapshots, policies and run must match. Cheap; run before anything is loaded.
 *     2. `recomputeCoverage` runs the deterministic selection AGAIN over the stored text, under the policy and budgets derived from the trusted
 *        inputs, builds the record the run would have written, and requires byte equality with the stored record (canonical JSON). Shown and
 *        omitted ranges, passage counts, statuses, duplicates, measures, verdict, concerns, skipped artifacts and the limitations that reached the
 *        assessors all come from this recomputation. Nothing is "recomputed from the record's own fields".
 *
 *   BUDGETS. The effective source budget is not in the frozen configuration (the preflight ladder may lower it). When the run has a source
 *   extraction, the plan is the unique ladder step whose extraction identity hash equals the persisted extraction's: the budget is pinned by data
 *   the record's author cannot choose. A run refused before any extraction exists has no such anchor; its budget is then only shown to be one of
 *   the budgets the frozen configuration allows (`allowed_set_only`), which is reported, not hidden.
 *
 *   NOT CLAIMED. Nothing here protects against a database administrator who rewrites every row (the snapshots, the extraction, the record and
 *   its hash together): that actor can make any consistent history. It defends against a defective or unauthorized APPLICATION write of a record,
 *   and against a record that was valid for other evidence.
 */

export const PROVENANCE_VERIFIER_VERSION = 'coverage-provenance/v1' as const;

export interface TrustedPin {
  readonly snapshotId: string;
  /** The content hash the run pinned (assessment_run_input_snapshots). */
  readonly pinnedContentHash: string;
  readonly projectId: string;
  readonly sourceType: RoutedSourceType;
  readonly status: string;
  /** The snapshot's own content hash. */
  readonly contentHash: string;
  readonly provenance: 'fetched' | 'organizer_supplied';
  readonly partialReasons: readonly string[];
}

export interface TrustedArtifactMeta {
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly key: string;
  readonly kind: string;
  readonly mediaType: string;
  /** SHA-256 of the stored text (database-enforced). */
  readonly contentHash: string;
  /** Length of the stored text in code points. */
  readonly codePoints: number;
}

export interface TrustedCoverageEvidence {
  readonly runId: string;
  readonly projectId: string;
  /** The run's frozen configuration, or null when the stored JSON no longer parses as one. */
  readonly config: AssessmentPipelineConfig | null;
  readonly pins: readonly TrustedPin[];
  readonly artifacts: readonly TrustedArtifactMeta[];
  /** `graph_extractions.config_hash` of the run's bound source extraction; null when the run has none (for example a run refused at the gate). */
  readonly boundSourceConfigHash: string | null;
}

export type BudgetBinding = 'pinned_by_extraction' | 'allowed_set_only';

export interface ProvenanceResult {
  readonly problems: readonly CoverageProblem[];
  /** Present when the plan could be determined (so callers can show how the budget was established). */
  readonly budgetBinding: BudgetBinding | null;
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** The plan (and so the budgets) the run executed under, derived from trusted inputs only. */
export function derivePlan(
  config: AssessmentPipelineConfig,
  boundSourceConfigHash: string | null,
  recordedBudgets: WindowingBudgets,
): { plan: EffectivePlan | null; binding: BudgetBinding } {
  const steps = ladder(config.windowing);
  if (boundSourceConfigHash !== null) {
    return {
      plan:
        steps.find((step) => extractionConfigHash(config, step) === boundSourceConfigHash) ?? null,
      binding: 'pinned_by_extraction',
    };
  }
  return {
    plan: steps.find((step) => sameJson(step.budgets, recordedBudgets)) ?? null,
    binding: 'allowed_set_only',
  };
}

/** Stage 1: no artifact text needed. */
export function checkCoverageIdentity(
  record: CoverageRecord,
  evidence: TrustedCoverageEvidence,
): ProvenanceResult {
  const problems = new Set<CoverageProblem>();
  if (evidence.config === null) {
    return { problems: ['provenance_unavailable'], budgetBinding: null };
  }
  const { config } = evidence;
  if (
    !(SELECTION_POLICY_VALUES as readonly string[]).includes(config.policies.selection) ||
    record.policy.selection !== config.policies.selection ||
    record.policy.windowing !== config.policies.windowing ||
    record.policy.routing !== config.policies.routing
  ) {
    problems.add('provenance_policy_mismatch');
  }
  // snapshots: the set, and every fact about each one, from the immutable rows
  const pinById = new Map(evidence.pins.map((pin) => [pin.snapshotId, pin] as const));
  if (
    record.snapshots.length !== evidence.pins.length ||
    new Set(record.snapshots.map((s) => s.snapshotId)).size !== record.snapshots.length
  ) {
    problems.add('provenance_snapshot_mismatch');
  }
  for (const snapshot of record.snapshots) {
    const pin = pinById.get(snapshot.snapshotId);
    if (
      pin === undefined ||
      pin.projectId !== evidence.projectId ||
      pin.contentHash !== pin.pinnedContentHash ||
      snapshot.contentHash !== pin.contentHash ||
      snapshot.sourceType !== pin.sourceType ||
      snapshot.status !== pin.status ||
      snapshot.provenance !== pin.provenance ||
      !sameJson([...snapshot.partialReasons].sort(), [...pin.partialReasons].sort())
    ) {
      problems.add('provenance_snapshot_mismatch');
    }
  }
  // artifacts: each one the record names must exist in a PINNED snapshot with this key, hash and length
  const byId = new Map(evidence.artifacts.map((a) => [a.artifactId, a] as const));
  for (const entry of record.artifacts) {
    const actual = byId.get(entry.artifactId);
    if (
      actual === undefined ||
      !pinById.has(entry.snapshotId) ||
      actual.snapshotId !== entry.snapshotId ||
      actual.key !== entry.key ||
      actual.contentHash !== entry.textSha256 ||
      actual.codePoints !== entry.totalCodePoints
    ) {
      problems.add('provenance_artifact_mismatch');
    }
  }
  if (new Set(record.artifacts.map((a) => a.artifactId)).size !== record.artifacts.length) {
    problems.add('provenance_artifact_mismatch');
  }
  // budgets
  const { plan, binding } = derivePlan(config, evidence.boundSourceConfigHash, record.budgets);
  if (plan === null || !sameJson(plan.budgets, record.budgets)) {
    problems.add('provenance_budget_mismatch');
  }
  return { problems: [...problems], budgetBinding: binding };
}

export interface RecomputeInput {
  readonly evidence: TrustedCoverageEvidence;
  /** The stored text of the pinned snapshots' artifacts (same order or any: the selection is order-independent). */
  readonly artifacts: readonly (TrustedArtifactMeta & { readonly text: string })[];
}

/** Stage 2: run the selection again from the stored text and require the record to be exactly what the run would have written. */
export function recomputeCoverage(record: CoverageRecord, input: RecomputeInput): ProvenanceResult {
  const { evidence } = input;
  const identity = checkCoverageIdentity(record, evidence);
  const problems = new Set<CoverageProblem>(identity.problems);
  const config = evidence.config;
  if (config === null || problems.has('provenance_unavailable')) {
    return { problems: [...problems], budgetBinding: identity.budgetBinding };
  }
  const { plan, binding } = derivePlan(config, evidence.boundSourceConfigHash, record.budgets);
  if (plan === null) {
    // identity already reported the budget; nothing further can be derived
    return { problems: [...problems], budgetBinding: binding };
  }
  const pinById = new Map(evidence.pins.map((pin) => [pin.snapshotId, pin] as const));
  const artifacts: SourceArtifact[] = [];
  for (const a of input.artifacts) {
    const pin = pinById.get(a.snapshotId);
    if (pin === undefined) continue; // not pinned: it takes no part in the selection (and the record must not name it)
    artifacts.push({
      snapshotId: a.snapshotId,
      artifactId: a.artifactId,
      sourceType: pin.sourceType,
      snapshotStatus: pin.status,
      key: a.key,
      kind: a.kind,
      mediaType: a.mediaType,
      text: a.text,
    });
  }
  const selection = config.policies.selection;
  const windowing = buildPassages(artifacts, plan.budgets, selection);
  const expected = buildCoverageRecord({
    windowing,
    budgets: plan.budgets,
    snapshots: evidence.pins.map((pin) => ({
      snapshotId: pin.snapshotId,
      sourceType: pin.sourceType,
      status: pin.status as 'captured' | 'partial',
      contentHash: pin.contentHash,
      provenance: pin.provenance,
      partialReasons: pin.partialReasons,
    })),
    notices: runNotices(windowing, evidence.pins),
  }).record;
  if (sameJson(expected, record)) return { problems: [...problems], budgetBinding: binding };

  // Not equal: say which part differs (a record is rejected as a whole; the codes only help the operator).
  const identityOf = (a: CoverageRecord['artifacts'][number]) => [
    a.snapshotId,
    a.artifactId,
    a.key,
    a.sourceType,
    a.totalCodePoints,
    a.textSha256,
  ];
  if (!sameJson(expected.artifacts.map(identityOf), record.artifacts.map(identityOf))) {
    problems.add('provenance_artifact_mismatch');
  }
  if (!sameJson(expected.snapshots, record.snapshots)) problems.add('provenance_snapshot_mismatch');
  if (!sameJson(expected.budgets, record.budgets)) problems.add('provenance_budget_mismatch');
  if (!sameJson(expected.policy, record.policy)) problems.add('provenance_policy_mismatch');
  const selectionOf = (r: CoverageRecord) => ({ artifacts: r.artifacts, skipped: r.skipped });
  if (!sameJson(selectionOf(expected), selectionOf(record)))
    problems.add('provenance_selection_mismatch');
  const measuresOf = (r: CoverageRecord) => ({
    verdict: r.verdict,
    concerns: r.concerns,
    measures: r.measures,
    components: r.components,
    truncated: r.componentsTruncated,
    relevance: r.relevance,
    roleBasis: r.roleBasis,
  });
  if (!sameJson(measuresOf(expected), measuresOf(record)))
    problems.add('provenance_measures_mismatch');
  if (!sameJson(expected.assessorInputs, record.assessorInputs))
    problems.add('provenance_limitations_mismatch');
  if (problems.size === identity.problems.length) problems.add('provenance_selection_mismatch'); // unequal in some other part
  return { problems: [...problems], budgetBinding: binding };
}
