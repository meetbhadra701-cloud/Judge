import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actors,
  events,
  projectSources,
  projectSubmissionRequests,
  projectSubmissions,
  projects,
} from './index.js';
import {
  expectPgError,
  rows,
  sql,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';

/*
 * P6B-beta1: the DATABASE enforces the submission invariants, independently of the application. Every statement here goes straight to SQL,
 * so a bug (or a different writer) in the service cannot make these hold or fail. Each attack targets ONE row or ONE column, so the test
 * cannot pass by tripping an unrelated constraint.
 */

const RESTRICT = SQLSTATE.RESTRICT_VIOLATION;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
let counter = 0;

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing value');
  return value;
}

describe.each(testDatabaseTargets())('P6B-beta1 submission guards on %s', (_name, open) => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function actor() {
    counter += 1;
    const [row] = await testDb.db
      .insert(actors)
      .values({ issuer: 'urn:guard', subject: `guard-${String(counter)}` })
      .returning();
    return must(row);
  }
  async function event() {
    counter += 1;
    const [row] = await testDb.db
      .insert(events)
      .values({ name: `Guard ${String(counter)}`, slug: `submission-guard-${String(counter)}` })
      .returning();
    return must(row);
  }
  async function project(eventId: string, name?: string) {
    counter += 1;
    const [row] = await testDb.db
      .insert(projects)
      .values({ eventId, name: name ?? `Guarded ${String(counter)}` })
      .returning();
    return must(row);
  }

  /** A project with its submission and request records, links `github-<n>` / `devpost-<n>`. */
  async function submitted(existing?: { eventId: string; actorId: string }) {
    const owner = existing?.actorId ?? (await actor()).id;
    const eventId = existing?.eventId ?? (await event()).id;
    counter += 1;
    const n = String(counter);
    const created = await project(eventId, `Submitted ${n}`);
    const [submission] = await testDb.db
      .insert(projectSubmissions)
      .values({
        eventId,
        projectId: created.id,
        submittedByActorId: owner,
        githubUrl: `https://github.com/guard/repo-${n}`,
        devpostUrl: `https://devpost.com/software/guard-${n}`,
        nameKey: `submitted ${n}`,
      })
      .returning();
    const [request] = await testDb.db
      .insert(projectSubmissionRequests)
      .values({
        actorId: owner,
        idempotencyKey: `key-${n}-abcdefgh`,
        requestHash: sha(n),
        submissionId: must(submission).id,
        projectId: created.id,
        result: 'created',
      })
      .returning();
    return {
      eventId,
      actorId: owner,
      project: created,
      submission: must(submission),
      request: must(request),
      n,
    };
  }

  describe('append-only records', () => {
    it.each([
      ['github_url', "github_url = 'https://github.com/guard/moved'"],
      ['devpost_url', "devpost_url = 'https://devpost.com/software/moved'"],
      ['name_key', "name_key = 'moved'"],
      ['created_at', "created_at = now() + interval '1 day'"],
    ])('a submission cannot have %s changed', async (_column, assignment) => {
      const row = await submitted();
      await expectPgError(
        testDb.db.execute(
          sql.raw(`UPDATE project_submissions SET ${assignment} WHERE id = '${row.submission.id}'`),
        ),
        RESTRICT,
      );
    });

    it('a submission cannot be deleted', async () => {
      const row = await submitted();
      await expectPgError(
        testDb.db.execute(sql`DELETE FROM project_submissions WHERE id = ${row.submission.id}`),
        RESTRICT,
        SQLSTATE.FOREIGN_KEY_VIOLATION,
      );
      expect(
        await rows(
          testDb.db,
          sql`SELECT id FROM project_submissions WHERE id = ${row.submission.id}`,
        ),
      ).toHaveLength(1);
    });

    it.each([
      ['request_hash', `request_hash = '${'0'.repeat(64)}'`],
      ['result', "result = 'already_submitted'"],
      ['idempotency_key', "idempotency_key = 'another-key-abcdefgh'"],
    ])('a request record cannot have %s changed', async (_column, assignment) => {
      const row = await submitted();
      await expectPgError(
        testDb.db.execute(
          sql.raw(
            `UPDATE project_submission_requests SET ${assignment} WHERE id = '${row.request.id}'`,
          ),
        ),
        RESTRICT,
      );
    });

    it('a request record cannot be deleted, so a key can never be forgotten and reused', async () => {
      const row = await submitted();
      await expectPgError(
        testDb.db.execute(
          sql`DELETE FROM project_submission_requests WHERE id = ${row.request.id}`,
        ),
        RESTRICT,
      );
    });

    it('TRUNCATE-free: the records of other submissions are untouched by a refused change', async () => {
      const a = await submitted();
      const b = await submitted();
      await expectPgError(
        testDb.db.execute(
          sql`UPDATE project_submissions SET name_key = 'x' WHERE id = ${a.submission.id}`,
        ),
        RESTRICT,
      );
      const [after] = await rows<{ name_key: string }>(
        testDb.db,
        sql`SELECT name_key FROM project_submissions WHERE id = ${b.submission.id}`,
      );
      expect(after?.name_key).toBe(`submitted ${b.n}`);
    });
  });

  describe('uniqueness decides who owns a link or a label', () => {
    it('one submission per project', async () => {
      const row = await submitted();
      await expectPgError(
        testDb.db.insert(projectSubmissions).values({
          eventId: row.eventId,
          projectId: row.project.id,
          submittedByActorId: row.actorId,
          githubUrl: 'https://github.com/guard/other-a',
          devpostUrl: 'https://devpost.com/software/other-a',
          nameKey: 'other a',
        }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
    });

    it.each([
      [
        'github_url',
        {
          githubUrl: 'https://github.com/guard/taken',
          devpostUrl: 'https://devpost.com/software/free-1',
          nameKey: 'free 1',
        },
        'Second owner',
      ],
      [
        'devpost_url',
        {
          githubUrl: 'https://github.com/guard/free-2',
          devpostUrl: 'https://devpost.com/software/taken',
          nameKey: 'free 2',
        },
        'Second owner',
      ],
    ])(
      'within one event the same %s cannot belong to two submissions',
      async (_column, clash, secondName) => {
        const e = await event();
        const owner = await actor();
        const first = await project(e.id, 'First owner');
        await testDb.db.insert(projectSubmissions).values({
          eventId: e.id,
          projectId: first.id,
          submittedByActorId: owner.id,
          githubUrl: 'https://github.com/guard/taken',
          devpostUrl: 'https://devpost.com/software/taken',
          nameKey: 'taken',
        });
        const second = await project(e.id, secondName);
        await expectPgError(
          testDb.db.insert(projectSubmissions).values({
            eventId: e.id,
            projectId: second.id,
            submittedByActorId: owner.id,
            ...clash,
          }),
          SQLSTATE.UNIQUE_VIOLATION,
        );
      },
    );

    it('the same links in ANOTHER event are independent submissions', async () => {
      const owner = await actor();
      const one = await event();
      const two = await event();
      for (const e of [one, two]) {
        const p = await project(e.id, 'Same links');
        await testDb.db.insert(projectSubmissions).values({
          eventId: e.id,
          projectId: p.id,
          submittedByActorId: owner.id,
          githubUrl: 'https://github.com/guard/shared-across-events',
          devpostUrl: 'https://devpost.com/software/shared-across-events',
          nameKey: 'same links',
        });
      }
      expect(
        await rows(
          testDb.db,
          sql`SELECT 1 FROM project_submissions WHERE github_url = 'https://github.com/guard/shared-across-events'`,
        ),
      ).toHaveLength(2);
    });

    it('one idempotency record per actor and key; another actor may use the same key text', async () => {
      const row = await submitted();
      await expectPgError(
        testDb.db.insert(projectSubmissionRequests).values({
          actorId: row.actorId,
          idempotencyKey: row.request.idempotencyKey,
          requestHash: sha('different'),
          submissionId: row.submission.id,
          projectId: row.project.id,
          result: 'already_submitted',
        }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      const other = await actor();
      await testDb.db.insert(projectSubmissionRequests).values({
        actorId: other.id,
        idempotencyKey: row.request.idempotencyKey,
        requestHash: sha('different'),
        submissionId: row.submission.id,
        projectId: row.project.id,
        result: 'already_submitted',
      });
    });

    it('a request record must point at the submission of ITS project', async () => {
      const a = await submitted();
      const b = await submitted();
      await expectPgError(
        testDb.db.insert(projectSubmissionRequests).values({
          actorId: a.actorId,
          idempotencyKey: 'mismatch-key-abcdefgh',
          requestHash: sha('m'),
          submissionId: a.submission.id,
          projectId: b.project.id,
          result: 'created',
        }),
        SQLSTATE.FOREIGN_KEY_VIOLATION,
      );
    });

    it('a submission cannot claim a project of another event', async () => {
      const owner = await actor();
      const one = await event();
      const two = await event();
      const p = await project(one.id, 'Event one project');
      await expectPgError(
        testDb.db.insert(projectSubmissions).values({
          eventId: two.id,
          projectId: p.id,
          submittedByActorId: owner.id,
          githubUrl: 'https://github.com/guard/cross-event',
          devpostUrl: 'https://devpost.com/software/cross-event',
          nameKey: 'event one project',
        }),
        SQLSTATE.FOREIGN_KEY_VIOLATION,
      );
    });
  });

  describe('value constraints', () => {
    const attempt = async (
      overrides: Partial<{ githubUrl: string; devpostUrl: string; nameKey: string }>,
    ) => {
      const e = await event();
      const owner = await actor();
      const p = await project(e.id);
      return testDb.db.insert(projectSubmissions).values({
        eventId: e.id,
        projectId: p.id,
        submittedByActorId: owner.id,
        githubUrl: 'https://github.com/guard/valid',
        devpostUrl: 'https://devpost.com/software/valid',
        nameKey: 'valid',
        ...overrides,
      });
    };

    it.each([
      ['a GitHub URL on another host', { githubUrl: 'https://gitlab.com/guard/valid' }],
      [
        'a GitHub URL with a deeper path',
        { githubUrl: 'https://github.com/guard/valid/tree/main' },
      ],
      ['a non-https GitHub URL', { githubUrl: 'http://github.com/guard/valid' }],
      [
        'a Devpost URL that is not a project page',
        { devpostUrl: 'https://devpost.com/hackathons' },
      ],
      ['a Devpost URL on another host', { devpostUrl: 'https://example.com/software/valid' }],
    ])('rejects %s', async (_label, overrides) => {
      await expectPgError(attempt(overrides), SQLSTATE.CHECK_VIOLATION);
    });

    it('rejects a malformed idempotency key, request hash and result', async () => {
      const row = await submitted();
      const base = {
        actorId: row.actorId,
        submissionId: row.submission.id,
        projectId: row.project.id,
      };
      await expectPgError(
        testDb.db
          .insert(projectSubmissionRequests)
          .values({ ...base, idempotencyKey: 'short', requestHash: sha('a'), result: 'created' }),
        SQLSTATE.CHECK_VIOLATION,
      );
      await expectPgError(
        testDb.db.insert(projectSubmissionRequests).values({
          ...base,
          idempotencyKey: 'valid-key-abcdefgh',
          requestHash: 'not-hex',
          result: 'created',
        }),
        SQLSTATE.CHECK_VIOLATION,
      );
      await expectPgError(
        testDb.db.insert(projectSubmissionRequests).values({
          ...base,
          idempotencyKey: 'valid-key-abcdefgh',
          requestHash: sha('b'),
          result: 'replayed' as never,
        }),
        SQLSTATE.CHECK_VIOLATION,
      );
    });
  });

  describe('a project of a submission keeps exactly its submission’s GitHub and Devpost links', () => {
    const declare = (
      projectId: string,
      sourceType: 'github' | 'devpost' | 'video' | 'deployment',
      url: string,
      position: number,
    ) => testDb.db.insert(projectSources).values({ projectId, sourceType, url, position });

    it.each([
      ['github', 'https://github.com/guard/another-repo'],
      ['devpost', 'https://devpost.com/software/another-page'],
    ] as const)('refuses a different %s source', async (sourceType, url) => {
      const row = await submitted();
      await expectPgError(declare(row.project.id, sourceType, url, 5), SQLSTATE.CHECK_VIOLATION);
      expect(
        await rows(
          testDb.db,
          sql`SELECT 1 FROM project_sources WHERE project_id = ${row.project.id}`,
        ),
      ).toHaveLength(0);
    });

    it('accepts the submission’s own links, and video and deployment sources', async () => {
      const row = await submitted();
      await declare(row.project.id, 'github', row.submission.githubUrl, 0);
      await declare(row.project.id, 'devpost', row.submission.devpostUrl, 1);
      await declare(row.project.id, 'video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 2);
      await declare(row.project.id, 'deployment', 'https://demo.example.test/', 3);
      expect(
        await rows(
          testDb.db,
          sql`SELECT 1 FROM project_sources WHERE project_id = ${row.project.id}`,
        ),
      ).toHaveLength(4);
    });

    it('does not restrict a project that has no submission (earlier flow)', async () => {
      const e = await event();
      const legacy = await project(e.id, 'No submission');
      await declare(legacy.id, 'github', 'https://github.com/guard/legacy-a', 0);
      await declare(legacy.id, 'github', 'https://github.com/guard/legacy-b', 1);
      expect(
        await rows(testDb.db, sql`SELECT 1 FROM project_sources WHERE project_id = ${legacy.id}`),
      ).toHaveLength(2);
    });

    it('a submission cannot be recorded over a project that already holds a different link', async () => {
      const e = await event();
      const owner = await actor();
      const mixed = await project(e.id, 'Already mixed');
      await declare(mixed.id, 'github', 'https://github.com/guard/pre-existing', 0);
      await expectPgError(
        testDb.db.insert(projectSubmissions).values({
          eventId: e.id,
          projectId: mixed.id,
          submittedByActorId: owner.id,
          githubUrl: 'https://github.com/guard/a-different-repo',
          devpostUrl: 'https://devpost.com/software/pre-existing-page',
          nameKey: 'already mixed',
        }),
        SQLSTATE.CHECK_VIOLATION,
      );
      // the same link is fine
      await testDb.db.insert(projectSubmissions).values({
        eventId: e.id,
        projectId: mixed.id,
        submittedByActorId: owner.id,
        githubUrl: 'https://github.com/guard/pre-existing',
        devpostUrl: 'https://devpost.com/software/pre-existing-page',
        nameKey: 'already mixed',
      });
    });
  });
});
