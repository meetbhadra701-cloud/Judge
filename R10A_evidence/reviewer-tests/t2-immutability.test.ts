import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPgError, SQLSTATE } from '../../packages/database/src/testing/databases.js';
import { caller, count, openEnv, P, rows, sql, TOK, twoAssessmentProject, type Env, type Project } from './env.js';

describe.each(['pglite', 'pg'] as const)('R10 T2 immutability and corrections on %s', (kind) => {
  let env: Env | null; let p: Project; let call: ReturnType<typeof caller>;
  beforeAll(async () => { env = await openEnv(kind); if (!env) return; call = caller(env); p = await twoAssessmentProject(env); });
  afterAll(async () => { await env?.close(); });
  const A = (i: 0 | 1) => p.a[i]!;
  const ans = (q: number, text: string, extra: Record<string, unknown> = {}, token: string = TOK.judgeA, i: 0 | 1 = 0) =>
    call('POST', P.answers(p.projectId, A(i).setId, A(i).questionIds[q]!), { token, payload: { text, ...extra } });
  const obs = (payload: Record<string, unknown>, token: string = TOK.judgeA, i: 0 | 1 = 0) =>
    call('POST', P.observations(p.projectId, A(i).assessmentId), { token, payload });
  const rowText = async (table: string, id: string) => (await rows<{ t: string }>(env!.db, sql.raw(`SELECT t::text AS t FROM ${table} t WHERE id = '${id}'`)))[0]!.t;

  it('UPDATE / DELETE / TRUNCATE are refused for both tables; the database stamps time (a writer cannot backdate)', async () => {
    if (!env) return;
    const a = (await ans(0, 'immutable?')).body.teamAnswer;
    const o = (await obs({ subject: 's', observed: 'o', outcome: 'confirmed' })).body.judgeObservation;
    const E = ['23001', '0A000', SQLSTATE.CHECK_VIOLATION, 'P0001', '55000', '42501'] as const;
    for (const [t, id] of [['team_answers', a.id], ['judge_observations', o.id]] as const) {
      await expectPgError(env.db.execute(sql.raw(`UPDATE ${t} SET created_at = now() WHERE id = '${id}'`)), ...E);
      await expectPgError(env.db.execute(sql.raw(`DELETE FROM ${t} WHERE id = '${id}'`)), ...E);
      await expectPgError(env.db.execute(sql.raw(`TRUNCATE ${t}`)), ...E);
      await expectPgError(env.db.execute(sql.raw(`TRUNCATE ${t} CASCADE`)), ...E);
    }
    // a direct insert with a forged old timestamp is re-stamped
    const actor = (await rows<{ id: string }>(env.db, sql`SELECT id FROM actors LIMIT 1`))[0]!.id;
    const back = (await rows<{ created_at: string; now: string }>(env.db, sql`INSERT INTO team_answers (project_id, assessment_id, question_set_id, question_id, answer_text, recorded_by_actor_id, recorded_as_role, idempotency_key, request_hash, created_at) VALUES (${p.projectId}, ${A(0).assessmentId}, ${A(0).setId}, ${A(0).questionIds[0]!}, 'backdated', ${actor}, 'judge', ${randomUUID()}, ${'c'.repeat(64)}, '2001-01-01T00:00:00Z') RETURNING created_at::text AS created_at, now()::text AS now`))[0]!;
    console.log('R10 backdate', kind, back.created_at);
    expect(new Date(back.created_at).getFullYear()).toBeGreaterThanOrEqual(2026);
    // API clients cannot supply a timestamp
    expect((await ans(0, 'x', { createdAt: '2001-01-01T00:00:00Z' })).status).toBe(400);
  });

  it('corrections append; the original is byte-identical; one immediate successor; the newest is current; both identities recoverable (answers)', async () => {
    if (!env) return;
    const o = (await ans(1, 'first', {}, TOK.judgeA)).body.teamAnswer;
    const before = await rowText('team_answers', o.id);
    const c = await ans(1, 'second', { supersedesAnswerId: o.id }, TOK.judgeB);
    expect(c.status).toBe(201);
    expect(await rowText('team_answers', o.id)).toBe(before); // byte-identical
    const again = await ans(1, 'third (second correction of the same original)', { supersedesAnswerId: o.id }, TOK.judgeA);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INTERVIEW_ALREADY_CORRECTED');
    const c2 = await ans(1, 'third', { supersedesAnswerId: c.body.teamAnswer.id }, TOK.both);
    expect(c2.status).toBe(201);
    const list = (await call('GET', P.interview(p.projectId, A(0).assessmentId))).body;
    const chain = list.teamAnswers.filter((x: any) => [o.id, c.body.teamAnswer.id, c2.body.teamAnswer.id].includes(x.id));
    expect(chain.map((x: any) => [x.isCurrent, x.recordedBy.subject, x.recordedAsRole])).toEqual([[false, 'judge-a', 'judge'], [false, 'judge-b', 'judge'], [true, 'both-1', 'judge']]);
    console.log('R10 chain roles (dual-role credential recorded as):', chain[2].recordedAsRole);
    expect(chain[0].supersededByAnswerId).toBe(chain[1].id);
    expect(chain[1].supersedesAnswerId).toBe(chain[0].id);
    // the database refuses a successor of a record that already has one (even for a direct insert)
    const actor = chain[0].recordedBy.id;
    await expectPgError(env.db.execute(sql`INSERT INTO team_answers (project_id, assessment_id, question_set_id, question_id, answer_text, recorded_by_actor_id, recorded_as_role, idempotency_key, request_hash, supersedes_answer_id) VALUES (${p.projectId}, ${A(0).assessmentId}, ${A(0).setId}, ${A(0).questionIds[1]!}, 'fork', ${actor}, 'judge', ${randomUUID()}, ${'d'.repeat(64)}, ${o.id})`), SQLSTATE.UNIQUE_VIOLATION);
  });

  it('PROBE: can an OBSERVATION correction change its question and linked answer? (history of the chain)', async () => {
    if (!env) return;
    const q0 = A(0).questionIds[0]!; const q1 = A(0).questionIds[1];
    if (!q1) return;
    const a0 = (await ans(0, 'team said X')).body.teamAnswer;
    const original = (await obs({ subject: 'live demo of X', observed: 'saw X working', outcome: 'confirmed', questionSetId: A(0).setId, questionId: q0, teamAnswerId: a0.id })).body.judgeObservation;
    // the correction names ANOTHER question, no answer link
    const moved = await obs({ subject: 'live demo of X', observed: 'saw X working', outcome: 'confirmed', questionSetId: A(0).setId, questionId: q1, supersedesObservationId: original.id });
    // and a further correction detaches it from any question
    const detached = await obs({ subject: 'live demo of X', observed: 'saw X working', outcome: 'confirmed', supersedesObservationId: moved.body.judgeObservation?.id ?? original.id });
    console.log('R10 observation correction moves question:', JSON.stringify({ moved: moved.status, detached: detached.status }));
    const list = (await call('GET', P.interview(p.projectId, A(0).assessmentId))).body;
    const chain = list.judgeObservations.filter((x: any) => [original.id, moved.body.judgeObservation?.id, detached.body.judgeObservation?.id].includes(x.id));
    console.log('R10 chain', JSON.stringify(chain.map((x: any) => ({ q: x.questionId === q0 ? 'Q0' : x.questionId === q1 ? 'Q1' : x.questionId, ans: x.teamAnswerId ? 'linked' : null, current: x.isCurrent }))));
    // per-question view of CURRENT observations (what an M8 reader or the UI would show)
    const currentByQuestion = (q: string) => list.judgeObservations.filter((x: any) => x.questionId === q && x.isCurrent).length;
    console.log('R10 current observations: Q0=', currentByQuestion(q0), 'Q1=', currentByQuestion(q1), 'standalone=', list.judgeObservations.filter((x: any) => x.questionId === null && x.isCurrent).length);
    expect(moved.status).toBe(201);
  });

  it('PROBE: team-answer corrections cannot change question; observation corrections can change recorder, link and outcome (cross-recorder)', async () => {
    if (!env) return;
    const a = (await ans(0, 'q0 answer')).body.teamAnswer;
    const wrongQ = A(0).questionIds[1];
    if (wrongQ) {
      const r = await call('POST', P.answers(p.projectId, A(0).setId, wrongQ), { payload: { text: 'moved?', supersedesAnswerId: a.id } });
      expect([r.status, r.body.error.code]).toEqual([422, 'INTERVIEW_TARGET_MISMATCH']);
    }
    const o = (await obs({ subject: 's', observed: 'saw it', outcome: 'confirmed' }, TOK.judgeA)).body.judgeObservation;
    const flipped = await obs({ subject: 's', observed: 'did not see it', outcome: 'not_confirmed', supersedesObservationId: o.id }, TOK.judgeB);
    expect(flipped.status).toBe(201);
    expect(flipped.body.judgeObservation.recordedBy.subject).toBe('judge-b');
    const org = await obs({ subject: 's', observed: 'organizer says unable', outcome: 'unable_to_verify', supersedesObservationId: flipped.body.judgeObservation.id }, TOK.organizer);
    console.log('R10 organizer corrected a judge observation:', org.status, org.body.judgeObservation?.recordedAsRole);
    expect(org.status).toBe(201);
    // audit trail has each actor and the supersession
    const ev = await rows<{ actor: string; action: string; meta: string }>(env.db, sql`SELECT a.subject AS actor, e.action, e.metadata::text AS meta FROM audit_events e JOIN actors a ON a.id = e.actor_id WHERE e.entity_id = ${org.body.judgeObservation.id}`);
    console.log('R10 audit of organizer correction', JSON.stringify(ev));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.meta).not.toContain('organizer says');
  });
  it('M5/M6 data is untouched by recording (digest of every pre-existing table before/after)', async () => {
    if (!env) return;
    const tables = ['pre_interview_assessments', 'assessment_dimension_judgments', 'assessment_judgment_citations', 'assessment_run_coverage', 'assessment_run_calls', 'assessment_run_outcomes', 'graph_extractions', 'evidence_items', 'claims', 'unknowns', 'contradictions', 'question_sets', 'question_set_opportunities', 'question_set_questions', 'source_snapshots', 'analysis_runs'];
    const digest = async () => { const d: string[] = []; for (const t of tables) d.push((await rows<{ d: string }>(env!.db, sql.raw(`SELECT coalesce(md5(string_agg(x::text,'|' ORDER BY x::text)),'empty') AS d FROM ${t} x`)))[0]!.d); return d.join(','); };
    const before = await digest();
    for (let i = 0; i < 3; i++) await ans(0, `noise ${i}`);
    await obs({ subject: 's', observed: 'o', outcome: 'inconclusive' }, TOK.judgeB, 1);
    expect(await digest()).toBe(before);
    expect(await count(env, 'evidence_items', "origin IN ('team_answer','judge_observation')")).toBe(0);
  });
});
