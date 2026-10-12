import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { ScoreReport } from '@judge-copilot/schemas';
import { reportOutputHash, roundReported } from '@judge-copilot/scoring';

/*
 * `verifyStoredAssessment` (design §8.8): pure verification of a STORED report. Four different things must never be conflated:
 *   report body             the M4 `ScoreReportBody` (no `outputHash`)
 *   M4 `outputHash`         `reportOutputHash(body)` = SHA-256 of the canonical JSON of the BODY (it EXCLUDES itself)
 *   report_canonical        the full canonical text, `canonicalJson({ ...body, outputHash })`: the authoritative stored bytes
 *   report_text_sha256      an independent SHA-256 of those stored bytes: storage integrity only, NOT the M4 outputHash
 * PostgreSQL `jsonb` does not preserve key order or numeric text, so the text column is authoritative and the jsonb mirror is only
 * compared after canonical re-serialization.
 */

export interface StoredAssessmentReport {
  readonly reportCanonical: string;
  readonly reportTextSha256: string;
  /** The `output_hash` column. */
  readonly outputHash: string;
  /** The queryable jsonb mirror, as read back (optional). */
  readonly reportJson?: unknown;
}

export const STORED_REPORT_CHECKS = [
  'text_hash',
  'schema',
  'output_hash',
  'stored_output_hash',
  'canonical_fixed_point',
  'jsonb_mirror',
] as const;
export type StoredReportCheck = (typeof STORED_REPORT_CHECKS)[number];

export type StoredReportVerification =
  { readonly ok: true } | { readonly ok: false; readonly failed: StoredReportCheck };

export function verifyStoredAssessment(stored: StoredAssessmentReport): StoredReportVerification {
  const fail = (failed: StoredReportCheck): StoredReportVerification => ({ ok: false, failed });
  // (1) storage integrity of the bytes
  if (sha256Hex(stored.reportCanonical) !== stored.reportTextSha256) return fail('text_hash');
  // (2) the bytes are a valid report
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stored.reportCanonical);
  } catch {
    return fail('schema');
  }
  const parsed = ScoreReport.safeParse(parsedJson);
  if (!parsed.success) return fail('schema');
  // (3) M4's own rule: strip outputHash, hash the BODY
  const { outputHash, ...body } = parsed.data;
  if (reportOutputHash(body) !== outputHash) return fail('output_hash');
  if (outputHash !== stored.outputHash) return fail('stored_output_hash');
  // (4) the canonical form is a fixed point
  if (canonicalJson(parsed.data) !== stored.reportCanonical) return fail('canonical_fixed_point');
  // (5) the jsonb mirror, compared canonically
  if (
    stored.reportJson !== undefined &&
    canonicalJson(stored.reportJson) !== stored.reportCanonical
  ) {
    return fail('jsonb_mirror');
  }
  return { ok: true };
}

/** The bytes and hashes to store for a report produced by the engine. (The engine itself is not changed.) */
export function storedFormOf(report: ScoreReport): StoredAssessmentReport {
  const reportCanonical = canonicalJson(report);
  return {
    reportCanonical,
    reportTextSha256: sha256Hex(reportCanonical),
    outputHash: report.outputHash,
    reportJson: JSON.parse(reportCanonical) as unknown,
  };
}

// -- Judgment rows versus the verified report (P6A-R1, P6A-R2) -------------------------------------------------------------------

/*
 * `verifyStoredAssessment` authenticates ONE thing: the stored report bytes (text hash, schema, M4 output hash, canonical fixed point, jsonb
 * mirror). It does not authenticate the per-dimension judgment ROWS (`assessment_dimension_judgments`, `assessment_judgment_citations`)
 * that carry the rationale, limitation codes and citation notes, and no hash in the report covers those texts.
 *
 * `verifyJudgmentsAgainstReport` closes the part that can be closed without a schema change: every fact about the rows that the
 * VERIFIED report also states must agree with it. The report is the source of truth for state and numbers:
 *
 *   dimensions   the rows cover exactly the report's dimensions (no missing, extra or duplicated dimension)
 *   state        an `assessed` dimension has a `scored` row whose score, AT THE REPORT'S CANONICAL PRECISION, equals the report's number;
 *                an `insufficient_evidence` dimension has no number to show, in one of two shapes (below)
 *   disposition  `scored` if and only if the row holds a judged value (an assessed dimension, or a value M4 did not use)
 *   citations    the cited evidence ids of the row equal the report's `citedEvidenceIds` (the scorer was handed exactly these, whatever
 *                their kind: M4 lists every cited id and only then decides which are usable)
 *
 * CANONICAL SCORE PRECISION (P6A-R2). The assessor's score is a JavaScript number stored as `double precision` in the row. M4 never
 * reports it as is: the report holds `roundReported(score)` = the decimal the number PRINTS as (`String(score)`), rounded ONCE, half-up,
 * to `SCORING_PARAMETERS.roundingDecimals` (4) places, with negative zero normalized to zero. A row therefore matches its report when
 * `roundReported(row.score) === dimension.scoreOnScale`, with `roundReported` being the engine's own function (not a copy, and no epsilon).
 * What this authenticates is the CANONICAL REPORT-LEVEL SCORE, an equivalence class of raw values: 7.33333 and 7.33334 are both 7.3333 and
 * cannot be told apart by this check. The raw value is covered only by the report's `inputFingerprint`, which cannot be recomputed here
 * without the whole authorized scoring context.
 *
 * TWO SHAPES OF "NO NUMBER". (1) `assessor_reported_insufficient`: the row is non-scored, has no score and a non-`scored` disposition
 * (the assessor declared insufficiency, or code downgraded the unit). (2) `no_usable_citation`: the assessor judged a value, the gates
 * passed, but every cited item was of a kind that cannot support anything (absence, unknown, contradiction), so M4 refused to use the
 * value ("missing evidence is not negative evidence"). The row is then legitimately `scored` with a finite number that the report does
 * not carry and the API never shows.
 *
 * It does NOT authenticate the free text of a row (rationale, notes, limitation codes, attempt counts, critic flags): those are returned
 * only for a report that verifies and whose rows agree as above, and are described as unauthenticated text by the API contract.
 */

/**
 * The canonical report-level form of a raw judged score, or null if the value cannot be a score at all (not finite, or outside what the
 * exact rounding accepts). This IS the engine's `roundReported`; it only converts its refusal into null so a hostile value fails closed.
 */
export function canonicalReportedScore(raw: number): number | null {
  try {
    return roundReported(raw);
  } catch {
    return null;
  }
}

export const JUDGMENT_MISMATCH_VALUES = [
  'dimension_set',
  'dimension_duplicated',
  'outcome_state',
  'score',
  'disposition',
  'citations',
] as const;
export type JudgmentMismatch = (typeof JUDGMENT_MISMATCH_VALUES)[number];

export interface StoredJudgmentFacts {
  readonly dimensionId: string;
  readonly outcomeKind: string;
  readonly score: number | null;
  readonly disposition: string;
  readonly citationEvidenceIds: readonly string[];
}

export type JudgmentConsistency =
  { readonly ok: true } | { readonly ok: false; readonly mismatch: JudgmentMismatch };

export function verifyJudgmentsAgainstReport(
  report: ScoreReport,
  rows: readonly StoredJudgmentFacts[],
): JudgmentConsistency {
  const fail = (mismatch: JudgmentMismatch): JudgmentConsistency => ({ ok: false, mismatch });
  const byId = new Map<string, StoredJudgmentFacts>();
  for (const row of rows) {
    if (byId.has(row.dimensionId)) return fail('dimension_duplicated');
    byId.set(row.dimensionId, row);
  }
  if (
    byId.size !== report.dimensions.length ||
    report.dimensions.some((dimension) => !byId.has(dimension.id))
  ) {
    return fail('dimension_set');
  }
  for (const dimension of report.dimensions) {
    const row = byId.get(dimension.id);
    if (!row) return fail('dimension_set');
    const canonical = row.score === null ? null : canonicalReportedScore(row.score);
    if (dimension.state === 'assessed') {
      if (row.outcomeKind !== 'scored') return fail('outcome_state');
      if (canonical === null || canonical !== dimension.scoreOnScale) return fail('score');
      if (row.disposition !== 'scored') return fail('disposition');
    } else if (dimension.reason === 'no_usable_citation') {
      // a judged value M4 did not use: the row is scored with a finite number the report (rightly) does not carry
      if (row.outcomeKind !== 'scored') return fail('outcome_state');
      if (canonical === null) return fail('score');
      if (row.disposition !== 'scored') return fail('disposition');
    } else {
      if (row.outcomeKind !== 'insufficient_evidence') return fail('outcome_state');
      if (row.score !== null) return fail('score');
      if (row.disposition === 'scored') return fail('disposition');
    }
    const stored = [...new Set(row.citationEvidenceIds)].sort();
    const reported = [...new Set(dimension.citedEvidenceIds)].sort();
    if (
      stored.length !== reported.length ||
      stored.some((id, index) => id !== reported[index]) ||
      row.citationEvidenceIds.length !== stored.length
    ) {
      return fail('citations');
    }
  }
  return { ok: true };
}
