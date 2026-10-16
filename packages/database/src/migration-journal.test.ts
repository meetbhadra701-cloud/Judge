import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from './client.js';
import { checkMigrationJournal } from './migration-journal.js';

/*
 * P6B-beta3-R2: the journal is checked as a manifest. Every defect class that makes the Drizzle migrator skip, misorder or misread a migration
 * is rejected here, and the check is wired into `db:check` (and so into `pnpm check`), which the last test pins.
 */

interface Journal {
  version: string;
  dialect: string;
  entries: Record<string, unknown>[];
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
function mutate(change: (journal: Journal, folder: string) => void): string[] {
  const folder = mkdtempSync(join(tmpdir(), 'judge-journal-'));
  cleanups.push(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  cpSync(migrationsFolder, folder, { recursive: true });
  const path = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  change(journal, folder);
  writeFileSync(path, JSON.stringify(journal));
  return checkMigrationJournal(folder);
}
/** The idx the shipped journal ends with (M6 added 0021 after 0020: no assertion here may hard-code the final migration). */
const LAST_IDX =
  (JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal)
    .entries.length - 1;
const last = (journal: Journal) =>
  journal.entries[journal.entries.length - 1] as Record<string, number | string>;
const previous = (journal: Journal) =>
  journal.entries[journal.entries.length - 2] as Record<string, number | string>;

describe('the migration journal check', () => {
  it('accepts the shipped journal', () => {
    expect(checkMigrationJournal(migrationsFolder)).toEqual([]);
  });

  it('rejects a migration whose timestamp is not greater than its predecessor (the defect that skipped 0020), equal or lower', () => {
    const lower = mutate((j) => {
      last(j)['when'] = (previous(j)['when'] as number) - 1;
    });
    expect(lower.join('\n')).toMatch(/not greater than the previous.*SKIP/);
    const equal = mutate((j) => {
      last(j)['when'] = previous(j)['when'] as number;
    });
    expect(equal.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-order timestamp anywhere in the file, not only at the end', () => {
    const problems = mutate((j) => {
      (j.entries[5] as Record<string, number>)['when'] =
        (j.entries[2] as Record<string, number>)['when'] ?? 0;
    });
    expect(problems.join('\n')).toContain('not greater than the previous');
  });

  it('rejects duplicate and non-contiguous indexes', () => {
    expect(
      mutate((j) => {
        last(j)['idx'] = 19;
      }).join('\n'),
    ).toContain(`idx must be ${String(LAST_IDX)}`);
    expect(
      mutate((j) => {
        last(j)['idx'] = LAST_IDX + 2;
      }).join('\n'),
    ).toContain(`idx must be ${String(LAST_IDX)}`);
  });

  it('rejects a tag whose number differs from its idx, a malformed tag, and a duplicate tag', () => {
    expect(
      mutate((j) => {
        last(j)['tag'] = '0019_p6b_beta3_r1_coverage_record';
      }).join('\n'),
    ).toContain('differs from idx');
    expect(
      mutate((j) => {
        last(j)['tag'] = 'coverage';
      }).join('\n'),
    ).toContain('tag must look like');
    expect(
      mutate((j) => {
        last(j)['tag'] = previous(j)['tag'] as string;
      }).join('\n'),
    ).toContain('duplicate tag');
  });

  it('rejects malformed entries (missing or mistyped fields) and a malformed or missing journal', () => {
    expect(
      mutate((j) => {
        delete last(j)['when'];
      }).join('\n'),
    ).toContain('malformed');
    expect(
      mutate((j) => {
        last(j)['when'] = '1792108000000';
      }).join('\n'),
    ).toContain('malformed');
    expect(
      mutate((j) => {
        last(j)['breakpoints'] = 'yes';
      }).join('\n'),
    ).toContain('malformed');
    expect(
      mutate((j) => {
        j.dialect = 'mysql';
      }).join('\n'),
    ).toContain('dialect');
    expect(
      mutate((j) => {
        (j as unknown as { entries: unknown }).entries = 'none';
      }).join('\n'),
    ).toContain('no entries array');
    const folder = mkdtempSync(join(tmpdir(), 'judge-journal-'));
    cleanups.push(() => {
      rmSync(folder, { recursive: true, force: true });
    });
    expect(checkMigrationJournal(folder).join('\n')).toContain('_journal.json is missing');
    cpSync(migrationsFolder, folder, { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), '{not json');
    expect(checkMigrationJournal(folder).join('\n')).toContain('not valid JSON');
  });

  it('rejects an inconsistent manifest: a journal entry without its SQL file, an SQL file without an entry, a missing snapshot, an empty file', () => {
    expect(
      mutate((_j, folder) => {
        unlinkSync(join(folder, '0020_p6b_beta3_r1_coverage_record.sql'));
      }).join('\n'),
    ).toContain('0020_p6b_beta3_r1_coverage_record.sql is missing');
    expect(
      mutate((_j, folder) => {
        writeFileSync(join(folder, '0021_stray.sql'), 'SELECT 1;');
      }).join('\n'),
    ).toContain('0021_stray.sql has no journal entry');
    expect(
      mutate((_j, folder) => {
        unlinkSync(join(folder, 'meta', '0020_snapshot.json'));
      }).join('\n'),
    ).toContain('0020_snapshot.json is missing');
    expect(
      mutate((_j, folder) => {
        writeFileSync(join(folder, '0020_p6b_beta3_r1_coverage_record.sql'), '  \n');
      }).join('\n'),
    ).toContain('is empty');
  });

  it('is part of `db:check`, which is part of `pnpm check` (so CI cannot pass this defect silently again)', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:check']).toMatch(/^tsx scripts\/check-migration-journal\.ts && /);
    expect(pkg.scripts['db:check']).toContain('drizzle-kit check');
    expect(root.scripts['check']).toContain('pnpm db:check');
  });
});
