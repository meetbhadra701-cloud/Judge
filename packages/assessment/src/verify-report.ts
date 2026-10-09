import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { ScoreReport } from '@judge-copilot/schemas';
import { reportOutputHash } from '@judge-copilot/scoring';

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
