import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseDevpostProjectUrl,
  parseGithubRepositoryUrl,
} from '../../packages/capture/src/index.js';
import { events, projects, projectSources } from '../../packages/database/src/index.js';
import {
  testDatabaseTargets,
  type TestDatabase,
} from '../../packages/database/src/testing/databases.js';

/*
 * P6B-beta2 (R7B): the canonical form is an invariant at every trust boundary. The application produces it (the parsers); the database
 * independently refuses anything else (CHECK `project_sources_canonical_url`). Those two definitions must agree: every URL the parsers accept
 * must be storable, or a valid submission would fail with a database error. Here a deterministic set of curated and generated inputs -- including
 * hostile ones -- is run through the parsers, and every ACCEPTED canonical URL is written to the real database.
 */

function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

const OWNER_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
const REPO_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-';
const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
function word(random: () => number, chars: string, min: number, max: number): string {
  const length = min + Math.floor(random() * (max - min + 1));
  return Array.from({ length }, () => chars[Math.floor(random() * chars.length)]).join('');
}

function candidates(): { github: string[]; devpost: string[] } {
  const random = generator(20_260_429);
  const github = [
    'https://github.com/a/b',
    'HTTPS://GITHUB.COM/Owner/Repo.GIT',
    'http://www.github.com/o/r/',
    'https://github.com/o/r?tab=readme#top',
    'https://github.com/o/...',
    'https://github.com/o/-',
    'https://github.com/o/_x',
    'https://github.com/o/r.git.git',
    'https://github.com/0/0',
    'https://github.com/o-/r',
    'https://github.com/%6f/r',
    'https://github.com/o/r%20x',
    'https://github.com/o/r\u0000',
    'https://github.com/ı/r', // dotless i: a case-folding trap
    'https://github.com/K/r', // Kelvin sign
    'https://github.com:443/o/r',
    'https://github.com./o/r',
    'https://github.com/o/r/../x',
  ];
  const devpost = [
    'https://devpost.com/software/a',
    'HTTPS://WWW.DEVPOST.COM/software/Some-Thing/',
    'https://devpost.com/software/a-b-c?ref=x#y',
    'https://devpost.com/software/a--b',
    'https://devpost.com/software/-a',
    'https://devpost.com/software/a_b',
    'https://devpost.com/software/%61',
    'https://devpost.com/software/ı',
    'https://devpost.com/software/' + 'a'.repeat(200),
    'https://devpost.com/software/' + 'a'.repeat(201),
  ];
  for (let i = 0; i < 150; i += 1) {
    github.push(
      `https://github.com/${word(random, OWNER_CHARS, 1, 39)}/${word(random, REPO_CHARS, 1, 100)}${pick(random, ['', '/', '.git', '?x=1', '#f'])}`,
    );
    devpost.push(
      `https://${pick(random, ['devpost.com', 'www.devpost.com'])}/software/${word(random, SLUG_CHARS, 1, 60)}${pick(random, ['', '/', '?x=1', '#f'])}`,
    );
  }
  return { github, devpost };
}

describe.each(testDatabaseTargets())('canonical URL boundary on %s', (_name, open) => {
  let testDb: TestDatabase;
  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });

  it('every URL the parsers accept is storable, and the canonical form is a fixed point', async () => {
    const db = testDb.db;
    const [event] = await db
      .insert(events)
      .values({ name: 'Boundary', slug: 'boundary' })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ eventId: event?.id ?? '', name: 'Boundary project' })
      .returning();
    const { github, devpost } = candidates();
    let accepted = 0;
    const stored = new Set<string>();
    let position = 0;
    for (const raw of github) {
      const parsed = parseGithubRepositoryUrl(raw);
      if (typeof parsed === 'string') continue;
      accepted += 1;
      // idempotent: parsing the canonical form gives the same canonical form
      expect(parseGithubRepositoryUrl(parsed.canonicalUrl)).toMatchObject({
        canonicalUrl: parsed.canonicalUrl,
      });
      expect(parsed.canonicalUrl).toBe(parsed.canonicalUrl.toLowerCase());
      if (stored.has(parsed.canonicalUrl)) continue;
      stored.add(parsed.canonicalUrl);
      await db.insert(projectSources).values({
        projectId: project?.id ?? '',
        sourceType: 'github',
        url: parsed.canonicalUrl,
        position: (position += 1),
      });
    }
    for (const raw of devpost) {
      const parsed = parseDevpostProjectUrl(raw);
      if (typeof parsed === 'string') continue;
      accepted += 1;
      expect(parseDevpostProjectUrl(parsed.canonicalUrl)).toMatchObject({
        canonicalUrl: parsed.canonicalUrl,
      });
      if (stored.has(parsed.canonicalUrl)) continue;
      stored.add(parsed.canonicalUrl);
      await db.insert(projectSources).values({
        projectId: project?.id ?? '',
        sourceType: 'devpost',
        url: parsed.canonicalUrl,
        position: (position += 1),
      });
    }
    // the generator must really exercise the parsers (a vacuous pass would prove nothing)
    expect(accepted).toBeGreaterThan(150);
    expect(stored.size).toBeGreaterThan(150);
  });
});
