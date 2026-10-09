import { sliceCodePoints } from '@judge-copilot/evidence';
import { describe, expect, it } from 'vitest';
import { artifact, hydroTrackArtifacts, seeded } from './testing/world.js';
import { codePointCount, isPassageBarrier, toCodePoints } from './text.js';
import {
  artifactLabel,
  buildPassages,
  compareCodePoints,
  DEFAULT_BUDGETS,
  interpretViews,
  PASSAGE_MAX_CODE_POINTS,
  passageRanges,
  statementViews,
  type Passage,
  type SourceArtifact,
} from './windowing.js';

const only = (text: string) =>
  passageRanges(text).map((r) => toCodePoints(text).slice(r.start, r.end).join(''));

describe('passageRanges: exact slices of the original', () => {
  it('splits on line boundaries and keeps terminators with their lines', () => {
    const text = 'one\ntwo\nthree\n';
    expect(only(text)).toEqual([text]);
  });

  it('never exceeds the maximum and packs whole lines', () => {
    const line = `${'x'.repeat(99)}\n`; // 100 code points
    const text = line.repeat(30); // 3000
    const parts = only(text);
    expect(parts.every((p) => codePointCount(p) <= PASSAGE_MAX_CODE_POINTS)).toBe(true);
    expect(parts.join('')).toBe(text);
    expect(parts.slice(0, -1).every((p) => p.endsWith('\n'))).toBe(true);
  });

  it('cuts an over-long line at a code-point boundary, never inside a surrogate pair', () => {
    const text = '💧'.repeat(2_500);
    const parts = only(text);
    expect(parts.map(codePointCount)).toEqual([1_200, 1_200, 100]);
    expect(parts.join('')).toBe(text);
    for (const part of parts) expect(part).toBe(Array.from(part).join('')); // no lone surrogate was introduced
  });

  it('keeps CRLF together, including when a cut would otherwise fall between CR and LF', () => {
    const body = 'a'.repeat(1_199);
    const text = `${body}\r\n${'b'.repeat(10)}`;
    const points = toCodePoints(text);
    const ranges = passageRanges(text);
    expect(ranges.length).toBeGreaterThan(1);
    for (const r of ranges) {
      // no passage ends between a CR and its LF, and none starts with the LF of a CRLF
      expect(points[r.end - 1] === '\r' && points[r.end] === '\n').toBe(false);
      expect(points[r.start] === '\n' && points[r.start - 1] === '\r').toBe(false);
    }
    expect(only(text).join('')).toBe(text);
  });

  it('treats a lone CR as a line terminator and keeps it', () => {
    const text = 'first line\rsecond line\rthird';
    expect(only(text)).toEqual([text]);
    // a long text of CR-terminated lines is packed on those boundaries
    const long = 'abcdefghi\r'.repeat(200);
    const parts = only(long);
    expect(parts.join('')).toBe(long);
    expect(parts.slice(0, -1).every((p) => p.endsWith('\r'))).toBe(true);
  });

  it('excludes barrier characters, which separate passages, while offsets stay those of the original', () => {
    const text = 'before the escape\u001Bafter the escape';
    const ranges = passageRanges(text);
    expect(ranges).toEqual([
      { start: 0, end: 17 },
      { start: 18, end: 34 },
    ]);
    const points = toCodePoints(text);
    expect(points[17]).toBe('\u001B');
    for (const r of ranges) {
      expect(points.slice(r.start, r.end).some((p) => isPassageBarrier(p))).toBe(false);
    }
  });

  it('drops passages with no visible character but keeps later offsets', () => {
    const text = '   \n\t\n\u001Bvisible words here\n';
    const ranges = passageRanges(text);
    expect(ranges).toHaveLength(1);
    expect(toCodePoints(text).slice(ranges[0]?.start, ranges[0]?.end).join('')).toBe(
      'visible words here\n',
    );
  });

  it('handles empty and barrier-only text', () => {
    expect(passageRanges('')).toEqual([]);
    expect(passageRanges('\u0000\u0001\u0002')).toEqual([]);
  });

  it('is deterministic and the ranges are disjoint, ordered and in bounds (seeded property)', () => {
    const alphabet = [
      'a',
      'b',
      ' ',
      '\n',
      '\r',
      '\r\n',
      '💧',
      'é',
      '́',
      '\u001B',
      '\t',
      'xxxxxxxxxxxx',
    ];
    for (let seed = 1; seed <= 60; seed += 1) {
      const next = seeded(seed);
      let text = '';
      const pieces = 1 + Math.floor(next() * 900);
      for (let i = 0; i < pieces; i += 1)
        text += alphabet[Math.floor(next() * alphabet.length)] ?? '';
      const first = passageRanges(text);
      expect(passageRanges(text)).toEqual(first);
      const total = codePointCount(text);
      let previousEnd = 0;
      for (const r of first) {
        expect(r.start).toBeGreaterThanOrEqual(previousEnd);
        expect(r.end).toBeGreaterThan(r.start);
        expect(r.end - r.start).toBeLessThanOrEqual(PASSAGE_MAX_CODE_POINTS);
        expect(r.end).toBeLessThanOrEqual(total);
        previousEnd = r.end;
      }
    }
  });
});

describe('passage coverage (independent reference)', () => {
  it('every code point is in exactly one passage, is a barrier, or is whitespace in a dropped blank run (seeded property)', () => {
    const alphabet = [
      'a',
      'bb',
      ' ',
      '\n',
      '\r',
      '\r\n',
      '💧',
      'é',
      '\u0301',
      '\u001B',
      '\t',
      '\u0000',
      'xxxxxxxxxxxx',
      '\u00A0',
    ];
    for (let seed = 1; seed <= 80; seed += 1) {
      const next = seeded(seed * 104729);
      let text = '';
      const pieces = 1 + Math.floor(next() * 700);
      for (let i = 0; i < pieces; i += 1)
        text += alphabet[Math.floor(next() * alphabet.length)] ?? '';
      const points = toCodePoints(text);
      const covered = new Array<number>(points.length).fill(0);
      for (const r of passageRanges(text))
        for (let i = r.start; i < r.end; i += 1) covered[i] = (covered[i] ?? 0) + 1;
      points.forEach((point, index) => {
        const count = covered[index] ?? 0;
        if (isPassageBarrier(point)) {
          expect(count, `barrier at ${String(index)}`).toBe(0);
        } else if (count === 0) {
          // not shown: it must belong to a run that has no visible character at all
          expect(
            /^\s$/u.test(point),
            `dropped non-blank ${JSON.stringify(point)} at ${String(index)} (seed ${String(seed)})`,
          ).toBe(true);
        } else {
          expect(count).toBe(1);
        }
      });
    }
  });
});

describe('buildPassages', () => {
  const build = (artifacts: readonly SourceArtifact[]) => buildPassages(artifacts);

  it('gives every passage the exact original text at its offsets (the exact-slice invariant)', () => {
    const artifacts = hydroTrackArtifacts();
    const { passages } = build(artifacts);
    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages) {
      const source = artifacts.find((a) => a.artifactId === passage.artifactId);
      expect(source).toBeDefined();
      expect(sliceCodePoints(source?.text ?? '', passage.start, passage.end)).toBe(passage.text);
    }
  });

  it('assigns handles P-0001... in final order, independent of input order (seeded permutations)', () => {
    const base = hydroTrackArtifacts();
    const expected = build(base);
    for (let seed = 1; seed <= 25; seed += 1) {
      const next = seeded(seed);
      const shuffled = [...base].sort(() => next() - 0.5);
      const result = build(shuffled);
      expect(result.passages.map((p) => [p.handle, p.artifactKey, p.start, p.end])).toEqual(
        expected.passages.map((p) => [p.handle, p.artifactKey, p.start, p.end]),
      );
      expect(result.omissions).toEqual(expected.omissions);
    }
    expect(expected.passages.map((p) => p.handle)).toEqual(
      expected.passages.map((_, i) => `P-${String(i + 1).padStart(4, '0')}`),
    );
  });

  it('does not depend on random ids: only the key order and content decide the handles', () => {
    const a = hydroTrackArtifacts();
    const b = hydroTrackArtifacts().map((x, i) => ({
      ...x,
      artifactId: `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    expect(build(a).passages.map((p) => [p.handle, p.artifactKey, p.text])).toEqual(
      build(b).passages.map((p) => [p.handle, p.artifactKey, p.text]),
    );
  });

  it('routes statements and interpretations, and records every skipped artifact with a reason', () => {
    const artifacts = [
      ...hydroTrackArtifacts(),
      artifact({
        sourceType: 'github',
        key: 'commits.json',
        kind: 'commit_history',
        mediaType: 'application/json',
        text: '{"commits":["fix"]}',
      }),
      artifact({
        sourceType: 'github',
        key: 'tree.json',
        kind: 'tree',
        mediaType: 'application/json',
        text: '{"entries":[]}',
      }),
      artifact({
        sourceType: 'github',
        key: 'omissions.json',
        kind: 'omissions',
        mediaType: 'application/json',
        text: '{"omitted":[]}',
      }),
      artifact({
        sourceType: 'devpost',
        key: 'submission.json',
        kind: 'submission',
        mediaType: 'application/json',
        text: '{"title":"x"}',
      }),
    ];
    const { passages, omissions } = build(artifacts);
    const statementKeys = new Set(
      passages.filter((p) => p.route === 'statement').map((p) => p.artifactKey),
    );
    const interpretKeys = new Set(
      passages.filter((p) => p.route === 'interpret').map((p) => p.artifactKey),
    );
    expect([...statementKeys].sort()).toEqual(['files/README.md', 'page.txt', 'submission.txt']);
    expect([...interpretKeys].sort()).toEqual(['files/src/intake.ts', 'response.json']);
    expect(omissions.map((o) => [o.artifactKey, o.reason]).sort()).toEqual([
      ['commits.json', 'commit_history_not_routed'],
      ['omissions.json', 'code_authored_source_gap'],
      ['submission.json', 'duplicate_structured_form'],
      ['tree.json', 'listing_only'],
    ]);
  });

  it('omits snapshots that are not content-bearing, with a reason', () => {
    const artifacts = [
      ...hydroTrackArtifacts(),
      artifact({
        sourceType: 'video',
        key: 'metadata.json',
        kind: 'video_metadata',
        snapshotStatus: 'failed',
        text: '{"title":"demo video"}',
      }),
    ];
    const { passages, omissions } = build(artifacts);
    expect(passages.some((p) => p.sourceType === 'video')).toBe(false);
    expect(omissions.find((o) => o.sourceType === 'video')?.reason).toBe(
      'snapshot_not_content_bearing',
    );
  });

  it('orders by priority class: Devpost, README, deployment, video, metadata, then source', () => {
    const { passages } = build([
      ...hydroTrackArtifacts(),
      artifact({
        sourceType: 'video',
        key: 'metadata.json',
        kind: 'video_metadata',
        mediaType: 'application/json',
        text: '{"title":"HydroTrack demo video"}',
      }),
    ]);
    const order = [...new Set(passages.map((p) => p.artifactKey))];
    expect(order).toEqual([
      'submission.txt',
      'files/README.md',
      'page.txt',
      'response.json',
      'metadata.json',
      'files/src/intake.ts',
    ]);
  });

  it('orders repository source by manifest, entry points, then round-robin over top-level directories', () => {
    const file = (path: string, text = `// ${path}\nexport const value = 1;\n`) =>
      artifact({ sourceType: 'github', key: `files/${path}`, text });
    const artifacts = [
      file('zeta/deep/z.ts'),
      file('alpha/a2.ts'),
      file('alpha/a1.ts'),
      file('src/index.ts'),
      file('beta/b1.ts'),
      file('lib/util.ts'),
      artifact({
        sourceType: 'github',
        key: 'files/package.json',
        mediaType: 'application/json',
        text: '{"name":"x","main":"lib/util.ts"}',
      }),
      file('top.ts'),
    ];
    const order = [...new Set(build(artifacts).passages.map((p) => p.artifactKey))];
    expect(order).toEqual([
      'files/package.json', // manifest
      'files/lib/util.ts', // declared entry point (package.json main)
      'files/src/index.ts', // conventional entry
      // round-robin across top-level directories: '' (root), alpha, beta, zeta
      'files/top.ts',
      'files/alpha/a1.ts',
      'files/beta/b1.ts',
      'files/zeta/deep/z.ts',
      'files/alpha/a2.ts',
    ]);
  });

  it('is not influenced by size: a huge file does not outrank a small one', () => {
    const small = artifact({
      sourceType: 'github',
      key: 'files/a/small.ts',
      text: 'export const a = 1;\n',
    });
    const huge = artifact({
      sourceType: 'github',
      key: 'files/b/huge.ts',
      text: 'export const filler = 1;\n'.repeat(2_000),
    });
    const order = [...new Set(build([huge, small]).passages.map((p) => p.artifactKey))];
    expect(order).toEqual(['files/a/small.ts', 'files/b/huge.ts']);
  });

  it('enforces bucket budgets, records what was omitted and marks sampling', () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `line ${String(i)} of the prose that fills the budget`,
    ).join('\n');
    const artifacts = [
      artifact({
        sourceType: 'devpost',
        key: 'submission.txt',
        kind: 'submission_text',
        text: lines,
      }),
    ];
    const small = buildPassages(artifacts, { statement: 5_000, source: 1, metadata: 1 });
    const shown = small.passages.reduce((sum, p) => sum + codePointCount(p.text), 0);
    expect(shown).toBeLessThanOrEqual(5_000);
    expect(small.buckets.find((b) => b.bucket === 'statement')?.sampled).toBe(true);
    expect(
      small.omissions.some(
        (o) => o.reason === 'budget_exhausted' && o.artifactKey === 'submission.txt',
      ),
    ).toBe(true);
    const full = buildPassages(artifacts, DEFAULT_BUDGETS);
    expect(full.buckets.find((b) => b.bucket === 'statement')?.sampled).toBe(false);
    expect(full.omissions).toEqual([]);
  });

  it('keeps CRLF and lone CR text byte-exact in passages', () => {
    const crlf = 'First line of the readme.\r\nSecond line of the readme.\r\n';
    const cr = 'Old mac line one here.\rOld mac line two here.\r';
    const result = build([
      artifact({
        sourceType: 'devpost',
        key: 'submission.txt',
        kind: 'submission_text',
        text: crlf,
      }),
      artifact({
        sourceType: 'github',
        key: 'files/NOTES.md',
        mediaType: 'text/markdown',
        text: cr,
      }),
    ]);
    expect(result.passages.map((p) => p.text)).toEqual([crlf, cr]);
  });

  it('exposes plain views in the shape the prompts take', () => {
    const { passages } = build(hydroTrackArtifacts());
    const statements = statementViews(passages);
    const interpretations = interpretViews(passages);
    expect(statements.length + interpretations.length).toBe(passages.length);
    for (const v of interpretations)
      expect(['source_code', 'repository_metadata', 'deployment_observation']).toContain(
        v.artifactClass,
      );
    expect(Object.keys(statements[0] ?? {}).sort()).toEqual([
      'artifact',
      'handle',
      'sourceType',
      'text',
    ]);
  });
});

describe('helpers', () => {
  it('compares by code point, not UTF-16 unit', () => {
    // U+1F4A7 (astral) sorts AFTER U+FF5E (BMP, full-width) by code point, but BEFORE it by UTF-16 code unit.
    expect(compareCodePoints('～', '💧')).toBe(-1);
    const byCodeUnit = (a: string, b: string) => a < b;
    expect(byCodeUnit('\uFF5E', '💧')).toBe(false);
    expect(compareCodePoints('a', 'a')).toBe(0);
    expect(compareCodePoints('a', 'ab')).toBe(-1);
  });
  it('shortens an over-long label deterministically', () => {
    const key = `files/${'d/'.repeat(300)}x.ts`;
    const label = artifactLabel(key);
    expect(codePointCount(label)).toBe(200);
    expect(artifactLabel(key)).toBe(label);
    expect(artifactLabel('files/a.ts')).toBe('files/a.ts');
  });
});

export type { Passage };
