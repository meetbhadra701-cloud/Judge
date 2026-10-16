import {
  AssessmentPipelineConfig,
  checkCoverageIdentity,
  PROVENANCE_VERIFIER_VERSION,
  recomputeCoverage,
  type BudgetBinding,
  type TrustedArtifactMeta,
  type TrustedCoverageEvidence,
  type TrustedPin,
} from '@judge-copilot/assessment';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type { CoverageProblem, CoverageRecord } from '@judge-copilot/schemas';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { JudgeDatabase } from './client.js';
import {
  analysisRuns,
  assessmentRunExtractions,
  assessmentRunInputs,
  assessmentRunInputSnapshots,
  graphExtractions,
  sourceSnapshotArtifacts,
  sourceSnapshots,
} from './schema/index.js';

/*
 * The TRUSTED side of coverage verification (P6B-beta3-R2): what the immutable tables say about a run, read independently of the coverage
 * record. Everything here is a SELECT. The artifact metadata (id, key, kind, media type, SHA-256 and length of the text) is computed by the
 * database from `text_content`, and the table's own CHECK constraints (content_hash = SHA-256 of the text, byte_length = octet_length) are what
 * make those values properties of the rows rather than claims. The text itself is fetched only when a recomputation is actually needed.
 */

export interface LoadedCoverageEvidence {
  readonly evidence: TrustedCoverageEvidence;
  /** Identifies exactly these inputs (and this verifier): equal fingerprints mean an equal verification outcome. */
  readonly fingerprint: string;
}

export async function loadCoverageEvidence(
  db: JudgeDatabase,
  runId: string,
): Promise<LoadedCoverageEvidence | null> {
  const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
  if (!run?.projectId) return null;
  const [inputs] = await db
    .select({ pipelineConfig: assessmentRunInputs.pipelineConfig })
    .from(assessmentRunInputs)
    .where(eq(assessmentRunInputs.runId, runId));
  const parsedConfig = AssessmentPipelineConfig.safeParse(inputs?.pipelineConfig);
  const pinRows = await db
    .select({
      snapshotId: assessmentRunInputSnapshots.snapshotId,
      pinnedHash: assessmentRunInputSnapshots.snapshotContentHash,
      snapshot: sourceSnapshots,
    })
    .from(assessmentRunInputSnapshots)
    .innerJoin(sourceSnapshots, eq(sourceSnapshots.id, assessmentRunInputSnapshots.snapshotId))
    .where(eq(assessmentRunInputSnapshots.runId, runId))
    .orderBy(asc(assessmentRunInputSnapshots.snapshotId));
  const pins: TrustedPin[] = pinRows.map(({ snapshotId, pinnedHash, snapshot }) => ({
    snapshotId,
    pinnedContentHash: pinnedHash,
    projectId: snapshot.projectId,
    sourceType: snapshot.sourceType,
    status: snapshot.status,
    contentHash: snapshot.contentHash ?? '',
    provenance:
      snapshot.metadata?.['provenance'] === 'organizer_supplied' ? 'organizer_supplied' : 'fetched',
    partialReasons: [...snapshot.partialReasons],
  }));
  const snapshotIds = pins.map((pin) => pin.snapshotId);
  const metaRows =
    snapshotIds.length === 0
      ? []
      : await db
          .select({
            snapshotId: sourceSnapshotArtifacts.snapshotId,
            artifactId: sourceSnapshotArtifacts.id,
            key: sourceSnapshotArtifacts.artifactKey,
            kind: sourceSnapshotArtifacts.artifactKind,
            mediaType: sourceSnapshotArtifacts.mediaType,
            contentHash: sql<string>`encode(sha256(convert_to(${sourceSnapshotArtifacts.textContent}, 'UTF8')), 'hex')`,
            codePoints: sql<number>`char_length(${sourceSnapshotArtifacts.textContent})`.mapWith(
              Number,
            ),
          })
          .from(sourceSnapshotArtifacts)
          .where(inArray(sourceSnapshotArtifacts.snapshotId, snapshotIds))
          .orderBy(
            asc(sourceSnapshotArtifacts.snapshotId),
            asc(sourceSnapshotArtifacts.artifactKey),
          );
  const artifacts: TrustedArtifactMeta[] = metaRows.map((row) => ({ ...row }));
  const [bound] = await db
    .select({ configHash: graphExtractions.configHash })
    .from(assessmentRunExtractions)
    .innerJoin(graphExtractions, eq(graphExtractions.id, assessmentRunExtractions.extractionId))
    .where(
      and(eq(assessmentRunExtractions.runId, runId), eq(assessmentRunExtractions.kind, 'source')),
    );
  const evidence: TrustedCoverageEvidence = {
    runId,
    projectId: run.projectId,
    config: parsedConfig.success ? parsedConfig.data : null,
    pins,
    artifacts,
    boundSourceConfigHash: bound?.configHash ?? null,
  };
  const fingerprint = sha256Hex(
    canonicalJson({
      verifier: PROVENANCE_VERIFIER_VERSION,
      runId,
      projectId: evidence.projectId,
      config: evidence.config,
      pins,
      artifacts,
      bound: evidence.boundSourceConfigHash,
    }),
  );
  return { evidence, fingerprint };
}

async function loadTexts(
  db: JudgeDatabase,
  evidence: TrustedCoverageEvidence,
): Promise<(TrustedArtifactMeta & { text: string })[]> {
  const ids = evidence.pins.map((pin) => pin.snapshotId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      artifactId: sourceSnapshotArtifacts.id,
      text: sourceSnapshotArtifacts.textContent,
    })
    .from(sourceSnapshotArtifacts)
    .where(inArray(sourceSnapshotArtifacts.snapshotId, ids));
  const textById = new Map(rows.map((row) => [row.artifactId, row.text] as const));
  return evidence.artifacts.map((meta) => ({ ...meta, text: textById.get(meta.artifactId) ?? '' }));
}

export interface ProvenanceOutcome {
  readonly problems: readonly CoverageProblem[];
  readonly budgetBinding: BudgetBinding | null;
}

/** Deterministic outcomes are memoized per process: the key names the record and every trusted input, so a hit cannot be stale. */
const MEMO_LIMIT = 256;
const memo = new Map<string, ProvenanceOutcome>();
function remember(key: string, outcome: ProvenanceOutcome): void {
  if (memo.size >= MEMO_LIMIT) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, outcome);
}
/** Test seam: forget memoized outcomes. */
export function clearProvenanceMemo(): void {
  memo.clear();
}

/**
 * Verifies `record` against the immutable evidence of its run. Stage 1 (identity) needs no text; only a record that survives it is
 * recomputed from the stored artifact text. A failure to read the evidence at all is a failure, never a pass.
 */
export async function verifyCoverageProvenance(
  db: JudgeDatabase,
  runId: string,
  record: CoverageRecord,
  recordSha256: string,
): Promise<ProvenanceOutcome> {
  let loaded: LoadedCoverageEvidence | null;
  try {
    loaded = await loadCoverageEvidence(db, runId);
  } catch {
    return { problems: ['provenance_unavailable'], budgetBinding: null };
  }
  if (loaded === null) return { problems: ['provenance_run_mismatch'], budgetBinding: null };
  const key = `${recordSha256}:${loaded.fingerprint}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const identity = checkCoverageIdentity(record, loaded.evidence);
  if (identity.problems.length > 0) {
    const outcome = { problems: identity.problems, budgetBinding: identity.budgetBinding };
    remember(key, outcome);
    return outcome;
  }
  let outcome: ProvenanceOutcome;
  try {
    const artifacts = await loadTexts(db, loaded.evidence);
    const result = recomputeCoverage(record, { evidence: loaded.evidence, artifacts });
    outcome = { problems: result.problems, budgetBinding: result.budgetBinding };
  } catch {
    return { problems: ['provenance_unavailable'], budgetBinding: null };
  }
  remember(key, outcome);
  return outcome;
}
