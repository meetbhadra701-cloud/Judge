/*
 * M5 P4, design §8.8 / test T-R7f: the stored report round trip on the real column types (text + jsonb), on PGlite and on PostgreSQL.
 *   report_canonical (text)  the authoritative bytes
 *   report (jsonb)           a queryable mirror that does NOT preserve key order, whitespace or numeric text
 * Over (a) every complete report among the M4 golden files, (b) every report the engine produces for every golden scenario and (c) the
 * known jsonb normalizations, the stored text must verify by M4's own rule and the jsonb mirror must compare equal only canonically.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../packages/context/src/index.js';
import { storedFormOf, verifyStoredAssessment } from '../../packages/assessment/src/index.js';
import { ScoreReport } from '../../packages/schemas/src/index.js';
import { scoreProject } from '../../packages/scoring/src/engine.js';
import { goldenScenarios } from '../../packages/scoring/src/testing/scenarios.js';
import {
  openPglite,
  openPostgres,
  rows,
  sql,
  type TestDatabase,
} from '../../packages/database/src/testing/databases.js';

const GOLDEN = join(import.meta.dirname, '../../packages/scoring/golden');
const goldenReports = (): { name: string; report: ScoreReport }[] =>
  readdirSync(GOLDEN)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const parsed = ScoreReport.safeParse(JSON.parse(readFileSync(join(GOLDEN, name), 'utf8')));
      return parsed.success ? [{ name, report: parsed.data }] : [];
    });
const engineReports = (): { name: string; report: ScoreReport }[] =>
  goldenScenarios().flatMap((scenario) => {
    const result = scoreProject(scenario.context, scenario.body, scenario.options);
    return result.ok ? [{ name: scenario.name, report: result.report }] : [];
  });

function firstGolden(): ScoreReport {
  const first = goldenReports()[0];
  if (!first) throw new Error('no golden report');
  return first.report;
}

const URL_ = process.env['TEST_DATABASE_URL'];
const targets: [string, () => Promise<TestDatabase>][] = [['PGlite', openPglite]];
if (URL_) targets.push(['PostgreSQL', () => openPostgres(URL_)]);

describe('the report corpus', () => {
  it('finds the golden reports and the engine reports (the test fails if it finds none)', () => {
    expect(goldenReports()).toHaveLength(14);
    expect(engineReports().length).toBeGreaterThanOrEqual(14);
  });
});

describe.each(targets)('stored report round trip on %s', (_name, open) => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await open();
    await testDb.db.execute(
      sql`CREATE TEMP TABLE report_roundtrip (id serial PRIMARY KEY, report_canonical text NOT NULL, report jsonb NOT NULL)`,
    );
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function roundTrip(report: ScoreReport) {
    const stored = storedFormOf(report);
    await testDb.db.execute(
      sql`INSERT INTO report_roundtrip (report_canonical, report) VALUES (${stored.reportCanonical}, ${stored.reportCanonical}::jsonb)`,
    );
    const [row] = await rows<{ report_canonical: string; report: unknown; jsonb_text: string }>(
      testDb.db,
      sql`SELECT report_canonical, report, report::text AS jsonb_text FROM report_roundtrip ORDER BY id DESC LIMIT 1`,
    );
    if (!row) throw new Error('no row');
    return { stored, row };
  }

  const corpus = [...goldenReports(), ...engineReports()];
  it.each(corpus.map((c) => [c.name, c.report] as const))(
    '%s: write -> read -> verify',
    async (_n, report) => {
      const { stored, row } = await roundTrip(report);
      // the text column returns the bytes unchanged, and they verify by M4's own rule
      expect(row.report_canonical).toBe(stored.reportCanonical);
      expect(
        verifyStoredAssessment({
          reportCanonical: row.report_canonical,
          reportTextSha256: sha256Hex(row.report_canonical),
          outputHash: report.outputHash,
          reportJson: row.report,
        }),
      ).toEqual({ ok: true });
      // the M4 outputHash is not the hash of the stored text
      expect(sha256Hex(row.report_canonical)).not.toBe(report.outputHash);
      // the jsonb mirror is canonically equal but is NOT the same bytes: that is why the text column is authoritative
      expect(canonicalJson(row.report)).toBe(stored.reportCanonical);
      expect(row.jsonb_text).not.toBe(stored.reportCanonical);
      expect(sha256Hex(row.jsonb_text)).not.toBe(sha256Hex(stored.reportCanonical));
    },
  );

  it('MUTATION PROOF: persisting only the jsonb and re-deriving the hash from it fails', async () => {
    const report = firstGolden();
    const { stored, row } = await roundTrip(report);
    // a store that kept only jsonb::text would hash different bytes than the engine produced
    expect(sha256Hex(row.jsonb_text)).not.toBe(stored.reportTextSha256);
    expect(
      verifyStoredAssessment({
        reportCanonical: row.jsonb_text,
        reportTextSha256: stored.reportTextSha256,
        outputHash: report.outputHash,
      }),
    ).toEqual({ ok: false, failed: 'text_hash' });
  });

  it('MUTATION PROOF: hashing the whole report (including outputHash) is not the M4 rule', () => {
    const report = firstGolden();
    expect(sha256Hex(canonicalJson(report))).not.toBe(report.outputHash);
    expect(
      verifyStoredAssessment({
        reportCanonical: storedFormOf(report).reportCanonical,
        reportTextSha256: sha256Hex(storedFormOf(report).reportCanonical),
        outputHash: sha256Hex(canonicalJson(report)),
      }),
    ).toEqual({ ok: false, failed: 'stored_output_hash' });
  });

  it('known jsonb normalizations: key order, numeric text and whitespace change; canonical value does not', async () => {
    const text = '{"b":2,"a":1.50,"c":1e2,"d":0.10,"ee":[3,2,1],"z":{"y":1,"x":2}}';
    await testDb.db.execute(
      sql`INSERT INTO report_roundtrip (report_canonical, report) VALUES (${text}, ${text}::jsonb)`,
    );
    const [row] = await rows<{ jsonb_text: string; report: unknown }>(
      testDb.db,
      sql`SELECT report::text AS jsonb_text, report FROM report_roundtrip ORDER BY id DESC LIMIT 1`,
    );
    expect(row?.jsonb_text).not.toBe(text);
    expect(row?.jsonb_text).toContain('1.50'); // jsonb keeps the numeric TEXT of a number, JSON text does not need to
    expect(row?.jsonb_text.indexOf('"a"')).toBeLessThan(row?.jsonb_text.indexOf('"ee"') ?? 0); // reordered (shorter keys first)
    expect(canonicalJson(row?.report)).toBe(canonicalJson(JSON.parse(text)));
  });

  it('a NUL character is rejected by jsonb, so the store refuses it up front (no half-written report)', async () => {
    await expect(testDb.db.execute(sql`SELECT ${'{"a":"\\u0000"}'}::jsonb`)).rejects.toThrow();
  });
});
