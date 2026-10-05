import {
  deterministicIdAllocator,
  EvidenceGraphError,
  type GraphIssueCode,
} from '@judge-copilot/evidence';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import type { JudgeDatabase } from './index.js';
import { rows, testDatabaseTargets, type TestDatabase } from './testing/databases.js';
import { README_TEXT, seedGraphWorld, span, type GraphWorld } from './testing/graph-world.js';

/*
 * The M3 producer trust boundary, through the REAL write path (EvidenceGraphStore.createGraph).
 * A producer (a fixture today, a model in M5) must not be able to grant itself machine_verified,
 * judge_verified or live_verified by choosing the enum value, and repository prose (a README) is
 * still team-authored and cannot corroborate. A span proves provenance, never that the evidence
 * text or a claim is true.
 */

const API_TEXT = 'export const health = () => ({ status: "ok" });\n';
const DEPLOYMENT_TEXT = '{"status":"ok","uptime":"1h"}';

describe.each(testDatabaseTargets())('M3 producer trust boundary on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let w: GraphWorld;
  let n = 0;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    w = await seedGraphWorld(db);
  });
  afterAll(async () => {
    await testDb.close();
  });

  const must = <T>(value: T | undefined | null): T => {
    if (value === undefined || value === null) throw new Error('missing');
    return value;
  };
  const store = () => {
    n += 1;
    return new EvidenceGraphStore({ db, ids: deterministicIdAllocator(`trust-${String(n)}`) });
  };
  const artifact = (snapshot: GraphWorld['snapshots']['github'], key: string) =>
    must(snapshot.artifacts.find((a) => a.key === key));

  const github = () => w.snapshots.github.snapshot.id;
  const readmeSpan = () => ({
    snapshotId: github(),
    artifactId: artifact(w.snapshots.github, 'files/README.md').id,
    span: span(README_TEXT, 'GET /health'),
  });
  const codeSpan = () => ({
    snapshotId: github(),
    artifactId: artifact(w.snapshots.github, 'files/src/api.ts').id,
    span: span(API_TEXT, 'export const health'),
  });
  const deploymentSpan = () => ({
    snapshotId: w.snapshots.deployment.snapshot.id,
    artifactId: artifact(w.snapshots.deployment, 'response.json').id,
    span: span(DEPLOYMENT_TEXT, '"status":"ok"'),
  });
  const evidence = (
    level: string,
    origin: string,
    provenance: object,
    kind = 'fact',
    ref = 'e',
  ) => ({ ref, kind, origin, verificationLevel: level, text: 'Observed.', provenance });

  async function totals() {
    const [row] = await rows<{ c: number; e: number }>(
      db,
      sql`SELECT (SELECT count(*) FROM claims)::int AS c, (SELECT count(*) FROM evidence_items)::int AS e`,
    );
    return row;
  }

  async function refused(batch: unknown, expected: GraphIssueCode[]) {
    const before = await totals();
    const error = await store()
      .createGraph(w.project.id, batch, null)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(EvidenceGraphError);
    expect((error as EvidenceGraphError).codes).toEqual(expected);
    expect(await totals()).toEqual(before); // nothing was written
  }

  it('1. refuses a GitHub README fact at machine_verified', async () => {
    await refused({ evidence: [evidence('machine_verified', 'github', readmeSpan())] }, [
      'VERIFICATION_NOT_AVAILABLE',
    ]);
  });

  it('2. refuses a GitHub source-code fact at machine_verified, even fully anchored', async () => {
    await refused({ evidence: [evidence('machine_verified', 'github', codeSpan())] }, [
      'VERIFICATION_NOT_AVAILABLE',
    ]);
  });

  it('3. refuses deployment evidence at machine_verified', async () => {
    await refused({ evidence: [evidence('machine_verified', 'deployment', deploymentSpan())] }, [
      'VERIFICATION_NOT_AVAILABLE',
    ]);
  });

  it('4. refuses a machine_verified claim even when apparently qualifying evidence supports it', async () => {
    await refused(
      {
        claims: [
          { ref: 'c', text: 'The health handler works.', verificationLevel: 'machine_verified' },
        ],
        evidence: [evidence('repo_corroborated', 'github', codeSpan(), 'fact', 'g')],
        relations: [{ claim: { ref: 'c' }, evidence: { ref: 'g' }, type: 'supports' }],
      },
      // The level is unreachable AND the evidence does not justify it: both are reported.
      ['UNJUSTIFIED_VERIFICATION', 'VERIFICATION_NOT_AVAILABLE'],
    );
  });

  it('5-6. refuses judge_verified and live_verified claims', async () => {
    for (const level of ['judge_verified', 'live_verified']) {
      await refused({ claims: [{ ref: 'c', text: 'x', verificationLevel: level }] }, [
        'UNJUSTIFIED_VERIFICATION',
        'VERIFICATION_NOT_AVAILABLE',
      ]);
    }
  });

  it('7. refuses repo_corroborated evidence anchored in a README (team-authored prose)', async () => {
    await refused({ evidence: [evidence('repo_corroborated', 'github', readmeSpan())] }, [
      'ARTIFACT_NOT_CORROBORATING',
    ]);
  });

  it('8. accepts README / prose evidence as a team claim', async () => {
    const created = await store().createGraph(
      w.project.id,
      { evidence: [evidence('team_claim', 'github', readmeSpan(), 'claim')] },
      null,
    );
    expect(created.evidence[0]).toMatchObject({ kind: 'claim', verificationLevel: 'team_claim' });
    expect(created.evidence[0]?.provenance.excerpt).toBe('GET /health');
  });

  it('9. accepts a real source-code fact at repo_corroborated, and a claim it justifies', async () => {
    const created = await store().createGraph(
      w.project.id,
      {
        claims: [
          {
            ref: 'c',
            text: 'The project has a health handler.',
            verificationLevel: 'repo_corroborated',
          },
        ],
        evidence: [evidence('repo_corroborated', 'github', codeSpan(), 'fact', 'g')],
        relations: [{ claim: { ref: 'c' }, evidence: { ref: 'g' }, type: 'supports' }],
      },
      null,
    );
    expect(created.claims[0]?.verificationLevel).toBe('repo_corroborated');
    expect(created.evidence[0]?.provenance.excerpt).toBe('export const health');
  });

  it('10. keeps Devpost and video team text capped at team_claim', async () => {
    for (const [origin, snapshotId] of [
      ['devpost', w.snapshots.devpost.snapshot.id],
      ['video', w.snapshots.video.snapshot.id],
    ] as const) {
      const ok = await store().createGraph(
        w.project.id,
        { evidence: [evidence('team_claim', origin, { snapshotId }, 'claim')] },
        null,
      );
      expect(ok.evidence[0]?.verificationLevel).toBe('team_claim');
      for (const level of [
        'repo_corroborated',
        'machine_verified',
        'judge_verified',
        'live_verified',
      ]) {
        const error = await store()
          .createGraph(
            w.project.id,
            { evidence: [evidence(level, origin, { snapshotId }, 'claim')] },
            null,
          )
          .then(
            () => null,
            (caught: unknown) => caught,
          );
        expect(error, `${origin} ${level}`).toBeInstanceOf(EvidenceGraphError);
      }
    }
  });

  it('11. keeps contradicted reachable, only together with its Contradiction', async () => {
    await refused({ claims: [{ ref: 'c', text: 'x', verificationLevel: 'contradicted' }] }, [
      'UNJUSTIFIED_VERIFICATION',
    ]);
    const created = await store().createGraph(
      w.project.id,
      {
        claims: [
          {
            ref: 'c',
            text: 'The submission claims persistence.',
            verificationLevel: 'contradicted',
          },
        ],
        evidence: [
          evidence('unverified', 'deployment', { snapshotId: w.snapshots.deployment.snapshot.id }),
        ],
        contradictions: [
          {
            sideA: { type: 'claim', ref: 'c' },
            sideB: { type: 'evidence', ref: 'e' },
            description: 'The response does not show it.',
          },
        ],
      },
      null,
    );
    expect(created.claims[0]?.verificationLevel).toBe('contradicted');
    expect(created.contradictions).toHaveLength(1);
  });

  it('refuses the old permissive combination end to end: machine_verified fact + supports + machine_verified claim', async () => {
    await refused(
      {
        claims: [{ ref: 'c', text: 'The cache works.', verificationLevel: 'machine_verified' }],
        evidence: [evidence('machine_verified', 'github', codeSpan(), 'fact', 'g')],
        relations: [{ claim: { ref: 'c' }, evidence: { ref: 'g' }, type: 'supports' }],
      },
      ['VERIFICATION_NOT_AVAILABLE', 'VERIFICATION_NOT_AVAILABLE'],
    );
  });
});
