import { describe, expect, it } from 'vitest';
import { buildEventReferenceItems } from '../../packages/assessment/src/index.js';
import type { EventContextLockedSnapshot } from '../../packages/schemas/src/index.js';
import { runSubmission, type ApiFn } from '../../apps/web/lib/submission.js';
import { postedTrackKeys, trackContextOf } from '../../apps/web/lib/tracks.js';
import { lockedSnapshot as assessmentLocked } from '../../packages/assessment/src/testing/world.js';

/* P6D: the web tier's track handling around the one submission request. */

const KEY = '0b9f6c1e-5b0e-4c27-9d6d-0a8e7d3f2a11';
const INPUT = {
  github: 'https://github.com/synthetic/atlas',
  devpost: 'https://devpost.com/software/synthetic-atlas',
  name: '',
};

function recordingApi(refusal?: {
  status: number;
  code: string;
  details?: Record<string, unknown>;
}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: ApiFn = (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') {
      return Promise.resolve({ ok: true, data: { lockedVersionId: 'v1' } } as never);
    }
    if (refusal) {
      return Promise.resolve({
        ok: false,
        status: refusal.status,
        code: refusal.code,
        message: 'raw api message',
        issues: [],
        details: refusal.details,
      } as never);
    }
    return Promise.resolve({
      ok: true,
      data: { result: 'created', project: { id: 'p1', name: 'synthetic/atlas' } },
    } as never);
  };
  return { api, calls };
}
const posted = (calls: { method: string; body: unknown }[]) =>
  calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;

describe('P6D submission body and refusals (web tier)', () => {
  it('sends the ticked tracks and the context token; an empty selection is stated explicitly', async () => {
    const withTracks = recordingApi();
    await runSubmission(
      withTracks.api,
      'e1',
      { ...INPUT, trackKeys: ['edu', 'health'], contextVersionId: 'v-token' },
      KEY,
    );
    expect(posted(withTracks.calls)).toMatchObject({
      trackKeys: ['edu', 'health'],
      contextVersionId: 'v-token',
    });
    const none = recordingApi();
    await runSubmission(
      none.api,
      'e1',
      { ...INPUT, trackKeys: [], contextVersionId: 'v-token' },
      KEY,
    );
    expect(posted(none.calls)).toMatchObject({ trackKeys: [] });
  });

  it('a page that offered no tracks sends no track fields at all (the request is the one older clients send)', async () => {
    const plain = recordingApi();
    await runSubmission(plain.api, 'e1', INPUT, KEY);
    expect(posted(plain.calls)).not.toHaveProperty('trackKeys');
    expect(posted(plain.calls)).not.toHaveProperty('contextVersionId');
  });

  it.each([
    ['UNKNOWN_TRACK', 422, undefined, /not part of this hackathon’s locked Event Context/],
    ['CONTEXT_VERSION_CHANGED', 409, undefined, /locked a new Event Context version/],
    [
      'SUBMISSION_CONFLICT',
      409,
      { reason: 'tracks_differ', projectIds: ['p9'] },
      /already submitted with different tracks/,
    ],
  ])(
    '%s is explained next to the tracks field, with nothing implied to be saved',
    async (code, status, details, message) => {
      const { api } = recordingApi({ status, code, ...(details ? { details } : {}) });
      const outcome = await runSubmission(
        api,
        'e1',
        { ...INPUT, trackKeys: ['health'], contextVersionId: 'v' },
        KEY,
      );
      expect(outcome).toMatchObject({ kind: 'failed', field: 'tracks' });
      expect((outcome as { message: string }).message).toMatch(message);
      expect((outcome as { message: string }).message).toMatch(
        /Nothing was (saved|changed)|nothing was changed/,
      );
    },
  );

  it('postedTrackKeys keeps only strings, once each, sorted', () => {
    expect(postedTrackKeys(['health', 'edu', 'health', 3, null, new File([], 'x')])).toEqual([
      'edu',
      'health',
    ]);
  });
});

describe('P6D trackContextOf mirrors the assessment preflight for display', () => {
  it('hasEventWideReference equals "the preflight finds reference items with no track declared", for every kind of context', () => {
    const base = assessmentLocked({});
    const cases: [string, EventContextLockedSnapshot][] = [];
    const clone = (mutate: (doc: EventContextLockedSnapshot['document']) => void) => {
      const copy = structuredClone(base);
      mutate(copy.document);
      return copy;
    };
    cases.push(['as built', base]);
    cases.push([
      'no rules',
      clone((d) => {
        d.rules = [];
        d.submissionRequirements = [];
      }),
    ]);
    cases.push([
      'unclear rule only',
      clone((d) => {
        d.rules = d.rules.map((r) => ({ ...r, certainty: 'unclear' as const }));
        d.submissionRequirements = [];
      }),
    ]);
    cases.push([
      'track requirement only',
      clone((d) => {
        d.rules = [];
        d.submissionRequirements = [
          {
            ...(d.rules[0] ?? ({} as never)),
            id: '00000000-0000-4000-8000-000000000099',
            statement: 'Track entrants must demo.',
            certainty: 'explicit',
            sourceIds: [],
            origin: 'human',
            humanModified: false,
            trackKey: 'health',
          },
        ];
      }),
    ]);
    for (const [label, locked] of cases) {
      const expected = buildEventReferenceItems(locked, []).items.length > 0;
      expect(trackContextOf(locked).hasEventWideReference, label).toBe(expected);
    }
  });
});
