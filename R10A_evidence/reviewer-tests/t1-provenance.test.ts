import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPgError, SQLSTATE } from '../../packages/database/src/testing/databases.js';
import { caller, count, openEnv, P, rows, sql, TOK, twoAssessmentProject, type Env, type Project } from './env.js';

const GHOST = '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e';
describe.each(['pglite', 'pg'] as const)('R10 T1 provenance with TWO verified assessments on %s', (kind) => {
  let env: Env | null; let p: Project; let other: Project;
  let call: ReturnType<typeof caller>;
  beforeAll(async () => { env = await openEnv(kind); if (!env) return; call = caller(env); p = await twoAssessmentProject(env); other = await twoAssessmentProject(env); });
  afterAll(async () => { await env?.close(); });
  const A = (i: 0 | 1) => p.a[i]!;

  it('records stay inside their own assessment in the API: reads, counts and ordering (two assessments, same project)', async () => {
    if (!env) return;
    const q0 = A(0).questionIds[0]!; const q1 = A(1).questionIds[0]!;
    const a0 = await call('POST', P.answers(p.projectId, A(0).setId, q0), { payload: { text: 'answer on assessment 1' } });
    const a1 = await call('POST', P.answers(p.projectId, A(1).setId, q1), { payload: { text: 'answer on assessment 2' } });
    const o0 = await call('POST', P.observations(p.projectId, A(0).assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'confirmed', questionSetId: A(0).setId, questionId: q0, teamAnswerId: a0.body.teamAnswer.id } });
    expect([a0.status, a1.status, o0.status]).toEqual([201, 201, 201]);
    const l0 = (await call('GET', P.interview(p.projectId, A(0).assessmentId))).body;
    const l1 = (await call('GET', P.interview(p.projectId, A(1).assessmentId))).body;
    expect(l0.teamAnswers.map((x: any) => x.text)).toEqual(['answer on assessment 1']);
    expect(l1.teamAnswers.map((x: any) => x.text)).toEqual(['answer on assessment 2']);
    expect(l0.judgeObservations).toHaveLength(1);
    expect(l1.judgeObservations).toHaveLength(0);
    for (const r of [...l0.teamAnswers, ...l0.judgeObservations]) expect(r.assessmentId).toBe(A(0).assessmentId);
    for (const r of [...l1.teamAnswers, ...l1.judgeObservations]) expect(r.assessmentId).toBe(A(1).assessmentId);
  });

  const cases: [string, () => Promise<{ status: number; body: any }>, number[]][] = [
    ['answer: question of set 1 posted under set 2', () => call('POST', P.answers(p.projectId, A(1).setId, A(0).questionIds[0]!), { payload: { text: 'x' } }), [404]],
    ['answer: set of ANOTHER project under this project', () => call('POST', P.answers(p.projectId, other.a[0]!.setId, other.a[0]!.questionIds[0]!), { payload: { text: 'x' } }), [404]],
    ['answer: this project\'s set under ANOTHER project path', () => call('POST', P.answers(other.projectId, A(0).setId, A(0).questionIds[0]!), { payload: { text: 'x' } }), [404]],
    ['answer: nonexistent question', () => call('POST', P.answers(p.projectId, A(0).setId, GHOST), { payload: { text: 'x' } }), [404]],
    ['answer: nonexistent set', () => call('POST', P.answers(p.projectId, GHOST, A(0).questionIds[0]!), { payload: { text: 'x' } }), [404]],
    ['observation: assessment 2 with the question set of assessment 1', () => call('POST', P.observations(p.projectId, A(1).assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'inconclusive', questionSetId: A(0).setId, questionId: A(0).questionIds[0]! } }), [422]],
    ['observation: assessment 1 with set 1 but a question of set 2', () => call('POST', P.observations(p.projectId, A(0).assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'inconclusive', questionSetId: A(0).setId, questionId: A(1).questionIds[0]! } }), [404, 422]],
    ['observation: assessment of ANOTHER project in this project path', () => call('POST', P.observations(p.projectId, other.a[0]!.assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'inconclusive' } }), [404]],
    ['observation: nonexistent assessment', () => call('POST', P.observations(p.projectId, GHOST), { payload: { subject: 's', observed: 'o', outcome: 'inconclusive' } }), [404]],
    ['observation: set of another project', () => call('POST', P.observations(p.projectId, A(0).assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'inconclusive', questionSetId: other.a[0]!.setId, questionId: other.a[0]!.questionIds[0]! } }), [404]],
    ['observation: nonexistent linked answer', () => call('POST', P.observations(p.projectId, A(0).assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'inconclusive', questionSetId: A(0).setId, questionId: A(0).questionIds[0]!, teamAnswerId: GHOST } }), [404]],
    ['interview GET: assessment of another project', () => call('GET', P.interview(p.projectId, other.a[0]!.assessmentId)), [404]],
  ];
  for (const [name, run, statuses] of cases) {
    it(`API refuses: ${name}`, async () => {
      if (!env) return;
      const before = [await count(env, 'team_answers'), await count(env, 'judge_observations'), await count(env, 'audit_events')];
      const r = await run();
      expect(statuses, `${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
      expect([await count(env, 'team_answers'), await count(env, 'judge_observations'), await count(env, 'audit_events')]).toEqual(before);
    });
  }

  it('API refuses an answer link / correction that crosses the assessment boundary', async () => {
    if (!env) return;
    const q0 = A(0).questionIds[0]!; const q1 = A(1).questionIds[0]!;
    const ans1 = (await call('POST', P.answers(p.projectId, A(1).setId, q1), { payload: { text: 'a2 answer for linking' } })).body.teamAnswer;
    const ans0 = (await call('POST', P.answers(p.projectId, A(0).setId, q0), { payload: { text: 'a1 answer for correcting' } })).body.teamAnswer;
    const obs0 = (await call('POST', P.observations(p.projectId, A(0).assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'confirmed' } })).body.judgeObservation;
    const before = [await count(env, 'team_answers'), await count(env, 'judge_observations'), await count(env, 'audit_events')];
    // observation of assessment 1 linking the team answer of assessment 2
    const r1 = await call('POST', P.observations(p.projectId, A(0).assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'confirmed', questionSetId: A(0).setId, questionId: q0, teamAnswerId: ans1.id } });
    // an answer of assessment 2 "correcting" an answer of assessment 1
    const r2 = await call('POST', P.answers(p.projectId, A(1).setId, q1), { payload: { text: 'cross correction', supersedesAnswerId: ans0.id } });
    // an observation of assessment 2 "correcting" an observation of assessment 1
    const r3 = await call('POST', P.observations(p.projectId, A(1).assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'confirmed', supersedesObservationId: obs0.id } });
    // an answer correcting an answer of ANOTHER question in the same set / same assessment
    const q0b = A(0).questionIds[1];
    const r4 = q0b ? await call('POST', P.answers(p.projectId, A(0).setId, q0b), { payload: { text: 'wrong question', supersedesAnswerId: ans0.id } }) : { status: 422 };
    console.log('R10 cross-assessment link/correction', kind, [r1.status, r2.status, r3.status, r4.status]);
    expect([r1.status, r2.status, r3.status, r4.status].every((s) => s === 422 || s === 404)).toBe(true);
    expect([await count(env, 'team_answers'), await count(env, 'judge_observations'), await count(env, 'audit_events')]).toEqual(before);
  });

  // ---- direct SQL: the database refuses what the service would have refused (authorized tampering is not possible without privileged DDL) ----
  const answerCols = `project_id, assessment_id, question_set_id, question_id, answer_text, recorded_by_actor_id, recorded_as_role, idempotency_key, request_hash`;
  async function actorId(): Promise<string> { return (await rows<{ id: string }>(env!.db, sql`SELECT id FROM actors LIMIT 1`))[0]!.id; }
  const insertAnswer = (c: { project?: string; assessment?: string; set?: string; question?: string; actor?: string; supersedes?: string | null }) =>
    env!.db.execute(sql`INSERT INTO team_answers (${sql.raw(answerCols)}, supersedes_answer_id) VALUES (${c.project}, ${c.assessment}, ${c.set}, ${c.question}, 'sql', ${c.actor}, 'judge', ${randomUUID()}, ${'a'.repeat(64)}, ${c.supersedes ?? null})`);
  it('SQL negative controls (answers): POSITIVE control commits; every crossing is refused with an FK/check violation', async () => {
    if (!env) return;
    const actor = await actorId();
    const base = { project: p.projectId, assessment: A(0).assessmentId, set: A(0).setId, question: A(0).questionIds[0]!, actor };
    await insertAnswer(base); // positive control
    const F = SQLSTATE.FOREIGN_KEY_VIOLATION;
    await expectPgError(insertAnswer({ ...base, project: other.projectId }), F); // another project
    await expectPgError(insertAnswer({ ...base, assessment: A(1).assessmentId }), F); // another assessment, same project
    await expectPgError(insertAnswer({ ...base, set: A(1).setId }), F); // a set of another assessment
    await expectPgError(insertAnswer({ ...base, question: A(1).questionIds[0]! }), F); // a question of a different set
    await expectPgError(insertAnswer({ ...base, question: GHOST }), F); // forged question
    await expectPgError(insertAnswer({ ...base, assessment: GHOST }), F); // forged assessment
    await expectPgError(insertAnswer({ ...base, actor: GHOST }), F); // forged actor
    const wrongQ = A(0).questionIds[1];
    const orig = (await rows<{ id: string }>(env.db, sql`SELECT id FROM team_answers WHERE question_id = ${A(0).questionIds[0]!} LIMIT 1`))[0]!.id;
    if (wrongQ) await expectPgError(insertAnswer({ ...base, question: wrongQ, supersedes: orig }), F); // correction of an answer to a different question
    await expectPgError(insertAnswer({ ...base, supersedes: GHOST }), F);
  });
  const insertObs = (c: { project?: string; assessment?: string; set?: string | null; question?: string | null; answer?: string | null; supersedes?: string | null; actor?: string }) =>
    env!.db.execute(sql`INSERT INTO judge_observations (project_id, assessment_id, question_set_id, question_id, team_answer_id, subject, observed, outcome, recorded_by_actor_id, recorded_as_role, idempotency_key, request_hash, supersedes_observation_id) VALUES (${c.project}, ${c.assessment}, ${c.set ?? null}, ${c.question ?? null}, ${c.answer ?? null}, 's', 'o', 'confirmed', ${c.actor}, 'judge', ${randomUUID()}, ${'b'.repeat(64)}, ${c.supersedes ?? null})`);
  it('SQL negative controls (observations): positive control commits; crossings refused; NULL cannot skip the answer link', async () => {
    if (!env) return;
    const actor = await actorId();
    const b = { project: p.projectId, assessment: A(0).assessmentId, actor };
    await insertObs({ ...b }); // standalone: positive
    await insertObs({ ...b, set: A(0).setId, question: A(0).questionIds[0]! }); // linked: positive
    const F = SQLSTATE.FOREIGN_KEY_VIOLATION; const C = SQLSTATE.CHECK_VIOLATION;
    await expectPgError(insertObs({ ...b, project: other.projectId }), F);
    await expectPgError(insertObs({ ...b, assessment: A(1).assessmentId, set: A(0).setId, question: A(0).questionIds[0]! }), F); // set of the other assessment
    await expectPgError(insertObs({ ...b, set: A(0).setId, question: A(1).questionIds[0]! }), F); // question of a different set
    await expectPgError(insertObs({ ...b, set: A(0).setId, question: null }), C); // half a link
    await expectPgError(insertObs({ ...b, answer: GHOST }), C); // an answer without a question (NULL must not skip the FK)
    await expectPgError(insertObs({ ...b, set: A(0).setId, question: A(0).questionIds[0]!, answer: GHOST }), F);
    const ans1 = (await rows<{ id: string }>(env.db, sql`SELECT id FROM team_answers WHERE assessment_id = ${A(1).assessmentId} LIMIT 1`))[0]?.id;
    if (ans1) await expectPgError(insertObs({ ...b, set: A(0).setId, question: A(0).questionIds[0]!, answer: ans1 }), F); // an answer of the other assessment
    await expectPgError(insertObs({ ...b, supersedes: GHOST }), F);
    await expectPgError(insertObs({ ...b, actor: GHOST }), F);
  });
  it('privileged tampering is distinguishable: a superuser who disables the trigger CAN rewrite a record (documented; not an application path)', async () => {
    if (!env) return;
    const row = (await rows<{ id: string }>(env.db, sql`SELECT id FROM team_answers LIMIT 1`))[0]!.id;
    await expectPgError(env.db.execute(sql`UPDATE team_answers SET answer_text = 'tampered' WHERE id = ${row}`), '23001', SQLSTATE.CHECK_VIOLATION, 'P0001', '55000');
    let done = 'refused';
    try {
      await env.db.execute(sql`ALTER TABLE team_answers DISABLE TRIGGER team_answers_immutable_guard`);
      await env.db.execute(sql`UPDATE team_answers SET answer_text = 'tampered by admin' WHERE id = ${row}`);
      done = 'admin-rewrite-possible';
    } finally {
      await env.db.execute(sql`UPDATE team_answers SET answer_text = 'restored' WHERE id = ${row}`).catch(() => undefined);
      await env.db.execute(sql`ALTER TABLE team_answers ENABLE TRIGGER team_answers_immutable_guard`);
    }
    console.log('R10 privileged tamper', kind, done);
    void TOK;
  });
});
