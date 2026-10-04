import type { EventContextDocumentInput } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import {
  applyHumanEdit,
  documentFromExtraction,
  EventContextError,
  listUnresolved,
  type EventContextErrorCode,
} from './index.js';
import {
  JUDGE_ID,
  OTHER_EVENT_SOURCE_ID,
  RUBRIC_ID,
  RULES_ID,
  sampleExtraction,
  sampleSources,
  sequentialIds,
} from './testing/sample.js';

function expectCode(fn: () => unknown, code: EventContextErrorCode): EventContextError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EventContextError);
    expect((error as EventContextError).code).toBe(code);
    return error as EventContextError;
  }
  throw new Error(`expected ${code}`);
}

/** The stored document converted back to an edit request, as the UI round-trips it. */
function asInput(document: ReturnType<typeof documentFromExtraction>): EventContextDocumentInput {
  return structuredClone(document);
}

describe('documentFromExtraction', () => {
  it('assigns server IDs and marks every item source-derived and unmodified', () => {
    const document = documentFromExtraction(sampleExtraction(), {
      sources: sampleSources(),
      newId: sequentialIds(),
    });
    expect(document.rules[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000006',
      origin: 'source_derived',
      humanModified: false,
      sourceIds: [RULES_ID],
    });
    expect(document.rubrics[0]?.criteria.map((criterion) => criterion.origin)).toEqual([
      'source_derived',
      'source_derived',
    ]);
    expect(document.dates.startsAt.value).toBe('2031-04-12T09:00:00.000Z');
  });

  it('resolves conflicts by authority while keeping the losing position', () => {
    const document = documentFromExtraction(
      sampleExtraction({
        conflicts: [
          {
            topic: 'Prior work',
            description: 'Official rule vs judge note.',
            positions: [
              { sourceId: JUDGE_ID, statement: 'Projects should be new.' },
              { sourceId: RULES_ID, statement: 'Pre-existing code is allowed.' },
            ],
          },
        ],
      }),
      { sources: sampleSources() },
    );
    const [conflict] = document.conflicts;
    expect(conflict?.resolution).toEqual({
      status: 'resolved_by_authority',
      prevailingSourceIds: [RULES_ID],
      note: null,
    });
    expect(conflict?.positions.map((position) => position.sourceId)).toEqual([JUDGE_ID, RULES_ID]);
    expect(listUnresolved(document).some((item) => item.kind === 'unresolved_conflict')).toBe(
      false,
    );
  });

  it('rejects references to sources outside the version (no invented provenance)', () => {
    expectCode(
      () =>
        documentFromExtraction(
          sampleExtraction({
            rules: [{ statement: 'x', certainty: 'explicit', sourceIds: [OTHER_EVENT_SOURCE_ID] }],
          }),
          { sources: sampleSources() },
        ),
      'UNKNOWN_SOURCE_REFERENCE',
    );
  });

  it('rejects a non-unclear source-derived fact without provenance', () => {
    expectCode(
      () =>
        documentFromExtraction(
          sampleExtraction({
            rules: [{ statement: 'Unsourced.', certainty: 'explicit', sourceIds: [] }],
          }),
          { sources: sampleSources() },
        ),
      'MISSING_PROVENANCE',
    );
  });

  it('preserves ambiguity: an unclear fact needs no source and is listed as unresolved', () => {
    const document = documentFromExtraction(
      sampleExtraction({
        priorWorkPolicy: {
          statement: 'The rules do not mention prior work.',
          certainty: 'unclear',
          sourceIds: [],
          stance: 'unclear',
        },
      }),
      { sources: sampleSources() },
    );
    expect(document.priorWorkPolicy.stance).toBe('unclear');
    expect(listUnresolved(document).map((item) => item.path)).toContain('priorWorkPolicy');
  });

  it('rejects duplicate criterion keys and invalid scales structurally', () => {
    const [rubric] = sampleExtraction().rubrics;
    if (!rubric) throw new Error('fixture');
    const [criterion] = rubric.criteria;
    if (!criterion) throw new Error('fixture');
    expectCode(
      () =>
        documentFromExtraction(
          sampleExtraction({ rubrics: [{ ...rubric, criteria: [criterion, { ...criterion }] }] }),
          { sources: sampleSources() },
        ),
      'DUPLICATE_CRITERION_KEY',
    );
    expectCode(
      () =>
        documentFromExtraction(
          sampleExtraction({ rubrics: [{ ...rubric, scaleMin: 5, scaleMax: 5 }] }),
          {
            sources: sampleSources(),
          },
        ),
      'INVALID_RUBRIC_SCALE',
    );
    expectCode(
      () =>
        documentFromExtraction(
          sampleExtraction({
            rubrics: [
              {
                ...rubric,
                criteria: [
                  { ...criterion, anchors: [{ score: 9, description: 'Beyond the scale.' }] },
                ],
              },
            ],
          }),
          { sources: sampleSources() },
        ),
      'INVALID_RUBRIC_SCALE',
    );
  });
});

describe('applyHumanEdit', () => {
  const base = () =>
    documentFromExtraction(sampleExtraction(), {
      sources: sampleSources(),
      newId: sequentialIds(),
    });

  it('keeps source provenance when a human rewords a fact and flags it as human-modified', () => {
    const previous = base();
    const input = asInput(previous);
    input.priorWorkPolicy.statement = 'Pre-existing code is allowed (organizer wording clarified).';

    const { document, changes } = applyHumanEdit(previous, input, { sources: sampleSources() });
    expect(document.priorWorkPolicy).toMatchObject({
      id: previous.priorWorkPolicy.id,
      origin: 'source_derived',
      humanModified: true,
      sourceIds: [RULES_ID],
    });
    expect(changes.modified).toEqual(['priorWorkPolicy']);
    expect(document.rules[0]?.humanModified).toBe(false);
  });

  it('rejects dropping a cited source from a source-derived fact', () => {
    const previous = base();
    const input = asInput(previous);
    input.priorWorkPolicy.sourceIds = [];
    input.priorWorkPolicy.certainty = 'unclear';
    input.priorWorkPolicy.stance = 'unclear';
    expectCode(
      () => applyHumanEdit(previous, input, { sources: sampleSources() }),
      'PROVENANCE_REMOVED',
    );
  });

  it('records new facts as human-origin notes, which may carry no source', () => {
    const previous = base();
    const input = asInput(previous);
    input.organizerGuidance.push({
      statement: 'Head judge note: demos must run on the presenter laptop.',
      certainty: 'explicit',
      sourceIds: [],
    });
    const { document, changes } = applyHumanEdit(previous, input, { sources: sampleSources() });
    expect(document.organizerGuidance[0]).toMatchObject({
      origin: 'human',
      humanModified: false,
      sourceIds: [],
    });
    expect(changes.added).toEqual(['organizerGuidance:new']);
  });

  it('rejects unknown fact ids instead of letting clients mint IDs', () => {
    const previous = base();
    const input = asInput(previous);
    input.rules.push({
      id: '9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f',
      statement: 'Forged.',
      certainty: 'explicit',
      sourceIds: [RULES_ID],
    });
    expectCode(
      () => applyHumanEdit(previous, input, { sources: sampleSources() }),
      'UNKNOWN_FACT_ID',
    );
  });

  it('marks edited rubric criteria as human-modified but keeps their sources', () => {
    const previous = base();
    const input = asInput(previous);
    const criterion = input.rubrics[0]?.criteria[0];
    if (!criterion) throw new Error('fixture');
    criterion.description = 'Depth of the technical implementation.';
    const { document } = applyHumanEdit(previous, input, { sources: sampleSources() });
    expect(document.rubrics[0]?.criteria[0]).toMatchObject({
      humanModified: true,
      origin: 'source_derived',
      sourceIds: [RUBRIC_ID],
    });
    expect(document.rubrics[0]?.criteria[1]?.humanModified).toBe(false);
  });

  it('never lets a human edit erase a source-derived conflict or override authority', () => {
    const previous = documentFromExtraction(
      sampleExtraction({
        conflicts: [
          {
            topic: 'Prior work',
            description: 'Official rule vs judge note.',
            positions: [
              { sourceId: RULES_ID, statement: 'Allowed.' },
              { sourceId: JUDGE_ID, statement: 'Should be new.' },
            ],
          },
        ],
      }),
      { sources: sampleSources() },
    );
    const removed = asInput(previous);
    removed.conflicts = [];
    expectCode(
      () => applyHumanEdit(previous, removed, { sources: sampleSources() }),
      'PROVENANCE_REMOVED',
    );

    const overridden = asInput(previous);
    const [conflict] = overridden.conflicts;
    if (!conflict) throw new Error('fixture');
    conflict.humanResolution = { prevailingSourceIds: [JUDGE_ID], note: 'Prefer new work.' };
    expectCode(
      () => applyHumanEdit(previous, overridden, { sources: sampleSources() }),
      'INVALID_CONFLICT_RESOLUTION',
    );
  });

  it('can author a document by hand from nothing (no extractor)', () => {
    const { document } = applyHumanEdit(null, sampleExtraction(), { sources: sampleSources() });
    expect(document.rules[0]?.origin).toBe('human');
    expect(document.rubrics[0]?.origin).toBe('human');
  });
});
