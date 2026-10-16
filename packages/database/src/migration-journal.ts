import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The migration journal, checked as a MANIFEST (P6B-beta3-R2). The installed Drizzle migrator applies a migration only when its journal `when`
 * is GREATER than the newest `created_at` already recorded in the database (it compares nothing else: not the tag, not the hash). A new
 * migration whose `when` is not greater than its predecessor's is therefore skipped on every existing database while the command reports
 * success. That is exactly how migration 0020 was lost. Nothing in this file talks to a database: it fails the build before one is involved.
 *
 * Pure (node:fs/node:crypto only) so that the same function is the CI check, the unit test and the operator's preflight.
 */

export interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

export interface JournalReadResult {
  readonly entries: readonly JournalEntry[];
  readonly problems: string[];
}

const TAG = /^(\d{4})_[a-z0-9_]+$/;

/** Reads `meta/_journal.json`; malformed content is a problem, never an exception. */
export function readJournal(folder: string): JournalReadResult {
  const problems: string[] = [];
  const path = join(folder, 'meta', '_journal.json');
  if (!existsSync(path)) return { entries: [], problems: ['meta/_journal.json is missing'] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { entries: [], problems: ['meta/_journal.json is not valid JSON'] };
  }
  const journal = raw as { version?: unknown; dialect?: unknown; entries?: unknown };
  if (journal.dialect !== 'postgresql') problems.push('journal dialect is not "postgresql"');
  if (typeof journal.version !== 'string') problems.push('journal version is not a string');
  if (!Array.isArray(journal.entries)) {
    return { entries: [], problems: [...problems, 'journal has no entries array'] };
  }
  const entries: JournalEntry[] = [];
  journal.entries.forEach((candidate: unknown, position) => {
    const where = `entry #${String(position)}`;
    const e = (typeof candidate === 'object' && candidate !== null ? candidate : {}) as Partial<
      Record<keyof JournalEntry, unknown>
    >;
    if (
      !Number.isInteger(e.idx) ||
      typeof e.version !== 'string' ||
      typeof e.when !== 'number' ||
      !Number.isSafeInteger(e.when) ||
      typeof e.tag !== 'string' ||
      typeof e.breakpoints !== 'boolean'
    ) {
      problems.push(`${where} is malformed (idx, version, when, tag and breakpoints are required)`);
      return;
    }
    entries.push(e as unknown as JournalEntry);
  });
  return { entries, problems };
}

/**
 * Every problem with the journal and its folder, in a stable order; an empty list means consistent.
 *
 *  - entries are well-formed, `idx` runs 0,1,2,... with no gap or duplicate, in file order;
 *  - `tag` is `NNNN_name` and NNNN equals `idx`; tags are unique;
 *  - `when` is STRICTLY increasing (the rule the migrator depends on);
 *  - each tag has its `.sql` file (non-empty) and its `meta/NNNN_snapshot.json`; no `.sql` file exists without an entry.
 */
export function checkMigrationJournal(folder: string): string[] {
  const { entries, problems } = readJournal(folder);
  const out = [...problems];
  const seenTags = new Set<string>();
  entries.forEach((entry, position) => {
    const label = `${entry.tag} (idx ${String(entry.idx)})`;
    if (entry.idx !== position) {
      out.push(
        `${label}: idx must be ${String(position)} (indexes are contiguous, unique and ordered)`,
      );
    }
    const match = TAG.exec(entry.tag);
    if (!match) out.push(`${label}: tag must look like 0000_name`);
    else if (Number(match[1]) !== entry.idx) out.push(`${label}: the tag number differs from idx`);
    if (seenTags.has(entry.tag)) out.push(`${label}: duplicate tag`);
    seenTags.add(entry.tag);
    const previous = entries[position - 1];
    if (previous !== undefined && entry.when <= previous.when) {
      out.push(
        `${label}: when=${String(entry.when)} is not greater than the previous entry's ${String(previous.when)} (${previous.tag}); the migrator would SKIP it on every database that already applied ${previous.tag}`,
      );
    }
    const sqlPath = join(folder, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) out.push(`${label}: ${entry.tag}.sql is missing`);
    else if (readFileSync(sqlPath, 'utf8').trim().length === 0)
      out.push(`${label}: ${entry.tag}.sql is empty`);
    const number = TAG.exec(entry.tag)?.[1];
    if (number !== undefined && !existsSync(join(folder, 'meta', `${number}_snapshot.json`))) {
      out.push(`${label}: meta/${number}_snapshot.json is missing`);
    }
  });
  if (existsSync(folder)) {
    for (const name of readdirSync(folder)
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      if (!seenTags.has(name.slice(0, -4))) out.push(`${name} has no journal entry`);
    }
  }
  return out;
}

/** What the Drizzle migrator records for a migration: SHA-256 of the file text (it does not verify it later). */
export function migrationHash(folder: string, tag: string): string {
  return createHash('sha256')
    .update(readFileSync(join(folder, `${tag}.sql`), 'utf8'))
    .digest('hex');
}
