import type { ScoreReport, ScoreReportBody } from '@judge-copilot/schemas';
import { hashOf } from './canonical.js';

/*
 * The one additive public export of M5 (design §8.9, owner decision D15): verifying a report's `outputHash` WITHOUT changing the engine.
 *
 * It reproduces the engine's existing computation exactly: `outputHash = hashOf(body)` where `body` is the report WITHOUT `outputHash`
 * (engine.ts computes `const outputHash = hashOf(body)` and then returns `{ ...body, outputHash }`). It is NOT the SHA-256 of the whole
 * serialized report, which is a different value. `engine.ts` is deliberately not edited, so the engine version, parameters, formulas
 * and every golden hash are unchanged by construction.
 */

/** Exactly the engine's rule: SHA-256 of the canonical JSON of the report BODY (no outputHash). */
export function reportOutputHash(body: ScoreReportBody): string {
  return hashOf(body);
}

/** Strips `outputHash`, recomputes it by the engine's rule and compares with the report's own value. */
export function verifyScoreReportHash(report: ScoreReport): {
  ok: boolean;
  expected: string;
  actual: string;
} {
  const { outputHash, ...body } = report;
  const actual = reportOutputHash(body);
  return { ok: actual === outputHash, expected: outputHash, actual };
}
