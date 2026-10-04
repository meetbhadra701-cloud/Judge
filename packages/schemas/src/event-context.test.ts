import { describe, expect, it } from 'vitest';
import {
  EVENT_CONTEXT_LIMITS,
  EventContextExtraction,
  EventSourceAuthority,
  EventSourceInput,
  EventSourceType,
  FactOrigin,
  PriorWorkPolicyInput,
  RubricScope,
  SourceCertainty,
  DateFactInput,
} from './index.js';

const source = {
  sourceType: 'pasted_text',
  authority: 'official_event_rules',
  title: 'Rules',
  normalizedText: 'Teams of four.',
} as const;

describe('Event Context vocabularies', () => {
  it('defines the source authority, source type, certainty, rubric scope and origin vocabularies', () => {
    expect(EventSourceAuthority.options).toEqual([
      'official_event_rules',
      'official_judging_rubric',
      'official_track_rules',
      'organizer_guidance',
      'judge_context',
      'universal_fallback',
    ]);
    expect(EventSourceType.options).toEqual(['pasted_text', 'url_text', 'document_text']);
    expect(SourceCertainty.options).toEqual(['explicit', 'interpreted', 'unclear']);
    expect(RubricScope.options).toEqual(['overall', 'track']);
    expect(FactOrigin.options).toEqual(['source_derived', 'human']);
    expect(EventSourceAuthority.safeParse('sponsor_wish').success).toBe(false);
  });
});

describe('EventSourceInput', () => {
  it('accepts normalized text with an https URL as provenance metadata', () => {
    expect(
      EventSourceInput.safeParse({
        ...source,
        sourceType: 'url_text',
        url: 'https://events.example.org/rules',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a url_text source without a url', { sourceType: 'url_text' }],
    ['a non-http(s) URL', { url: 'file:///etc/passwd' }],
    ['an IP-address URL', { url: 'http://169.254.169.254/latest/meta-data' }],
    ['a localhost URL', { url: 'http://localhost:3001/health' }],
    ['empty text', { normalizedText: '' }],
    ['oversized text', { normalizedText: 'x'.repeat(EVENT_CONTEXT_LIMITS.sourceTextMaxChars + 1) }],
    ['text containing NUL', { normalizedText: 'a\u0000b' }],
    ['an unknown authority', { authority: 'sponsor_wish' }],
  ])('rejects %s', (_label, override) => {
    expect(EventSourceInput.safeParse({ ...source, ...override }).success).toBe(false);
  });
});

describe('fact certainty rules', () => {
  it('requires date values to be null exactly when certainty is unclear', () => {
    const base = { statement: 'Starts Saturday.', sourceIds: [] };
    expect(DateFactInput.safeParse({ ...base, certainty: 'unclear', value: null }).success).toBe(
      true,
    );
    expect(DateFactInput.safeParse({ ...base, certainty: 'explicit', value: null }).success).toBe(
      false,
    );
    expect(
      DateFactInput.safeParse({ ...base, certainty: 'unclear', value: '2031-04-12T09:00:00Z' })
        .success,
    ).toBe(false);
  });

  it('requires the prior-work stance to be unclear exactly when certainty is unclear', () => {
    const base = { statement: 'Not mentioned.', sourceIds: [] };
    expect(
      PriorWorkPolicyInput.safeParse({ ...base, certainty: 'unclear', stance: 'unclear' }).success,
    ).toBe(true);
    expect(
      PriorWorkPolicyInput.safeParse({ ...base, certainty: 'unclear', stance: 'allowed' }).success,
    ).toBe(false);
    expect(
      PriorWorkPolicyInput.safeParse({ ...base, certainty: 'explicit', stance: 'unclear' }).success,
    ).toBe(false);
  });
});

describe('EventContextExtraction', () => {
  const unclear = { statement: 'Not stated.', certainty: 'unclear', sourceIds: [] };
  const extraction = {
    dates: {
      startsAt: { ...unclear, value: null },
      endsAt: { ...unclear, value: null },
      judgingStartsAt: { ...unclear, value: null },
      submissionDeadline: { ...unclear, value: null },
    },
    judgingFormat: unclear,
    rules: [],
    submissionRequirements: [],
    priorWorkPolicy: { ...unclear, stance: 'unclear' },
    organizerGuidance: [],
    tracks: [],
    rubrics: [],
    conflicts: [],
  };

  it('accepts an extraction that states only unknowns', () => {
    expect(EventContextExtraction.safeParse(extraction).success).toBe(true);
  });

  it('rejects extractor output that supplies IDs (models never invent IDs)', () => {
    const withId = {
      ...extraction,
      rules: [{ ...unclear, id: '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e' }],
    };
    expect(EventContextExtraction.safeParse(withId).success).toBe(false);
  });

  it('rejects extractor output that resolves conflicts on behalf of a human', () => {
    const id = '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e';
    const withResolution = {
      ...extraction,
      conflicts: [
        {
          topic: 'Prior work',
          description: 'x',
          positions: [],
          humanResolution: { prevailingSourceIds: [id], note: 'chosen' },
        },
      ],
    };
    expect(EventContextExtraction.safeParse(withResolution).success).toBe(false);
  });
});
