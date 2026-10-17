import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from './client.js';
import { InterviewStore } from './interview-store.js';
import { QuestionSetStore } from './question-set-store.js';
import { auditEvents } from './schema/index.js';
import {
  emptyDatabaseTargets,
  expectPgError,
  migrateFolder,
  rows,
  sql,
  SQLSTATE,
  type TestDatabase,
} from './testing/databases.js';
import { newActor } from './testing/interview-world.js';
import { persistedAssessment, questionSetInput } from './testing/question-world.js';

/*
 * M7 over an existing, populated M6 database: migrations 0000-0024 (the M6 baseline, including generation claims) are applied, a verified assessment and its question set
 * are written, then 0025 is applied on top. Nothing that existed may change, the new keys, tables and triggers must be active, an interview record must be writable for
 * the question set that already existed, and running the migration's own statements a second time must change nothing (the documented recovery of docs/MIGRATIONS.md 6.4).
 */

function baselineFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'judge-m6-migrations-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.filter((entry) => entry.idx <= 24);
  expect(kept.map((entry) => entry.tag).at(-1)).toBe('0024_m6_r1_generation_claims');
  for (const entry of kept)
    cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return folder;
}

describe.each(emptyDatabaseTargets())(
  'M6 baseline -> M7 migration upgrade on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    beforeAll(async () => {
      testDb = await open();
    });
    afterAll(async () => {
      await testDb.close();
    });

    it('adds the interview tables over populated M6 data without changing any of it; the new rules are active and work for the existing set', async () => {
      const db = testDb.db;
      await migrateFolder(testDb, baselineFolder());
      const tablesBefore = await rows<{ table_name: string }>(
        db,
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('team_answers', 'judge_observations')`,
      );
      expect(tablesBefore).toEqual([]);

      // a verified assessment and a stored question set, written under the M6 schema
      const made = await persistedAssessment(db);
      const [assessmentRow] = await rows<{
        context_version_id: string;
        extraction_id: string;
        output_hash: string;
      }>(
        db,
        sql`SELECT context_version_id, extraction_id, output_hash FROM pre_interview_assessments WHERE id = ${made.assessmentId}`,
      );
      const sets = new QuestionSetStore(db);
      const stored = await sets.persist(
        questionSetInput(
          {
            projectId: made.world.project.id,
            assessmentId: made.assessmentId,
            contextVersionId: assessmentRow?.context_version_id ?? '',
            extractionId: assessmentRow?.extraction_id ?? '',
            reportOutputHash: made.report.outputHash,
          },
          { generationKey: 'c'.repeat(64) },
        ),
      );
      const viewBefore = JSON.stringify(await sets.getView(made.world.project.id, stored.setId));
      const dumpBefore = async () =>
        rows(
          db,
          sql`SELECT (SELECT md5(string_agg(x::text, '~' ORDER BY x::text)) FROM question_sets x) AS sets,
                   (SELECT md5(string_agg(x::text, '~' ORDER BY x::text)) FROM question_set_questions x) AS questions,
                   (SELECT md5(string_agg(x::text, '~' ORDER BY x::text)) FROM pre_interview_assessments x) AS assessments,
                   (SELECT count(*) FROM audit_events) AS audits`,
        );
      const snapshot = await dumpBefore();

      await migrateFolder(testDb, migrationsFolder);

      // nothing that existed changed
      expect(await dumpBefore()).toEqual(snapshot);
      expect(JSON.stringify(await sets.getView(made.world.project.id, stored.setId))).toBe(
        viewBefore,
      );
      const tablesAfter = await rows<{ table_name: string }>(
        db,
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('team_answers', 'judge_observations') ORDER BY 1`,
      );
      expect(tablesAfter.map((t) => t.table_name)).toEqual(['judge_observations', 'team_answers']);
      const keys = await rows<{ conname: string }>(
        db,
        sql`SELECT conname FROM pg_constraint WHERE conname IN ('question_sets_id_project_assessment_key', 'question_set_questions_id_set_key') ORDER BY 1`,
      );
      expect(keys.map((k) => k.conname)).toEqual([
        'question_set_questions_id_set_key',
        'question_sets_id_project_assessment_key',
      ]);

      // an interview record is writable for the question set that existed BEFORE the upgrade
      const judge = await newActor(db);
      const view = await sets.getView(made.world.project.id, stored.setId);
      const questionId = view?.questions[0]?.id ?? '';
      const interview = new InterviewStore(db);
      const saved = await interview.recordTeamAnswer({
        projectId: made.world.project.id,
        setId: stored.setId,
        questionId,
        text: 'An answer after the upgrade.',
        supersedesAnswerId: null,
        actorId: judge.id,
        role: 'judge',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'a'.repeat(64),
      });
      expect(saved.kind).toBe('created');
      expect(
        (await db.select().from(auditEvents)).filter((e) => e.entityId === saved.id),
      ).toHaveLength(1);

      // the new rules are active on the upgraded database
      await expectPgError(
        db.execute(sql`UPDATE team_answers SET answer_text = 'edited' WHERE id = ${saved.id}`),
        SQLSTATE.RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.execute(sql`DELETE FROM team_answers WHERE id = ${saved.id}`),
        SQLSTATE.RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.execute(sql`TRUNCATE judge_observations`),
        SQLSTATE.RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.execute(sql`DELETE FROM question_set_questions WHERE id = ${questionId}`),
        SQLSTATE.RESTRICT_VIOLATION,
      );
    });

    it('running the migration’s own statements again changes nothing and fails nothing (the documented recovery)', async () => {
      const db = testDb.db;
      const before = await rows(
        db,
        sql`SELECT (SELECT count(*) FROM team_answers) AS a, (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('team_answers'::regclass, 'judge_observations'::regclass)) AS c,
                 (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('team_answers'::regclass, 'judge_observations'::regclass) AND NOT tgisinternal) AS t`,
      );
      const file = readFileSync(join(migrationsFolder, '0025_m7_interview_records.sql'), 'utf8');
      for (const statement of file
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)) {
        await db.execute(sql.raw(statement));
      }
      expect(
        await rows(
          db,
          sql`SELECT (SELECT count(*) FROM team_answers) AS a, (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('team_answers'::regclass, 'judge_observations'::regclass)) AS c,
                   (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('team_answers'::regclass, 'judge_observations'::regclass) AND NOT tgisinternal) AS t`,
        ),
      ).toEqual(before);
    });
  },
);
