import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import {
  storedFormOf,
  verifyStoredAssessment,
  type StoredAssessmentReport,
} from './verify-report.js';

const GOLDEN = resolve(import.meta.dirname, '../../scoring/golden');

function goldenReports(): { name: string; report: ScoreReport }[] {
  return readdirSync(GOLDEN)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const parsed = ScoreReport.safeParse(JSON.parse(readFileSync(join(GOLDEN, name), 'utf8')));
      return parsed.success ? [{ name, report: parsed.data }] : [];
    });
}

const reports = goldenReports();
const reorderKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reorderKeys(v)]),
    );
  }
  return value;
};

describe('verifyStoredAssessment against the existing M4 golden reports', () => {
  it('finds the golden reports (the test fails if it finds none)', () => {
    expect(reports).toHaveLength(14);
  });

  it.each(reports.map((r) => [r.name, r.report] as const))(
    '%s: verifies through the stored form',
    (_name, report) => {
      const stored = storedFormOf(report);
      expect(verifyStoredAssessment(stored)).toEqual({ ok: true });
      // the three hashes are distinct things
      expect(stored.reportTextSha256).not.toBe(stored.outputHash);
      expect(sha256Hex(stored.reportCanonical)).toBe(stored.reportTextSha256);
      // a jsonb mirror that reordered every key still verifies (the text column is authoritative)
      expect(
        verifyStoredAssessment({ ...stored, reportJson: reorderKeys(stored.reportJson) }),
      ).toEqual({ ok: true });
    },
  );
});

describe('negative controls', () => {
  const first = reports[0];
  if (!first) throw new Error('no golden report');
  const stored = storedFormOf(first.report);
  const withText = (
    reportCanonical: string,
    extra: Partial<StoredAssessmentReport> = {},
  ): StoredAssessmentReport => ({
    ...stored,
    reportCanonical,
    reportTextSha256: sha256Hex(reportCanonical),
    ...extra,
  });
  const failed = (value: StoredAssessmentReport) => {
    const result = verifyStoredAssessment(value);
    return result.ok ? null : result.failed;
  };

  it('detects a changed byte of the stored text', () => {
    expect(failed({ ...stored, reportCanonical: `${stored.reportCanonical} ` })).toBe('text_hash');
  });

  it('detects a tampered body even when the attacker also recomputes the text hash (M4 outputHash check)', () => {
    const forged = JSON.parse(stored.reportCanonical) as Record<string, unknown>;
    forged['inputFingerprint'] = 'f'.repeat(64);
    expect(failed(withText(canonicalJson(forged)))).toBe('output_hash');
  });

  it('detects a tampered outputHash inside the text, and a different output_hash column', () => {
    const forged = JSON.parse(stored.reportCanonical) as Record<string, unknown>;
    forged['outputHash'] = 'e'.repeat(64);
    expect(failed(withText(canonicalJson(forged)))).toBe('output_hash');
    expect(failed({ ...stored, outputHash: 'e'.repeat(64) })).toBe('stored_output_hash');
  });

  it('detects text that is not a valid report', () => {
    expect(failed(withText('not json'))).toBe('schema');
    expect(
      failed(
        withText(
          canonicalJson({
            ...JSON.parse(stored.reportCanonical),
            engineVersion: 'scoring-engine/v0',
          }),
        ),
      ),
    ).toBe('schema');
    expect(
      failed(withText(canonicalJson({ ...JSON.parse(stored.reportCanonical), extra: 1 }))),
    ).toBe('schema');
  });

  it('detects non-canonical text (the canonical form is a fixed point)', () => {
    const pretty = JSON.stringify(JSON.parse(stored.reportCanonical), null, 2);
    expect(failed(withText(pretty))).toBe('canonical_fixed_point');
  });

  it('detects a jsonb mirror that differs from the authoritative text', () => {
    const mirror = JSON.parse(stored.reportCanonical) as { overall: { state?: string } };
    const altered = { ...mirror, overall: { ...mirror.overall, extra: true } };
    expect(failed({ ...stored, reportJson: altered })).toBe('jsonb_mirror');
  });

  it('hashing the FULL report (including outputHash) is not the M4 rule and never verifies', () => {
    const wrong = sha256Hex(canonicalJson(first.report));
    expect(wrong).not.toBe(first.report.outputHash);
    expect(failed({ ...stored, outputHash: wrong })).toBe('stored_output_hash');
  });

  it('storing only the jsonb and recomputing from it would still need the canonical form, which the text column carries', () => {
    // jsonb may re-order keys and re-print numbers; only canonical re-serialization makes the mirror comparable
    const mirror = reorderKeys(JSON.parse(stored.reportCanonical));
    expect(JSON.stringify(mirror)).not.toBe(stored.reportCanonical);
    expect(canonicalJson(mirror)).toBe(stored.reportCanonical);
  });
});
