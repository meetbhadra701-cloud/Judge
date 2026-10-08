import { describe, expect, it } from 'vitest';
import { groupByProvenance, type GroupableItem } from './groups.js';
import { seeded, uid } from './testing/builders.js';

const SNAP = uid(1, 'f1000001');
const SNAP2 = uid(2, 'f1000001');
const ART = uid(1, 'f2000001');
const ART2 = uid(2, 'f2000001');
const CTX = uid(1, 'f3000001');

let n = 0;
const item = (
  overrides: Omit<Partial<GroupableItem>, 'span'> & { span?: [number, number] | null },
): GroupableItem => {
  n += 1;
  const { span, ...rest } = overrides;
  return {
    id: uid(n, 'e2000001'),
    strength: 0.6,
    snapshotId: SNAP,
    artifactId: ART,
    span: span ? { start: span[0], end: span[1] } : null,
    contextVersionId: null,
    ...rest,
  };
};

const ids = (groups: ReturnType<typeof groupByProvenance>) => groups.map((g) => g.memberIds);

describe('provenance grouping', () => {
  it('groups records whose spans overlap in the same artifact', () => {
    const a = item({ span: [0, 10] });
    const b = item({ span: [5, 15] });
    const groups = groupByProvenance([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toEqual([a.id, b.id].sort());
  });

  it('keeps disjoint and merely adjacent spans apart (half-open intervals)', () => {
    const a = item({ span: [0, 10] });
    const b = item({ span: [10, 20] });
    const c = item({ span: [30, 40] });
    expect(groupByProvenance([a, b, c])).toHaveLength(3);
  });

  it('treats a record without a span as covering its whole artifact', () => {
    const whole = item({ span: null });
    const part = item({ span: [100, 110] });
    const other = item({ span: [200, 210] });
    expect(groupByProvenance([whole, part, other])).toHaveLength(1);
  });

  it('groups transitively: A~B and B~C is one group even though A and C do not overlap', () => {
    const a = item({ span: [0, 10] });
    const b = item({ span: [8, 20] });
    const c = item({ span: [18, 30] });
    expect(a.span && c.span && a.span.end <= c.span.start).toBe(true);
    const groups = groupByProvenance([c, a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toHaveLength(3);
  });

  it('never merges different artifacts or different snapshots', () => {
    expect(
      groupByProvenance([item({ span: [0, 10] }), item({ artifactId: ART2, span: [0, 10] })]),
    ).toHaveLength(2);
    expect(
      groupByProvenance([item({ span: [0, 10] }), item({ snapshotId: SNAP2, span: [0, 10] })]),
    ).toHaveLength(2);
  });

  it('keeps a snapshot-level reference apart from a code span of the same snapshot', () => {
    const code = item({ strength: 0.6, span: [0, 10] });
    const snapshotLevel = item({ strength: 0.15, artifactId: null, span: null });
    const groups = groupByProvenance([code, snapshotLevel]);
    expect(groups).toHaveLength(2);
  });

  it('groups snapshot-level references of the same snapshot with each other', () => {
    const groups = groupByProvenance([
      item({ artifactId: null, span: null }),
      item({ artifactId: null, span: null }),
      item({ artifactId: null, span: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberIds).toHaveLength(3);
  });

  it('groups event-context references to the same version', () => {
    const groups = groupByProvenance([
      item({ snapshotId: null, artifactId: null, contextVersionId: CTX }),
      item({ snapshotId: null, artifactId: null, contextVersionId: CTX }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('gives every record without provenance its own group', () => {
    const groups = groupByProvenance([
      item({ snapshotId: null, artifactId: null }),
      item({ snapshotId: null, artifactId: null }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('a group is as strong as its MOST CONSERVATIVE member and reports the inconsistency', () => {
    const strong = item({ strength: 0.6, span: [0, 10] });
    const weak = item({ strength: 0.126, span: [5, 15] });
    const [group] = groupByProvenance([strong, weak]);
    expect(group?.strength).toBe(0.126);
    expect(group?.inconsistent).toBe(true);
    const [equal] = groupByProvenance([
      item({ strength: 0.6, span: [0, 10] }),
      item({ strength: 0.6, span: [5, 15] }),
    ]);
    expect(equal?.strength).toBe(0.6);
    expect(equal?.inconsistent).toBe(false);
  });

  it('repeating a passage can never raise strength', () => {
    const original = item({ strength: 0.35, span: [0, 10] });
    const copies = Array.from({ length: 20 }, () => item({ strength: 0.6, span: [0, 10] }));
    const [alone] = groupByProvenance([original]);
    const [repeated] = groupByProvenance([original, ...copies]);
    expect(repeated?.strength).toBe(Math.min(0.35, 0.6));
    expect(repeated?.strength).toBeLessThanOrEqual(alone?.strength ?? 0);
  });

  it('is independent of input order (all 120 permutations of five records)', () => {
    const base = [
      item({ strength: 0.6, span: [0, 10] }),
      item({ strength: 0.35, span: [8, 20] }),
      item({ strength: 0.15, span: [100, 110] }),
      item({ strength: 0.6, artifactId: ART2, span: null }),
      item({ strength: 0.35, artifactId: null, span: null }),
    ];
    const permutations = (list: GroupableItem[]): GroupableItem[][] =>
      list.length <= 1
        ? [list]
        : list.flatMap((head, index) =>
            permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [
              head,
              ...rest,
            ]),
          );
    const all = permutations(base);
    expect(all).toHaveLength(120);
    const expected = JSON.stringify(groupByProvenance(base));
    for (const permutation of all)
      expect(JSON.stringify(groupByProvenance(permutation))).toBe(expected);
  });

  it('is independent of input order for random overlapping sets (seeded)', () => {
    const random = seeded(7);
    for (let round = 0; round < 100; round += 1) {
      const count = 2 + Math.floor(random() * 8);
      const items = Array.from({ length: count }, () => {
        const start = Math.floor(random() * 60);
        return item({
          strength: [0.15, 0.35, 0.6][Math.floor(random() * 3)] ?? 0.6,
          artifactId: random() < 0.7 ? ART : ART2,
          span: random() < 0.15 ? null : [start, start + 1 + Math.floor(random() * 15)],
        });
      });
      const shuffled = [...items].sort(() => random() - 0.5).reverse();
      expect(JSON.stringify(groupByProvenance(shuffled))).toBe(
        JSON.stringify(groupByProvenance(items)),
      );
    }
  });

  it('orders groups by their smallest member ID and members by ID', () => {
    const a = item({ artifactId: ART, span: [0, 5] });
    const b = item({ artifactId: ART2, span: [0, 5] });
    const groups = groupByProvenance([b, a]);
    expect(ids(groups)).toEqual([[a.id], [b.id]]);
  });
});
