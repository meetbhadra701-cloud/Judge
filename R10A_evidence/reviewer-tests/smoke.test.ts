import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caller, count, openEnv, P, TOK, twoAssessmentProject, type Env } from './env.js';
describe.each(['pglite', 'pg'] as const)('R10 harness smoke %s', (kind) => {
  let env: Env | null;
  beforeAll(async () => { env = await openEnv(kind); });
  afterAll(async () => { await env?.close(); });
  it('builds a project with two verified assessments and two distinct question sets', async () => {
    if (!env) return;
    const p = await twoAssessmentProject(env);
    expect(p.a[0]!.assessmentId).not.toBe(p.a[1]!.assessmentId);
    expect(p.a[0]!.setId).not.toBe(p.a[1]!.setId);
    expect(p.a[0]!.questionIds.length).toBeGreaterThan(0);
    const call = caller(env);
    const r = await call('POST', P.answers(p.projectId, p.a[1]!.setId, p.a[1]!.questionIds[0]!), { payload: { text: 'hello' } });
    console.log('R10 smoke answer', env.kind, r.status, await count(env, 'team_answers'));
    expect(r.status).toBe(201);
    const l = await call('GET', P.interview(p.projectId, p.a[1]!.assessmentId));
    expect(l.body.assessmentVerified).toBe(true);
    void TOK;
  });
});
