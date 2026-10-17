import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseConnection } from './client.js';
import type { JudgeDatabase } from './index.js';
import {
  InterviewAlreadyCorrectedError,
  InterviewKeyReusedError,
  InterviewProjectVoidedError,
  InterviewStore,
  type RecordTeamAnswerInput,
} from './interview-store.js';
import { auditEvents, projectVoids, teamAnswers } from './schema/index.js';
import { openPostgres, rows, sql } from './testing/databases.js';
import { interviewWorld, newActor } from './testing/interview-world.js';

/*
 * M7: the interview records under REAL concurrency: separate connections of one pool, real transactions, real locks. Skipped without TEST_DATABASE_URL: PGlite is
 * a single connection and cannot interleave transactions, so a passing PGlite run proves none of this.
 */

const URL_ = process.env['TEST_DATABASE_URL'];
const HASH = (c: string) => c.repeat(64);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!URL_)('M7 interview records: concurrency (PostgreSQL)', () => {
  let setup: Awaited<ReturnType<typeof openPostgres>>;
  let pool: DatabaseConnection;
  let db: JudgeDatabase;
  let store: InterviewStore;
  let judge: { id: string };

  beforeAll(async () => {
    setup = await openPostgres(URL_ ?? '');
    pool = createDatabase(URL_ ?? '', { maxConnections: 30 });
    db = pool.db;
    store = new InterviewStore(db);
    judge = await newActor(db, 'judge-concurrent');
  });
  afterAll(async () => {
    await pool.close();
    await setup.close();
  });

  const answer = (
    w: { projectId: string; setId: string; questionIds: readonly [string, string] },
    over: Partial<RecordTeamAnswerInput> = {},
  ): RecordTeamAnswerInput => ({
    projectId: w.projectId,
    setId: w.setId,
    questionId: w.questionIds[0],
    text: 'An answer.',
    supersedesAnswerId: null,
    actorId: judge.id,
    role: 'judge',
    idempotencyKey: randomUUID(),
    requestHash: HASH('a'),
    ...over,
  });
  async function waitUntilBlocked(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if ((row?.n ?? 0) > 0) return;
      await sleep(25);
    }
    throw new Error('nothing became blocked on a lock');
  }
  const countAnswers = async (assessmentId: string): Promise<number> =>
    (await db.select().from(teamAnswers).where(eq(teamAnswers.assessmentId, assessmentId))).length;

  it('twenty simultaneous submissions of ONE logical request create exactly one record and one audit event; the rest are replays', async () => {
    const w = await interviewWorld(db);
    const input = answer(w);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.recordTeamAnswer(input)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const kinds = results.map((r) => (r.status === 'fulfilled' ? r.value.kind : 'rejected'));
    expect(kinds.filter((k) => k === 'created')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'replayed')).toHaveLength(19);
    const ids = new Set(results.map((r) => (r.status === 'fulfilled' ? r.value.id : '')));
    expect(ids.size).toBe(1);
    expect(await countAnswers(w.assessmentId)).toBe(1);
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, [...ids][0] ?? ''));
    expect(events).toHaveLength(1);
  });

  it('simultaneous submissions that reuse one key for DIFFERENT content: one wins, the others are refused, never a second record', async () => {
    const w = await interviewWorld(db);
    const key = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        store.recordTeamAnswer(
          answer(w, {
            idempotencyKey: key,
            requestHash: HASH(i % 2 === 0 ? 'a' : 'b'),
            text: `variant ${String(i % 2)}`,
          }),
        ),
      ),
    );
    const created = results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'created');
    expect(created).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(InterviewKeyReusedError);
    }
    expect(await countAnswers(w.assessmentId)).toBe(1);
  });

  it('twenty distinct simultaneous answers are all kept (no lost write), each audited once', async () => {
    const w = await interviewWorld(db);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.recordTeamAnswer(answer(w, { text: `answer ${String(i)}` })),
      ),
    );
    expect(results.every((r) => r.kind === 'created')).toBe(true);
    expect(await countAnswers(w.assessmentId)).toBe(20);
    const all = await store.listForAssessment(w.projectId, w.assessmentId);
    expect(new Set(all.teamAnswers.map((a) => a.text)).size).toBe(20);
    const ids = all.teamAnswers.map((a) => a.id);
    const events = (await db.select().from(auditEvents)).filter((e) => ids.includes(e.entityId));
    expect(events).toHaveLength(20);
  });

  it('twelve simultaneous, conflicting corrections of ONE record: exactly one is written, the other eleven are refused, and the chain stays linear', async () => {
    const w = await interviewWorld(db);
    const original = await store.recordTeamAnswer(answer(w, { text: 'original' }));
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        store.recordTeamAnswer(
          answer(w, { text: `fix ${String(i)}`, supersedesAnswerId: original.id }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(InterviewAlreadyCorrectedError);
    }
    const all = (await store.listForAssessment(w.projectId, w.assessmentId)).teamAnswers;
    expect(all).toHaveLength(2);
    expect(all.filter((a) => a.isCurrent)).toHaveLength(1);
    expect(all[0]?.supersededByAnswerId).toBe(all[1]?.id);
    expect(await countAnswers(w.assessmentId)).toBe(2);
  });

  it('a record written while a void is being committed is refused (the record waits on the void, then sees it)', async () => {
    const w = await interviewWorld(db);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const voiding = db.transaction(async (tx) => {
      await tx.insert(projectVoids).values({
        eventId: w.eventId,
        projectId: w.projectId,
        voidedByActorId: judge.id,
        reason: 'wrong submission',
        nameBefore: 'overwritten',
        idempotencyKey: `void-${randomUUID()}`,
        requestHash: HASH('c'),
      });
      await gate;
    });
    await sleep(150);
    // the void is not committed: the store's own up-front check cannot see it, so only the database's guard can refuse this write
    const writing = store.recordTeamAnswer(answer(w, { text: 'written during the void' })).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitUntilBlocked();
    release();
    await voiding;
    const outcome = await writing;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(InterviewProjectVoidedError);
    expect(await countAnswers(w.assessmentId)).toBe(0);
  });

  it('a void requested while a record is being written waits for it: the record is kept, and nothing is written afterwards', async () => {
    const w = await interviewWorld(db);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = db.transaction(async (tx) => {
      await tx.insert(teamAnswers).values({
        projectId: w.projectId,
        assessmentId: w.assessmentId,
        questionSetId: w.setId,
        questionId: w.questionIds[0],
        answerText: 'written before the void commits',
        recordedByActorId: judge.id,
        recordedAsRole: 'judge',
        idempotencyKey: randomUUID(),
        requestHash: HASH('d'),
      });
      await gate;
    });
    await sleep(150);
    const voiding = db
      .insert(projectVoids)
      .values({
        eventId: w.eventId,
        projectId: w.projectId,
        voidedByActorId: judge.id,
        reason: 'wrong submission',
        nameBefore: 'overwritten',
        idempotencyKey: `void-${randomUUID()}`,
        requestHash: HASH('e'),
      })
      .then(() => 'voided');
    await waitUntilBlocked();
    release();
    await writing;
    expect(await voiding).toBe('voided');
    expect(await countAnswers(w.assessmentId)).toBe(1);
    await expect(store.recordTeamAnswer(answer(w))).rejects.toBeInstanceOf(
      InterviewProjectVoidedError,
    );
    expect(await countAnswers(w.assessmentId)).toBe(1);
  });

  it('under a burst of writers, a void splits the writes cleanly: every accepted record is stored, every other is refused as voided', async () => {
    const w = await interviewWorld(db);
    const writers = Array.from({ length: 24 }, (_, i) =>
      sleep(i * 8)
        .then(() => store.recordTeamAnswer(answer(w, { text: `burst ${String(i)}` })))
        .then(
          () => 'created' as const,
          (error: unknown) =>
            error instanceof InterviewProjectVoidedError ? ('voided' as const) : ('error' as const),
        ),
    );
    const voiding = sleep(90).then(() =>
      db.insert(projectVoids).values({
        eventId: w.eventId,
        projectId: w.projectId,
        voidedByActorId: judge.id,
        reason: 'wrong submission',
        nameBefore: 'overwritten',
        idempotencyKey: `void-${randomUUID()}`,
        requestHash: HASH('f'),
      }),
    );
    const outcomes = await Promise.all(writers);
    await voiding;
    expect(outcomes.filter((o) => o === 'error')).toHaveLength(0);
    expect(await countAnswers(w.assessmentId)).toBe(outcomes.filter((o) => o === 'created').length);
    await expect(store.recordTeamAnswer(answer(w))).rejects.toBeInstanceOf(
      InterviewProjectVoidedError,
    );
  });
});
