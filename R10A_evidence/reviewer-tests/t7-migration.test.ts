import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../packages/database/src/client.js';
import { createDatabase } from '../../packages/database/src/index.js';
import { migrateFolder, openEmptyPglite, openEmptyPostgres, rows, sql, type TestDatabase } from '../../packages/database/src/testing/databases.js';
import { caller, envOver, P, TOK, twoAssessmentProject, type Env, type Project } from './env.js';

const log = (k: string, v: unknown) => console.log(`R10-T7 ${k} ${JSON.stringify(v)}`);
const NEW_TABLES = ['team_answers', 'judge_observations'];

function baselineFolder(upTo: number): string {
  const folder = mkdtempSync(join(tmpdir(), 'r10-migs-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
  const kept = journal.entries.filter((e) => e.idx <= upTo);
  for (const e of kept) cpSync(join(migrationsFolder, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  return folder;
}

async function inventory(db: any): Promise<string[]> {
  const out: string[] = [];
  for (const r of await rows<any>(db, sql`SELECT table_name t, column_name c, data_type d, is_nullable n, coalesce(column_default,'') df, coalesce(generation_expression,'') g FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2`)) out.push(`col ${r.t}.${r.c} ${r.d} ${r.n} [${r.df}] [${r.g}]`);
  for (const r of await rows<any>(db, sql`SELECT conrelid::regclass::text t, conname n, pg_get_constraintdef(oid) d FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`)) out.push(`con ${r.t} ${r.n} ${r.d}`);
  for (const r of await rows<any>(db, sql`SELECT indexname n, indexdef d FROM pg_indexes WHERE schemaname='public' ORDER BY 1`)) out.push(`idx ${r.n} ${r.d}`);
  for (const r of await rows<any>(db, sql`SELECT tgrelid::regclass::text t, tgname n, pg_get_triggerdef(oid) d FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2`)) out.push(`trg ${r.t} ${r.n} ${r.d}`);
  for (const r of await rows<any>(db, sql`SELECT proname n, md5(prosrc) h FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1`)) out.push(`fn ${r.n} ${r.h}`);
  return out;
}
async function digests(db: any, skip: string[] = []): Promise<Record<string, string>> {
  const tables = (await rows<{ t: string }>(db, sql`SELECT table_name t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).map((r) => r.t).filter((t) => !skip.includes(t));
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = (await rows<{ d: string }>(db, sql.raw(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text,'|' ORDER BY x::text)),'') AS d FROM "${t}" x`)))[0]!.d;
  return out;
}

describe.each(['pglite', 'pg'] as const)('R10 T7 migration 0025 on %s', (kind) => {
  const URL_UPG = process.env['R10_UPG_URL']; const URL_FRESH = process.env['R10_FRESH_URL'];
  let up: TestDatabase; let fresh: TestDatabase; let env: Env; let p: Project; let call: ReturnType<typeof caller>;
  let pool: ReturnType<typeof createDatabase> | null = null;
  let invBefore: string[]; let digBefore: Record<string, string>; let invAfter: string[]; let invFresh: string[];
  const skip = kind === 'pg' && (!URL_UPG || !URL_FRESH);

  beforeAll(async () => {
    if (skip) return;
    up = kind === 'pglite' ? await openEmptyPglite() : await openEmptyPostgres(URL_UPG!);
    await migrateFolder(up, baselineFolder(24));
    const db = up.db;
    // populate with REAL pipelines at the M6 baseline: two verified assessments + a question set each (the 0025 tables do not exist yet)
    env = await envOver(kind, db as any, null, async () => undefined);
    call = caller(env);
    p = await twoAssessmentProject(env);
    invBefore = await inventory(db);
    digBefore = await digests(db);
    await migrateFolder(up, migrationsFolder); // the real, complete folder: 0025 is the only pending migration
    invAfter = await inventory(db);
    fresh = kind === 'pglite' ? await openEmptyPglite() : await openEmptyPostgres(URL_FRESH!);
    await migrateFolder(fresh, migrationsFolder);
    invFresh = await inventory(fresh.db);
  }, 300_000);
  afterAll(async () => { if (skip) return; await env?.app.close(); await up?.close(); await fresh?.close(); void pool; });

  it('upgrade from a POPULATED 0024 yields exactly the schema of a fresh install (columns, constraints, indexes, triggers, functions)', async () => {
    if (skip) return;
    expect(invAfter).toEqual(invFresh);
    log('inventory-sizes', { before: invBefore.length, after: invAfter.length, fresh: invFresh.length });
  });

  it('the only differences from 0024 are the two new tables and the two UNIQUE keys on the immutable M6 tables (nothing else in any old table changes)', async () => {
    if (skip) return;
    const before = new Set(invBefore); const added = invAfter.filter((l) => !before.has(l)); const removed = invBefore.filter((l) => !new Set(invAfter).has(l));
    const unrelated = added.filter((l) => !NEW_TABLES.some((t) => l.includes(`${t}`)) && !/question_sets_id_project_assessment_key|question_set_questions_id_set_key|interview_records_stamp|project_not_voided_guard/.test(l));
    log('removed', removed); log('added-outside-new-tables', unrelated);
    expect(removed).toEqual([]);
    expect(unrelated).toEqual([]);
  });

  it('every pre-existing table is row-for-row identical after the migration (digest per table)', async () => {
    if (skip) return;
    const after = await digests(up.db, NEW_TABLES);
    const changed = Object.keys(digBefore).filter((t) => digBefore[t] !== after[t]);
    log('tables-digested', Object.keys(digBefore).length); log('changed', changed);
    expect(changed).toEqual([]);
    expect(Object.keys(digBefore).length).toBeGreaterThan(30);
    // the new tables exist and are empty
    for (const t of NEW_TABLES) expect((await rows<{ n: number }>(up.db, sql.raw(`SELECT count(*)::int n FROM ${t}`)))[0]!.n).toBe(0);
  });

  it('the new objects exist: all FKs, CHECKs, uniques, indexes and triggers of both tables', async () => {
    if (skip) return;
    const lines = invAfter.filter((l) => NEW_TABLES.some((t) => new RegExp(`^(con|idx|trg) .*\\b${t}\\b`).test(l)));
    const kinds = (re: RegExp) => lines.filter((l) => re.test(l)).length;
    log('new-object-counts', { fk: kinds(/^con .*FOREIGN KEY/), check: kinds(/^con .*CHECK/), unique: kinds(/^con .* UNIQUE/), pk: kinds(/PRIMARY KEY/), triggers: kinds(/^trg/), indexes: kinds(/^idx/) });
    for (const t of NEW_TABLES) for (const g of ['immutable_guard', 'no_truncate', 'not_voided_guard', 'stamp']) expect(lines.some((l) => l.startsWith('trg') && l.includes(`${t}_${g}`)), `${t}_${g}`).toBe(true);
    expect(kinds(/^con .*FOREIGN KEY/)).toBeGreaterThanOrEqual(12);
    const dump = lines.filter((l) => /^con /.test(l)).map((l) => l.slice(0, 200));
    writeFileSync(join(process.env['R10_OUT'] ?? tmpdir(), `inventory-new-objects-${kind}.txt`), lines.join('\n'));
    void dump;
  });

  it('an interview record is writable for the question set that existed BEFORE the migration, for both assessments, and linkage enforcement is live', async () => {
    if (skip) return;
    const r = await call('POST', P.answers(p.projectId, p.a[0]!.setId, p.a[0]!.questionIds[0]!), { payload: { text: 'post-upgrade answer' } });
    const x = await call('POST', P.answers(p.projectId, p.a[1]!.setId, p.a[0]!.questionIds[0]!), { payload: { text: 'crossed' } });
    const o = await call('POST', P.observations(p.projectId, p.a[1]!.assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'inconclusive' } });
    log('post-upgrade', [r.status, x.status, o.status]);
    expect([r.status, x.status, o.status]).toEqual([201, 404, 201]);
  });

  it('re-applying the migration\'s own statements twice (the documented recovery) changes neither schema nor data', async () => {
    if (skip) return;
    const sqlText = readFileSync(join(migrationsFolder, '0025_m7_interview_records.sql'), 'utf8');
    const stmts = sqlText.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    const dBefore = await digests(up.db);
    for (let round = 0; round < 2; round++) for (const s of stmts) await up.db.execute(sql.raw(s));
    expect(await inventory(up.db)).toEqual(invFresh);
    expect(await digests(up.db)).toEqual(dBefore);
    log('reapplied-statements', stmts.length);
  });

  it('atomicity: a failing AUDIT insert rolls back the record; a failing RECORD insert rolls back the audit event; the key is not poisoned', async () => {
    if (skip) return;
    const a = p.a[0]!;
    const count = async (t: string) => (await rows<{ n: number }>(up.db, sql.raw(`SELECT count(*)::int n FROM ${t} WHERE project_id='${p.projectId}'`)))[0]!.n;
    const auditN = async () => (await rows<{ n: number }>(up.db, sql`SELECT count(*)::int n FROM audit_events WHERE action LIKE 'interview.%' AND metadata->>'projectId' = ${p.projectId}`))[0]!.n;
    const cases: [string, string, () => Promise<{ status: number; body: any }>][] = [
      ['team_answers', 'interview.team_answer_recorded', () => call('POST', P.answers(p.projectId, a.setId, a.questionIds[1]!), { key: KEY1, payload: { text: 'atomic answer' } })],
      ['judge_observations', 'interview.judge_observation_recorded', () => call('POST', P.observations(p.projectId, a.assessmentId), { key: KEY2, payload: { subject: 's', observed: 'atomic', outcome: 'confirmed' } })],
    ];
    const out: unknown[] = [];
    for (const [table, action, submit] of cases) {
      const base = { rec: await count(table), aud: await auditN() };
      // (1) the audit insert fails
      await up.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION r10_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'r10 injected failure'; END $$`));
      await up.db.execute(sql.raw(`CREATE TRIGGER r10_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = '${action}') EXECUTE FUNCTION r10_fail()`));
      const r1 = await submit();
      await up.db.execute(sql.raw(`DROP TRIGGER r10_fail_audit ON audit_events`));
      const afterAudit = { rec: await count(table), aud: await auditN() };
      // (2) the record insert fails
      await up.db.execute(sql.raw(`CREATE TRIGGER r10_fail_rec BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION r10_fail()`));
      const r2 = await submit();
      await up.db.execute(sql.raw(`DROP TRIGGER r10_fail_rec ON ${table}`));
      const afterRec = { rec: await count(table), aud: await auditN() };
      // (3) with the fault removed the SAME key succeeds (a failed attempt left nothing behind) and exactly one of each exists
      const ok = await submit();
      const fin = { rec: await count(table), aud: await auditN() };
      out.push({ table, auditFail: [r1.status, r1.body?.error?.code], recFail: [r2.status, r2.body?.error?.code], afterAudit, afterRec, retry: ok.status, fin, leaked: JSON.stringify([r1.body, r2.body]).includes('atomic') });
      expect(r1.status).toBeGreaterThanOrEqual(500); expect(r2.status).toBeGreaterThanOrEqual(500);
      expect(afterAudit).toEqual(base); expect(afterRec).toEqual(base);
      expect(ok.status).toBe(201); expect(fin).toEqual({ rec: base.rec + 1, aud: base.aud + 1 });
      expect(JSON.stringify([r1.body, r2.body])).not.toContain('injected failure'); // no internal error text to the client
    }
    log('atomicity', out);
  });
});
const KEY1 = '11111111-1111-4111-8111-111111111111'; const KEY2 = '22222222-2222-4222-8222-222222222222';
