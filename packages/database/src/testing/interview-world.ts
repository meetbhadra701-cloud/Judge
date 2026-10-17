import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { JudgeDatabase } from '../client.js';
import { QuestionSetStore } from '../question-set-store.js';
import { actors, preInterviewAssessments, projectVoids, projects } from '../schema/index.js';
import { persistedAssessment, questionSetInput } from './question-world.js';

/*
 * Test-only: a verified assessment with a stored question set of two questions, and the actors who interview. Excluded from the package build and exports.
 */

export interface InterviewWorld {
  readonly projectId: string;
  readonly eventId: string;
  readonly assessmentId: string;
  readonly setId: string;
  readonly questionIds: readonly [string, string];
}

export async function newActor(
  db: JudgeDatabase,
  subject?: string,
): Promise<{ id: string; subject: string }> {
  const who = subject ?? `judge-${randomBytes(4).toString('hex')}`;
  const [row] = await db
    .insert(actors)
    .values({ issuer: 'urn:interview-test', subject: who })
    .returning();
  if (!row) throw new Error('actor not created');
  return { id: row.id, subject: who };
}

export async function interviewWorld(db: JudgeDatabase): Promise<InterviewWorld> {
  const made = await persistedAssessment(db);
  const [assessment] = await db
    .select({
      contextVersionId: preInterviewAssessments.contextVersionId,
      extractionId: preInterviewAssessments.extractionId,
    })
    .from(preInterviewAssessments)
    .where(eq(preInterviewAssessments.id, made.assessmentId));
  const store = new QuestionSetStore(db);
  const stored = await store.persist(
    questionSetInput(
      {
        projectId: made.world.project.id,
        assessmentId: made.assessmentId,
        contextVersionId: assessment?.contextVersionId ?? '',
        extractionId: assessment?.extractionId ?? '',
        reportOutputHash: made.report.outputHash,
      },
      { generationKey: randomBytes(32).toString('hex') },
    ),
  );
  const view = await store.getView(made.world.project.id, stored.setId);
  const ids = view?.questions.map((q) => q.id) ?? [];
  const [project] = await db
    .select({ eventId: projects.eventId })
    .from(projects)
    .where(eq(projects.id, made.world.project.id));
  if (ids.length !== 2 || !ids[0] || !ids[1] || !project)
    throw new Error('interview world not built');
  return {
    projectId: made.world.project.id,
    eventId: project.eventId,
    assessmentId: made.assessmentId,
    setId: stored.setId,
    questionIds: [ids[0], ids[1]],
  };
}

/** Voids the project the way an organizer does (the void record; the database guards do the rest). */
export async function voidProject(
  db: JudgeDatabase,
  world: Pick<InterviewWorld, 'projectId' | 'eventId'>,
  actorId: string,
): Promise<void> {
  await db.insert(projectVoids).values({
    eventId: world.eventId,
    projectId: world.projectId,
    voidedByActorId: actorId,
    reason: 'wrong submission',
    nameBefore: 'overwritten by the database',
    idempotencyKey: `void-${randomUUID()}`,
    requestHash: 'a'.repeat(64),
  });
}

/** A second question set of the SAME assessment (a different generation identity), with its two questions. */
export async function extraSet(
  db: JudgeDatabase,
  world: Pick<InterviewWorld, 'projectId' | 'assessmentId'>,
): Promise<{ setId: string; questionIds: readonly [string, string] }> {
  const [assessment] = await db
    .select({
      contextVersionId: preInterviewAssessments.contextVersionId,
      extractionId: preInterviewAssessments.extractionId,
      reportOutputHash: preInterviewAssessments.outputHash,
    })
    .from(preInterviewAssessments)
    .where(eq(preInterviewAssessments.id, world.assessmentId));
  if (!assessment) throw new Error('assessment missing');
  const store = new QuestionSetStore(db);
  const stored = await store.persist(
    questionSetInput(
      {
        projectId: world.projectId,
        assessmentId: world.assessmentId,
        contextVersionId: assessment.contextVersionId,
        extractionId: assessment.extractionId,
        reportOutputHash: assessment.reportOutputHash,
      },
      { generationKey: randomBytes(32).toString('hex') },
    ),
  );
  const view = await store.getView(world.projectId, stored.setId);
  const ids = view?.questions.map((q) => q.id) ?? [];
  if (!ids[0] || !ids[1]) throw new Error('extra set not built');
  return { setId: stored.setId, questionIds: [ids[0], ids[1]] };
}
