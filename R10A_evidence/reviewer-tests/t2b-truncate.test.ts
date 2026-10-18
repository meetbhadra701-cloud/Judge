import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caller, openEnv, P, rows, sql, TOK, twoAssessmentProject, type Env, type Project } from './env.js';

const attempt = async (env: Env, stmt: string) => {
  try { await env.db.execute(sql.raw(stmt)); return 'OK(!)'; } catch (e) {
    const codes: string[] = []; const msgs: string[] = [];
    for (let c: any = e; c instanceof Error; c = c.cause) { codes.push(String(c.code)); msgs.push(c.message.slice(0, 90)); }
    return `${codes.find((c) => c !== 'undefined') ?? '?'} | ${msgs[msgs.length - 1]}`;
  }
};
describe.each(['pglite', 'pg'] as const)('R10 T2b truncate attribution on %s', (kind) => {
  let env: Env | null; let p: Project; let call: ReturnType<typeof caller>;
  beforeAll(async () => { env = await openEnv(kind); if (!env) return; call = caller(env); p = await twoAssessmentProject(env); });
  afterAll(async () => { await env?.close(); });
  it('which defence stops each TRUNCATE form', async () => {
    if (!env) return;
    const a = p.a[0]!;
    await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: 'x' } });
    await call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'confirmed' } });
    const out: Record<string, string> = {};
    for (const s of ['TRUNCATE team_answers', 'TRUNCATE judge_observations', 'TRUNCATE team_answers CASCADE', 'TRUNCATE judge_observations CASCADE', 'TRUNCATE team_answers, judge_observations']) out[s] = await attempt(env, s);
    console.log('R10 truncate', kind, JSON.stringify(out, null, 1));
    // positive control: the row counts are intact afterwards
    expect((await rows<{ n: number }>(env.db, sql`SELECT count(*)::int AS n FROM team_answers`))[0]!.n).toBeGreaterThan(0);
    expect((await rows<{ n: number }>(env.db, sql`SELECT count(*)::int AS n FROM judge_observations`))[0]!.n).toBeGreaterThan(0);
    for (const v of Object.values(out)) expect(v).not.toBe('OK(!)');
  });
});
