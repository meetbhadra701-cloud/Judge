import { describe, expect, it } from 'vitest';
import {
  applyHumanEdit,
  documentFromExtraction,
  draftStateFingerprint,
  hasReviewedChanges,
  sourceSetFingerprint,
  type FingerprintSource,
} from './index.js';
import {
  RULES_ID,
  RUBRIC_ID,
  sampleExtraction,
  sampleSources,
  sequentialIds,
} from './testing/sample.js';

const sources: FingerprintSource[] = [
  {
    id: RULES_ID,
    position: 0,
    authority: 'official_event_rules',
    sourceType: 'pasted_text',
    title: 'Rules',
    url: null,
    contentHash: 'a'.repeat(64),
  },
  {
    id: RUBRIC_ID,
    position: 1,
    authority: 'official_judging_rubric',
    sourceType: 'pasted_text',
    title: 'Rubric',
    url: null,
    contentHash: 'b'.repeat(64),
  },
];

describe('sourceSetFingerprint', () => {
  it('is deterministic and independent of input order', () => {
    expect(sourceSetFingerprint(sources)).toBe(sourceSetFingerprint([...sources].reverse()));
    expect(sourceSetFingerprint(sources)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['an added source', [...sources, { ...sources[0], id: 'c', position: 2 } as FingerprintSource]],
    ['a removed source', sources.slice(0, 1)],
    [
      'changed content',
      [
        { ...sources[0], contentHash: 'c'.repeat(64) } as FingerprintSource,
        sources[1] as FingerprintSource,
      ],
    ],
    [
      'a changed authority',
      [
        { ...sources[0], authority: 'judge_context' } as FingerprintSource,
        sources[1] as FingerprintSource,
      ],
    ],
    [
      'a changed position',
      [{ ...sources[0], position: 5 } as FingerprintSource, sources[1] as FingerprintSource],
    ],
  ])('changes for %s', (_label, changed) => {
    expect(sourceSetFingerprint(changed)).not.toBe(sourceSetFingerprint(sources));
  });
});

describe('reviewed-change detection', () => {
  const built = () =>
    documentFromExtraction(sampleExtraction(), {
      sources: sampleSources(),
      newId: sequentialIds(),
    });

  it('treats an untouched build as having no reviewed changes', () => {
    const document = built();
    expect(hasReviewedChanges({ document, extraction: structuredClone(document) })).toBe(false);
    expect(hasReviewedChanges({ document: null, extraction: null })).toBe(false);
  });

  it('detects a document without an extraction baseline (hand-authored or copied)', () => {
    expect(hasReviewedChanges({ document: built(), extraction: null })).toBe(true);
  });

  it('detects any human edit by canonical comparison, not by flags alone', () => {
    const extraction = built();
    const input = structuredClone(extraction);
    input.rules.push({
      statement: 'Head judge note.',
      certainty: 'explicit',
      sourceIds: [],
    } as never);
    const { document } = applyHumanEdit(extraction, input, { sources: sampleSources() });
    expect(hasReviewedChanges({ document, extraction })).toBe(true);
    expect(document.rules.every((rule) => rule.origin === 'human' || !rule.humanModified)).toBe(
      true,
    );
  });

  it('ignores key order: canonically equal documents are not reviewed changes', () => {
    const extraction = built();
    const reKeyed = Object.fromEntries(
      Object.entries(structuredClone(extraction)).reverse(),
    ) as typeof extraction;
    expect(Object.keys(reKeyed)).not.toEqual(Object.keys(extraction));
    expect(hasReviewedChanges({ document: reKeyed, extraction })).toBe(false);
  });

  it('fingerprints the draft document together with its baseline', () => {
    const document = built();
    const fingerprint = draftStateFingerprint({ document, extraction: document });
    expect(
      draftStateFingerprint({ document: structuredClone(document), extraction: document }),
    ).toBe(fingerprint);
    expect(draftStateFingerprint({ document, extraction: null })).not.toBe(fingerprint);
    expect(draftStateFingerprint({ document: null, extraction: null })).not.toBe(fingerprint);
  });
});
