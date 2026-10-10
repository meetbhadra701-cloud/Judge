/*
 * M5 P4 parity: the database package's read-only `LockedContextReader` must reconstruct a locked Event Context EXACTLY as the API's
 * `EventContextService.getLockedContext` does, on the same real fixtures, so the two loaders cannot drift apart (design §7.3).
 */
import { LockedContextReader, type JudgeDatabase } from '@judge-copilot/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadFixtures,
  replayService,
  requireValue,
  seedFromRecording,
  testDatabaseTargets,
  type TestDatabase,
} from '../testing/harness.js';
import type { EventContextService } from './service.js';

describe.each(testDatabaseTargets())(
  'LockedContextReader parity with EventContextService on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let service: EventContextService;
    let names: string[];
    let fixtures: Awaited<ReturnType<typeof loadFixtures>>;

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      fixtures = await loadFixtures();
      service = replayService(db, fixtures.values());
      names = ['a-clear-official-rubric', 'e-multiple-tracks', 'b-ambiguous-policy'];
    });
    afterAll(async () => {
      await testDb.close();
    });

    it('returns the identical locked snapshot for every lockable fixture, and recomputes the stored hash', async () => {
      let compared = 0;
      for (const name of names) {
        const seeded = await seedFromRecording(
          service,
          requireValue(fixtures.get(`fixture-${name}`), name),
        );
        await service.buildContext(seeded.eventId, seeded.versionId);
        try {
          await service.lockContext(seeded.eventId, seeded.versionId);
        } catch {
          continue; // a fixture that is not lockable has no locked snapshot to compare
        }
        const viaApi = await service.getLockedContext(seeded.eventId);
        const viaReader = await new LockedContextReader().read(
          db,
          seeded.eventId,
          seeded.versionId,
        );
        expect(viaReader.ok, name).toBe(true);
        if (!viaReader.ok) continue;
        expect(viaReader.snapshot, name).toEqual(viaApi);
        expect(viaReader.recomputedHash).toBe(viaApi.lockedContentHash);
        compared += 1;
      }
      expect(compared).toBeGreaterThanOrEqual(2);
    });

    it('refuses an unknown version, another event, and a draft', async () => {
      const seeded = await seedFromRecording(
        service,
        requireValue(fixtures.get('fixture-a-clear-official-rubric'), 'a'),
      );
      const reader = new LockedContextReader();
      expect(await reader.read(db, seeded.eventId, '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e')).toEqual(
        { ok: false, failure: 'version_not_found' },
      );
      expect(await reader.read(db, seeded.eventId, seeded.versionId)).toEqual({
        ok: false,
        failure: 'not_frozen',
      });
      expect(
        await reader.read(db, '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e', seeded.versionId),
      ).toEqual({ ok: false, failure: 'wrong_event' });
    });
  },
);
