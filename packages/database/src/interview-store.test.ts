import { randomUUID } from 'node:crypto';
import { INTERVIEW_FORBIDDEN_TEXT_SQL } from '@judge-copilot/schemas';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InterviewAlreadyCorrectedError,
  InterviewKeyReusedError,
  InterviewProjectVoidedError,
  InterviewStore,
  InterviewTargetMismatchError,
  InterviewTargetNotFoundError,
  type RecordJudgeObservationInput,
  type RecordTeamAnswerInput,
} from './interview-store.js';
import type { JudgeDatabase } from './client.js';
import { auditEvents, judgeObservations, teamAnswers } from './schema/index.js';
import {
  expectPgError,
  rows,
  sql,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import {
  extraSet,
  interviewWorld,
  newActor,
  voidProject,
  type InterviewWorld,
} from './testing/interview-world.js';

/*
 * M7: the interview records, at the database. Two layers are tested separately: the STORE (typed refusals, idempotency, audit, void handling) and the DATABASE
 * itself (composite foreign keys, CHECKs, append-only and not-voided triggers), where every statement goes straight to SQL so a bug in the store cannot make a
 * rule hold or fail. Concurrency across real connections is in interview-concurrency.test.ts (PostgreSQL only).
 */

const HASH = (c: string) => c.repeat(64);

describe.each(testDatabaseTargets())('interview records on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let store: InterviewStore;
  let judge: { id: string; subject: string };
  let second: { id: string; subject: string };

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    store = new InterviewStore(db);
    judge = await newActor(db, 'judge-alpha');
    second = await newActor(db, 'judge-beta');
  });
  afterAll(async () => {
    await testDb.close();
  });

  const answer = (
    w: Pick<InterviewWorld, 'projectId' | 'setId'> & { questionId: string },
    over: Partial<RecordTeamAnswerInput> = {},
  ): RecordTeamAnswerInput => ({
    projectId: w.projectId,
    setId: w.setId,
    questionId: w.questionId,
    text: 'We use a mesh radio protocol for sync.',
    supersedesAnswerId: null,
    actorId: judge.id,
    role: 'judge',
    idempotencyKey: randomUUID(),
    requestHash: HASH('a'),
    ...over,
  });
  const observation = (
    w: Pick<InterviewWorld, 'projectId' | 'assessmentId'>,
    over: Partial<RecordJudgeObservationInput> = {},
  ): RecordJudgeObservationInput => ({
    projectId: w.projectId,
    assessmentId: w.assessmentId,
    questionSetId: null,
    questionId: null,
    teamAnswerId: null,
    subject: 'Sync demo',
    observed: 'The two devices exchanged a message with the network disabled.',
    outcome: 'confirmed',
    supersedesObservationId: null,
    actorId: judge.id,
    role: 'judge',
    idempotencyKey: randomUUID(),
    requestHash: HASH('b'),
    ...over,
  });
  const q = (w: InterviewWorld, i: 0 | 1 = 0) => ({ ...w, questionId: w.questionIds[i] });

  describe('recording and reading', () => {
    it('records a team answer: the assessment is derived from the set, the actor, role, time and id are the server’s, and it reads back', async () => {
      const w = await interviewWorld(db);
      const done = await store.recordTeamAnswer(answer(q(w)));
      expect(done.kind).toBe('created');
      const all = await store.listForAssessment(w.projectId, w.assessmentId);
      expect(all.teamAnswers).toHaveLength(1);
      const view = all.teamAnswers[0];
      expect(view).toMatchObject({
        id: done.id,
        projectId: w.projectId,
        assessmentId: w.assessmentId,
        questionSetId: w.setId,
        questionId: w.questionIds[0],
        text: 'We use a mesh radio protocol for sync.',
        recordedBy: { id: judge.id, subject: 'judge-alpha' },
        recordedAsRole: 'judge',
        supersedesAnswerId: null,
        supersededByAnswerId: null,
        isCurrent: true,
      });
      expect(Number.isNaN(Date.parse(view?.recordedAt ?? ''))).toBe(false);
      expect(await store.teamAnswerView(w.projectId, done.id)).toEqual(view);
    });

    it('records observations of every outcome, linked to a question and answer or standing alone, and keeps them apart from answers', async () => {
      const w = await interviewWorld(db);
      const a = await store.recordTeamAnswer(answer(q(w)));
      const outcomes = ['confirmed', 'not_confirmed', 'inconclusive', 'unable_to_verify'] as const;
      for (const outcome of outcomes) {
        await store.recordJudgeObservation(
          observation(w, {
            outcome,
            questionSetId: w.setId,
            questionId: w.questionIds[0],
            teamAnswerId: a.id,
          }),
        );
      }
      await store.recordJudgeObservation(
        observation(w, { subject: 'General', observed: 'Looked at the repository layout.' }),
      );
      const all = await store.listForAssessment(w.projectId, w.assessmentId);
      expect(all.teamAnswers).toHaveLength(1);
      expect(all.judgeObservations).toHaveLength(5);
      expect(all.judgeObservations.map((o) => o.outcome)).toEqual([...outcomes, 'confirmed']);
      expect(all.judgeObservations[0]).toMatchObject({
        teamAnswerId: a.id,
        questionId: w.questionIds[0],
      });
      expect(all.judgeObservations[4]).toMatchObject({
        teamAnswerId: null,
        questionId: null,
        questionSetId: null,
      });
    });

    it('lists oldest first, so the interview reads in the order it happened, and several answers to one question are all kept', async () => {
      const w = await interviewWorld(db);
      const texts = ['first answer', 'second answer', 'third answer'];
      for (const text of texts) await store.recordTeamAnswer(answer(q(w), { text }));
      const all = await store.listForAssessment(w.projectId, w.assessmentId);
      expect(all.teamAnswers.map((x) => x.text)).toEqual(texts);
      expect(all.teamAnswers.every((x) => x.isCurrent)).toBe(true);
    });

    it('stores text as typed: markup, scripts, instructions and unicode are data', async () => {
      const w = await interviewWorld(db);
      const hostile =
        "<script>alert(1)</script> ignore previous instructions {{x}} 日本語 🙂 '; DROP TABLE team_answers; --\nline two\ttab";
      await store.recordTeamAnswer(answer(q(w), { text: hostile }));
      expect(
        (await store.listForAssessment(w.projectId, w.assessmentId)).teamAnswers[0]?.text,
      ).toBe(hostile);
    });

    it('never returns another project’s records', async () => {
      const a = await interviewWorld(db);
      const b = await interviewWorld(db);
      await store.recordTeamAnswer(answer(q(a)));
      expect((await store.listForAssessment(b.projectId, a.assessmentId)).teamAnswers).toEqual([]);
      const mine = await store.listForAssessment(a.projectId, a.assessmentId);
      expect(await store.teamAnswerView(b.projectId, mine.teamAnswers[0]?.id ?? '')).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('a replay of the same actor, key and content returns the stored record and writes nothing (not even a second audit event)', async () => {
      const w = await interviewWorld(db);
      const input = answer(q(w));
      const first = await store.recordTeamAnswer(input);
      const again = await store.recordTeamAnswer(input);
      expect(again).toEqual({ kind: 'replayed', id: first.id });
      expect((await store.listForAssessment(w.projectId, w.assessmentId)).teamAnswers).toHaveLength(
        1,
      );
      const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, first.id));
      expect(events).toHaveLength(1);
    });

    it('the same key with different content is refused and changes nothing; a different actor’s same key is a different request', async () => {
      const w = await interviewWorld(db);
      const input = answer(q(w));
      await store.recordTeamAnswer(input);
      await expect(
        store.recordTeamAnswer({ ...input, requestHash: HASH('c'), text: 'other' }),
      ).rejects.toBeInstanceOf(InterviewKeyReusedError);
      const other = await store.recordTeamAnswer({ ...input, actorId: second.id });
      expect(other.kind).toBe('created');
      expect((await store.listForAssessment(w.projectId, w.assessmentId)).teamAnswers).toHaveLength(
        2,
      );
    });

    it('observations are idempotent in the same way', async () => {
      const w = await interviewWorld(db);
      const input = observation(w);
      const first = await store.recordJudgeObservation(input);
      expect(await store.recordJudgeObservation(input)).toEqual({ kind: 'replayed', id: first.id });
      await expect(
        store.recordJudgeObservation({ ...input, requestHash: HASH('d'), observed: 'different' }),
      ).rejects.toBeInstanceOf(InterviewKeyReusedError);
      expect(
        (await store.listForAssessment(w.projectId, w.assessmentId)).judgeObservations,
      ).toHaveLength(1);
    });
  });

  describe('targets (the store’s precise refusals)', () => {
    it('an answer to a question of another project, to an unknown question, or to a question named with the wrong set is not found', async () => {
      const a = await interviewWorld(db);
      const b = await interviewWorld(db);
      const other = await extraSet(db, a);
      for (const bad of [
        answer({ projectId: a.projectId, setId: b.setId, questionId: b.questionIds[0] }),
        answer({ projectId: b.projectId, setId: a.setId, questionId: a.questionIds[0] }),
        answer(q(a), { questionId: randomUUID() }),
        answer({ projectId: a.projectId, setId: a.setId, questionId: other.questionIds[0] }),
      ]) {
        await expect(store.recordTeamAnswer(bad)).rejects.toBeInstanceOf(
          InterviewTargetNotFoundError,
        );
      }
      expect((await store.listForAssessment(a.projectId, a.assessmentId)).teamAnswers).toEqual([]);
      expect((await store.listForAssessment(b.projectId, b.assessmentId)).teamAnswers).toEqual([]);
    });

    it('an observation must name an assessment of its project, a set of that assessment, a question of that set and an answer to that question', async () => {
      const a = await interviewWorld(db);
      const b = await interviewWorld(db);
      const secondSet = await extraSet(db, a);
      const answered = await store.recordTeamAnswer(answer(q(a, 0)));
      // nonexistent in this project (another project's objects look exactly like nonexistent ones)
      await expect(
        store.recordJudgeObservation(
          observation({ projectId: a.projectId, assessmentId: b.assessmentId }),
        ),
      ).rejects.toBeInstanceOf(InterviewTargetNotFoundError);
      await expect(
        store.recordJudgeObservation(
          observation(a, { questionSetId: b.setId, questionId: b.questionIds[0] }),
        ),
      ).rejects.toBeInstanceOf(InterviewTargetNotFoundError);
      await expect(
        store.recordJudgeObservation(
          observation(a, { questionSetId: a.setId, questionId: b.questionIds[0] }),
        ),
      ).rejects.toBeInstanceOf(InterviewTargetNotFoundError);
      // real objects that do not belong together
      await expect(
        store.recordJudgeObservation(
          observation(a, { questionSetId: a.setId, questionId: secondSet.questionIds[0] }),
        ),
      ).rejects.toBeInstanceOf(InterviewTargetMismatchError);
      await expect(
        store.recordJudgeObservation(
          observation(a, {
            questionSetId: a.setId,
            questionId: a.questionIds[1],
            teamAnswerId: answered.id,
          }),
        ),
      ).rejects.toBeInstanceOf(InterviewTargetMismatchError);
      await expect(
        store.recordJudgeObservation(observation(a, { teamAnswerId: answered.id })),
      ).rejects.toBeInstanceOf(InterviewTargetMismatchError);
      await expect(
        store.recordJudgeObservation(
          observation(a, {
            questionSetId: a.setId,
            questionId: a.questionIds[0],
            teamAnswerId: randomUUID(),
          }),
        ),
      ).rejects.toBeInstanceOf(InterviewTargetNotFoundError);
      expect(
        (await store.listForAssessment(a.projectId, a.assessmentId)).judgeObservations,
      ).toEqual([]);
    });
  });

  describe('corrections and history', () => {
    it('a correction is a new record that names the one it replaces; the original stays; only the newest of a chain is current', async () => {
      const w = await interviewWorld(db);
      const original = await store.recordTeamAnswer(
        answer(q(w), { text: 'We built it in two days.' }),
      );
      const c1 = await store.recordTeamAnswer(
        answer(q(w), {
          text: 'Correction: three days.',
          supersedesAnswerId: original.id,
          actorId: second.id,
        }),
      );
      const c2 = await store.recordTeamAnswer(
        answer(q(w), {
          text: 'Correction again: three and a half days.',
          supersedesAnswerId: c1.id,
        }),
      );
      const { teamAnswers: all } = await store.listForAssessment(w.projectId, w.assessmentId);
      expect(all.map((x) => x.text)).toEqual([
        'We built it in two days.',
        'Correction: three days.',
        'Correction again: three and a half days.',
      ]);
      expect(all.map((x) => x.isCurrent)).toEqual([false, false, true]);
      expect(all[0]).toMatchObject({ supersedesAnswerId: null, supersededByAnswerId: c1.id });
      expect(all[1]).toMatchObject({
        supersedesAnswerId: original.id,
        supersededByAnswerId: c2.id,
      });
      expect(all[1]?.recordedBy.subject).toBe('judge-beta');
    });

    it('two corrections of the same record cannot both be written; correcting something that is not there, or of another question, is refused', async () => {
      const w = await interviewWorld(db);
      const original = await store.recordTeamAnswer(answer(q(w)));
      await store.recordTeamAnswer(
        answer(q(w), { text: 'fix one', supersedesAnswerId: original.id }),
      );
      await expect(
        store.recordTeamAnswer(answer(q(w), { text: 'fix two', supersedesAnswerId: original.id })),
      ).rejects.toBeInstanceOf(InterviewAlreadyCorrectedError);
      await expect(
        store.recordTeamAnswer(answer(q(w), { text: 'x', supersedesAnswerId: randomUUID() })),
      ).rejects.toBeInstanceOf(InterviewTargetNotFoundError);
      await expect(
        store.recordTeamAnswer(answer(q(w, 1), { text: 'x', supersedesAnswerId: original.id })),
      ).rejects.toBeInstanceOf(InterviewTargetMismatchError);
      const stranger = await interviewWorld(db);
      await expect(
        store.recordTeamAnswer(answer(q(stranger), { text: 'x', supersedesAnswerId: original.id })),
      ).rejects.toBeInstanceOf(InterviewTargetNotFoundError);
      expect((await store.listForAssessment(w.projectId, w.assessmentId)).teamAnswers).toHaveLength(
        2,
      );
    });

    it('observations are corrected the same way', async () => {
      const w = await interviewWorld(db);
      const original = await store.recordJudgeObservation(
        observation(w, { outcome: 'inconclusive' }),
      );
      const fixed = await store.recordJudgeObservation(
        observation(w, { outcome: 'confirmed', supersedesObservationId: original.id }),
      );
      await expect(
        store.recordJudgeObservation(observation(w, { supersedesObservationId: original.id })),
      ).rejects.toBeInstanceOf(InterviewAlreadyCorrectedError);
      const { judgeObservations: all } = await store.listForAssessment(w.projectId, w.assessmentId);
      expect(all.map((x) => [x.id, x.isCurrent])).toEqual([
        [original.id, false],
        [fixed.id, true],
      ]);
      expect(all[1]?.supersedesObservationId).toBe(original.id);
    });
  });

  describe('audit', () => {
    it('records the actor, the action and identifiers; never the text', async () => {
      const w = await interviewWorld(db);
      const secret = 'A-DISTINCT-ANSWER-TEXT-9f2c';
      const a = await store.recordTeamAnswer(answer(q(w), { text: secret }));
      const o = await store.recordJudgeObservation(
        observation(w, {
          observed: `${secret} observed`,
          subject: `${secret} subject`,
          questionSetId: w.setId,
          questionId: w.questionIds[0],
          teamAnswerId: a.id,
        }),
      );
      const fix = await store.recordTeamAnswer(
        answer(q(w), { text: secret + '2', supersedesAnswerId: a.id, actorId: second.id }),
      );
      const events = await db.select().from(auditEvents);
      const forA = events.find((e) => e.entityId === a.id);
      expect(forA).toMatchObject({
        actorId: judge.id,
        entityType: 'team_answer',
        action: 'interview.team_answer_recorded',
        metadata: {
          projectId: w.projectId,
          assessmentId: w.assessmentId,
          questionSetId: w.setId,
          questionId: w.questionIds[0],
          role: 'judge',
        },
      });
      expect(events.find((e) => e.entityId === o.id)).toMatchObject({
        actorId: judge.id,
        entityType: 'judge_observation',
        action: 'interview.judge_observation_recorded',
        metadata: { outcome: 'confirmed', teamAnswerId: a.id },
      });
      expect(events.find((e) => e.entityId === fix.id)).toMatchObject({
        actorId: second.id,
        action: 'interview.team_answer_corrected',
        metadata: { supersedesAnswerId: a.id },
      });
      const mine = events.filter((e) => [a.id, o.id, fix.id].includes(e.entityId));
      expect(mine).toHaveLength(3);
      expect(JSON.stringify(mine)).not.toContain('A-DISTINCT-ANSWER-TEXT');
    });

    it('a refused write leaves no record and no audit event (one transaction)', async () => {
      const w = await interviewWorld(db);
      const before = (await db.select().from(auditEvents)).length;
      await expect(
        store.recordTeamAnswer(answer({ ...q(w), questionId: randomUUID() })),
      ).rejects.toBeInstanceOf(InterviewTargetNotFoundError);
      expect((await db.select().from(auditEvents)).length).toBe(before);
    });
  });

  describe('a voided project', () => {
    it('keeps its history readable, refuses a new record, and still answers a replay of a request that was already saved', async () => {
      const w = await interviewWorld(db);
      const saved = answer(q(w));
      const first = await store.recordTeamAnswer(saved);
      await voidProject(db, w, judge.id);
      expect(await store.projectVoided(w.projectId)).toBe(true);
      await expect(store.recordTeamAnswer(answer(q(w), { text: 'late' }))).rejects.toBeInstanceOf(
        InterviewProjectVoidedError,
      );
      await expect(store.recordJudgeObservation(observation(w))).rejects.toBeInstanceOf(
        InterviewProjectVoidedError,
      );
      expect(await store.recordTeamAnswer(saved)).toEqual({ kind: 'replayed', id: first.id });
      expect((await store.listForAssessment(w.projectId, w.assessmentId)).teamAnswers).toHaveLength(
        1,
      );
    });

    it('the database refuses a direct insert for a voided project, for both tables', async () => {
      const w = await interviewWorld(db);
      await voidProject(db, w, judge.id);
      await expectPgError(
        db.insert(teamAnswers).values({ ...rawAnswer(w) }),
        SQLSTATE.RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.insert(judgeObservations).values({ ...rawObservation(w) }),
        SQLSTATE.RESTRICT_VIOLATION,
      );
    });
  });

  // -- the database, directly -------------------------------------------------------------------------------------------------------

  const rawAnswer = (
    w: Pick<InterviewWorld, 'projectId' | 'assessmentId' | 'setId' | 'questionIds'>,
    over: Partial<typeof teamAnswers.$inferInsert> = {},
  ): typeof teamAnswers.$inferInsert => ({
    projectId: w.projectId,
    assessmentId: w.assessmentId,
    questionSetId: w.setId,
    questionId: w.questionIds[0],
    answerText: 'raw answer',
    recordedByActorId: judge.id,
    recordedAsRole: 'judge',
    idempotencyKey: randomUUID(),
    requestHash: HASH('e'),
    ...over,
  });
  const rawObservation = (
    w: Pick<InterviewWorld, 'projectId' | 'assessmentId'>,
    over: Partial<typeof judgeObservations.$inferInsert> = {},
  ): typeof judgeObservations.$inferInsert => ({
    projectId: w.projectId,
    assessmentId: w.assessmentId,
    subject: 'raw subject',
    observed: 'raw observed',
    outcome: 'confirmed',
    recordedByActorId: judge.id,
    recordedAsRole: 'judge',
    idempotencyKey: randomUUID(),
    requestHash: HASH('f'),
    ...over,
  });

  describe('database integrity (direct SQL)', () => {
    it('a valid raw row is accepted (the control for every refusal below)', async () => {
      const w = await interviewWorld(db);
      await db.insert(teamAnswers).values(rawAnswer(w));
      await db.insert(judgeObservations).values(rawObservation(w));
    });

    it('composite foreign keys: a question outside its set, a set of another assessment or project, and another project’s assessment are refused', async () => {
      const a = await interviewWorld(db);
      const b = await interviewWorld(db);
      const other = await extraSet(db, a);
      const FK = SQLSTATE.FOREIGN_KEY_VIOLATION;
      // question of another SET of the same assessment
      await expectPgError(
        db.insert(teamAnswers).values(rawAnswer(a, { questionId: other.questionIds[0] })),
        FK,
      );
      // question and set of another project, under this project's identifiers
      await expectPgError(
        db
          .insert(teamAnswers)
          .values(rawAnswer(a, { questionSetId: b.setId, questionId: b.questionIds[0] })),
        FK,
      );
      // this project's set under another project's assessment
      await expectPgError(
        db.insert(teamAnswers).values(rawAnswer(a, { assessmentId: b.assessmentId })),
        FK,
      );
      // another project's assessment with this project id
      await expectPgError(
        db.insert(judgeObservations).values(rawObservation(a, { assessmentId: b.assessmentId })),
        FK,
      );
      // a set that is not this assessment's set
      await expectPgError(
        db
          .insert(judgeObservations)
          .values(rawObservation(a, { questionSetId: b.setId, questionId: b.questionIds[0] })),
        FK,
      );
      // a question that is not in the named set
      await expectPgError(
        db
          .insert(judgeObservations)
          .values(rawObservation(a, { questionSetId: a.setId, questionId: other.questionIds[0] })),
        FK,
      );
    });

    it('an observation’s link shape: a set without a question, a question without a set, an answer without a question are refused; an answer to another question is refused', async () => {
      const a = await interviewWorld(db);
      const [answered] = await db.insert(teamAnswers).values(rawAnswer(a)).returning();
      const CHECK = SQLSTATE.CHECK_VIOLATION;
      await expectPgError(
        db.insert(judgeObservations).values(rawObservation(a, { questionSetId: a.setId })),
        CHECK,
      );
      await expectPgError(
        db.insert(judgeObservations).values(rawObservation(a, { questionId: a.questionIds[0] })),
        CHECK,
      );
      await expectPgError(
        db.insert(judgeObservations).values(rawObservation(a, { teamAnswerId: answered?.id })),
        CHECK,
      );
      await expectPgError(
        db.insert(judgeObservations).values(
          rawObservation(a, {
            questionSetId: a.setId,
            questionId: a.questionIds[1],
            teamAnswerId: answered?.id,
          }),
        ),
        SQLSTATE.FOREIGN_KEY_VIOLATION,
      );
      await db.insert(judgeObservations).values(
        rawObservation(a, {
          questionSetId: a.setId,
          questionId: a.questionIds[0],
          teamAnswerId: answered?.id,
        }),
      );
    });

    it('a correction must point at a record of the same project, assessment, set and question, and a record is corrected at most once', async () => {
      const a = await interviewWorld(db);
      const b = await interviewWorld(db);
      const [original] = await db.insert(teamAnswers).values(rawAnswer(a)).returning();
      const [elsewhere] = await db.insert(teamAnswers).values(rawAnswer(b)).returning();
      const FK = SQLSTATE.FOREIGN_KEY_VIOLATION;
      await expectPgError(
        db.insert(teamAnswers).values(rawAnswer(a, { supersedesAnswerId: elsewhere?.id })),
        FK,
      );
      await expectPgError(
        db
          .insert(teamAnswers)
          .values(rawAnswer(a, { questionId: a.questionIds[1], supersedesAnswerId: original?.id })),
        FK,
      );
      await db.insert(teamAnswers).values(rawAnswer(a, { supersedesAnswerId: original?.id }));
      await expectPgError(
        db.insert(teamAnswers).values(rawAnswer(a, { supersedesAnswerId: original?.id })),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      const [oOriginal] = await db.insert(judgeObservations).values(rawObservation(a)).returning();
      await expectPgError(
        db
          .insert(judgeObservations)
          .values(rawObservation(b, { supersedesObservationId: oOriginal?.id })),
        FK,
      );
      await db
        .insert(judgeObservations)
        .values(rawObservation(a, { supersedesObservationId: oOriginal?.id }));
      await expectPgError(
        db
          .insert(judgeObservations)
          .values(rawObservation(a, { supersedesObservationId: oOriginal?.id })),
        SQLSTATE.UNIQUE_VIOLATION,
      );
    });

    it('text, outcome, role and hash constraints', async () => {
      const w = await interviewWorld(db);
      const CHECK = SQLSTATE.CHECK_VIOLATION;
      for (const answerText of [
        '',
        '   ',
        'x'.repeat(4001),
        'bell\u0007',
        'nul-ish\u0001',
        'del\u007f',
        'c1\u0085',
        'bidi' + String.fromCharCode(0x202e) + 'evil',
        'iso' + String.fromCharCode(0x2066) + 'x',
      ]) {
        await expectPgError(db.insert(teamAnswers).values(rawAnswer(w, { answerText })), CHECK);
      }
      await expectPgError(
        db.insert(judgeObservations).values(rawObservation(w, { subject: 'x'.repeat(501) })),
        CHECK,
      );
      await expectPgError(
        db.insert(judgeObservations).values(rawObservation(w, { observed: 'x'.repeat(4001) })),
        CHECK,
      );
      await expectPgError(
        db.insert(judgeObservations).values(rawObservation(w, { observed: '' })),
        CHECK,
      );
      await expectPgError(
        db.insert(judgeObservations).values(rawObservation(w, { outcome: 'proven' as never })),
        CHECK,
      );
      await expectPgError(
        db
          .insert(judgeObservations)
          .values(rawObservation(w, { recordedAsRole: 'admin' as never })),
        CHECK,
      );
      await expectPgError(
        db.insert(teamAnswers).values(rawAnswer(w, { recordedAsRole: 'system' as never })),
        CHECK,
      );
      await expectPgError(
        db.insert(teamAnswers).values(rawAnswer(w, { requestHash: 'nothex' })),
        CHECK,
      );
      // the bounds are inclusive, and a line break and a tab are text
      await db.insert(teamAnswers).values(rawAnswer(w, { answerText: `${'y'.repeat(3996)}\n\tz` }));
      await db.insert(teamAnswers).values(rawAnswer(w, { answerText: '🙂'.repeat(4000) }));
    });

    it('the CHECK constraints refuse exactly the characters the request schema refuses (every code point up to U+2100, measured in the database)', async () => {
      const js = new RegExp(INTERVIEW_FORBIDDEN_TEXT_SQL, 'u');
      const measured = await rows<{ n: number; bad: boolean }>(
        db,
        sql`SELECT n, (chr(n) ~ ${INTERVIEW_FORBIDDEN_TEXT_SQL}) AS bad FROM generate_series(1, 8448) AS n WHERE n NOT BETWEEN 55296 AND 57343`,
      );
      expect(measured.length).toBe(8448);
      const disagreements = measured.filter((m) => m.bad !== js.test(String.fromCodePoint(m.n)));
      expect(disagreements).toEqual([]);
      expect(measured.filter((m) => m.bad).length).toBeGreaterThan(40);
    });

    it('an unknown actor is refused', async () => {
      const w = await interviewWorld(db);
      await expectPgError(
        db.insert(teamAnswers).values(rawAnswer(w, { recordedByActorId: randomUUID() })),
        SQLSTATE.FOREIGN_KEY_VIOLATION,
      );
    });

    it('the time of a record is the database clock, whatever the writer supplied', async () => {
      const w = await interviewWorld(db);
      const before = Date.now();
      const [row] = await db
        .insert(teamAnswers)
        .values(rawAnswer(w, { createdAt: new Date('2001-01-01T00:00:00Z') }))
        .returning();
      expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
      expect(row?.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
      const [obs] = await db
        .insert(judgeObservations)
        .values(rawObservation(w, { createdAt: new Date('2002-02-02T00:00:00Z') }))
        .returning();
      expect(obs?.createdAt.getFullYear()).toBeGreaterThan(2020);
    });

    it('append-only: no update, delete or truncate of either table, by any statement', async () => {
      const w = await interviewWorld(db);
      const [a] = await db.insert(teamAnswers).values(rawAnswer(w)).returning();
      const [o] = await db.insert(judgeObservations).values(rawObservation(w)).returning();
      const R = SQLSTATE.RESTRICT_VIOLATION;
      await expectPgError(
        db.execute(sql`UPDATE team_answers SET answer_text = 'edited' WHERE id = ${a?.id}`),
        R,
      );
      await expectPgError(
        db.execute(
          sql`UPDATE team_answers SET recorded_by_actor_id = ${second.id} WHERE id = ${a?.id}`,
        ),
        R,
      );
      await expectPgError(db.execute(sql`DELETE FROM team_answers WHERE id = ${a?.id}`), R);
      await expectPgError(
        db.execute(
          sql`UPDATE judge_observations SET outcome = 'not_confirmed' WHERE id = ${o?.id}`,
        ),
        R,
      );
      await expectPgError(db.execute(sql`DELETE FROM judge_observations WHERE id = ${o?.id}`), R);
      await expectPgError(db.execute(sql`TRUNCATE team_answers, judge_observations`), R);
      await expectPgError(db.execute(sql`TRUNCATE judge_observations`), R);
      const [kept] = await rows<{ answer_text: string }>(
        db,
        sql`SELECT answer_text FROM team_answers WHERE id = ${a?.id}`,
      );
      expect(kept?.answer_text).toBe('raw answer');
    });

    it('the M6 tables the records point at stay immutable and undeletable (the new keys did not weaken them)', async () => {
      const w = await interviewWorld(db);
      await expectPgError(
        db.execute(sql`DELETE FROM question_set_questions WHERE id = ${w.questionIds[0]}`),
        SQLSTATE.RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.execute(sql`UPDATE question_sets SET selected_count = 1 WHERE id = ${w.setId}`),
        SQLSTATE.RESTRICT_VIOLATION,
      );
    });
  });
});
