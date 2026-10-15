import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actors,
  analysisRuns,
  events,
  projectReplacements,
  projectSources,
  projectSubmissionClaims,
  projectSubmissions,
  projectVoids,
  projects,
  sourceSnapshots,
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
 * P6B-beta2: the DATABASE enforces the identity, ownership and void invariants, independently of the application. Every statement goes
 * straight to SQL, so a bug (or another writer) in the service cannot make these hold or fail. Each attack targets one rule.
 */

const RESTRICT = SQLSTATE.RESTRICT_VIOLATION;
const IN_USE = '55006';
let counter = 0;

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing value');
  return value;
}

describe.each(testDatabaseTargets())('P6B-beta2 ownership and void guards on %s', (_name, open) => {
  let testDb: TestDatabase;
  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });
  const db = () => testDb.db;

  async function actor() {
    counter += 1;
    const [row] = await db()
      .insert(actors)
      .values({ issuer: 'urn:void', subject: `void-${String(counter)}` })
      .returning();
    return must(row);
  }
  async function event() {
    counter += 1;
    const [row] = await db()
      .insert(events)
      .values({ name: `Void ${String(counter)}`, slug: `void-guard-${String(counter)}` })
      .returning();
    return must(row);
  }
  async function project(eventId: string, name: string) {
    const [row] = await db().insert(projects).values({ eventId, name }).returning();
    return must(row);
  }

  /** A project with a recorded submission (the three claims are written by the database) and both declared sources. */
  async function submission(eventId: string, ownerId: string, tag: string, name = `Owner ${tag}`) {
    const created = await project(eventId, name);
    const github = `https://github.com/void/${tag}`;
    const devpost = `https://devpost.com/software/void-${tag}`;
    await db().insert(projectSubmissions).values({
      eventId,
      projectId: created.id,
      submittedByActorId: ownerId,
      githubUrl: github,
      devpostUrl: devpost,
      nameKey: 'ignored: derived by the database',
    });
    await db()
      .insert(projectSources)
      .values([
        { projectId: created.id, sourceType: 'github', url: github, position: 0 },
        { projectId: created.id, sourceType: 'devpost', url: devpost, position: 1 },
      ]);
    return { project: created, github, devpost };
  }

  async function voidIt(eventId: string, projectId: string, actorId: string, tag: string) {
    await db()
      .insert(projectVoids)
      .values({
        eventId,
        projectId,
        voidedByActorId: actorId,
        reason: 'wrong submission',
        nameBefore: 'overwritten by the database',
        idempotencyKey: `void-key-${tag}-abcdef`,
        requestHash: 'a'.repeat(64),
      });
  }

  const claimsOf = async (projectId: string) =>
    (await db().select().from(projectSubmissionClaims))
      .filter((c) => c.projectId === projectId)
      .map((c) => [c.kind, c.value] as const)
      .sort();

  describe('ownership registry', () => {
    it('recording a submission claims its two links and its case-folded, trimmed label -- derived by the database, not supplied', async () => {
      const e = await event();
      const a = await actor();
      const owner = await submission(e.id, a.id, 'claims', '  Mixed CASE Name  ');
      const [stored] = await rows<{ name_key: string }>(
        db(),
        sql`SELECT name_key FROM project_submissions WHERE project_id = ${owner.project.id}`,
      );
      expect(stored?.name_key).toBe('mixed case name');
      expect(await claimsOf(owner.project.id)).toEqual([
        ['devpost', owner.devpost],
        ['github', owner.github],
        ['name', 'mixed case name'],
      ]);
    });

    it('a claim can never be updated, and can be deleted only after its project has been voided', async () => {
      const e = await event();
      const a = await actor();
      const owner = await submission(e.id, a.id, 'claim-guard');
      await expectPgError(
        db().execute(
          sql`UPDATE project_submission_claims SET value = 'x' WHERE project_id = ${owner.project.id}`,
        ),
        RESTRICT,
      );
      await expectPgError(
        db().execute(
          sql`DELETE FROM project_submission_claims WHERE project_id = ${owner.project.id}`,
        ),
        RESTRICT,
      );
      expect(await claimsOf(owner.project.id)).toHaveLength(3);
      // even a voided project's remaining claims cannot be edited
      await voidIt(e.id, owner.project.id, a.id, 'claim-guard');
      expect(await claimsOf(owner.project.id)).toEqual([]); // released by the void itself
    });

    it('two active submissions of one event cannot share a link or a label (the unique registry decides), in any write order', async () => {
      const e = await event();
      const a = await actor();
      const first = await submission(e.id, a.id, 'dup-1', 'Shared Name');
      const rival = await project(e.id, 'Rival');
      const base = { eventId: e.id, projectId: rival.id, submittedByActorId: a.id, nameKey: 'x' };
      await expectPgError(
        db()
          .insert(projectSubmissions)
          .values({
            ...base,
            githubUrl: first.github,
            devpostUrl: 'https://devpost.com/software/void-free-a',
          }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      await expectPgError(
        db()
          .insert(projectSubmissions)
          .values({
            ...base,
            githubUrl: 'https://github.com/void/free-b',
            devpostUrl: first.devpost,
          }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      // the refused attempts left nothing behind: the project holds only the claim on its own label, made when it was created
      expect(await claimsOf(rival.id)).toEqual([['name', 'rival']]);
    });

    it('a label that differs only by case is the same label: a project cannot be created with it, and a submission cannot take an active project’s', async () => {
      const e = await event();
      const a = await actor();
      await submission(e.id, a.id, 'label', 'Orbit Team');
      await expectPgError(
        db().insert(projects).values({ eventId: e.id, name: 'ORBIT TEAM' }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      // since P6B-beta3 EVERY project claims its label when it is created, so an earlier-flow project's label is owned too: a second project whose
      // label folds to the same key cannot even be created (no race window between the creation and a later submission)
      await project(e.id, 'Case Twin');
      await expectPgError(
        db().insert(projects).values({ eventId: e.id, name: 'case twin' }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
    });

    it('the same links in ANOTHER event are independent', async () => {
      const a = await actor();
      const one = await event();
      const two = await event();
      const first = await submission(one.id, a.id, 'shared');
      const second = await submission(two.id, a.id, 'shared');
      expect(await claimsOf(first.project.id)).toHaveLength(3);
      expect(await claimsOf(second.project.id)).toHaveLength(3);
    });
  });

  describe('every write path respects the identity', () => {
    it('a project declares only the links of its own submission, and never a link another active submission owns', async () => {
      const e = await event();
      const a = await actor();
      const owner = await submission(e.id, a.id, 'paths');
      const legacy = await project(e.id, 'Earlier flow');
      await expectPgError(
        db()
          .insert(projectSources)
          .values({ projectId: legacy.id, sourceType: 'github', url: owner.github, position: 0 }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      await expectPgError(
        db()
          .insert(projectSources)
          .values({ projectId: legacy.id, sourceType: 'devpost', url: owner.devpost, position: 0 }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      // the submission's own project cannot gain a different link either
      await expectPgError(
        db().insert(projectSources).values({
          projectId: owner.project.id,
          sourceType: 'github',
          url: 'https://github.com/void/other',
          position: 5,
        }),
        SQLSTATE.CHECK_VIOLATION,
      );
      // other source types are unaffected
      await db().insert(projectSources).values({
        projectId: owner.project.id,
        sourceType: 'deployment',
        url: 'https://example.org/app',
        position: 6,
      });
    });

    it.each([
      ['an upper-case GitHub URL', 'github', 'https://github.com/Void/Repo'],
      ['a GitHub URL with a trailing slash', 'github', 'https://github.com/void/repo/'],
      ['a GitHub URL with a .git suffix path', 'github', 'https://github.com/void/repo/tree/main'],
      ['a GitHub URL on another host', 'github', 'https://gitlab.com/void/repo'],
      ['a GitHub URL with credentials', 'github', 'https://user:pw@github.com/void/repo'],
      ['an http GitHub URL', 'github', 'http://github.com/void/repo'],
      ['a GitHub URL with a query', 'github', 'https://github.com/void/repo?x=1'],
      [
        'a Devpost URL with a trailing slash',
        'devpost',
        'https://devpost.com/software/some-thing/',
      ],
      ['an upper-case Devpost URL', 'devpost', 'https://devpost.com/software/Some-Thing'],
      ['a Devpost gallery page', 'devpost', 'https://devpost.com/software'],
      ['a Devpost URL with a fragment', 'devpost', 'https://devpost.com/software/a#b'],
    ] as const)(
      'refuses %s as a declaration, whoever writes it',
      async (_label, sourceType, url) => {
        const e = await event();
        const p = await project(e.id, `Canonical ${String(counter++)}`);
        await expectPgError(
          db().insert(projectSources).values({ projectId: p.id, sourceType, url, position: 0 }),
          SQLSTATE.CHECK_VIOLATION,
        );
      },
    );

    it('stores canonical GitHub and Devpost declarations, and any URL for the other source types', async () => {
      const e = await event();
      const p = await project(e.id, `Canonical ok ${String(counter++)}`);
      await db()
        .insert(projectSources)
        .values([
          {
            projectId: p.id,
            sourceType: 'github',
            url: 'https://github.com/a-b/c.d_e',
            position: 0,
          },
          {
            projectId: p.id,
            sourceType: 'devpost',
            url: 'https://devpost.com/software/a1-b2',
            position: 1,
          },
          {
            projectId: p.id,
            sourceType: 'deployment',
            url: 'https://Example.org/App/',
            position: 2,
          },
        ]);
    });

    it('a project name changes only when the project is voided', async () => {
      const e = await event();
      const p = await project(e.id, 'Fixed Name');
      await expectPgError(
        db().execute(sql`UPDATE projects SET name = 'Another' WHERE id = ${p.id}`),
        RESTRICT,
      );
      const [unchanged] = (await db().select().from(projects)).filter((row) => row.id === p.id);
      expect(unchanged?.name).toBe('Fixed Name');
    });
  });

  describe('void', () => {
    it('releases the claims, marks the label, records the old label, and leaves every other row of the project as it was', async () => {
      const e = await event();
      const a = await actor();
      const owner = await submission(e.id, a.id, 'release', 'Release Me');
      const sourcesBefore = JSON.stringify(
        (await db().select().from(projectSources)).filter((s) => s.projectId === owner.project.id),
      );
      const submissionBefore = JSON.stringify(
        (await db().select().from(projectSubmissions)).filter(
          (s) => s.projectId === owner.project.id,
        ),
      );
      await voidIt(e.id, owner.project.id, a.id, 'release');
      expect(await claimsOf(owner.project.id)).toEqual([]);
      const [voided] = (await db().select().from(projects)).filter(
        (p) => p.id === owner.project.id,
      );
      expect(voided?.name).toBe(`Release Me [voided ${owner.project.id.slice(0, 8)}]`);
      const [record] = (await db().select().from(projectVoids)).filter(
        (row) => row.projectId === owner.project.id,
      );
      expect(record?.nameBefore).toBe('Release Me'); // the database records the label, whatever the caller supplied
      expect(
        JSON.stringify(
          (await db().select().from(projectSources)).filter(
            (s) => s.projectId === owner.project.id,
          ),
        ),
      ).toBe(sourcesBefore);
      expect(
        JSON.stringify(
          (await db().select().from(projectSubmissions)).filter(
            (s) => s.projectId === owner.project.id,
          ),
        ),
      ).toBe(submissionBefore);
      // the freed links and label can be taken by a new submission, and by nobody before the void
      const again = await submission(e.id, a.id, 'release', 'Release Me');
      expect(again.project.id).not.toBe(owner.project.id);
      expect(await claimsOf(again.project.id)).toHaveLength(3);
    });

    it('is refused while a capture is pending or a run is in flight (SQLSTATE 55006), and then changes nothing', async () => {
      const e = await event();
      const a = await actor();
      const owner = await submission(e.id, a.id, 'busy');
      const [source] = (await db().select().from(projectSources)).filter(
        (s) => s.projectId === owner.project.id,
      );
      const [snapshot] = await db()
        .insert(sourceSnapshots)
        .values({
          projectId: owner.project.id,
          projectSourceId: must(source).id,
          captureNumber: 1,
          sourceType: 'github',
          sourceUrl: must(source).url,
          status: 'pending',
        })
        .returning();
      await expectPgError(voidIt(e.id, owner.project.id, a.id, 'busy-1'), IN_USE);
      await db().execute(
        sql`UPDATE source_snapshots SET status = 'failed', failure_category = 'timeout', failure_metadata = '{}'::jsonb, completed_at = now() WHERE id = ${must(snapshot).id}`,
      );
      const [run] = await db()
        .insert(analysisRuns)
        .values({
          eventId: e.id,
          projectId: owner.project.id,
          runType: 'synthetic_stage',
          state: 'running',
        })
        .returning();
      await expectPgError(voidIt(e.id, owner.project.id, a.id, 'busy-2'), IN_USE);
      expect(await claimsOf(owner.project.id)).toHaveLength(3);
      expect(
        (await db().select().from(projectVoids)).filter((v) => v.projectId === owner.project.id),
      ).toHaveLength(0);
      await db().execute(
        sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${must(run).id}`,
      );
      await voidIt(e.id, owner.project.id, a.id, 'busy-3');
      expect(await claimsOf(owner.project.id)).toEqual([]);
    });

    it('is recorded once per project and by one actor+key only, and a void record can never be changed or removed', async () => {
      const e = await event();
      const a = await actor();
      const owner = await submission(e.id, a.id, 'once');
      await voidIt(e.id, owner.project.id, a.id, 'once');
      await expectPgError(
        voidIt(e.id, owner.project.id, a.id, 'once-2'),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      await expectPgError(
        db().execute(
          sql`UPDATE project_voids SET reason = 'edited' WHERE project_id = ${owner.project.id}`,
        ),
        RESTRICT,
      );
      await expectPgError(
        db().execute(sql`DELETE FROM project_voids WHERE project_id = ${owner.project.id}`),
        RESTRICT,
      );
      // the voided project cannot be deleted either, so the record can never dangle
      await expectPgError(
        db().execute(sql`DELETE FROM projects WHERE id = ${owner.project.id}`),
        SQLSTATE.FOREIGN_KEY_VIOLATION,
        RESTRICT,
      );
    });

    it('the replacement link is append-only, distinct, one-to-one and within one event', async () => {
      const e = await event();
      const other = await event();
      const a = await actor();
      const one = await submission(e.id, a.id, 'rep-1');
      const two = await submission(e.id, a.id, 'rep-2');
      const foreign = await submission(other.id, a.id, 'rep-3');
      await voidIt(e.id, one.project.id, a.id, 'rep-1');
      // not voided yet: no replacement can be recorded for it
      await expectPgError(
        db().insert(projectReplacements).values({
          eventId: e.id,
          voidedProjectId: two.project.id,
          replacementProjectId: one.project.id,
        }),
        SQLSTATE.FOREIGN_KEY_VIOLATION,
      );
      await expectPgError(
        db().insert(projectReplacements).values({
          eventId: e.id,
          voidedProjectId: one.project.id,
          replacementProjectId: one.project.id,
        }),
        SQLSTATE.CHECK_VIOLATION,
      );
      await expectPgError(
        db().insert(projectReplacements).values({
          eventId: e.id,
          voidedProjectId: one.project.id,
          replacementProjectId: foreign.project.id,
        }),
        SQLSTATE.FOREIGN_KEY_VIOLATION,
      );
      await db().insert(projectReplacements).values({
        eventId: e.id,
        voidedProjectId: one.project.id,
        replacementProjectId: two.project.id,
      });
      await expectPgError(
        db().insert(projectReplacements).values({
          eventId: e.id,
          voidedProjectId: one.project.id,
          replacementProjectId: two.project.id,
        }),
        SQLSTATE.UNIQUE_VIOLATION,
      );
      await expectPgError(
        db().execute(
          sql`UPDATE project_replacements SET event_id = event_id WHERE voided_project_id = ${one.project.id}`,
        ),
        RESTRICT,
      );
      await expectPgError(
        db().execute(
          sql`DELETE FROM project_replacements WHERE voided_project_id = ${one.project.id}`,
        ),
        RESTRICT,
      );
    });

    it('a voided project starts no new snapshot, run or source, while its existing rows stay readable', async () => {
      const e = await event();
      const a = await actor();
      const owner = await submission(e.id, a.id, 'inert');
      const [source] = (await db().select().from(projectSources)).filter(
        (s) => s.projectId === owner.project.id,
      );
      await voidIt(e.id, owner.project.id, a.id, 'inert');
      await expectPgError(
        db()
          .insert(sourceSnapshots)
          .values({
            projectId: owner.project.id,
            projectSourceId: must(source).id,
            captureNumber: 1,
            sourceType: 'github',
            sourceUrl: must(source).url,
            status: 'pending',
          }),
        RESTRICT,
      );
      await expectPgError(
        db().insert(analysisRuns).values({
          eventId: e.id,
          projectId: owner.project.id,
          runType: 'project_source_capture',
          state: 'pending',
        }),
        RESTRICT,
      );
      await expectPgError(
        db().insert(projectSources).values({
          projectId: owner.project.id,
          sourceType: 'deployment',
          url: 'https://example.org/late',
          position: 9,
        }),
        RESTRICT,
      );
      expect(
        (await db().select().from(projectSources)).filter((s) => s.projectId === owner.project.id),
      ).toHaveLength(2);
    });

    it('work on a DIFFERENT project of the same event is unaffected by a void', async () => {
      const e = await event();
      const a = await actor();
      const voided = await submission(e.id, a.id, 'neighbour-1');
      const alive = await submission(e.id, a.id, 'neighbour-2');
      await voidIt(e.id, voided.project.id, a.id, 'neighbour-1');
      const [source] = (await db().select().from(projectSources)).filter(
        (s) => s.projectId === alive.project.id && s.sourceType === 'github',
      );
      await db()
        .insert(sourceSnapshots)
        .values({
          projectId: alive.project.id,
          projectSourceId: must(source).id,
          captureNumber: 1,
          sourceType: 'github',
          sourceUrl: must(source).url,
          status: 'pending',
        });
      expect(await claimsOf(alive.project.id)).toHaveLength(3);
    });
  });
});
