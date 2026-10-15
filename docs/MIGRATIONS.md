# Database migrations: applying, verifying and recovering

Applies to every migration; §4 is specific to the P6B-beta2 pair `0017` / `0018`. Rule 6 of `CLAUDE.md` stands: **never edit an existing migration**. A
change is a new migration (`pnpm db:generate`, or hand-written SQL plus its journal entry and snapshot for what drizzle-kit cannot model, such as triggers).

## 1. How migrations are applied

- `pnpm db:migrate` (needs `DATABASE_URL`) runs drizzle's migrator over `packages/database/drizzle`. The migrator applies **all pending
  migrations in ONE transaction**: either every pending migration is applied or none is. A failing migration therefore leaves the database exactly
  as it was before the run; nothing needs cleaning up. Fix the cause and run it again.
- Applied migrations are recorded in `drizzle.__drizzle_migrations` (hash and timestamp). Running `pnpm db:migrate` again when nothing is pending is a no-op.
- There are **no down-migrations**. Going back means restoring the backup taken before the upgrade (§3), together with the application version that
  matches it. An older application against a newer schema is not supported: for example the β1 application does not know about voided projects, and the
  database (correctly) refuses its attempts to start work on one.
- `pnpm db:check` verifies that the journal, the SQL files and the snapshots agree; `pnpm db:generate` must report no pending schema change. Both run in `pnpm check`.

## 2. Before upgrading a database that holds real data

1. **Back up.** `pg_dump --format=custom "$DATABASE_URL" > judge-before-<tag>.dump`. The backup is the only rollback.
2. **Stop the worker** (or let it finish) so no capture or run is in flight while the schema changes, then stop the API.
3. **Read the integrity report** of every event: `GET /events/<id>/submission-integrity`. It is read-only. Projects it flags (several GitHub or Devpost links, a link claimed
   by several projects) are not repaired by any migration; they are history (see `docs/DEMO_RUNBOOK.md` §1.7). Note them so the post-upgrade report can be compared.
4. Apply: `DATABASE_URL=… pnpm db:migrate`. Start the API, then the worker.

## 3. Verifying an upgrade

```sql
-- the migrations that were applied, newest last
SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5;
-- every recorded submission owns exactly its two links and its label (0018 backfills them): this must return no row
SELECT s.project_id FROM project_submissions s
 WHERE (SELECT count(*) FROM project_submission_claims c WHERE c.project_id = s.project_id) <> 3;
-- the canonical-URL rule (see §4.3): rows written BEFORE the rule that violate it; informational, not an error
SELECT project_id, source_type, url FROM project_sources
 WHERE (source_type = 'github' AND url !~ '^https://github\.com/[a-z0-9._-]+/[a-z0-9._-]+$')
    OR (source_type = 'devpost' AND url !~ '^https://devpost\.com/software/[a-z0-9]+(-[a-z0-9]+)*$');
```

## 4. P6B-beta2: `0017_p6b_beta2_claims_and_voids` and `0018_p6b_beta2_integrity`

`0017` is generated; `0018` is hand-written (triggers). They are applied together and are additive for data: no row is deleted, rewritten or re-pointed.

### 4.1 What they do

| Change                                                                                                                                                                                                                                             | Why                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| new tables `project_submission_claims`, `project_voids`, `project_replacements`                                                                                                                                                                    | who owns a link or a label; the explicit, immutable record of a correction; which project replaced which       |
| the three per-event unique constraints on `project_submissions` are dropped; the unique `(event, kind, value)` of the claims table replaces them                                                                                                   | a voided submission must release its links; ownership is now a table that a void may release, nothing else may |
| backfill of the claims from the recorded submissions                                                                                                                                                                                               | the upgraded database enforces the rules for the submissions that already exist                                |
| triggers: claims never updated, deleted only for a voided project; voids refused while work is pending; voided projects refuse new snapshots, runs and sources; the project label changes only by a void; the label key is derived by the database | the rules hold for every writer, not only for the application                                                  |
| `project_sources_submission_guard` replaced: also refuses a link owned by another active submission                                                                                                                                                | the earlier project/source routes can no longer take a link that a submission owns                             |
| `project_sources_canonical_url` CHECK, `NOT VALID`                                                                                                                                                                                                 | GitHub and Devpost declarations must be in the canonical form the application produces (see 4.3)               |

### 4.2 If the migration fails

The run is one transaction, so a failure leaves the database at its previous version. The only failure the data can cause is the backfill: it inserts the claims of the recorded submissions into a table with a
unique `(event, kind, value)`. Before `0017` the per-event unique constraints on `project_submissions` made a duplicate impossible, so a failure there means the table was changed by hand. Find it with

```sql
SELECT event_id, github_url, count(*) FROM project_submissions GROUP BY 1, 2 HAVING count(*) > 1;   -- likewise devpost_url, name_key
```

and resolve it with the owners; submissions are append-only, so do not delete rows: restore the backup, or ask for a reviewed corrective migration.

### 4.3 The canonical-URL constraint is `NOT VALID`

`NOT VALID` means: enforced for every **new** row, not scanned for existing ones. A declaration written by the earlier flows may be non-canonical (upper case, a trailing slash); declarations are immutable
(trigger), so such a row cannot be edited. Such rows are listed by the third query in §3. To make the database assert the rule for all rows, void (and replace) the project that owns each offender, then run
`ALTER TABLE project_sources VALIDATE CONSTRAINT project_sources_canonical_url;`. Until then the constraint still protects everything written from now on.

### 4.4 Application checks and database enforcement

Every rule above exists twice: as an application check that answers with a precise message, and as a database constraint or trigger that holds even if the application is bypassed or two requests race. The
tests in `packages/database/src/void-guards.test.ts` go straight to SQL; `tests/integration/submission-correction.test.ts` goes through the routes. A rule that only the application checks is stated as such in the
code and in `docs/ARCHITECTURE.md`.

## 5. P6B-beta3: `0019_p6b_beta3_identity_registry`

Hand-written (functions and triggers); one transaction; additive for data. It adds `project_claim()`, claim triggers on `projects`, `project_sources` and `project_submissions`, a backfill, and `BEFORE TRUNCATE`
guards on `project_submissions`, `project_submission_requests`, `project_submission_claims`, `project_voids` and `project_replacements`. No table or column is added, dropped or rewritten.

### 5.1 The backfill never fails on, and never rewrites, shared identities

It inserts a claim for every active project's label and for the links of every active project that holds at most one GitHub and one Devpost link, with `ON CONFLICT DO NOTHING`: an identity already shared by several
projects (possible only in a database that held legacy data) keeps its first owner in the registry and the others are left alone. Nothing is merged, deleted or re-pointed. After upgrading, list what the database
sees with `GET /events/<id>/submission-integrity` (`registryProblems`, and the earlier findings) or directly:

```sql
-- identities held by more than one active project (the registry holds only one of them)
WITH active AS (SELECT p.id, p.event_id, p.name FROM projects p WHERE NOT EXISTS (SELECT 1 FROM project_voids v WHERE v.project_id = p.id)),
holdings AS (
  SELECT a.event_id, a.id AS project_id, s.source_type AS kind, s.url AS value FROM active a JOIN project_sources s ON s.project_id = a.id WHERE s.source_type IN ('github','devpost')
  UNION SELECT a.event_id, a.id, 'name', lower(btrim(a.name)) FROM active a)
SELECT event_id, kind, value, array_agg(project_id) FROM holdings GROUP BY 1,2,3 HAVING count(DISTINCT project_id) > 1;
```

Resolve each with the owners by **voiding** the erroneous project (`docs/DEMO_RUNBOOK.md` §1.8); do not delete rows.

### 5.2 If the migration fails, and rollback

One transaction: a failure leaves the previous version. The backfill cannot fail on data (conflicts are skipped). There is no down migration; rollback is restoring the pre-upgrade backup. After a restore the
application of this version must not be started against it (it expects the functions).

### 5.3 Behaviour to expect after upgrading

A legacy declaration of a link another active project owns is now refused with the same errors a submission gets. A project created through the earlier route now owns its label in the registry, so a later
submission with a case-variant label is refused (`PROJECT_NAME_TAKEN`) where it previously could succeed. Voiding releases the claims as before.
