// R10A reviewer-owned harness. Written by the reviewer; uses only the product's public services and the test helpers it ships.
import { randomUUID } from 'node:crypto';
import type { AuthVerifier, VerifiedIdentity } from '../../packages/domain/src/index.js';
import { createDatabase, type JudgeDatabase } from '../../packages/database/src/index.js';
import { openPglite, openPostgres, rows, sql } from '../../packages/database/src/testing/databases.js';
import { ScriptedProvider } from '../../packages/llm/src/index.js';
import type { AssessmentListResponse, CreateQuestionSetResponse, QuestionSetView } from '../../packages/schemas/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { InterviewService } from '../../apps/api/src/interview/service.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import { QuestionService } from '../../apps/api/src/questions/service.js';
import { loadFixtures, replayService } from '../../apps/api/src/testing/harness.js';
import { demonstrationStep } from '../../apps/worker/src/assessment/demonstration-model.js';
import { execute } from '../../apps/worker/src/testing/run.js';

export const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
export const MODELS = { extraction: 'claude-haiku-5-5', assessment: 'claude-sonnet-5-5', critic: 'claude-sonnet-5-5' };
export const RUNTIME = { provider: { id: 'scripted', mode: 'scripted' }, models: MODELS } as const;

/** Distinct credentials, including a holder of BOTH roles and two separate judges. */
export const TOK = { judgeA: 'r10-judge-a', judgeB: 'r10-judge-b', organizer: 'r10-organizer', both: 'r10-both', none: 'r10-none' } as const;
const IDS: Record<string, VerifiedIdentity> = {
  [TOK.judgeA]: { issuer: 'urn:r10', subject: 'judge-a', roles: ['judge'] },
  [TOK.judgeB]: { issuer: 'urn:r10', subject: 'judge-b', roles: ['judge'] },
  [TOK.organizer]: { issuer: 'urn:r10', subject: 'organizer-1', roles: ['organizer'] },
  [TOK.both]: { issuer: 'urn:r10', subject: 'both-1', roles: ['organizer', 'judge'] },
  [TOK.none]: { issuer: 'urn:r10', subject: 'nobody', roles: [] },
};
export const verifier: AuthVerifier = { name: 'r10', verify: (c) => Promise.resolve(IDS[c] ?? null) };

export interface Env {
  readonly kind: 'pglite' | 'pg';
  readonly db: JudgeDatabase;
  readonly url: string | null;
  readonly app: ApiApp;
  readonly close: () => Promise<void>;
}

export async function openEnv(kind: 'pglite' | 'pg'): Promise<Env | null> {
  let db: JudgeDatabase;
  let closeDb: () => Promise<void>;
  let url: string | null = null;
  if (kind === 'pglite') {
    const t = await openPglite();
    db = t.db;
    closeDb = t.close;
  } else {
    url = process.env['R10_PG_URL'] ?? null;
    if (!url) return null;
    const setup = await openPostgres(url); // drops, recreates and migrates the disposable database
    const pool = createDatabase(url, { maxConnections: 40 });
    db = pool.db;
    closeDb = async () => { await pool.close(); await setup.close(); };
  }
  return envOver(kind, db, url, closeDb);
}

/** The same environment over a database someone else has migrated (used by the upgrade tests). */
export async function envOver(kind: 'pglite' | 'pg', db: JudgeDatabase, url: string | null, closeDb: () => Promise<void>): Promise<Env> {
  const app = buildApp({
    logger, db, verifier,
    eventContext: replayService(db, (await loadFixtures()).values()),
    projects: new ProjectService({ db }),
    assessments: new AssessmentService({ db, offline: RUNTIME }),
    questions: new QuestionService({ db, offline: RUNTIME }),
    interview: new InterviewService({ db }),
  });
  return { kind, db, url, app, close: async () => { await app.close(); await closeDb(); } };
}

export type Res = { status: number; body: any };
export const caller = (env: Env) => async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, o: { token?: string | null; payload?: unknown; key?: string | null; raw?: string } = {}): Promise<Res> => {
  const token = o.token === undefined ? TOK.judgeA : o.token;
  const key = o.key === undefined ? randomUUID() : o.key;
  const r = await env.app.inject({
    method, url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key && method !== 'GET' ? { 'idempotency-key': key } : {}), ...(o.raw === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(o.raw === undefined ? (o.payload === undefined ? {} : { payload: o.payload as object }) : { payload: o.raw }),
  });
  let body: unknown = null;
  try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};

export const P = {
  interview: (p: string, a: string) => `/projects/${p}/assessments/${a}/interview`,
  answers: (p: string, s: string, q: string) => `/projects/${p}/question-sets/${s}/questions/${q}/team-answers`,
  observations: (p: string, a: string) => `/projects/${p}/assessments/${a}/judge-observations`,
  sets: (p: string, a: string) => `/projects/${p}/assessments/${a}/question-sets`,
};

export interface Verified { assessmentId: string; setId: string; questionIds: string[]; set: QuestionSetView }
export interface Project { projectId: string; eventId: string; a: Verified[] }

async function setFor(call: ReturnType<typeof caller>, projectId: string, assessmentId: string): Promise<Verified> {
  const created = await call('POST', P.sets(projectId, assessmentId), { token: TOK.organizer, key: null });
  if (created.status !== 201 && created.status !== 200) throw new Error(`question set not created: ${created.status} ${JSON.stringify(created.body)}`);
  const set = (created.body as CreateQuestionSetResponse).set;
  return { assessmentId, setId: set.id, questionIds: set.questions.map((q) => q.id), set };
}

/** A project with TWO verified pre-interview assessments, each with its OWN question set (the scenario the author did not test end to end). */
export async function twoAssessmentProject(env: Env, options: Record<string, unknown> = { trackKeys: ['health'], declare: ['health'] }): Promise<Project> {
  const call = caller(env);
  const first = await execute(env.db, { worldOptions: options, provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }) });
  if (first.outcome.kind !== 'succeeded') throw new Error('first assessment failed');
  const second = await execute(env.db, { world: first.world, mode: 'reassess', provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }) });
  if (second.outcome.kind !== 'succeeded') throw new Error(`second assessment failed: ${JSON.stringify(second.outcome)}`);
  const projectId = first.world.project.id;
  const list = (await call('GET', `/projects/${projectId}/assessments`)).body as AssessmentListResponse;
  if (list.assessments.length < 2) throw new Error(`expected two assessments, got ${list.assessments.length}`);
  const ids = [...list.assessments].sort((x, y) => x.versionNumber - y.versionNumber).map((a) => a.id);
  const a = [await setFor(call, projectId, ids[0]!), await setFor(call, projectId, ids[1]!)];
  const eventId = (await rows<{ event_id: string }>(env.db, sql`SELECT event_id FROM projects WHERE id = ${projectId}`))[0]!.event_id;
  return { projectId, eventId, a };
}

export async function oneAssessmentProject(env: Env, options: Record<string, unknown> = { trackKeys: ['health'], declare: ['health'] }): Promise<Project> {
  const call = caller(env);
  const first = await execute(env.db, { worldOptions: options, provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }) });
  if (first.outcome.kind !== 'succeeded') throw new Error('assessment failed');
  const projectId = first.world.project.id;
  const list = (await call('GET', `/projects/${projectId}/assessments`)).body as AssessmentListResponse;
  const a = [await setFor(call, projectId, list.assessments[0]!.id)];
  const eventId = (await rows<{ event_id: string }>(env.db, sql`SELECT event_id FROM projects WHERE id = ${projectId}`))[0]!.event_id;
  return { projectId, eventId, a };
}

export const count = async (env: Env, table: string, where = 'true'): Promise<number> => Number((await rows<{ n: number }>(env.db, sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)))[0]?.n);
export { rows, sql };
