import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@judge-copilot/shared';
import type { EventSourceAuthority } from '@judge-copilot/schemas';
import { buildApp, SERVICE_NAME, type ApiApp } from '../app.js';
import {
  bearer,
  fakeVerifier,
  loadFixtures,
  replayService,
  TEST_TOKENS,
  testDatabaseTargets,
  type TestDatabase,
} from '../testing/harness.js';

/*
 * M6 phase 0 (R8B P3-1): the source-authority rule is ONE rule for every way of writing a context. These tests use only the HTTP API, which is exactly
 * what the advanced (raw) editor and any direct caller use: a statement is official only when it is `explicit` AND cites an official-authority
 * source, and nothing can be LOCKED as official without one. A draft may still hold the statement, and the response says why it cannot be locked.
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
type Json = Record<string, any>;

describe.each(testDatabaseTargets())(
  'source authority is one rule for every writer, on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let app: ApiApp;

    beforeAll(async () => {
      testDb = await open();
      const fixtures = await loadFixtures();
      app = buildApp({
        logger,
        db: testDb.db,
        verifier: fakeVerifier(),
        eventContext: replayService(testDb.db, fixtures.values()),
      });
    });
    afterAll(async () => {
      await app.close();
      await testDb.close();
    });

    const call = async (
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      payload?: unknown,
      token: string | null = TEST_TOKENS.organizer,
    ) => {
      const response = await app.inject({
        method,
        url,
        headers: token === null ? {} : bearer(token),
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return { status: response.statusCode, body: response.json<Json>() };
    };

    const UNCLEAR = { statement: 'Not stated.', certainty: 'unclear', sourceIds: [] };
    const baseDocument = (): Json => ({
      dates: {
        startsAt: { ...UNCLEAR, value: null },
        endsAt: { ...UNCLEAR, value: null },
        judgingStartsAt: { ...UNCLEAR, value: null },
        submissionDeadline: { ...UNCLEAR, value: null },
      },
      judgingFormat: UNCLEAR,
      rules: [],
      submissionRequirements: [],
      priorWorkPolicy: { ...UNCLEAR, stance: 'unclear' },
      organizerGuidance: [],
      tracks: [],
      rubrics: [],
      conflicts: [],
    });

    let counter = 0;
    /** A draft with one source per authority, and a helper to write any document into it. */
    async function draft() {
      counter += 1;
      const slug = `prov-${Date.now().toString(36)}-${counter}`;
      const event = (await call('POST', '/events', { name: `Provenance ${slug}`, slug })).body;
      const version = (await call('POST', `/events/${event.id}/context-versions`, {})).body;
      const base = `/events/${event.id}/context-versions/${version.id}`;
      const sources: Record<string, string> = {};
      for (const authority of [
        'official_event_rules',
        'official_judging_rubric',
        'official_track_rules',
        'organizer_guidance',
        'judge_context',
        'universal_fallback',
      ] as EventSourceAuthority[]) {
        const created = await call('POST', `${base}/sources`, {
          sourceType: 'pasted_text',
          authority,
          title: `SYNTHETIC ${authority}`,
          normalizedText: `SYNTHETIC text for ${authority}.`,
        });
        sources[authority] = created.body.id;
      }
      const detail = async () => (await call('GET', base)).body;
      const write = (document: Json) => call('PATCH', `${base}`, { document });
      const lock = () => call('POST', `${base}/lock`, {});
      return { event, version, base, sources, detail, write, lock };
    }

    const rubric = (source: string, name = 'Official criteria'): Json => ({
      scope: 'overall',
      trackKey: null,
      name,
      scaleMin: 1,
      scaleMax: 5,
      sourceIds: [source],
      criteria: [
        {
          key: 'impact',
          name: 'Impact',
          description: 'Who benefits.',
          weight: 1,
          sourceIds: [source],
          anchors: [],
        },
      ],
    });

    it('an explicit rule with NO source is stored as a draft but cannot be locked, and the response says why', async () => {
      const d = await draft();
      const doc = baseDocument();
      doc['rules'] = [
        { statement: 'Entries must be written in Rust.', certainty: 'explicit', sourceIds: [] },
      ];
      doc['rubrics'] = [rubric(d.sources['official_judging_rubric']!)];
      expect((await d.write(doc)).status).toBe(200);
      const detail = await d.detail();
      expect(detail.lockReadiness.ready).toBe(false);
      expect(detail.lockReadiness.issues).toEqual([
        expect.objectContaining({ code: 'UNOFFICIAL_EXPLICIT_STATEMENT', path: 'rules[0]' }),
      ]);
      const rule = detail.document.rules[0];
      expect(detail.statementBases[rule.id]).toBe('unverified');
      const locked = await d.lock();
      expect(locked.status).toBe(422);
      expect(locked.body.error.code).toBe('UNOFFICIAL_EXPLICIT_STATEMENT');
      expect((await d.detail()).status).toBe('draft');
    });

    it.each(['organizer_guidance', 'judge_context', 'universal_fallback'] as const)(
      'an explicit rule citing only a lower-authority source (%s) is not official and cannot be locked',
      async (authority) => {
        const d = await draft();
        const doc = baseDocument();
        doc['rules'] = [
          {
            statement: 'All entries need a licence.',
            certainty: 'explicit',
            sourceIds: [d.sources[authority]!],
          },
        ];
        doc['rubrics'] = [rubric(d.sources['official_judging_rubric']!)];
        expect((await d.write(doc)).status).toBe(200);
        const detail = await d.detail();
        expect(detail.statementBases[detail.document.rules[0].id]).toBe('unverified');
        const locked = await d.lock();
        expect(locked.status).toBe(422);
        expect(locked.body.error.code).toBe('UNOFFICIAL_EXPLICIT_STATEMENT');
      },
    );

    it('the same checks cover dates, requirements, the judging format and the prior-work policy, not only rules', async () => {
      const d = await draft();
      const doc = baseDocument();
      doc['dates'].startsAt = {
        statement: 'Starts May 1.',
        certainty: 'explicit',
        sourceIds: [],
        value: '2031-05-01T09:00:00Z',
      };
      doc['judgingFormat'] = {
        statement: 'Expo judging.',
        certainty: 'explicit',
        sourceIds: [d.sources['judge_context']!],
      };
      doc['priorWorkPolicy'] = {
        statement: 'Prior work allowed.',
        certainty: 'explicit',
        sourceIds: [],
        stance: 'allowed',
      };
      doc['submissionRequirements'] = [
        { statement: 'A public repository.', certainty: 'explicit', sourceIds: [], trackKey: null },
      ];
      doc['rubrics'] = [rubric(d.sources['official_judging_rubric']!)];
      expect((await d.write(doc)).status).toBe(200);
      const paths = (await d.detail()).lockReadiness.issues.map((i: Json) => i.path).sort();
      expect(paths).toEqual([
        'dates.startsAt',
        'judgingFormat',
        'priorWorkPolicy',
        'submissionRequirements[0]',
      ]);
    });

    it('official statements, interpretations and unverified notes lock, each reported with its own basis', async () => {
      const d = await draft();
      const doc = baseDocument();
      doc['rules'] = [
        {
          statement: 'Original work only.',
          certainty: 'explicit',
          sourceIds: [d.sources['official_event_rules']!],
        },
        {
          statement: 'Teams are probably small.',
          certainty: 'interpreted',
          sourceIds: [d.sources['organizer_guidance']!],
        },
        { statement: 'Judges may like polish.', certainty: 'unclear', sourceIds: [] },
      ];
      doc['organizerGuidance'] = [
        {
          statement: 'Be kind.',
          certainty: 'explicit',
          sourceIds: [d.sources['organizer_guidance']!],
        },
      ];
      doc['rubrics'] = [rubric(d.sources['official_judging_rubric']!)];
      expect((await d.write(doc)).status).toBe(200);
      const before = await d.detail();
      expect(before.lockReadiness).toEqual({ ready: true, issues: [] });
      const ids = before.document.rules.map((r: Json) => r.id);
      expect(ids.map((id: string) => before.statementBases[id])).toEqual([
        'official',
        'organizer_interpreted',
        'unverified',
      ]);
      // organizer guidance is advice, not an official statement: it has no basis and is never blocked
      expect(Object.keys(before.statementBases)).not.toContain(
        before.document.organizerGuidance[0].id,
      );
      const locked = await d.lock();
      expect(locked.status).toBe(200);
      expect(locked.body.status).toBe('locked');
    });

    it('a rubric that cites no official source cannot be locked (an official rubric is never invented)', async () => {
      const d = await draft();
      const doc = baseDocument();
      doc['rubrics'] = [rubric(d.sources['organizer_guidance']!, 'Chat-message criteria')];
      expect((await d.write(doc)).status).toBe(200);
      expect((await d.detail()).lockReadiness.issues).toEqual([
        expect.objectContaining({ code: 'UNSOURCED_OFFICIAL_RUBRIC', path: 'rubrics[0]' }),
      ]);
      const locked = await d.lock();
      expect(locked.status).toBe(422);
      expect(locked.body.error.code).toBe('UNSOURCED_OFFICIAL_RUBRIC');
      const noSource = baseDocument();
      noSource['rubrics'] = [{ ...rubric(d.sources['official_judging_rubric']!), sourceIds: [] }];
      expect((await d.write(noSource)).status).toBe(200);
      expect((await d.lock()).body.error.code).toBe('UNSOURCED_OFFICIAL_RUBRIC');
    });

    it('fixing the statement (citing an official source) makes the same draft lockable; the lock is the only gate, writing is never blocked', async () => {
      const d = await draft();
      const doc = baseDocument();
      doc['rules'] = [{ statement: 'Original work only.', certainty: 'explicit', sourceIds: [] }];
      doc['rubrics'] = [rubric(d.sources['official_judging_rubric']!)];
      expect((await d.write(doc)).status).toBe(200);
      expect((await d.lock()).status).toBe(422);
      doc['rules'] = [
        {
          statement: 'Original work only.',
          certainty: 'explicit',
          sourceIds: [d.sources['official_event_rules']!],
        },
      ];
      expect((await d.write(doc)).status).toBe(200);
      expect((await d.lock()).status).toBe(200);
    });

    it('judge-role and anonymous callers cannot write or lock (the rule is not a substitute for authorization)', async () => {
      const d = await draft();
      const doc = baseDocument();
      expect((await call('PATCH', d.base, { document: doc }, TEST_TOKENS.judge)).status).toBe(403);
      expect((await call('POST', `${d.base}/lock`, {}, null)).status).toBe(401);
    });
  },
);
