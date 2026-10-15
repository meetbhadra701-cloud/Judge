import type { JudgeDatabase } from '@judge-copilot/database';
import { sql, type SQL } from 'drizzle-orm';

/*
 * Test-only (excluded from the build, like the rest of this directory). It lets a hostile-review test simulate corruption of an
 * immutable assessment row on a DISPOSABLE database: the table's immutability trigger is disabled only for the duration of the callback,
 * and re-enabled even if the callback throws. The application has no code path that does this; the production database role is the
 * only thing that stands between a writer and these rows, which is exactly the threat the read model's verification is for.
 */

export const IMMUTABLE_GUARDS = {
  assessments: ['pre_interview_assessments', 'pre_interview_assessments_immutable_guard'],
  judgments: ['assessment_dimension_judgments', 'assessment_dimension_judgments_immutable_guard'],
  citations: ['assessment_judgment_citations', 'assessment_judgment_citations_immutable_guard'],
  coverage: ['assessment_run_coverage', 'assessment_run_coverage_immutable_guard'],
} as const;

export type GuardedTable = keyof typeof IMMUTABLE_GUARDS;

export async function withGuardsDisabled(
  db: JudgeDatabase,
  tables: readonly GuardedTable[],
  statements: readonly SQL[],
): Promise<void> {
  const disabled: GuardedTable[] = [];
  try {
    for (const key of tables) {
      const [table, trigger] = IMMUTABLE_GUARDS[key];
      await db.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
      disabled.push(key);
    }
    for (const statement of statements) await db.execute(statement);
  } finally {
    for (const key of disabled) {
      const [table, trigger] = IMMUTABLE_GUARDS[key];
      await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
    }
  }
}

/** Named corruptions for tests outside this package (they cannot import the query builder). */
export const corruptions = {
  /** The queryable JSONB mirror of the report no longer equals the canonical text. */
  reportMirror: (db: JudgeDatabase, assessmentId: string) =>
    withGuardsDisabled(
      db,
      ['assessments'],
      [
        sql`UPDATE pre_interview_assessments SET report = jsonb_set(report, '{overall,score10}', '10') WHERE id = ${assessmentId}`,
      ],
    ),
  /** The stored judgment scores disagree with the (still valid) report. */
  judgmentScores: (db: JudgeDatabase, assessmentId: string) =>
    withGuardsDisabled(
      db,
      ['judgments'],
      [
        sql`UPDATE assessment_dimension_judgments SET score = 1 WHERE assessment_id = ${assessmentId}`,
      ],
    ),
};
