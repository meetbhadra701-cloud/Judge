import { lockedContentHash } from '@judge-copilot/context';
import type { EventContextLockedSnapshot } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { createTrustedScoringContext } from '../context.js';
import { scoreProject } from '../engine.js';
import {
  baseWorld,
  cite,
  devpostEvidence,
  EVENT_ID,
  lockedSnapshot,
  makeContext,
  OTHER_EVENT_ID,
  payload,
  rubricDefinition,
  scored,
  uid,
  VERSION_ID,
} from '../testing/builders.js';
import { denormalizeScore, normalizeScore } from '../dimension.js';
import { cmp, fromNumber } from '../rational.js';
import { validateLockedSnapshot } from './locked.js';
import { validateOfficialScale } from './scale.js';

/*
 * F3: unsafe official scales are rejected as typed RUBRIC_INVALID before any normalization.
 * F4: the locked Event Context snapshot is validated structurally (and only structurally).
 */

const create = (locked: unknown) =>
  createTrustedScoringContext({
    ...baseWorld().build(),
    locked: locked as EventContextLockedSnapshot,
    target: { kind: 'overall' },
    declaredTrackKeys: [],
  });

const withScale = (scaleMin: number, scaleMax: number) =>
  lockedSnapshot({
    rubrics: [rubricDefinition({ scaleMin, scaleMax, criteria: [{ key: 'a', weight: 1 }] })],
  });

describe('F3: the official-scale policy', () => {
  it.each([
    ['-1e308 .. +1e308 (the range overflows)', -1e308, 1e308],
    ['0 .. 1e308', 0, 1e308],
    ['0 .. 1e-320 (subnormal spacing)', 0, 1e-320],
    ['0 .. 5e-324 (the smallest double)', 0, 5e-324],
    ['0 .. 0.001 (range below 0.01)', 0, 0.001],
    ['0 .. 1,000,001 (beyond the magnitude limit)', 0, 1_000_001],
    ['-1,000,001 .. 0', -1_000_001, 0],
    ['equal endpoints', 5, 5],
    ['inverted endpoints', 10, 0],
  ])('rejects %s as RUBRIC_INVALID, before any scoring', (_name, min, max) => {
    const result = create(withScale(min, max));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((issue) => issue.code === 'RUBRIC_INVALID')).toBe(true);
    expect(result.issues[0]?.path).toBe('rubric.scale');
  });

  it.each([
    ['0-10', 0, 10],
    ['1-5', 1, 5],
    ['0-100', 0, 100],
    ['-5..5', -5, 5],
    ['0-1', 0, 1],
    ['0-0.01 (the smallest allowed range)', 0, 0.01],
    ['-1e6..1e6 (the widest allowed)', -1_000_000, 1_000_000],
  ])('accepts the safe scale %s and scores its endpoints without error', (_name, min, max) => {
    const g = baseWorld();
    const dev = devpostEvidence(g, uid(1, 'e9000001'));
    const rubric = rubricDefinition({
      scaleMin: min,
      scaleMax: max,
      criteria: [{ key: 'a', weight: 1 }],
    });
    const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }));
    for (const [value, score10] of [
      [min, 0],
      [max, 10],
    ] as const) {
      const result = scoreProject(ctx, payload(scored('official.a', value, cite(dev))));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.overall).toMatchObject({ score10, scoreOnScale: value });
      }
    }
  });

  it('the full normalize/denormalize path round-trips exactly on every accepted scale', () => {
    for (const [min, max] of [
      [0, 10],
      [1, 5],
      [0, 100],
      [-5, 5],
      [0, 0.01],
      [-1_000_000, 1_000_000],
      [0.5, 3.7],
    ] as const) {
      expect(validateOfficialScale(min, max)).toBeNull();
      const scale = { min, max };
      for (const fraction of [0, 0.25, 0.5, 1]) {
        const x = fromNumber(min + (max - min) * fraction);
        const there = normalizeScore(x, scale);
        // x was computed in floating point, so compare the round trip of the EXACT normalized value.
        expect(cmp(denormalizeScore(there, scale), x)).toBe(0);
      }
      expect(cmp(normalizeScore(fromNumber(min), scale), fromNumber(0))).toBe(0);
      expect(cmp(normalizeScore(fromNumber(max), scale), fromNumber(10))).toBe(0);
    }
  });

  it('validateOfficialScale never throws, whatever it is given', () => {
    for (const [min, max] of [
      [Number.NaN, 1],
      [0, Number.POSITIVE_INFINITY],
      ['0', 1],
      [null, undefined],
      [0n, 1n],
    ] as const) {
      expect(typeof validateOfficialScale(min, max)).toBe('string');
    }
  });
});

describe('F4: locked Event Context validation is structural and typed', () => {
  const good = () => lockedSnapshot({ rubrics: [] });

  it('accepts a well-formed locked snapshot and returns a COPY', () => {
    const original = good();
    const result = validateLockedSnapshot(original, EVENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locked).toEqual(original);
    expect(result.locked).not.toBe(original);
    expect(result.locked.document).not.toBe(original.document);
  });

  it('a snapshot mutated after the context was created changes nothing', () => {
    const original = lockedSnapshot({
      rubrics: [rubricDefinition({ criteria: [{ key: 'a', weight: 1 }] })],
    });
    const g = baseWorld();
    const dev = devpostEvidence(g, uid(1, 'e9000002'));
    const ctx = makeContext(g.build(), original);
    const run = () => scoreProject(ctx, payload(scored('official.a', 6, cite(dev))));
    const before = run();
    const [rubric] = original.document.rubrics;
    if (!rubric?.criteria[0]) throw new Error('fixture');
    rubric.scaleMax = 100;
    rubric.criteria[0].weight = 0.25;
    original.lockedContentHash = 'f'.repeat(64);
    const after = run();
    expect(before.ok && after.ok && after.report.outputHash === before.report.outputHash).toBe(
      true,
    );
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['a string', 'locked'],
    ['an array', []],
  ])('rejects %s with LOCKED_CONTEXT_INVALID and no exception', (_name, value) => {
    const result = create(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((issue) => issue.code === 'LOCKED_CONTEXT_INVALID')).toBe(true);
    }
  });

  it.each([
    ['a superseded version', { status: 'superseded' }],
    ['a draft status', { status: 'draft' }],
    ['an in_review status', { status: 'in_review' }],
    ['a missing status', { status: undefined }],
    ['a malformed version id', { versionId: 'not-a-uuid' }],
    ['a malformed event id', { eventId: '123' }],
    ['version 0', { version: 0 }],
    ['a negative version', { version: -3 }],
    ['a fractional version', { version: 1.5 }],
    ['a short content hash', { lockedContentHash: 'abc' }],
    ['an uppercase content hash', { lockedContentHash: 'A'.repeat(64) }],
    ['a non-hex content hash', { lockedContentHash: 'z'.repeat(64) }],
    ['an invalid lockedAt', { lockedAt: 'yesterday' }],
    ['a malformed supersedesId', { supersedesId: 'xx' }],
  ])('rejects %s as LOCKED_CONTEXT_INVALID', (_name, override) => {
    const result = create({ ...good(), ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.every((issue) => issue.code === 'LOCKED_CONTEXT_INVALID')).toBe(true);
    }
  });

  it('rejects a source that belongs to another version', () => {
    const base = good();
    const sources = [
      {
        id: uid(1, 'c1000001'),
        contextVersionId: uid(2, 'c0000001'), // not VERSION_ID
        sourceType: 'pasted_text' as const,
        authority: 'official_event_rules' as const,
        authorityRank: 1,
        title: 'Rules',
        url: null,
        contentHash: 'a'.repeat(64),
        textLength: 10,
        capturedAt: '2031-04-12T00:00:00.000Z',
        createdAt: '2031-04-12T00:00:00.000Z',
        copiedFromId: null,
      },
    ];
    const hash = lockedContentHash({ document: base.document, sources });
    const result = create({ ...base, sources, lockedContentHash: hash });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(['LOCKED_CONTEXT_INVALID']);
      expect(result.issues[0]?.path).toBe('locked.sources.0.contextVersionId');
    }
    expect(VERSION_ID).not.toBe(uid(2, 'c0000001'));
  });

  it('rejects another event and a tampered document as LOCKED_CONTEXT_MISMATCH', () => {
    const otherEvent = create(lockedSnapshot({ eventId: OTHER_EVENT_ID }));
    expect(otherEvent.ok).toBe(false);
    if (!otherEvent.ok)
      expect(otherEvent.issues.map((i) => i.code)).toEqual(['LOCKED_CONTEXT_MISMATCH']);

    const tampered = create(lockedSnapshot({ tamper: true }));
    expect(tampered.ok).toBe(false);
    if (!tampered.ok)
      expect(tampered.issues.map((i) => i.code)).toEqual(['LOCKED_CONTEXT_MISMATCH']);
  });

  it('LIMITATION (documented): a self-consistent forged snapshot passes the structural checks', () => {
    // Someone who can write the document can recompute its hash. The engine cannot tell; the trusted
    // database adapter (M5) must source the snapshot. See docs/SECURITY.md §15.
    const forgedRubric = rubricDefinition({ criteria: [{ key: 'invented', weight: 1 }] });
    const forged = lockedSnapshot({ rubrics: [forgedRubric] });
    const result = create(forged);
    expect(result.ok).toBe(true);
  });
});
