import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssessmentInputError,
  AssessmentInputReader,
  AuthorizedAssessmentInputs,
} from './assessment-input-reader.js';
import type { JudgeDatabase } from './index.js';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import { extractAndBind, startRun, type PreparedRun } from './testing/assessment-pipeline.js';
import {
  declareTrack,
  seedAssessmentWorld,
  seedLockedContext,
} from './testing/assessment-world.js';
import { rows, testDatabaseTargets, type TestDatabase } from './testing/databases.js';
import { seedSnapshot } from './testing/graph-world.js';

describe.each(testDatabaseTargets())('M5 P4 trusted input reader on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
  });
  afterAll(async () => {
    await testDb.close();
  });

  const newWorld = () =>
    seedAssessmentWorld(db, {
      trackKeys: ['health', 'robotics'],
      declare: ['health'],
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
      requirements: [
        {
          statement: 'Health projects must cite their data source.',
          certainty: 'explicit',
          trackKey: 'health',
        },
      ],
    });
  async function readyRun() {
    const w = await newWorld();
    const run = await startRun(db, w);
    const bound = await extractAndBind(w, run);
    return { w, run, bound };
  }
  const read = (run: PreparedRun) => new AssessmentInputReader(db).read(run.runId);
  const rejection = async (run: PreparedRun) => {
    try {
      await read(run);
    } catch (error) {
      if (error instanceof AssessmentInputError) return error;
      throw error;
    }
    throw new Error('expected the read to be rejected');
  };
  /** Test-only forgery: edits an immutable table the way a superuser (or a bug) could, with the user triggers off for one statement. */
  async function forge(table: string, statement: ReturnType<typeof sql>) {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER USER`));
      await tx.execute(statement);
      await tx.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER USER`));
    });
  }

  it('returns verified inputs: the pinned context, declared tracks, committed members and verified reference metadata', async () => {
    const { w, run, bound } = await readyRun();
    const authorized = await read(run);
    expect(authorized).toBeInstanceOf(AuthorizedAssessmentInputs);
    const data = authorized.data;
    expect(data).toMatchObject({
      runId: run.runId,
      projectId: w.project.id,
      eventId: w.event.id,
      declaredTrackKeys: ['health'],
      newerDeclarationsExist: false,
    });
    expect(data.locked.versionId).toBe(w.context.versionId);
    expect(data.locked.lockedContentHash).toBe(w.context.hash);
    expect(data.records.claims.map((c) => c.id)).toEqual(bound.source.members.claimIds);
    expect(data.records.evidence).toHaveLength(
      bound.source.members.evidenceIds.length + bound.context.members.evidenceIds.length,
    );
    // the reference metadata is the code-authored one, derived from the pinned document
    expect(
      [...data.eventReferences.values()].map((m) => [m.kind, m.applicability, m.trackKey]),
    ).toEqual([
      ['track_definition', 'declared_track_definition', 'health'],
      ['rule', 'overall_rule', null],
      ['submission_requirement', 'track_specific_requirement', 'health'],
    ]);
    // artifact text is loaded so spans are VERIFIED, and only pinned snapshots are authorized
    expect(data.known.snapshots.size).toBe(2);
    expect([...data.known.artifacts.values()].every((a) => typeof a.slice === 'function')).toBe(
      true,
    );
  });

  it('accepts no caller-supplied facts: the only parameter is the run id, and the class cannot be constructed elsewhere', () => {
    expect(AssessmentInputReader.prototype.read.length).toBeLessThanOrEqual(2);
    expect(() => new AuthorizedAssessmentInputs(Symbol('forged'), {} as never)).toThrow(
      /can only be created/,
    );
    // a source scan: the only `new AuthorizedAssessmentInputs(` in non-test source is the reader's
    const root = join(import.meta.dirname, '..', '..', '..');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', '.next', 'drizzle', 'tests'].includes(entry.name))
            walk(path);
        } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) sources.push(path);
      }
    };
    walk(join(root, 'packages'));
    walk(join(root, 'apps'));
    const constructors = sources.filter((file) =>
      /new AuthorizedAssessmentInputs\(/.test(readFileSync(file, 'utf8')),
    );
    expect(constructors.map((f) => f.slice(root.length + 1))).toEqual([
      'packages/database/src/assessment-input-reader.ts',
    ]);
  });

  it('later captures and later track declarations do not change what the run is about; the declaration is reported', async () => {
    const { w, run } = await readyRun();
    const before = await read(run);
    await seedSnapshot(db, w.project, 'github', 'captured', [
      {
        key: 'files/README.md',
        kind: 'file',
        mediaType: 'text/markdown',
        text: 'A later capture.',
      },
    ]);
    await declareTrack(db, w.project.id, w.event.id, w.context.versionId, 'robotics', w.actor.id);
    const after = await read(run);
    expect(after.data.pinnedSnapshots).toEqual(before.data.pinnedSnapshots);
    expect(after.data.declaredTrackKeys).toEqual(['health']);
    expect(after.data.newerDeclarationsExist).toBe(true);
    expect(after.data.inputsFingerprint).toBe(before.data.inputsFingerprint);
  });

  it('a context superseded after pinning is rejected (not merely "still frozen")', async () => {
    const { w, run } = await readyRun();
    await seedLockedContext(db, w.event.id, { trackKeys: ['health'] });
    expect((await rejection(run)).code).toBe('context_superseded');
  });

  it('a run that is not running (or not an assessment run) is not readable', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    await extractAndBind(w, run);
    await run.store.finishRun({ runId: run.runId, state: 'failed', failureCode: 'x' });
    expect((await rejection(run)).code).toBe('run_not_readable');
    await expect(
      new AssessmentInputReader(db).read('5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e'),
    ).rejects.toMatchObject({
      code: 'run_not_found',
    });
  });

  it('a run without bound extractions is not readable', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    expect((await rejection(run)).code).toBe('extraction_not_bound');
  });

  describe('self-consistent forgeries are still rejected (the database is read, not believed)', () => {
    it('a forged context pin', async () => {
      const { run } = await readyRun();
      await forge(
        'assessment_run_inputs',
        sql`UPDATE assessment_run_inputs SET locked_content_hash = repeat('b', 64) WHERE run_id = ${run.runId}`,
      );
      expect((await rejection(run)).code).toBe('context_hash_mismatch');
    });

    it('a forged context row: the content no longer hashes to the stored hash', async () => {
      const { w, run } = await readyRun();
      await forge(
        'event_context_versions',
        sql`UPDATE event_context_versions SET summary = 'x', content = jsonb_set(content, '{judgingFormat,statement}', '"Tampered."') WHERE id = ${w.context.versionId}`,
      );
      expect((await rejection(run)).code).toBe('context_hash_mismatch');
    });

    it('a forged members_hash', async () => {
      const { run, bound } = await readyRun();
      await forge(
        'graph_extractions',
        sql`UPDATE graph_extractions SET members_hash = repeat('c', 64) WHERE id = ${bound.source.extraction.id}`,
      );
      expect((await rejection(run)).code).toBe('members_hash_mismatch');
    });

    it('a deleted member row (the committed hash no longer matches the members)', async () => {
      const { run, bound } = await readyRun();
      await forge(
        'graph_extraction_items',
        sql`DELETE FROM graph_extraction_items WHERE record_id = ${bound.source.members.relationIds[2] ?? ''}`,
      );
      expect((await rejection(run)).code).toBe('members_hash_mismatch');
    });

    it('fabricated provenance: every id, relation and hash is consistent, only the excerpt is invented', async () => {
      const { run, bound } = await readyRun();
      await forge(
        'evidence_items',
        sql`UPDATE evidence_items SET excerpt = repeat('x', span_end - span_start) WHERE id = ${bound.source.members.evidenceIds[0] ?? ''}`,
      );
      const error = await rejection(run);
      expect(error.code).toBe('graph_scope_failed');
      expect(error.detail.join(' ')).toMatch(/provenance_excerpt_mismatch/);
    });

    it('evidence citing a snapshot the run did NOT pin (a later capture of the same project) is unauthorized', async () => {
      const { w, run, bound } = await readyRun();
      const later = await seedSnapshot(db, w.project, 'devpost', 'captured', [
        {
          key: 'submission.txt',
          kind: 'submission_text',
          mediaType: 'text/plain',
          text: 'HydroTrack sends a reminder every two hours and stores each intake entry in SQLite.',
        },
      ]);
      const artifact = later.artifacts[0];
      await forge(
        'evidence_items',
        sql`UPDATE evidence_items SET snapshot_id = ${later.snapshot.id}, artifact_id = ${artifact?.id ?? ''} WHERE id = ${bound.source.members.evidenceIds[0] ?? ''}`,
      );
      const error = await rejection(run);
      expect(error.code).toBe('graph_scope_failed');
      expect(error.detail.join(' ')).toMatch(/provenance_snapshot_not_found/);
    });

    it('a member id that is a record of ANOTHER project is missing from this project', async () => {
      const { run, bound } = await readyRun();
      const other = await newWorld();
      const foreign = await new EvidenceGraphStore({ db }).createGraph(
        other.project.id,
        {
          claims: [
            { ref: 'f', text: 'A claim of another project.', verificationLevel: 'unverified' },
          ],
        },
        null,
      );
      await forge(
        'graph_extraction_items',
        sql`UPDATE graph_extraction_items SET record_id = ${foreign.claims[0]?.id ?? ''} WHERE record_id = ${bound.source.members.claimIds[0] ?? ''}`,
      );
      // the committed hash no longer matches, and the foreign claim is not a record of this project either way
      expect(['members_hash_mismatch', 'graph_scope_failed']).toContain(
        (await rejection(run)).code,
      );
    });

    it('altered reference metadata (the applicability a model could be told is "applicable")', async () => {
      const { run, bound } = await readyRun();
      await forge(
        'graph_extraction_items',
        sql`UPDATE graph_extraction_items SET reference_applicability = 'overall_rule', reference_track_key = NULL, reference_kind = 'rule' WHERE extraction_id = ${bound.context.extraction.id} AND ordinal = 1`,
      );
      expect((await rejection(run)).code).toBe('reference_meta_mismatch');
    });

    it('a tampered declared-track pin', async () => {
      const { run } = await readyRun();
      await forge(
        'assessment_run_inputs',
        sql`UPDATE assessment_run_inputs SET track_selection_set_hash = repeat('d', 64) WHERE run_id = ${run.runId}`,
      );
      expect((await rejection(run)).code).toBe('track_selection_mismatch');
    });

    it('a tampered snapshot pin', async () => {
      const { run } = await readyRun();
      await forge(
        'assessment_run_input_snapshots',
        sql`UPDATE assessment_run_input_snapshots SET snapshot_content_hash = repeat('e', 64) WHERE run_id = ${run.runId}`,
      );
      expect((await rejection(run)).code).toBe('pin_mismatch');
    });

    it('a tampered inputs fingerprint', async () => {
      const { run } = await readyRun();
      await forge(
        'assessment_run_inputs',
        sql`UPDATE assessment_run_inputs SET inputs_fingerprint = repeat('f', 64) WHERE run_id = ${run.runId}`,
      );
      expect((await rejection(run)).code).toBe('fingerprint_mismatch');
    });
  });

  it('the read happens in ONE read-only REPEATABLE READ transaction', async () => {
    const { run } = await readyRun();
    const seen: string[] = [];
    const reader = new AssessmentInputReader(db);
    await db.transaction(
      async (tx) => {
        const level = await rows<{ iso: string; ro: string }>(
          tx,
          sql`SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro`,
        );
        seen.push(`${level[0]?.iso ?? ''}/${level[0]?.ro ?? ''}`);
        await reader.readInTransaction(tx, run.runId, ['running']);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    expect(seen).toEqual(['repeatable read/on']);
    // and the production entry point asks for exactly that
    const { GRAPH_READ_TRANSACTION } = await import('./evidence-graph-store.js');
    expect(GRAPH_READ_TRANSACTION).toEqual({
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  });
});
