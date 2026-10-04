/*
 * Event Context workflow integration tests against a real (in-process) PostgreSQL: create,
 * source, build, edit, lock, supersede, immutability, provenance, conflicts and audit.
 */
import {
  EventContextError,
  lockedContentHash,
  remapSourceIds,
  normalizeSourceText,
  sourceContentHash,
  type EventContextErrorCode,
  type EventContextExtractor,
  type ReplayRecordingInput,
} from '@judge-copilot/context';
import {
  analysisRuns,
  eventContextVersions,
  eventSources,
  rubricAnchors,
  rubricCriteria,
  rubrics,
  tracks,
  type JudgeDatabase,
} from '@judge-copilot/database';
import type { EventContextDocumentInput } from '@judge-copilot/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditTrail,
  loadFixtures,
  replayService,
  requireValue,
  seedFromRecording,
  serviceWith,
  testDatabaseTargets,
  type TestDatabase,
} from '../testing/harness.js';
import { EVENT_CONTEXT_BUILD_RUN_TYPE, type EventContextService } from './service.js';

const RESTRICT_VIOLATION = '23001';
const FOREIGN_KEY_VIOLATION = '23503';

async function expectCode(
  promise: Promise<unknown>,
  code: EventContextErrorCode,
): Promise<EventContextError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EventContextError);
    expect((error as EventContextError).code).toBe(code);
    return error as EventContextError;
  }
  throw new Error(`expected ${code}`);
}

async function expectPgCode(promise: PromiseLike<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  const codes: unknown[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    codes.push((current as { code?: unknown }).code);
  }
  expect(codes, 'expected a database error').toContain(code);
}

function editable(document: unknown): EventContextDocumentInput {
  return structuredClone(document) as EventContextDocumentInput;
}

describe.each(testDatabaseTargets())('Event Context workflow on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let fixtures: Map<string, ReplayRecordingInput>;
  let service: EventContextService;
  const fixture = (name: string) => requireValue(fixtures.get(`fixture-${name}`), name);

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    fixtures = await loadFixtures();
    service = replayService(db, fixtures.values());
  });

  afterAll(async () => {
    await testDb.close();
  });

  /** Seeds a fixture, builds it and returns ids plus the built detail. */
  async function built(name: string) {
    const seeded = await seedFromRecording(service, fixture(name));
    const detail = await service.buildContext(seeded.eventId, seeded.versionId);
    return { ...seeded, detail };
  }

  describe('events and draft versions', () => {
    it('creates an event, audits it, and rejects a duplicate slug', async () => {
      const event = await service.createEvent({
        name: 'Demo Hackathon',
        slug: 'demo-hackathon-events',
      });
      expect(event).toMatchObject({
        name: 'Demo Hackathon',
        slug: 'demo-hackathon-events',
        startsAt: null,
      });
      expect((await auditTrail(db, event.id)).map((entry) => entry.action)).toEqual([
        'event_created',
      ]);
      await expectCode(
        service.createEvent({ name: 'Again', slug: 'demo-hackathon-events' }),
        'EVENT_SLUG_TAKEN',
      );
    });

    it('creates draft context version 1 with no content and audits it', async () => {
      const event = await service.createEvent({ name: 'Draft Test', slug: 'draft-test-event' });
      const version = await service.createContextVersion(event.id, {});
      expect(version).toMatchObject({
        version: 1,
        status: 'draft',
        supersedesId: null,
        document: null,
        sources: [],
        lockReadiness: { ready: false },
      });
      expect((await auditTrail(db, version.id)).map((entry) => entry.action)).toEqual([
        'context_version_created',
      ]);
      await expectCode(
        service.createContextVersion('5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e', {}),
        'EVENT_NOT_FOUND',
      );
    });
  });

  describe('sources', () => {
    it('persists sources with authority, type and a deterministic SHA-256 hash, auditing without raw text', async () => {
      const event = await service.createEvent({ name: 'Sources', slug: 'sources-event' });
      const version = await service.createContextVersion(event.id, {});
      const text = 'Official rules.\r\nPre-existing code is allowed.  ';
      const a = await service.addSource(event.id, version.id, {
        sourceType: 'pasted_text',
        authority: 'official_event_rules',
        title: 'Rules',
        normalizedText: text,
      });
      const b = await service.addSource(event.id, version.id, {
        sourceType: 'url_text',
        authority: 'judge_context',
        title: 'Same text, other authority',
        url: 'https://events.example.org/notes',
        normalizedText: 'Official rules.\nPre-existing code is allowed.',
      });
      expect(a).toMatchObject({
        authority: 'official_event_rules',
        authorityRank: 100,
        sourceType: 'pasted_text',
        normalizedText: 'Official rules.\nPre-existing code is allowed.',
        contentHash: sourceContentHash(normalizeSourceText(text)),
      });
      expect(b.contentHash).toBe(a.contentHash);
      expect(b.authorityRank).toBe(60);

      const listed = await service.listSources(event.id, version.id);
      expect(listed.map((source) => source.id)).toEqual([a.id, b.id]);

      const [audit] = await auditTrail(db, a.id);
      expect(audit?.action).toBe('event_source_added');
      expect(audit?.metadata).toMatchObject({
        authority: 'official_event_rules',
        contentHash: a.contentHash,
      });
      expect(JSON.stringify(audit?.metadata)).not.toContain('Pre-existing code');
    });

    it('rejects text that is empty after normalization', async () => {
      const event = await service.createEvent({ name: 'Blank', slug: 'blank-source-event' });
      const version = await service.createContextVersion(event.id, {});
      await expectCode(
        service.addSource(event.id, version.id, {
          sourceType: 'pasted_text',
          authority: 'official_event_rules',
          title: 'Blank',
          normalizedText: '   \r\n  ',
        }),
        'INVALID_SOURCE_TEXT',
      );
    });
  });

  describe('build', () => {
    it('builds a draft through the extractor port, recording an analysis run and an audit event', async () => {
      const { versionId, sourceIdByRef, detail } = await built('a-clear-official-rubric');
      const rules = requireValue(sourceIdByRef.get('rules'));
      expect(detail.status).toBe('draft');
      expect(detail.document?.priorWorkPolicy).toMatchObject({
        stance: 'allowed_with_disclosure',
        certainty: 'explicit',
        sourceIds: [rules],
        origin: 'source_derived',
        humanModified: false,
      });
      expect(detail.document?.rubrics[0]?.criteria.map((criterion) => criterion.weight)).toEqual([
        0.4, 0.3, 0.3,
      ]);
      expect(detail.extraction).toEqual(detail.document);
      expect(detail.lockReadiness).toEqual({ ready: true, issues: [] });

      const runs = await db
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.contextVersionId, versionId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        runType: EVENT_CONTEXT_BUILD_RUN_TYPE,
        state: 'succeeded',
        failureCategory: null,
      });
      const buildAudit = (await auditTrail(db, versionId)).find(
        (entry) => entry.action === 'event_context_built',
      );
      expect(buildAudit?.metadata).toMatchObject({
        extractor: 'replay',
        sourceCount: 3,
        rubricCount: 1,
      });
    });

    it('requires sources and a configured extractor', async () => {
      const event = await service.createEvent({ name: 'No sources', slug: 'no-sources-event' });
      const version = await service.createContextVersion(event.id, {});
      await expectCode(service.buildContext(event.id, version.id), 'NO_CONTEXT_SOURCES');
      await expectCode(
        serviceWith(db, null).buildContext(event.id, version.id),
        'EXTRACTOR_NOT_CONFIGURED',
      );
    });

    it.each([
      [
        'a provider failure',
        (): Promise<unknown> => Promise.reject(new Error('upstream exploded with secret sk-123')),
        'provider_error',
      ],
      [
        'schema-invalid output',
        (): Promise<unknown> => Promise.resolve({ rules: 'not a list' }),
        'schema_validation_failed',
      ],
    ] as const)(
      'leaves the last valid draft intact after %s',
      async (_label, extract, category) => {
        const { eventId, versionId, detail: before } = await built('a-clear-official-rubric');
        const failing: EventContextExtractor = { name: 'failing', extract };
        const error = await expectCode(
          serviceWith(db, failing).buildContext(eventId, versionId),
          'CONTEXT_BUILD_FAILED',
        );
        expect(error.details).toMatchObject({ failureCategory: category });
        expect(error.message).not.toContain('sk-123');

        const after = await service.getContextVersion(eventId, versionId);
        expect(after.document).toEqual(before.document);
        expect(after.extraction).toEqual(before.extraction);
        const runs = await db
          .select()
          .from(analysisRuns)
          .where(eq(analysisRuns.contextVersionId, versionId));
        expect(runs.map((run) => [run.state, run.failureCategory])).toEqual([
          ['succeeded', null],
          ['failed', category],
        ]);
        expect((await auditTrail(db, versionId)).map((entry) => entry.action)).toContain(
          'event_context_build_failed',
        );
      },
    );

    it('fails domain validation when the extractor cites a source outside the version, writing nothing', async () => {
      const {
        eventId,
        versionId,
        sourceIdByRef,
        detail: before,
      } = await built('a-clear-official-rubric');
      const other = await built('b-ambiguous-policy');
      const foreignSource = requireValue(other.sourceIdByRef.get('rules'));
      const extraction = remapSourceIds(fixture('a-clear-official-rubric').extraction, (ref) =>
        requireValue(sourceIdByRef.get(ref)),
      ) as Record<string, unknown>;
      const forged: EventContextExtractor = {
        name: 'forged',
        extract: () =>
          Promise.resolve({
            ...extraction,
            rules: [{ statement: 'Forged.', certainty: 'explicit', sourceIds: [foreignSource] }],
          }),
      };
      const error = await expectCode(
        serviceWith(db, forged).buildContext(eventId, versionId),
        'CONTEXT_BUILD_FAILED',
      );
      expect(error.details).toMatchObject({ failureCategory: 'domain_validation_failed' });
      expect(error.issues[0]?.code).toBe('UNKNOWN_SOURCE_REFERENCE');
      expect((await service.getContextVersion(eventId, versionId)).document).toEqual(
        before.document,
      );
    });
  });

  describe('human review and editing', () => {
    it('lets a human correct wording while source provenance survives and the extraction is kept', async () => {
      const { eventId, versionId, sourceIdByRef, detail } = await built('a-clear-official-rubric');
      const input = editable(detail.document);
      input.priorWorkPolicy.statement =
        'Pre-event personal code and open-source libraries are allowed when disclosed.';
      input.organizerGuidance.push({
        statement: 'Head judge: presenters must demo on their own laptops.',
        certainty: 'explicit',
        sourceIds: [],
      });

      const edited = await service.editContext(eventId, versionId, {
        document: input,
        summary: 'Reviewed by head judge.',
      });
      expect(edited.summary).toBe('Reviewed by head judge.');
      expect(edited.document?.priorWorkPolicy).toMatchObject({
        id: detail.document?.priorWorkPolicy.id,
        origin: 'source_derived',
        humanModified: true,
        sourceIds: [sourceIdByRef.get('rules')],
      });
      expect(edited.extraction?.priorWorkPolicy.statement).toBe(
        detail.document?.priorWorkPolicy.statement,
      );
      expect(edited.document?.organizerGuidance[0]).toMatchObject({
        origin: 'human',
        sourceIds: [],
      });

      const audit = (await auditTrail(db, versionId)).find(
        (entry) => entry.action === 'event_context_edited',
      );
      expect(audit?.metadata).toMatchObject({
        modified: ['priorWorkPolicy'],
        added: ['organizerGuidance:new'],
        summaryChanged: true,
      });
    });

    it('rejects edits that would remove provenance, reuse criterion keys or break the rubric scale', async () => {
      const { eventId, versionId, detail } = await built('a-clear-official-rubric');
      const dropped = editable(detail.document);
      dropped.rules[0] = { ...requireValue(dropped.rules[0]), sourceIds: [] };
      await expectCode(
        service.editContext(eventId, versionId, { document: dropped }),
        'PROVENANCE_REMOVED',
      );

      const duplicate = editable(detail.document);
      const rubric = requireValue(duplicate.rubrics[0]);
      rubric.criteria.push({ ...requireValue(rubric.criteria[0]) });
      await expectCode(
        service.editContext(eventId, versionId, { document: duplicate }),
        'DUPLICATE_CRITERION_KEY',
      );

      const scale = editable(detail.document);
      requireValue(scale.rubrics[0]).scaleMax = 0;
      await expectCode(
        service.editContext(eventId, versionId, { document: scale }),
        'INVALID_RUBRIC_SCALE',
      );

      expect((await service.getContextVersion(eventId, versionId)).document).toEqual(
        detail.document,
      );
    });

    it('supports authoring a draft by hand when no extractor is configured', async () => {
      const manual = serviceWith(db, null);
      const event = await manual.createEvent({ name: 'Manual', slug: 'manual-authoring-event' });
      const version = await manual.createContextVersion(event.id, {});
      const source = await manual.addSource(event.id, version.id, {
        sourceType: 'pasted_text',
        authority: 'official_event_rules',
        title: 'Rules',
        normalizedText: 'Prior work is not allowed.',
      });
      const document = editable(
        remapSourceIds(fixture('b-ambiguous-policy').extraction, () => source.id),
      );
      const authored = await manual.editContext(event.id, version.id, { document });
      expect(authored.document?.rules[0]).toMatchObject({
        origin: 'human',
        sourceIds: [source.id],
      });
      const locked = await manual.lockContext(event.id, version.id);
      expect(locked.status).toBe('locked');
    });
  });

  describe('locking', () => {
    it('locks a correctly weighted official rubric, records the hash and audits the lock', async () => {
      const { eventId, versionId } = await built('a-clear-official-rubric');
      const locked = await service.lockContext(eventId, versionId);
      expect(locked).toMatchObject({
        status: 'locked',
        lockReadiness: null,
        integrity: 'verified',
      });
      expect(locked.lockedAt).not.toBeNull();
      expect(locked.lockedContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        lockedContentHash({ document: requireValue(locked.document), sources: locked.sources }),
      ).toBe(locked.lockedContentHash);
      const audit = (await auditTrail(db, versionId)).find(
        (entry) => entry.action === 'event_context_locked',
      );
      expect(audit?.metadata).toMatchObject({
        version: 1,
        lockedContentHash: locked.lockedContentHash,
        supersededVersionId: null,
      });

      const snapshot = await service.getLockedContext(eventId);
      expect(snapshot).toMatchObject({
        versionId,
        version: 1,
        status: 'locked',
        lockedContentHash: locked.lockedContentHash,
      });
    });

    it('refuses to lock malformed official weights, without normalizing them', async () => {
      const { eventId, versionId, detail } = await built('d-malformed-rubric');
      expect(detail.lockReadiness?.ready).toBe(false);
      expect(detail.lockReadiness?.issues.map((issue) => issue.code)).toEqual([
        'INVALID_RUBRIC_WEIGHTS',
      ]);
      await expectCode(service.lockContext(eventId, versionId), 'INVALID_RUBRIC_WEIGHTS');
      const after = await service.getContextVersion(eventId, versionId);
      expect(after.status).toBe('draft');
      expect(after.document?.rubrics[0]?.criteria.map((criterion) => criterion.weight)).toEqual([
        0.5, 0.3, 0.3,
      ]);
      await expectCode(service.getLockedContext(eventId), 'NO_LOCKED_CONTEXT');
    });

    it('locks an unweighted rubric and an explicitly unclear prior-work policy without inventing answers', async () => {
      const { eventId, versionId } = await built('b-ambiguous-policy');
      const locked = await service.lockContext(eventId, versionId);
      expect(locked.status).toBe('locked');
      expect(
        locked.document?.rubrics[0]?.criteria.every((criterion) => criterion.weight === null),
      ).toBe(true);
      expect(locked.document?.priorWorkPolicy).toMatchObject({
        stance: 'unclear',
        certainty: 'unclear',
      });
      expect(locked.unresolved.map((item) => item.path)).toEqual(
        expect.arrayContaining(['priorWorkPolicy', 'judgingFormat', 'dates.judgingStartsAt']),
      );
    });

    it('requires content before locking', async () => {
      const event = await service.createEvent({ name: 'Empty lock', slug: 'empty-lock-event' });
      const version = await service.createContextVersion(event.id, {});
      await expectCode(service.lockContext(event.id, version.id), 'CONTEXT_CONTENT_MISSING');
    });

    it('locks a multi-track context with an overall rubric, a track rubric and track requirements', async () => {
      const { eventId, versionId } = await built('e-multiple-tracks');
      const locked = await service.lockContext(eventId, versionId);
      const document = requireValue(locked.document);
      expect(document.tracks.map((track) => track.key)).toEqual(['health', 'education']);
      expect(document.rubrics.map((rubric) => [rubric.scope, rubric.trackKey])).toEqual([
        ['overall', null],
        ['track', 'health'],
      ]);
      expect(document.submissionRequirements.map((requirement) => requirement.trackKey)).toEqual([
        'health',
        'education',
      ]);
    });
  });

  describe('authority and conflicts', () => {
    it('follows the official rule, keeps the lower-authority source and the conflict visible after locking', async () => {
      const { eventId, versionId, sourceIdByRef } = await built('c-conflicting-authority');
      const rules = requireValue(sourceIdByRef.get('rules'));
      const judgeNote = requireValue(sourceIdByRef.get('judge_note'));
      const locked = await service.lockContext(eventId, versionId);
      const document = requireValue(locked.document);

      expect(document.priorWorkPolicy).toMatchObject({ stance: 'allowed', sourceIds: [rules] });
      expect(document.conflicts).toHaveLength(1);
      expect(document.conflicts[0]?.resolution).toEqual({
        status: 'resolved_by_authority',
        prevailingSourceIds: [rules],
        note: null,
      });
      expect(document.conflicts[0]?.positions.map((position) => position.sourceId)).toEqual([
        rules,
        judgeNote,
      ]);
      expect(locked.sources.find((source) => source.id === judgeNote)).toMatchObject({
        authority: 'judge_context',
      });
    });
  });

  describe('immutability and versioning', () => {
    it('rejects every application-level mutation of a locked version', async () => {
      const { eventId, versionId, detail } = await built('a-clear-official-rubric');
      await service.lockContext(eventId, versionId);
      await expectCode(
        service.addSource(eventId, versionId, {
          sourceType: 'pasted_text',
          authority: 'organizer_guidance',
          title: 'Late note',
          normalizedText: 'Late note.',
        }),
        'LOCKED_CONTEXT_IMMUTABLE',
      );
      await expectCode(
        service.editContext(eventId, versionId, { document: editable(detail.document) }),
        'LOCKED_CONTEXT_IMMUTABLE',
      );
      await expectCode(service.buildContext(eventId, versionId), 'LOCKED_CONTEXT_IMMUTABLE');
      await expectCode(service.lockContext(eventId, versionId), 'CONTEXT_NOT_DRAFT');
    });

    it('rejects direct database mutation of locked content, sources, rubric, weights and tracks', async () => {
      const { eventId, versionId } = await built('e-multiple-tracks');
      await service.lockContext(eventId, versionId);
      const [source] = await db
        .select()
        .from(eventSources)
        .where(eq(eventSources.contextVersionId, versionId));
      const [track] = await db.select().from(tracks).where(eq(tracks.contextVersionId, versionId));
      const [rubric] = await db
        .select()
        .from(rubrics)
        .where(eq(rubrics.contextVersionId, versionId));
      const [criterion] = await db
        .select()
        .from(rubricCriteria)
        .where(eq(rubricCriteria.rubricId, requireValue(rubric).id));

      await expectPgCode(
        db
          .update(eventContextVersions)
          .set({ summary: 'tampered' })
          .where(eq(eventContextVersions.id, versionId)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db
          .update(eventContextVersions)
          .set({ status: 'draft', lockedAt: null })
          .where(eq(eventContextVersions.id, versionId)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db.delete(eventContextVersions).where(eq(eventContextVersions.id, versionId)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db
          .update(eventSources)
          .set({ title: 'tampered' })
          .where(eq(eventSources.id, requireValue(source).id)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db.delete(eventSources).where(eq(eventSources.id, requireValue(source).id)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db.insert(eventSources).values({
          contextVersionId: versionId,
          sourceType: 'pasted_text',
          authority: 'judge_context',
          title: 'Injected',
          normalizedText: 'Injected.',
          contentHash: sourceContentHash('Injected.'),
          position: 99,
        }),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db
          .update(tracks)
          .set({ name: 'Renamed' })
          .where(eq(tracks.id, requireValue(track).id)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db
          .update(rubrics)
          .set({ scaleMax: 10 })
          .where(eq(rubrics.id, requireValue(rubric).id)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db
          .update(rubricCriteria)
          .set({ weight: 0.9 })
          .where(eq(rubricCriteria.id, requireValue(criterion).id)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db.delete(rubrics).where(eq(rubrics.id, requireValue(rubric).id)),
        RESTRICT_VIOLATION,
      );
      await expectPgCode(
        db.insert(rubricAnchors).values({
          criterionId: requireValue(criterion).id,
          score: 3,
          description: 'Injected anchor.',
        }),
        RESTRICT_VIOLATION,
      );

      const after = await service.getContextVersion(eventId, versionId);
      expect(after.integrity).toBe('verified');
    });

    it('derives v2 from locked v1, supersedes v1 atomically on lock, and keeps v1 reconstructable', async () => {
      const { eventId, versionId: v1Id } = await built('c-conflicting-authority');
      const v1Locked = await service.lockContext(eventId, v1Id);

      await expectCode(service.createContextVersion(eventId, {}), 'CHANGE_REASON_REQUIRED');
      const v2 = await service.createContextVersion(eventId, {
        changeReason: 'Organizers published the judging start time.',
      });
      expect(v2).toMatchObject({
        version: 2,
        status: 'draft',
        supersedesId: v1Id,
        changeReason: 'Organizers published the judging start time.',
      });

      // Sources are copied, not shared: new ids, same hashes, linked to their originals.
      expect(v2.sources.map((source) => source.copiedFromId)).toEqual(
        v1Locked.sources.map((source) => source.id),
      );
      expect(v2.sources.map((source) => source.contentHash)).toEqual(
        v1Locked.sources.map((source) => source.contentHash),
      );
      expect(
        v2.sources.some((source) => v1Locked.sources.some((original) => original.id === source.id)),
      ).toBe(false);
      const copiedId = new Map(
        v2.sources.map((source) => [requireValue(source.copiedFromId), source.id]),
      );
      expect(v2.document?.priorWorkPolicy.sourceIds).toEqual(
        v1Locked.document?.priorWorkPolicy.sourceIds.map((id) => copiedId.get(id)),
      );

      // Modify v2: a human may not turn an unclear source-derived fact into an explicit one
      // without citing a source, so the organizer announcement is added as a new source first.
      const input = editable(v2.document);
      input.dates.judgingStartsAt = {
        ...input.dates.judgingStartsAt,
        statement: 'Judging starts 2031-06-08 at 17:00 UTC (organizer announcement).',
        certainty: 'explicit',
        value: '2031-06-08T17:00:00Z',
      };
      await expectCode(
        service.editContext(eventId, v2.id, { document: input }),
        'MISSING_PROVENANCE',
      );
      const announcement = await service.addSource(eventId, v2.id, {
        sourceType: 'pasted_text',
        authority: 'organizer_guidance',
        title: 'Organizer announcement',
        normalizedText: 'Judging starts on 2031-06-08 at 17:00 UTC.',
      });
      input.dates.judgingStartsAt.sourceIds = [announcement.id];
      const v2Edited = await service.editContext(eventId, v2.id, { document: input });
      expect(v2Edited.document?.dates.judgingStartsAt).toMatchObject({
        origin: 'source_derived',
        humanModified: true,
        sourceIds: [announcement.id],
      });

      const v2Locked = await service.lockContext(eventId, v2.id);
      expect(v2Locked.status).toBe('locked');

      const v1After = await service.getContextVersion(eventId, v1Id);
      expect(v1After.status).toBe('superseded');
      expect(v1After.integrity).toBe('verified');
      expect({ ...v1After, status: 'locked' }).toEqual(v1Locked);
      expect(v1After.document?.dates.judgingStartsAt.certainty).toBe('unclear');

      const lockedRows = await db
        .select({ id: eventContextVersions.id })
        .from(eventContextVersions)
        .where(
          and(eq(eventContextVersions.eventId, eventId), eq(eventContextVersions.status, 'locked')),
        );
      expect(lockedRows).toEqual([{ id: v2.id }]);
      expect((await service.getLockedContext(eventId)).versionId).toBe(v2.id);

      const v1Audit = (await auditTrail(db, v1Id)).map((entry) => entry.action);
      expect(v1Audit).toContain('context_version_superseded');
      const event = await service.getEvent(eventId);
      expect(event.versions.map((version) => [version.version, version.status])).toEqual([
        [1, 'superseded'],
        [2, 'locked'],
      ]);
      expect(event.lockedVersionId).toBe(v2.id);
    });

    it('allows at most one locked version per event and rejects stale drafts', async () => {
      const { eventId, versionId } = await built('a-clear-official-rubric');
      const stale = await service.createContextVersion(eventId, {});
      await service.lockContext(eventId, versionId);
      await expectCode(service.lockContext(eventId, stale.id), 'STALE_CONTEXT_BASE');

      const [{ locked } = { locked: -1 }] = await db
        .select({ locked: sql<number>`count(*)::int` })
        .from(eventContextVersions)
        .where(
          and(eq(eventContextVersions.eventId, eventId), eq(eventContextVersions.status, 'locked')),
        );
      expect(locked).toBe(1);
      await expectPgCode(
        db
          .update(eventContextVersions)
          .set({ status: 'locked', lockedAt: new Date() })
          .where(eq(eventContextVersions.id, stale.id)),
        '23505',
      );
    });
  });

  describe('cross-event isolation', () => {
    it('never resolves a version or source through another event', async () => {
      const a = await built('a-clear-official-rubric');
      const b = await built('b-ambiguous-policy');
      await expectCode(
        service.getContextVersion(a.eventId, b.versionId),
        'CONTEXT_VERSION_NOT_FOUND',
      );
      await expectCode(service.listSources(a.eventId, b.versionId), 'CONTEXT_VERSION_NOT_FOUND');

      const input = editable(a.detail.document);
      input.rules[0] = {
        ...requireValue(input.rules[0]),
        sourceIds: [requireValue(b.sourceIdByRef.get('rules'))],
      };
      await expectCode(
        service.editContext(a.eventId, a.versionId, { document: input }),
        'CROSS_EVENT_REFERENCE',
      );

      // The database refuses a cross-version provenance reference even if application code is bypassed.
      await expectPgCode(
        db.insert(tracks).values({
          contextVersionId: a.versionId,
          key: 'forged',
          name: 'Forged',
          displayOrder: 99,
          sourceIds: [requireValue(b.sourceIdByRef.get('rules'))],
          origin: 'human',
        }),
        FOREIGN_KEY_VIOLATION,
      );
    });
  });
});
