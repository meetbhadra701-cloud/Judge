import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankModel, documentFromModel } from '../../../../../../lib/context-editor';

const api = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('../../../../../../lib/api', () => ({
  apiRequest: api.apiRequest,
  versionPath: (e: string, v: string) => `/events/${e}/context-versions/${v}`,
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { saveStructuredContextAction } from './actions';

const RULES = '11111111-1111-4111-8111-111111111111';
const NOTES = '22222222-2222-4222-8222-222222222222';
const draft = (status = 'draft') => ({
  ok: true,
  data: {
    status,
    version: 3,
    sources: [
      { id: RULES, title: 'Official rules', authority: 'official_event_rules' },
      { id: NOTES, title: 'Notes', authority: 'organizer_guidance' },
    ],
  },
});
const SOURCES = [
  { id: RULES, title: 'Official rules', authority: 'official_event_rules' as const },
  { id: NOTES, title: 'Notes', authority: 'organizer_guidance' as const },
];
const form = (document: unknown) => {
  const data = new FormData();
  data.set('eventId', 'e1');
  data.set('versionId', 'v1');
  data.set('document', typeof document === 'string' ? document : JSON.stringify(document));
  return data;
};
const INITIAL = { attempt: 0, error: null, issues: [] };

beforeEach(() => api.apiRequest.mockReset());

describe('P6D structured save action (server tier)', () => {
  it('a valid document is sent to the API as the draft, and the organizer is returned to the review page', async () => {
    const built = documentFromModel(blankModel(), SOURCES).input;
    if (built === null) throw new Error('the blank model builds');
    api.apiRequest.mockResolvedValueOnce(draft()).mockResolvedValueOnce({ ok: true, data: {} });
    await expect(saveStructuredContextAction(INITIAL, form(built))).rejects.toThrow(
      'REDIRECT /events/e1/versions/v1',
    );
    expect(api.apiRequest).toHaveBeenLastCalledWith(
      'PATCH',
      '/events/e1/context-versions/v1',
      expect.objectContaining({ summary: null }),
    );
  });

  it('a form post made without the browser’s checks cannot promote an unsourced statement to official: nothing reaches the API', async () => {
    const honest = {
      ...blankModel(),
      rules: [{ statement: 'Teams of four.', sourceIds: [NOTES], basis: 'interpreted' as const }],
    };
    const sneaky = documentFromModel(honest, SOURCES).input;
    if (sneaky === null) throw new Error('the honest model builds');
    // the same document, certainty edited by hand to `explicit` (what a crafted post would do)
    const crafted = {
      ...sneaky,
      rules: sneaky.rules.map((rule) => ({ ...rule, certainty: 'explicit' })),
    };
    api.apiRequest.mockResolvedValueOnce(draft());
    const result = await saveStructuredContextAction(INITIAL, form(crafted));
    expect(result.error).toMatch(/was not saved/);
    expect(result.issues.map((i) => i.path)).toContain('rules.0.sources');
    expect(api.apiRequest).toHaveBeenCalledTimes(1); // only the version read
  });

  it('refuses a locked or superseded version, and unreadable input, without touching the draft', async () => {
    api.apiRequest.mockResolvedValueOnce(draft('locked'));
    const locked = await saveStructuredContextAction(
      INITIAL,
      form(documentFromModel(blankModel(), SOURCES).input),
    );
    expect(locked.error).toMatch(/is locked and cannot be edited/);
    const garbage = await saveStructuredContextAction(INITIAL, form('{not json'));
    expect(garbage.error).toMatch(/could not be read/);
    expect(api.apiRequest).toHaveBeenCalledTimes(1);
  });

  it('returns what the API refused as issues for the form to show next to the fields', async () => {
    api.apiRequest.mockResolvedValueOnce(draft()).mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: 'INVALID_DOCUMENT',
      message: 'The document is invalid',
      issues: [{ path: 'rubrics[0].criteria[1].weight', message: 'bad weight' }],
    });
    const result = await saveStructuredContextAction(
      INITIAL,
      form(documentFromModel(blankModel(), SOURCES).input),
    );
    expect(result.error).toBe('The document is invalid');
    expect(result.issues).toEqual([
      { path: 'rubrics[0].criteria[1].weight', message: 'bad weight' },
    ]);
  });

  it('M6 phase 0 (R8B P3-2): a crafted post whose requirement names a track that does not exist is refused, never saved as an event-wide requirement', async () => {
    const built = documentFromModel(blankModel(), SOURCES).input;
    if (built === null) throw new Error('the blank model builds');
    const crafted = {
      ...built,
      submissionRequirements: [
        {
          statement: 'Health entrants must name a clinical advisor.',
          certainty: 'interpreted',
          sourceIds: [NOTES],
          trackKey: 'ghost',
        },
      ],
    };
    api.apiRequest.mockResolvedValueOnce(draft());
    const result = await saveStructuredContextAction(INITIAL, form(crafted));
    expect(result.error).toMatch(/was not saved/);
    expect(result.issues.map((i) => i.path)).toContain('requirements.0.trackKey');
    expect(result.issues.find((i) => i.path === 'requirements.0.trackKey')?.message).toMatch(
      /not changed for you/,
    );
    expect(api.apiRequest).toHaveBeenCalledTimes(1); // only the version read: nothing reached the API
  });
});
