import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { migrationsFolder, schema, type JudgeDatabase } from './client.js';
import { rows, sql } from './testing/databases.js';

/*
 * P6B-beta2: UPGRADING a database that already holds accepted P6B-beta1 data. Migrations 0017/0018 must (a) apply on top of 0016 without
 * touching or rejecting existing rows, (b) backfill the ownership registry from the recorded submissions, and (c) leave earlier-flow rows that
 * were written before the canonical-URL rule alone (the rule is enforced for new rows only, `NOT VALID`). docs/MIGRATIONS.md describes the
 * operator's side of this.
 */

const LAST_BETA1 = 16;

function truncatedFolder(): { folder: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'judge-migrations-'));
  cpSync(migrationsFolder, root, { recursive: true });
  const journalPath = join(root, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= LAST_BETA1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return {
    folder: root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Target {
  name: string;
  open: () => Promise<{
    db: JudgeDatabase;
    migrateTo: (folder: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

const targets: Target[] = [
  {
    name: 'PGlite',
    open: () => {
      const client = new PGlite();
      const db = drizzlePglite(client, { schema });
      return Promise.resolve({
        db,
        migrateTo: (folder) => migratePglite(db, { migrationsFolder: folder }),
        close: () => client.close(),
      });
    },
  },
];
const url = process.env['TEST_DATABASE_URL'];
if (url) {
  targets.push({
    name: 'PostgreSQL (TEST_DATABASE_URL)',
    open: async () => {
      if (!new URL(url).pathname.slice(1).endsWith('_test')) {
        throw new Error('TEST_DATABASE_URL must name a disposable database ending in "_test"');
      }
      const client = postgres(url, { max: 1, onnotice: () => undefined });
      await client.unsafe(
        'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
      );
      const db = drizzlePostgres(client, { schema });
      return {
        db,
        migrateTo: (folder) => migratePostgres(db, { migrationsFolder: folder }),
        close: () => client.end(),
      };
    },
  });
}

describe.each(targets)('upgrading P6B-beta1 data to P6B-beta2 on $name', (target) => {
  let handle: Awaited<ReturnType<Target['open']>>;
  let db: JudgeDatabase;
  const ids = {
    event: '00000000-0000-4000-8000-000000000001',
    actor: '00000000-0000-4000-8000-000000000002',
    submitted: '00000000-0000-4000-8000-000000000003',
    earlier: '00000000-0000-4000-8000-000000000004',
    twin: '00000000-0000-4000-8000-000000000005',
    mixed: '00000000-0000-4000-8000-000000000006',
  };

  beforeAll(async () => {
    handle = await target.open();
    db = handle.db;
    const old = truncatedFolder();
    try {
      await handle.migrateTo(old.folder);
    } finally {
      old.cleanup();
    }
    // data as P6B-beta1 left it
    await db.execute(
      sql`INSERT INTO events (id, name, slug) VALUES (${ids.event}, 'Old event', 'old-event')`,
    );
    await db.execute(
      sql`INSERT INTO actors (id, issuer, subject) VALUES (${ids.actor}, 'urn:old', 'organizer')`,
    );
    await db.execute(sql`INSERT INTO projects (id, event_id, name) VALUES
      (${ids.submitted}, ${ids.event}, 'Old/Submission'), (${ids.earlier}, ${ids.event}, 'Earlier flow'),
      (${ids.twin}, ${ids.event}, 'Shared twin'), (${ids.mixed}, ${ids.event}, 'Mixed historical')`);
    await db.execute(sql`INSERT INTO project_submissions (event_id, project_id, submitted_by_actor_id, github_url, devpost_url, name_key)
      VALUES (${ids.event}, ${ids.submitted}, ${ids.actor}, 'https://github.com/old/submission', 'https://devpost.com/software/old-submission', 'old/submission')`);
    // an earlier-flow source written before the canonical-URL rule existed: upper case and a trailing slash
    await db.execute(sql`INSERT INTO project_sources (project_id, source_type, url, position) VALUES
      (${ids.submitted}, 'github', 'https://github.com/old/submission', 0),
      (${ids.submitted}, 'devpost', 'https://devpost.com/software/old-submission', 1),
      (${ids.earlier}, 'github', 'https://github.com/Old/Earlier/', 0),
      (${ids.twin}, 'github', 'https://github.com/old/submission', 0),
      (${ids.mixed}, 'devpost', 'https://devpost.com/software/mixed-a', 0),
      (${ids.mixed}, 'devpost', 'https://devpost.com/software/mixed-b', 1)`);
    // the target migrations are applied on top of that data
    await handle.migrateTo(migrationsFolder);
  });
  afterAll(async () => {
    await handle.close();
  });

  it('applies on top of existing data and leaves every existing row untouched, including links that were ALREADY shared', async () => {
    const projects = await rows<{ name: string }>(db, sql`SELECT name FROM projects ORDER BY name`);
    expect(projects.map((p) => p.name)).toEqual([
      'Earlier flow',
      'Mixed historical',
      'Old/Submission',
      'Shared twin',
    ]);
    const sources = await rows<{ project_id: string; url: string }>(
      db,
      sql`SELECT project_id, url FROM project_sources ORDER BY project_id, position`,
    );
    expect(sources).toHaveLength(6); // nothing deleted, nothing merged: the non-canonical row and the shared link both survive
    expect(sources.map((s) => s.url)).toContain('https://github.com/Old/Earlier/');
    expect(sources.filter((s) => s.url === 'https://github.com/old/submission')).toHaveLength(2);
  });

  it('backfills the registry with what is unambiguous: labels of active projects, links of valid single declarations; shared and mixed stay unclaimed', async () => {
    const claims = await rows<{ project_id: string; kind: string; value: string }>(
      db,
      sql`SELECT project_id, kind, value FROM project_submission_claims ORDER BY kind, value`,
    );
    const mine = (id: string) =>
      claims.filter((c) => c.project_id === id).map((c) => `${c.kind}:${c.value}`);
    // the recorded submission owns its two links and its label (written by 0018, kept by 0019)
    expect(mine(ids.submitted)).toEqual([
      'devpost:https://devpost.com/software/old-submission',
      'github:https://github.com/old/submission',
      'name:old/submission',
    ]);
    // an earlier-flow project owns its label and its single link, as written (the non-canonical text is not rewritten)
    expect(mine(ids.earlier)).toEqual([
      'github:https://github.com/Old/Earlier/',
      'name:earlier flow',
    ]);
    // the historical twin shares a link the submission already owns: it keeps the row, gets no claim on that link, and still owns its label
    expect(mine(ids.twin)).toEqual(['name:shared twin']);
    // a historical mixed project (two Devpost links) owns its label only, so it still does not block the correct submissions of its links
    expect(mine(ids.mixed)).toEqual(['name:mixed historical']);
  });

  it('the upgraded database enforces the new rules for NEW rows: ownership, canonical URLs, void', async () => {
    // a new declaration of a link the backfilled submission owns is refused
    await expect(
      db.execute(sql`INSERT INTO project_sources (project_id, source_type, url, position)
        VALUES (${ids.earlier}, 'devpost', 'https://devpost.com/software/old-submission', 1)`),
    ).rejects.toThrow();
    // a new project cannot take a label an existing project owns, ignoring case
    await expect(
      db.execute(sql`INSERT INTO projects (event_id, name) VALUES (${ids.event}, 'EARLIER FLOW')`),
    ).rejects.toThrow();
    // a NEW declaration of the historically shared link by yet another project is refused: the registry now has one owner for it
    await expect(
      db.execute(sql`INSERT INTO project_sources (project_id, source_type, url, position)
        VALUES (${ids.mixed}, 'github', 'https://github.com/old/submission', 5)`),
    ).rejects.toThrow();
    // a new non-canonical declaration is refused, although the old one was kept
    await expect(
      db.execute(sql`INSERT INTO project_sources (project_id, source_type, url, position)
        VALUES (${ids.earlier}, 'github', 'https://github.com/Old/Other/', 3)`),
    ).rejects.toThrow();
    // the backfilled submission can be voided and releases what was backfilled
    await db.execute(sql`INSERT INTO project_voids (event_id, project_id, voided_by_actor_id, reason, name_before, idempotency_key, request_hash)
      VALUES (${ids.event}, ${ids.submitted}, ${ids.actor}, 'upgrade check', 'x', 'upgrade-key-0001', ${'b'.repeat(64)})`);
    const left = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM project_submission_claims WHERE project_id = ${ids.submitted}`,
    );
    expect(left[0]?.n).toBe(0);
  });
});
