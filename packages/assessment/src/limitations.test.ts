import { describe, expect, it } from 'vitest';
import { collectLimitations, unassessedTrackRubrics } from './limitations.js';
import { buildPassages } from './windowing.js';
import { artifact, lockedSnapshot } from './testing/world.js';

describe('limitations', () => {
  it('discloses sampling, fidelity downgrades, rejected items and dropped relations with counts and handles only', () => {
    const lines = Array.from(
      { length: 300 },
      (_, i) => `line ${String(i)} with enough text to fill the statement budget`,
    ).join('\n');
    const windowing = buildPassages(
      [
        artifact({
          sourceType: 'devpost',
          key: 'submission.txt',
          kind: 'submission_text',
          text: lines,
        }),
      ],
      {
        statement: 2_000,
        source: 1,
        metadata: 1,
      },
    );
    const limitations = collectLimitations({
      windowing,
      fidelity: [
        { handle: 'C-002', disposition: 'paraphrase_replaced_by_verbatim' },
        { handle: 'C-004', disposition: 'claim_dropped_unfaithful' },
        { handle: 'E-007', disposition: 'evidence_text_replaced_by_verbatim' },
        { handle: 'E-009', disposition: 'evidence_dropped_unfaithful' },
        { handle: 'C-001', disposition: 'exact_text' },
        { handle: 'C-003', disposition: 'paraphrase_reviewed_faithful' },
      ],
      rejections: [
        { gate: 'G1', code: 'quote_not_found', index: 0 },
        { gate: 'G1', code: 'quote_not_found', index: 3 },
        { gate: 'G4', code: 'accusatory_language', index: 1 },
        { gate: 'G5', code: 'unknown_claim', index: 0 },
      ],
      droppedRelations: [
        {
          pair: 'X-002',
          identity: 'a'.repeat(64),
          reason: 'verifier_unrelated',
          relation: {
            claim: 'C-001',
            evidence: 'E-001',
            type: 'supports',
            basis: 'independent_observation',
          },
        },
      ],
      locked: lockedSnapshot(),
    });
    expect(limitations.map((l) => [l.code, l.count, l.subjects])).toEqual([
      ['source_sampled', 1, ['statement']],
      ['documentation_partially_seen', 1, ['submission.txt']],
      ['item_rejected', 2, ['G1:quote_not_found']],
      ['paraphrase_replaced_by_verbatim', 1, ['C-002']],
      ['claim_dropped_unfaithful', 1, ['C-004']],
      ['evidence_text_replaced_by_verbatim', 1, ['E-007']],
      ['evidence_dropped_unfaithful', 1, ['E-009']],
      ['relation_dropped_by_verifier', 1, ['X-002']],
      ['contradiction_rejected', 1, ['accusatory_language']],
      ['unknown_rejected', 1, ['unknown_claim']],
    ]);
  });

  it('lists official track rubrics as not assessed (overall target only) and never merges them', () => {
    const locked = lockedSnapshot();
    const withTrack = {
      ...locked,
      document: {
        ...locked.document,
        rubrics: [
          ...locked.document.rubrics,
          {
            ...(locked.document.rubrics[0] ??
              (() => {
                throw new Error('fixture');
              })()),
            scope: 'track' as const,
            trackKey: 'health',
            name: 'Health track rubric',
          },
        ],
      },
    };
    expect(unassessedTrackRubrics(withTrack)).toEqual(['Health track rubric']);
    expect(collectLimitations({ locked: withTrack }).map((l) => [l.code, l.subjects])).toEqual([
      ['official_track_rubrics_not_assessed', ['Health track rubric']],
    ]);
  });

  it('names the coverage gaps of a repository the budget could not hold, with bounded subjects and the true count', () => {
    const files = Array.from(
      { length: 40 },
      (_, i) => `packages/pkg-${String(i).padStart(2, '0')}/src/index.ts`,
    );
    const lines = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `export const ${tag}_${String(i)} = ${String(i)};`).join(
        '\n',
      );
    const windowing = buildPassages(
      files.map((path) =>
        artifact({
          sourceType: 'github',
          key: `files/${path}`,
          kind: 'file',
          mediaType: 'text/plain',
          text: lines(300, path.replace(/\W/g, '_')),
        }),
      ),
      { statement: 1_000, source: 24_000, metadata: 1_000 },
    );
    const byCode = new Map(collectLimitations({ windowing }).map((l) => [l.code, l]));
    const unseen = byCode.get('implementation_components_unseen');
    // 24,000 code points hold a 1,200-code-point head of each of 20 packages; the other 20 are named as not seen
    expect(unseen?.count).toBe(20);
    expect(unseen?.subjects.length).toBeLessThanOrEqual(25);
    expect(byCode.has('implementation_partially_seen')).toBe(true);
    // 20,000 of ~700,000 code points were inspected (< 5 %): the verdict is the refusal, not "partial"
    expect(windowing.coverage.verdict).toBe('insufficient');
    for (const limitation of byCode.values()) {
      expect(JSON.stringify(limitation)).not.toContain('export const');
    }
  });

  it('bounds the subjects to 25 but keeps the true count when more components were not seen', () => {
    const lines = (tag: string) =>
      Array.from(
        { length: 100 },
        (_, i) => `export const ${tag}_${String(i)} = ${String(i)};`,
      ).join('\n');
    const files = Array.from(
      { length: 60 },
      (_, i) => `packages/pkg-${String(i).padStart(2, '0')}/src/index.ts`,
    );
    const windowing = buildPassages(
      files.map((path) =>
        artifact({
          sourceType: 'github',
          key: `files/${path}`,
          kind: 'file',
          mediaType: 'text/plain',
          text: lines(path.replace(/\W/g, '_')),
        }),
      ),
      { statement: 1_000, source: 20_000, metadata: 1_000 },
    );
    const unseen = collectLimitations({ windowing }).find(
      (l) => l.code === 'implementation_components_unseen',
    );
    expect(unseen?.count).toBeGreaterThan(25);
    expect(unseen?.subjects).toHaveLength(25);
    expect([...(unseen?.subjects ?? [])].sort()).toEqual(unseen?.subjects);
  });

  it('states a partial capture from the pinned snapshots themselves, whatever the selection did and whatever any model said', () => {
    const limitations = collectLimitations({
      snapshots: [
        {
          sourceType: 'github',
          status: 'partial',
          partialReasons: ['file_count_limit', 'commit_limit'],
        },
        { sourceType: 'devpost', status: 'captured', partialReasons: [] },
      ],
    });
    expect(limitations).toEqual([
      { code: 'partial_capture', count: 1, subjects: ['github:commit_limit+file_count_limit'] },
    ]);
    expect(
      collectLimitations({
        snapshots: [{ sourceType: 'github', status: 'captured', partialReasons: [] }],
      }),
    ).toEqual([]);
  });

  it('lists the components that were not inspected largest first, so the omitted core is not hidden behind the alphabet', () => {
    const lines = (tag: string, n: number) =>
      Array.from({ length: n }, (_, i) => `export const ${tag}_${String(i)} = ${String(i)};`).join(
        '\n',
      );
    const files = [
      ['packages/aaa-small', 20],
      ['packages/zzz-huge', 3_000],
      ['packages/mmm-mid', 400],
    ] as const;
    const windowing = buildPassages(
      files.map(([dir, n]) =>
        artifact({
          sourceType: 'github',
          key: `files/${dir}/src/index.ts`,
          kind: 'file',
          mediaType: 'text/plain',
          text: lines(dir.replace(/\W/g, '_'), n),
        }),
      ),
      { statement: 1_000, source: 2_000, metadata: 1_000 },
    );
    const unseen = collectLimitations({ windowing }).find(
      (l) => l.code === 'implementation_components_unseen',
    );
    expect(unseen?.subjects[0]).toBe('packages/zzz-huge');
  });

  it('is empty when nothing was lost', () => {
    expect(collectLimitations({})).toEqual([]);
  });
});
