import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caller, count, openEnv, oneAssessmentProject, P, rows, sql, TOK, type Env, type Project } from './env.js';

describe.each(['pglite', 'pg'] as const)('R10 T5 an assessment that fails verification takes no record and releases none, on %s', (kind) => {
  let env: Env | null; let p: Project; let call: ReturnType<typeof caller>;
  beforeAll(async () => { env = await openEnv(kind); if (!env) return; call = caller(env); p = await oneAssessmentProject(env); });
  afterAll(async () => { await env?.close(); });

  it('tampered report mirror (admin tamper with triggers disabled) -> POST answer/observation 409 ASSESSMENT_NOT_VERIFIED, GET withholds every record, nothing written', async () => {
    if (!env) return;
    const a = p.a[0]!;
    const ok = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: 'recorded while verified' } });
    expect(ok.status).toBe(201);
    const before = await count(env, 'team_answers', `project_id='${p.projectId}'`);
    await env.db.execute(sql`ALTER TABLE pre_interview_assessments DISABLE TRIGGER USER`);
    await env.db.execute(sql`UPDATE pre_interview_assessments SET report = jsonb_set(report, '{overall,score10}', '10') WHERE id = ${a.assessmentId}`);
    await env.db.execute(sql`ALTER TABLE pre_interview_assessments ENABLE TRIGGER USER`);
    const r1 = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: 'after tamper' } });
    const r2 = await call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 's', observed: 'after tamper', outcome: 'confirmed' } });
    const g = await call('GET', P.interview(p.projectId, a.assessmentId));
    console.log('R10-T5', kind, JSON.stringify({ answer: [r1.status, r1.body.error?.code], observation: [r2.status, r2.body.error?.code], read: [g.status, g.body.assessmentVerified, g.body.teamAnswers?.length, g.body.judgeObservations?.length] }));
    expect([r1.status, r1.body.error.code]).toEqual([409, 'ASSESSMENT_NOT_VERIFIED']);
    expect([r2.status, r2.body.error.code]).toEqual([409, 'ASSESSMENT_NOT_VERIFIED']);
    expect(g.body.assessmentVerified).toBe(false);
    expect(g.body.teamAnswers).toEqual([]); expect(g.body.judgeObservations).toEqual([]);
    expect(JSON.stringify(g.body)).not.toContain('recorded while verified');
    expect(await count(env, 'team_answers', `project_id='${p.projectId}'`)).toBe(before);
    expect(await count(env, 'judge_observations', `project_id='${p.projectId}'`)).toBe(0);
    // a replay of the earlier success is also withheld (it would release the stored answer text)
    const replay = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key: undefined, payload: { text: 'x' } });
    expect(replay.status).toBe(409);
    void TOK; void rows;
  });
});
