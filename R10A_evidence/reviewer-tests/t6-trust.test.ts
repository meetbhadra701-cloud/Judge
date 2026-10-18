import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caller, count, openEnv, P, rows, sql, TOK, twoAssessmentProject, type Env, type Project } from './env.js';

const log = (k: string, v: unknown) => console.log(`R10-T6 ${k} ${JSON.stringify(v)}`);
describe.each(['pglite', 'pg'] as const)('R10 T6 testimony is not evidence; outcomes are not findings on %s', (kind) => {
  let env: Env | null; let p: Project; let call: ReturnType<typeof caller>;
  beforeAll(async () => { env = await openEnv(kind); if (!env) return; call = caller(env); p = await twoAssessmentProject(env); });
  afterAll(async () => { await env?.close(); });

  const snapshot = async () => {
    const out: Record<string, string> = {};
    for (const t of ['pre_interview_assessments', 'assessment_dimension_judgments', 'assessment_judgment_citations', 'question_sets', 'question_set_questions', 'evidence_items', 'claims', 'unknowns', 'contradictions', 'analysis_runs', 'graph_versions']) {
      try { out[t] = (await rows<{ d: string }>(env!.db, sql.raw(`SELECT coalesce(md5(string_agg(x::text,'|' ORDER BY x::text)),'empty') AS d FROM ${t} x`)))[0]!.d; } catch { out[t] = 'n/a'; }
    }
    return out;
  };
  const scores = async () => JSON.stringify(await rows(env!.db, sql`SELECT * FROM pre_interview_assessments ORDER BY id`)).length;

  it('all four outcomes recorded, read back and displayed as testimony/judge report; none changes any M5/M6 row, score, evidence, unknown or contradiction', async () => {
    if (!env) return;
    const a = p.a[0]!; const before = await snapshot();
    const outcomes = ['confirmed', 'not_confirmed', 'inconclusive', 'unable_to_verify'] as const;
    for (const outcome of outcomes) {
      const ans = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: `team says it works (${outcome})` } });
      const o = await call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 'demo', observed: `observation ${outcome}`, outcome, questionSetId: a.setId, questionId: a.questionIds[0], teamAnswerId: ans.body.teamAnswer.id } });
      expect([ans.status, o.status]).toEqual([201, 201]);
      expect(o.body.judgeObservation.outcome).toBe(outcome);
    }
    // a "no answer" case: an observation with no answer record at all, and a question that was never answered
    expect((await call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 'x', observed: 'no answer given', outcome: 'unable_to_verify', questionSetId: a.setId, questionId: a.questionIds[1] } })).status).toBe(201);
    const after = await snapshot();
    log('digest-unchanged', Object.keys(before).filter((k) => before[k] !== after[k]));
    expect(after).toEqual(before);
    // no evidence / claim / unknown / contradiction derived from interview records, no negative finding table touched
    expect(await count(env, 'evidence_items', "origin IN ('team_answer','judge_observation')")).toBe(0);
    expect(await count(env, 'evidence_items', "verification_level IN ('judge_verified','live_verified')")).toBe(0);
    // the view the API exposes has no score/finding/verification fields on any record
    const list = (await call('GET', P.interview(p.projectId, a.assessmentId))).body;
    const keys = new Set<string>(); for (const r of [...list.teamAnswers, ...list.judgeObservations]) Object.keys(r).forEach((k) => keys.add(k));
    log('record-keys', [...keys].sort());
    expect([...keys].filter((k) => /score|verif|finding|evidence|deduct|penal|trust/i.test(k))).toEqual([]);
    expect(await scores()).toBeGreaterThan(0);
  });

  it('the assessment/score read model (GET assessments) is byte-identical before and after recording', async () => {
    if (!env) return;
    const a = p.a[1]!;
    const strip = (b: any) => JSON.stringify(b);
    const r0 = strip((await call('GET', `/projects/${p.projectId}/assessments/${a.assessmentId}`)).body);
    const q0 = strip((await call('GET', `/projects/${p.projectId}/assessments/${a.assessmentId}/question-sets`)).body);
    await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: 'late testimony' } });
    await call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'not_confirmed' } });
    expect(strip((await call('GET', `/projects/${p.projectId}/assessments/${a.assessmentId}`)).body)).toBe(r0);
    expect(strip((await call('GET', `/projects/${p.projectId}/assessments/${a.assessmentId}/question-sets`)).body)).toBe(q0);
  });

  it('the evidence graph still refuses interview origins and unreachable verification levels (direct SQL, positive control)', async () => {
    if (!env) return;
    const cons = await rows<{ t: string; n: string; d: string }>(env.db, sql`SELECT conrelid::regclass::text AS t, conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid IN ('evidence_items'::regclass) AND contype = 'c'`);
    const defs = cons.filter((c) => /origin|verification_level/.test(c.d)).map((c) => `${c.n}: ${c.d}`);
    log('evidence_items checks', defs.map((d) => d.slice(0, 400)));
    expect(defs.length).toBeGreaterThan(0);
    const trig = await rows<{ n: string }>(env.db, sql`SELECT tgname AS n FROM pg_trigger WHERE tgrelid = 'evidence_items'::regclass AND NOT tgisinternal`);
    log('evidence_items triggers', trig.map((t) => t.n));
    // attempt the forgery: reuse an existing evidence row's columns, change only origin/level
    const base = (await rows<Record<string, unknown>>(env.db, sql`SELECT * FROM evidence_items LIMIT 1`))[0];
    expect(base).toBeTruthy();
    const gen = new Set((await rows<{ c: string }>(env.db, sql`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'evidence_items' AND (is_generated = 'ALWAYS' OR column_default LIKE 'nextval%' OR identity_generation IS NOT NULL)`)).map((r) => r.c));
    const cols = Object.keys(base!).filter((c) => c !== 'id' && !gen.has(c));
    log('copied-columns-excluded', [...gen]);
    const attempt = async (origin: string, level: string) => {
      try {
        await env!.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`INSERT INTO evidence_items (${cols.map((c) => `"${c}"`).join(',')}) SELECT ${cols.map((c) => c === 'origin' ? `'${origin}'` : c === 'verification_level' ? `'${level}'` : `"${c}"`).join(',')} FROM evidence_items LIMIT 1`));
          throw new Error('ACCEPTED_ROLLBACK');
        });
        return 'accepted?';
      } catch (e) {
        let c: any = e; const codes: string[] = []; let msg = '';
        for (; c instanceof Error; c = c.cause) { codes.push(String(c.code)); msg = c.message; }
        return msg === 'ACCEPTED_ROLLBACK' ? 'ACCEPTED' : `refused ${codes.find((x) => x !== 'undefined') ?? '?'} ${msg.slice(0, 120)}`;
      }
    };
    const orig = String(base!['origin']); const lvl = String(base!['verification_level']);
    const control = await attempt(orig, lvl);
    const res = { control, teamAnswer: await attempt('team_answer', lvl), judgeObservation: await attempt('judge_observation', lvl), judgeVerified: await attempt(orig, 'judge_verified'), liveVerified: await attempt(orig, 'live_verified') };
    log('graph-forgery', res);
    expect(res.control).toBe('ACCEPTED'); // the negative controls are only meaningful if the unchanged copy is accepted
    expect(res.teamAnswer).toMatch(/^refused/); expect(res.judgeObservation).toMatch(/^refused/); expect(res.judgeVerified).toMatch(/^refused/); expect(res.liveVerified).toMatch(/^refused/);
  });

  it('M7 added no write path into the graph: the interview code imports nothing from the graph/scoring/llm/prompts layers', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = ['packages/database/src/interview-store.ts', 'apps/api/src/interview/service.ts', 'apps/api/src/interview/routes.ts', 'packages/schemas/src/interview.ts'];
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) if (/llm|prompts|scoring|graph|evidence|assessment|worker/.test(m[1]!)) bad.push(`${f}: ${m[1]}`);
      if (/evidenceItems|claims\b|unknowns\b|contradictions\b|createGraph|scoreProject|\.generate\(/.test(src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n'))) bad.push(`${f}: touches graph/score/model symbol`);
    }
    log('imports', bad);
    expect(bad).toEqual([]);
    void readdirSync;
  });
});
