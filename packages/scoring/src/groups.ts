import { compareText } from './canonical.js';

/*
 * Provenance grouping: evidence records that cite the same passage are ONE source, however many
 * records there are.
 *
 * Two cited records are in the same GROUP when they have the same provenance SCOPE and their
 * passages overlap:
 *
 *   scope  event context   -> the context version
 *          source snapshot -> (snapshot, artifact)   [a snapshot-level reference is its own scope:
 *                             it groups only with other snapshot-level references of that snapshot,
 *                             so a code span is never merged with a whole-snapshot statement]
 *          none            -> the record itself
 *
 *   overlap within a scope: spans [start, end) intersect; a record without a span covers the whole
 *           artifact (or whole snapshot) and overlaps every record of its scope.
 *
 * Groups are the CONNECTED COMPONENTS of that relation (union-find), so a chain A~B, B~C is one
 * group even when A and C do not overlap. Components do not depend on input order: members are
 * sorted by ID before anything else, and groups are ordered by their smallest member ID.
 *
 * The strength of a group is the MINIMUM strength of its members: a passage is only as strong as
 * the most conservative way the cited records describe it. Repeating a passage can never raise
 * strength, and an assessor who classifies the same passage inconsistently gets the lowest value.
 * The strength of a dimension is the MAXIMUM over its groups (docs/milestones/M4-design.md §5.1).
 */

export interface GroupableItem {
  readonly id: string;
  readonly strength: number;
  readonly snapshotId: string | null;
  readonly artifactId: string | null;
  readonly span: { readonly start: number; readonly end: number } | null;
  readonly contextVersionId: string | null;
}

export interface ProvenanceGroup {
  /** Sorted evidence IDs. */
  readonly memberIds: readonly string[];
  /** The minimum member strength. */
  readonly strength: number;
  readonly inconsistent: boolean;
}

function scopeOf(item: GroupableItem): string {
  if (item.contextVersionId !== null) return `ctx:${item.contextVersionId}`;
  if (item.snapshotId !== null) return `snap:${item.snapshotId}:${item.artifactId ?? ''}`;
  return `own:${item.id}`;
}

function overlaps(a: GroupableItem, b: GroupableItem): boolean {
  if (a.span === null || b.span === null) return true;
  return a.span.start < b.span.end && b.span.start < a.span.end;
}

export function groupByProvenance(items: readonly GroupableItem[]): ProvenanceGroup[] {
  const sorted = [...items].sort((a, b) => compareText(a.id, b.id));
  const parent = sorted.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    // The smaller index (smaller ID) always becomes the root, so the structure is canonical.
    if (rootA < rootB) parent[rootB] = rootA;
    else if (rootB < rootA) parent[rootA] = rootB;
  };

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (a && b && scopeOf(a) === scopeOf(b) && overlaps(a, b)) union(i, j);
    }
  }

  const byRoot = new Map<number, GroupableItem[]>();
  sorted.forEach((item, index) => {
    const root = find(index);
    const members = byRoot.get(root);
    if (members) members.push(item);
    else byRoot.set(root, [item]);
  });

  return [...byRoot.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, members]) => {
      const strengths = members.map((member) => member.strength);
      const strength = strengths.reduce((lowest, value) => Math.min(lowest, value), Infinity);
      return {
        memberIds: members.map((member) => member.id),
        strength,
        inconsistent: strengths.some((value) => value !== strength),
      };
    });
}
