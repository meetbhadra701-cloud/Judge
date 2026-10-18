import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caller, count, openEnv, P, rows, sql, TOK, twoAssessmentProject, type Env, type Project } from './env.js';

// Real PostgreSQL 16, one pool of 40 connections, every request is a separate HTTP-level call (Fastify inject) racing the others.
const URL = process.env['R10_PG_URL'];
const SECRET = 'SECRET-TYPED-TEXT-r10';
describe.skipIf(!URL)('R10 T3 HTTP-level concurrency on PostgreSQL 16', () => {
  let env: Env; let call: ReturnType<typeof caller>;
  beforeAll(async () => { env = (await openEnv('pg'))!; call = caller(env); });
  afterAll(async () => { await env?.close(); });
  const fresh = async (): Promise<Project> => twoAssessmentProject(env);
  const audit = async (p: Project, like = 'interview.%') => Number((await rows<{ n: number }>(env.db, sql`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE ${like} AND metadata->>'projectId' = ${p.projectId}`))[0]!.n);
  const recs = async (p: Project) => ({ ans: await count(env, 'team_answers', `project_id = '${p.projectId}'`), obs: await count(env, 'judge_observations', `project_id = '${p.projectId}'`) });
  const tally = (rs: { status: number }[]) => rs.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const leak = (rs: { body: any }[]) => rs.filter((r) => JSON.stringify(r.body?.error ?? {}).includes(SECRET)).length;
  const log = (k: string, v: unknown) => console.log(`R10-T3 ${k} ${JSON.stringify(v)}`);

  it('A: 20 simultaneous identical answers -> 1 record, 1 audit event, one 201 + nineteen 200 with the same id', async () => {
    const p = await fresh(); const a = p.a[0]!; const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 20 }, () => call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key, payload: { text: SECRET } })));
    log('A', { statuses: tally(rs), records: await recs(p), audit: await audit(p) });
    expect(tally(rs)).toEqual({ 201: 1, 200: 19 });
    expect(new Set(rs.map((r) => r.body.teamAnswer.id)).size).toBe(1);
    expect(await recs(p)).toEqual({ ans: 1, obs: 0 }); expect(await audit(p)).toBe(1);
    expect(JSON.stringify((await rows(env.db, sql`SELECT metadata FROM audit_events WHERE metadata->>'projectId' = ${p.projectId}`)))).not.toContain(SECRET);
  });

  it('B: same key, different text (20 racing, 10 texts) -> exactly 1 record; the others 409 IDEMPOTENCY_KEY_REUSED; no text in errors', async () => {
    const p = await fresh(); const a = p.a[0]!; const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key, payload: { text: `${SECRET} ${i % 10}` } })));
    log('B', { statuses: tally(rs), codes: [...new Set(rs.filter((r) => r.status === 409).map((r) => r.body.error.code))], records: await recs(p), audit: await audit(p), leaks: leak(rs) });
    expect(await recs(p)).toEqual({ ans: 1, obs: 0 }); expect(await audit(p)).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    for (const r of rs.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(leak(rs)).toBe(0);
  });

  it('C: same key, different question / different assessment\'s set / observation-vs-answer -> exactly 1 record in total', async () => {
    const p = await fresh(); const [a0, a1] = [p.a[0]!, p.a[1]!]; const key = randomUUID();
    const reqs = [
      () => call('POST', P.answers(p.projectId, a0.setId, a0.questionIds[0]!), { key, payload: { text: SECRET } }),
      () => call('POST', P.answers(p.projectId, a0.setId, a0.questionIds[1]!), { key, payload: { text: SECRET } }),
      () => call('POST', P.answers(p.projectId, a1.setId, a1.questionIds[0]!), { key, payload: { text: SECRET } }),
      () => call('POST', P.observations(p.projectId, a0.assessmentId), { key, payload: { subject: 's', observed: SECRET, outcome: 'confirmed' } }),
    ];
    const rs = await Promise.all(Array.from({ length: 24 }, (_, i) => reqs[i % 4]!()));
    const recd = await recs(p);
    log('C', { statuses: tally(rs), records: recd, audit: await audit(p), leaks: leak(rs) });
    // key is unique per (actor, table): at most ONE answer and ONE observation can exist
    expect(recd.ans).toBe(1); expect(recd.obs).toBeLessThanOrEqual(1);
    expect(await audit(p)).toBe(recd.ans + recd.obs);
    expect(rs.some((r) => r.status >= 500)).toBe(false); expect(leak(rs)).toBe(0);
    // whichever answer won is a coherent record (set/question/assessment all of one target)
    const w = (await rows<{ a: string; s: string; q: string }>(env.db, sql`SELECT assessment_id AS a, question_set_id AS s, question_id AS q FROM team_answers WHERE project_id = ${p.projectId}`))[0]!;
    expect([[a0.assessmentId, a0.setId], [a1.assessmentId, a1.setId]].some(([x, y]) => x === w.a && y === w.s)).toBe(true);
  });

  it('D: 20 concurrent duplicate observations -> 1 record, 1 audit event', async () => {
    const p = await fresh(); const a = p.a[0]!; const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 20 }, () => call('POST', P.observations(p.projectId, a.assessmentId), { key, payload: { subject: 'demo', observed: SECRET, outcome: 'unable_to_verify' } })));
    log('D', { statuses: tally(rs), records: await recs(p), audit: await audit(p) });
    expect(tally(rs)).toEqual({ 201: 1, 200: 19 }); expect(await recs(p)).toEqual({ ans: 0, obs: 1 }); expect(await audit(p)).toBe(1);
  });

  it('E: 12 conflicting corrections of one answer (and of one observation) -> exactly one winner each, linear chain', async () => {
    const p = await fresh(); const a = p.a[0]!;
    const orig = (await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: 'orig' } })).body.teamAnswer;
    const ob = (await call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 's', observed: 'o', outcome: 'confirmed' } })).body.judgeObservation;
    const toks = [TOK.judgeA, TOK.judgeB, TOK.both, TOK.organizer];
    const [ra, ro] = await Promise.all([
      Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { token: toks[i % 4]!, payload: { text: `${SECRET} fix ${i}`, supersedesAnswerId: orig.id } }))),
      Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', P.observations(p.projectId, a.assessmentId), { token: toks[i % 4]!, payload: { subject: 's', observed: `${SECRET} fix ${i}`, outcome: 'inconclusive', supersedesObservationId: ob.id } }))),
    ]);
    const succ = (await rows<{ n: number }>(env.db, sql`SELECT count(*)::int AS n FROM team_answers WHERE supersedes_answer_id = ${orig.id}`))[0]!.n;
    const osucc = (await rows<{ n: number }>(env.db, sql`SELECT count(*)::int AS n FROM judge_observations WHERE supersedes_observation_id = ${ob.id}`))[0]!.n;
    log('E', { answers: tally(ra), observations: tally(ro), succ, osucc, records: await recs(p), correctedAudit: await audit(p, 'interview.%_corrected'), leaks: leak(ra) + leak(ro) });
    expect(tally(ra)).toEqual({ 201: 1, 409: 11 }); expect(tally(ro)).toEqual({ 201: 1, 409: 11 });
    expect(succ).toBe(1); expect(osucc).toBe(1);
    expect(await recs(p)).toEqual({ ans: 2, obs: 2 }); expect(await audit(p, 'interview.%_corrected')).toBe(2);
    for (const r of [...ra, ...ro].filter((x) => x.status === 409)) expect(r.body.error.code).toBe('INTERVIEW_ALREADY_CORRECTED');
    expect(leak(ra) + leak(ro)).toBe(0);
    // exactly one current record per chain, via the API
    const list = (await call('GET', P.interview(p.projectId, a.assessmentId))).body;
    expect(list.teamAnswers.filter((x: any) => x.isCurrent)).toHaveLength(1); expect(list.judgeObservations.filter((x: any) => x.isCurrent)).toHaveLength(1);
  });

  it('F: response lost after commit, client retries with the same key -> 200 replay, same record, no new audit event; byte-identical body', async () => {
    const p = await fresh(); const a = p.a[0]!; const key = randomUUID();
    const first = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key, payload: { text: 'typed once' } });
    void first.body; // the client "never saw" it: discard and retry later, from another request, other connection
    await Promise.all(Array.from({ length: 5 }, () => call('GET', P.interview(p.projectId, a.assessmentId))));
    const retry = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key, payload: { text: 'typed once' } });
    log('F', { first: first.status, retry: retry.status, records: await recs(p), audit: await audit(p) });
    expect([first.status, retry.status]).toEqual([201, 200]);
    expect(retry.body.teamAnswer).toEqual(first.body.teamAnswer);
    expect(await recs(p)).toEqual({ ans: 1, obs: 0 }); expect(await audit(p)).toBe(1);
    // the same for an observation, and for a correction
    const okey = randomUUID();
    const o1 = await call('POST', P.observations(p.projectId, a.assessmentId), { key: okey, payload: { subject: 's', observed: 'o', outcome: 'confirmed' } });
    const o2 = await call('POST', P.observations(p.projectId, a.assessmentId), { key: okey, payload: { subject: 's', observed: 'o', outcome: 'confirmed' } });
    expect([o1.status, o2.status]).toEqual([201, 200]); expect(o2.body.judgeObservation).toEqual(o1.body.judgeObservation);
    const ckey = randomUUID();
    const c1 = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key: ckey, payload: { text: 'fixed', supersedesAnswerId: first.body.teamAnswer.id } });
    const c2 = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key: ckey, payload: { text: 'fixed', supersedesAnswerId: first.body.teamAnswer.id } });
    log('F-correction', { c1: c1.status, c2: c2.status, e: c2.body?.error?.code });
    expect([c1.status, c2.status]).toEqual([201, 200]);
    expect(await recs(p)).toEqual({ ans: 2, obs: 1 }); expect(await audit(p)).toBe(3);
  });

  it('G: void racing 12 interview submissions (both orders) -> every 201 is committed before the void; the rest 409 PROJECT_VOIDED; counts == 201s; no 5xx', async () => {
    const p = await fresh(); const a = p.a[0]!;
    const submit = (i: number) => (i % 2 ? call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: `${SECRET} ${i}` } }) : call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 's', observed: `${SECRET} ${i}`, outcome: 'confirmed' } }));
    const voidCall = () => call('POST', `/projects/${p.projectId}/void`, { token: TOK.organizer, payload: { reason: 'wrong submission, race test' } });
    const reqs: Promise<{ status: number; body: any }>[] = [];
    for (let i = 0; i < 12; i++) { if (i === 6) reqs.push(voidCall()); reqs.push(submit(i)); }
    const rs = await Promise.all(reqs);
    const voidRes = rs[6]!; const subs = rs.filter((_, i) => i !== 6);
    const created = subs.filter((r) => r.status === 201).length; const refused = subs.filter((r) => r.status === 409);
    log('G', { void: voidRes.status, voidBody: voidRes.status >= 400 ? voidRes.body?.error : 'ok', subs: tally(subs), codes: [...new Set(refused.map((r) => r.body.error.code))], records: await recs(p), audit: await audit(p), leaks: leak(subs) });
    expect(voidRes.status === 201 || voidRes.status === 200).toBe(true);
    expect(subs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    for (const r of refused) expect(r.body.error.code).toBe('PROJECT_VOIDED');
    const recd = await recs(p);
    expect(recd.ans + recd.obs).toBe(created); expect(await audit(p)).toBe(created);
    // every committed record predates the void record (DB clock)
    const late = (await rows<{ n: number }>(env.db, sql`SELECT count(*)::int AS n FROM (SELECT created_at FROM team_answers WHERE project_id = ${p.projectId} UNION ALL SELECT created_at FROM judge_observations WHERE project_id = ${p.projectId}) r, project_voids v WHERE v.project_id = ${p.projectId} AND r.created_at > v.created_at`))[0]!.n;
    log('G-after-void-records', late); expect(late).toBe(0);
    expect(leak(subs)).toBe(0);
  });


  it('G2: void landing MID-burst (submissions staggered across the void) in 4 projects -> a mix of 201/409, counts == 201s, nothing after the void, no 5xx', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let created = 0; let refused = 0;
    for (const voidAt of [30, 60, 90, 120]) {
      const p = await fresh(); const a = p.a[0]!;
      const subs: Promise<{ status: number; body: any }>[] = [];
      for (let i = 0; i < 40; i++) subs.push(wait(i * 4).then(() => (i % 2 ? call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: `${SECRET} ${i}` } }) : call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 's', observed: `${SECRET} ${i}`, outcome: 'confirmed' } }))));
      const v = wait(voidAt).then(() => call('POST', `/projects/${p.projectId}/void`, { token: TOK.organizer, payload: { reason: 'wrong submission, mid-burst' } }));
      const [vr, ...rs] = await Promise.all([v, ...subs]);
      const c = rs.filter((r) => r.status === 201).length; const f = rs.filter((r) => r.status === 409);
      const recd = await recs(p);
      log('G2', { voidAt, void: vr.status, created: c, refused: f.length, other: rs.length - c - f.length, records: recd, audit: await audit(p), leaks: leak(rs) });
      expect(vr.status).toBe(201);
      expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      for (const r of f) expect(r.body.error.code).toBe('PROJECT_VOIDED');
      expect(recd.ans + recd.obs).toBe(c); expect(await audit(p)).toBe(c);
      const late = (await rows<{ n: number }>(env.db, sql`SELECT count(*)::int AS n FROM (SELECT created_at FROM team_answers WHERE project_id = ${p.projectId} UNION ALL SELECT created_at FROM judge_observations WHERE project_id = ${p.projectId}) r, project_voids v WHERE v.project_id = ${p.projectId} AND r.created_at > v.created_at`))[0]!.n;
      expect(late).toBe(0); expect(leak(rs)).toBe(0);
      created += c; refused += f.length;
    }
    log('G2-total', { created, refused });
    expect(created).toBeGreaterThan(0); expect(refused).toBeGreaterThan(0); // both orders were actually exercised
  });

  it('H: after a void, a retry of an earlier success replays 200 (nothing new); a NEW key is refused 409 PROJECT_VOIDED; counts unchanged; reads still work', async () => {
    const p = await fresh(); const a = p.a[0]!; const key = randomUUID(); const okey = randomUUID();
    const ok = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key, payload: { text: 'before void' } });
    const ob = await call('POST', P.observations(p.projectId, a.assessmentId), { key: okey, payload: { subject: 's', observed: 'before', outcome: 'confirmed' } });
    expect((await call('POST', `/projects/${p.projectId}/void`, { token: TOK.organizer, payload: { reason: 'wrong submission' } })).status).toBe(201);
    const before = { r: await recs(p), a: await audit(p) };
    const replay = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key, payload: { text: 'before void' } });
    const oreplay = await call('POST', P.observations(p.projectId, a.assessmentId), { key: okey, payload: { subject: 's', observed: 'before', outcome: 'confirmed' } });
    const fresh1 = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: 'after void' } });
    const fresh2 = await call('POST', P.observations(p.projectId, a.assessmentId), { payload: { subject: 's', observed: 'after', outcome: 'confirmed' } });
    const corr = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { payload: { text: 'fix after void', supersedesAnswerId: ok.body.teamAnswer.id } });
    const reuse = await call('POST', P.answers(p.projectId, a.setId, a.questionIds[0]!), { key, payload: { text: 'DIFFERENT after void' } });
    const read = await call('GET', P.interview(p.projectId, a.assessmentId));
    log('H', { replay: replay.status, oreplay: oreplay.status, newAnswer: [fresh1.status, fresh1.body.error?.code], newObs: [fresh2.status, fresh2.body.error?.code], correction: [corr.status, corr.body.error?.code], reuseDifferent: [reuse.status, reuse.body.error?.code], read: read.status });
    expect(replay.status).toBe(200); expect(replay.body.teamAnswer).toEqual(ok.body.teamAnswer);
    expect(oreplay.status).toBe(200); expect(oreplay.body.judgeObservation).toEqual(ob.body.judgeObservation);
    for (const r of [fresh1, fresh2, corr]) { expect(r.status).toBe(409); expect(r.body.error.code).toBe('PROJECT_VOIDED'); }
    expect(reuse.status).toBe(409);
    expect({ r: await recs(p), a: await audit(p) }).toEqual(before);
    expect(read.status).toBe(200); expect(read.body.teamAnswers).toHaveLength(1);
  });
});
