import {
  applyHumanEdit,
  validateForLock,
  type VersionSources,
} from '../../packages/context/src/index.js';
import { EventContextDocument } from '../../packages/schemas/src/index.js';
import { describe, expect, it } from 'vitest';
import {
  blankCriterion,
  blankModel,
  blankRequirement,
  blankRubric,
  blankTrack,
  documentFromModel,
  fieldOfServerPath,
  inputFromDocument,
  keyFromName,
  modelFromInput,
  type EditorModel,
  type SourceOption,
} from '../../apps/web/lib/context-editor.js';

/*
 * P6D (P2-2): the structured editor's model, run against the REAL domain functions (applyHumanEdit, validateForLock). Whatever the form can build
 * must be accepted by the API's own rules; whatever the API would refuse for a reason the organizer can fix must be reported by the form first,
 * next to the field, in words.
 */

/** The value, or a failed test: the replacement for a non-null assertion. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

const RULES = '11111111-1111-4111-8111-111111111111';
const RUBRIC = '22222222-2222-4222-8222-222222222222';
const TRACKS = '33333333-3333-4333-8333-333333333333';
const NOTES = '44444444-4444-4444-8444-444444444444';
const SOURCES: SourceOption[] = [
  { id: RULES, title: 'Official rules', authority: 'official_event_rules' },
  { id: RUBRIC, title: 'Official judging rubric', authority: 'official_judging_rubric' },
  { id: TRACKS, title: 'Official track rules', authority: 'official_track_rules' },
  { id: NOTES, title: 'Organizer notes', authority: 'organizer_guidance' },
];
const AUTHORITY: VersionSources = new Map(SOURCES.map((s) => [s.id, s.authority]));

function complete(): EditorModel {
  const base = blankModel();
  return {
    ...base,
    dates: {
      ...base.dates,
      startsAt: { statement: '', basis: 'official', sourceIds: [RULES], value: '2026-05-01T09:00' },
      endsAt: {
        statement: 'Ends Sunday evening',
        basis: 'official',
        sourceIds: [RULES],
        value: '2026-05-03T18:00',
      },
    },
    judgingFormat: {
      statement: 'Two rounds of expo-style judging.',
      basis: 'official',
      sourceIds: [RULES],
    },
    priorWork: {
      statement: 'Prior work must be disclosed.',
      basis: 'official',
      sourceIds: [RULES],
      stance: 'allowed_with_disclosure',
    },
    rules: [
      {
        statement: 'Every project must be original work created during the event.',
        basis: 'official',
        sourceIds: [RULES],
      },
      { statement: 'Teams have at most five members.', basis: 'interpreted', sourceIds: [RULES] },
      { statement: 'Judges may also weigh polish.', basis: 'unverified', sourceIds: [] },
    ],
    requirements: [
      {
        ...blankRequirement(),
        statement: 'Every submission needs a public repository.',
        basis: 'official',
        sourceIds: [RULES],
      },
      {
        ...blankRequirement(),
        statement: 'Health entrants must name a clinical advisor.',
        basis: 'official',
        sourceIds: [TRACKS],
        trackKey: 'new-health',
      },
    ],
    guidance: [
      {
        statement: 'Please be generous with first-time hackers.',
        basis: 'interpreted',
        sourceIds: [NOTES],
      },
    ],
    tracks: [
      {
        ...blankTrack('new-health'),
        name: 'Health & Care',
        description: 'Projects that improve health.',
        sourceIds: [TRACKS],
      },
      { ...blankTrack('new-climate'), name: 'Climate', description: '', sourceIds: [TRACKS] },
    ],
    rubrics: [
      {
        ...blankRubric('overall'),
        name: 'Official judging rubric',
        scaleMin: '1',
        scaleMax: '5',
        sourceIds: [RUBRIC],
        criteria: [
          {
            ...blankCriterion(),
            name: 'Innovation',
            description: 'How novel it is.',
            weightPct: '40',
            anchors: [
              { score: '1', description: 'Nothing new.' },
              { score: '5', description: 'Genuinely new.' },
            ],
          },
          {
            ...blankCriterion(),
            name: 'Execution',
            description: 'How well built.',
            weightPct: '35.5',
          },
          { ...blankCriterion(), name: 'Impact', description: 'Who benefits.', weightPct: '24.5' },
        ],
      },
      {
        ...blankRubric('track', 'new-health'),
        name: 'Health track rubric',
        scaleMin: '0',
        scaleMax: '10',
        sourceIds: [TRACKS],
        criteria: [{ ...blankCriterion(), name: 'Clinical relevance', weightPct: '' }],
      },
    ],
  };
}

describe('the editor builds exactly what the domain model accepts', () => {
  it('a complete event (every section) yields no issues, is accepted by applyHumanEdit and passes the lock validation', () => {
    const built = documentFromModel(complete(), SOURCES);
    expect(built.issues).toEqual([]);
    expect(built.input).not.toBeNull();
    const { document } = applyHumanEdit(null, must(built.input), { sources: AUTHORITY });
    expect(validateForLock(document, AUTHORITY)).toEqual([]);
    expect(EventContextDocument.safeParse(document).success).toBe(true);
    // generated identifiers, never typed: keys are snake_case names, ids are assigned by the server
    expect(document.tracks.map((t) => t.key)).toEqual(['health_care', 'climate']);
    expect(document.rubrics[0]?.criteria.map((c) => c.key)).toEqual([
      'innovation',
      'execution',
      'impact',
    ]);
    expect(document.rubrics[1]).toMatchObject({ scope: 'track', trackKey: 'health_care' });
    expect(document.submissionRequirements.map((r) => r.trackKey)).toEqual([null, 'health_care']);
    // weights are stored as fractions that total 1
    const weights = document.rubrics[0]?.criteria.map((c) => c.weight) ?? [];
    expect(weights.reduce<number>((a, w) => a + (w ?? 0), 0)).toBeCloseTo(1, 9);
    // new items are human-entered: the server marks their origin, the form cannot
    expect(document.rules.every((rule) => rule.origin === 'human')).toBe(true);
  });

  it('the three kinds of statement keep their certainty: official -> explicit, interpretation -> interpreted, unverified -> unclear', () => {
    const built = documentFromModel(complete(), SOURCES);
    const { document } = applyHumanEdit(null, must(built.input), { sources: AUTHORITY });
    expect(document.rules.map((r) => r.certainty)).toEqual(['explicit', 'interpreted', 'unclear']);
    expect(document.organizerGuidance[0]?.certainty).toBe('interpreted');
  });

  it('an empty organizer-supplied slot is stored as "not stated" and unclear: nothing is invented', () => {
    const built = documentFromModel(blankModel(), SOURCES);
    expect(built.issues).toEqual([]);
    expect(built.input?.judgingFormat).toMatchObject({
      certainty: 'unclear',
      statement: 'Not stated.',
    });
    expect(built.input?.dates.startsAt).toMatchObject({ certainty: 'unclear', value: null });
    expect(built.input?.rubrics).toEqual([]);
  });

  it('editing a stored draft keeps ids and source-derived provenance (the form never shows or changes an id)', () => {
    const first = applyHumanEdit(null, must(documentFromModel(complete(), SOURCES).input), {
      sources: AUTHORITY,
    });
    const model = modelFromInput(inputFromDocument(first.document));
    expect(model.rules[0]).toMatchObject({ basis: 'official' });
    expect(model.tracks.map((t) => [t.uid, t.existing])).toEqual([
      ['health_care', true],
      ['climate', true],
    ]);
    const edited: EditorModel = {
      ...model,
      rules: model.rules.map((rule, i) =>
        i === 0 ? { ...rule, statement: 'Every project must be original work.' } : rule,
      ),
      tracks: [
        ...model.tracks,
        { ...blankTrack('new-edu'), name: 'Education', sourceIds: [TRACKS] },
      ],
    };
    const rebuilt = documentFromModel(edited, SOURCES);
    expect(rebuilt.issues).toEqual([]);
    const second = applyHumanEdit(first.document, must(rebuilt.input), { sources: AUTHORITY });
    expect(second.document.rules[0]?.id).toBe(first.document.rules[0]?.id);
    expect(second.document.rules[0]?.origin).toBe('human'); // the server, not the form, owns provenance
    expect(second.document.rules[1]?.humanModified).toBe(false); // untouched items stay untouched
    expect(second.document.tracks.map((t) => t.key)).toEqual([
      'health_care',
      'climate',
      'education',
    ]);
    // the existing track keeps its key even if it is renamed
    const renamed = documentFromModel(
      {
        ...model,
        tracks: model.tracks.map((t, i) => (i === 0 ? { ...t, name: 'Health and Wellbeing' } : t)),
      },
      SOURCES,
    );
    expect(renamed.input?.tracks[0]?.key).toBe('health_care');
    expect(validateForLock(second.document, AUTHORITY)).toEqual([]);
  });
});

describe('problems are caught next to the field, in words', () => {
  const fields = (model: EditorModel) =>
    documentFromModel(model, SOURCES).issues.map((i) => i.field);
  const messageAt = (model: EditorModel, field: string) =>
    documentFromModel(model, SOURCES).issues.find((i) => i.field === field)?.message ?? '';

  it('missing criteria and a missing rubric name', () => {
    const model: EditorModel = {
      ...blankModel(),
      rubrics: [
        {
          ...blankRubric('overall'),
          scaleMin: '1',
          scaleMax: '5',
          sourceIds: [RUBRIC],
          criteria: [],
        },
      ],
    };
    expect(fields(model)).toEqual(expect.arrayContaining(['rubrics.0.name', 'rubrics.0.criteria']));
    expect(messageAt(model, 'rubrics.0.criteria')).toMatch(/at least one criterion/);
  });

  it('weights that do not total 100 %, half-weighted rubrics, out-of-range and non-numeric weights', () => {
    const rubric = must(complete().rubrics[0]);
    const withWeights = (...w: string[]): EditorModel => ({
      ...blankModel(),
      rubrics: [
        { ...rubric, criteria: rubric.criteria.map((c, i) => ({ ...c, weightPct: w[i] ?? '' })) },
      ],
    });
    expect(messageAt(withWeights('40', '35', '24'), 'rubrics.0.criteria')).toMatch(
      /add up to 99 %.*total exactly 100 %/,
    );
    expect(messageAt(withWeights('50', '', '50'), 'rubrics.0.criteria')).toMatch(
      /every criterion a weight or leave every weight empty/,
    );
    expect(fields(withWeights('0', '50', '50'))).toContain('rubrics.0.criteria.0.weightPct');
    expect(fields(withWeights('150', '0', '0'))).toContain('rubrics.0.criteria.0.weightPct');
    const nonNumeric = documentFromModel(withWeights('forty', '30', '30'), SOURCES);
    expect(nonNumeric.input).toBeNull(); // cannot be represented: the draft is not even built
    expect(
      nonNumeric.issues.find((i) => i.field === 'rubrics.0.criteria.0.weightPct')?.blocks,
    ).toBe('save');
    // an unweighted official rubric is valid: weights are never invented
    expect(fields(withWeights('', '', ''))).toEqual([]);
  });

  it('malformed scales and scoring guides', () => {
    const rubric = must(complete().rubrics[0]);
    const scaled = (min: string, max: string): EditorModel => ({
      ...blankModel(),
      rubrics: [{ ...rubric, scaleMin: min, scaleMax: max }],
    });
    expect(messageAt(scaled('5', '1'), 'rubrics.0.scaleMax')).toMatch(/above the lowest/);
    expect(documentFromModel(scaled('', '5'), SOURCES).input).toBeNull();
    expect(documentFromModel(scaled('1', 'ten'), SOURCES).issues.map((i) => i.field)).toContain(
      'rubrics.0.scaleMax',
    );
    const outside: EditorModel = {
      ...blankModel(),
      rubrics: [
        {
          ...rubric,
          criteria: [
            {
              ...must(rubric.criteria[0]),
              anchors: [
                { score: '9', description: 'x' },
                { score: '1', description: 'a' },
                { score: '1', description: 'b' },
              ],
            },
            must(rubric.criteria[1]),
            must(rubric.criteria[2]),
          ],
        },
      ],
    };
    const messages = documentFromModel(outside, SOURCES).issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'This score is outside the rubric’s scale.',
        'Two scoring-guide rows use the same score.',
      ]),
    );
  });

  it('invalid tracks: a requirement or rubric pointing at a track that does not exist, a track nobody defined, a track without a source', () => {
    const base = complete();
    const noTrack: EditorModel = { ...base, tracks: [] };
    expect(fields(noTrack)).toEqual(
      expect.arrayContaining(['requirements.1.trackKey', 'rubrics.1.trackKey']),
    );
    const unsourced: EditorModel = {
      ...base,
      tracks: base.tracks.map((t, i) => (i === 0 ? { ...t, sourceIds: [] } : t)),
    };
    expect(messageAt(unsourced, 'tracks.0.sources')).toMatch(/A track is not invented/);
  });

  it('duplicated identifiers are impossible: same-named tracks and criteria get distinct generated keys, and a second overall rubric is refused', () => {
    expect(keyFromName('Impact', new Set(['impact']))).toBe('impact_2');
    expect(keyFromName('3D printing!', new Set())).toBe('c_3d_printing');
    expect(keyFromName('!!!', new Set())).toBe('item');
    const base = complete();
    const twin: EditorModel = { ...base, tracks: base.tracks.map((t) => ({ ...t, name: 'Same' })) };
    const built = documentFromModel(twin, SOURCES);
    expect(built.input?.tracks.map((t) => t.key)).toEqual(['same', 'same_2']);
    const secondOverall: EditorModel = {
      ...base,
      rubrics: [must(base.rubrics[0]), { ...must(base.rubrics[0]) }],
    };
    expect(messageAt(secondOverall, 'rubrics.1.name')).toMatch(/one overall rubric/);
  });

  it('contradictory content: an event that ends before it starts, and a date nobody confirmed', () => {
    const base = complete();
    const reversed: EditorModel = {
      ...base,
      dates: { ...base.dates, endsAt: { ...base.dates.endsAt, value: '2026-04-01T09:00' } },
    };
    expect(messageAt(reversed, 'dates.endsAt.value')).toMatch(/cannot end before it starts/);
    const unconfirmed: EditorModel = {
      ...base,
      dates: { ...base.dates, startsAt: { ...base.dates.startsAt, basis: 'unverified' } },
    };
    const built = documentFromModel(unconfirmed, SOURCES);
    expect(built.input).toBeNull();
    expect(built.issues.find((i) => i.field === 'dates.startsAt.basis')?.message).toMatch(
      /marked official or an interpretation/,
    );
  });

  it('no assumption is silently promoted to an official rule: "official" needs an OFFICIAL source; guidance is never official; official criteria need the rubric source', () => {
    const base = blankModel();
    const noSource: EditorModel = {
      ...base,
      rules: [{ statement: 'Teams of 4 only.', basis: 'official', sourceIds: [] }],
    };
    expect(messageAt(noSource, 'rules.0.sources')).toMatch(
      /Nothing is treated as official without a source/,
    );
    const wrongAuthority: EditorModel = {
      ...base,
      rules: [{ statement: 'Teams of 4 only.', basis: 'official', sourceIds: [NOTES] }],
    };
    expect(fields(wrongAuthority)).toContain('rules.0.sources');
    const officialGuidance: EditorModel = {
      ...base,
      guidance: [{ statement: 'Be kind.', basis: 'official', sourceIds: [RULES] }],
    };
    expect(fields(officialGuidance)).toContain('guidance.0.basis');
    const guessedRubric: EditorModel = {
      ...complete(),
      rubrics: [{ ...must(complete().rubrics[0]), sourceIds: [NOTES] }],
    };
    expect(messageAt(guessedRubric, 'rubrics.0.sources')).toMatch(/never invented/);
    // an interpretation may cite anything and stays an interpretation
    expect(
      fields({
        ...base,
        rules: [{ statement: 'Likely five members.', basis: 'interpreted', sourceIds: [] }],
      }),
    ).toEqual([]);
  });

  it('an empty list row must be written or removed, and the prior-work stance must match its basis', () => {
    const base = blankModel();
    expect(
      documentFromModel(
        { ...base, rules: [{ statement: '  ', basis: 'official', sourceIds: [RULES] }] },
        SOURCES,
      ).input,
    ).toBeNull();
    expect(
      fields({
        ...base,
        priorWork: {
          statement: 'Disclose prior work.',
          basis: 'official',
          sourceIds: [RULES],
          stance: 'unclear',
        },
      }),
    ).toContain('priorWork.stance');
    expect(
      fields({
        ...base,
        priorWork: {
          statement: 'Maybe disclose.',
          basis: 'unverified',
          sourceIds: [],
          stance: 'allowed',
        },
      }),
    ).toContain('priorWork.stance');
  });
});

describe('what the API reports is mapped to the same fields', () => {
  it.each([
    ['rubrics[0].criteria[1].weight', 'rubrics.0.criteria.1.weightPct'],
    ['submissionRequirements[2].trackKey', 'requirements.2.trackKey'],
    ['organizerGuidance[0].sourceIds', 'guidance.0.sources'],
    ['priorWorkPolicy', 'priorWork'],
    ['document.rules.3.statement', 'rules.3.statement'],
    ['dates.endsAt', 'dates.endsAt'],
    ['document', 'form'],
  ])('%s -> %s', (path, field) => {
    expect(fieldOfServerPath(path)).toBe(field);
  });
});
