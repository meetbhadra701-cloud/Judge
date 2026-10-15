import {
  nameHash,
  repositoryComponent,
  repositoryRole,
  type RepositoryRole,
} from './repository-roles.js';
import type { Bucket, RoutedSourceType } from './routing.js';

/*
 * source-selection/v2: WHICH passages of the routed artifacts are shown within each bucket's budget. Pure, deterministic and content-independent
 * (it sees keys, kinds, lengths, passage lengths and, for duplicate detection only, a digest of the text; never what the text says).
 *
 * Why v1 was replaced (measured, see docs/milestones/P6B_BETA3_IMPLEMENTATION_REPORT.md): it consumed whole files one after another in a fixed
 * order, closed a bucket at the first passage that did not fit, ranked a README and every document of the repository equal (so an alphabetical
 * tie-break let CHANGELOG.md starve README.md), grouped a monorepo's packages as ONE top-level directory (so shallow manifests were read before
 * any package's source), and let tests and generated snapshots compete with implementation. On the real 404-artifact capture 3 of 18 implementation
 * components were seen and one document used 59% of the prose budget.
 *
 * The rules (each bucket has its own budget; passages are at most 1,200 code points and are always taken from the START of a file):
 *   1. HEADS BEFORE DEPTH. Every eligible artifact is offered a small head (a few passages) before any artifact is read deeper. Head size adapts so
 *      that the artifacts of a round all fit when they can (never below one passage); when they cannot, the round is cut in a fixed, scrambled order.
 *   2. FAIR ACROSS COMPONENTS. Source files are visited in rounds: round k offers the k-th best implementation file of EVERY component (a monorepo
 *      package, or a top-level directory), so no component is read in depth while another is unseen. Within a component: entry points, then
 *      shallower, then path. Never by size, line count, commit count, stars or keywords.
 *   3. ROLES. Deployment, manifest and configuration files get a guaranteed small share (20% of the source budget) and are read first because they
 *      are short and decisive; tests get a reserved share (15%) and their heads only until depth is done; generated files and exact duplicates come
 *      last or not at all.
 *   4. NO ARTIFACT TAKES MORE THAN A QUARTER of a bucket's budget in the depth phase.
 *   5. WORK-CONSERVING. Whatever budget remains afterwards is spent (caps lifted, tests then generated files), so a bucket never wastes its budget
 *      and a passage that does not fit never closes the bucket for smaller ones.
 *   6. PROSE. Devpost text first; then the root README; other READMEs; other documents; then history/licence-style files (CHANGELOG, LICENSE...).
 */

export const PASSAGE = 1_200;

export interface SelectionItem {
  readonly id: number;
  readonly key: string;
  readonly sourceType: RoutedSourceType;
  readonly bucket: Bucket;
  /** The router's priority class (statement: 1 Devpost, 2 repository prose, 3 deployment page, 4 video; source: 6). */
  readonly priority: number;
  /** Code points of each eligible passage, in order. */
  readonly lengths: readonly number[];
  /** A digest of the full text, for duplicate detection of repository files (null: never a duplicate). */
  readonly textDigest: string | null;
  readonly artifactClass: 'source_code' | 'repository_metadata' | 'deployment_observation' | null;
}

export interface Decision {
  /** How many leading passages are shown. */
  readonly shown: number;
  /** For an artifact that is a byte-identical copy of an earlier one: the key of the copy that is shown instead. */
  readonly duplicateOf: string | null;
  readonly role: RepositoryRole | 'statement' | 'metadata' | 'observation';
  readonly component: string | null;
}

export interface Budgets {
  readonly statement: number;
  readonly source: number;
  readonly metadata: number;
}

interface State {
  readonly item: SelectionItem;
  readonly path: string;
  readonly role: Decision['role'];
  readonly component: string | null;
  readonly depth: number;
  /** Lower first. */
  readonly rank: readonly number[];
  next: number;
  shown: number;
  duplicateOf: string | null;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const repositoryPath = (key: string): string =>
  key.startsWith('files/') ? key.slice('files/'.length) : key;
const compareRank = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

const ENTRY_STEMS = new Set(['index', 'main', 'app', 'server', 'mod', 'lib', 'cli', 'program']);
const HISTORY_PROSE =
  /^(changelog|changes|history|news|release[-_ ]?notes|license|licence|copying|notice|contributing|code[-_]of[-_]conduct|security|authors|contributors)(\.|$)/i;

function isEntry(path: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(path)) return true;
  const segments = path.split('/');
  const base = segments[segments.length - 1] ?? '';
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  if (!ENTRY_STEMS.has(stem.toLowerCase())) return false;
  const directories = segments.slice(0, -1);
  // at the root of a component, or directly in its `src`
  const last = directories[directories.length - 1];
  return directories.length === 0 || last === 'src' || directories.length <= 2;
}

function stateOf(item: SelectionItem, declared: ReadonlySet<string>): State {
  const base = { item, next: 0, shown: 0, duplicateOf: null as string | null };
  if (item.sourceType !== 'github' || !item.key.startsWith('files/')) {
    const role: Decision['role'] =
      item.bucket === 'statement'
        ? 'statement'
        : item.bucket === 'metadata'
          ? 'metadata'
          : 'observation';
    return { ...base, path: item.key, role, component: null, depth: 0, rank: [item.priority] };
  }
  const path = repositoryPath(item.key);
  const segments = path.split('/');
  const depth = segments.length;
  const basename = segments[segments.length - 1] ?? '';
  if (item.bucket === 'statement') {
    const readme = /^readme(\.|$)/i.test(basename);
    const klass = readme && depth === 1 ? 0 : readme ? 1 : HISTORY_PROSE.test(basename) ? 3 : 2;
    return {
      ...base,
      path,
      role: 'statement',
      component: null,
      depth,
      rank: [item.priority, klass, depth],
    };
  }
  const role = repositoryRole(path);
  const component = repositoryComponent(path);
  const entry = isEntry(path, declared) ? 0 : 1;
  return { ...base, path, role, component, depth, rank: [item.priority, entry, depth] };
}

const byPath = (a: State, b: State): number =>
  compareRank(a.rank, b.rank) || compare(a.path, b.path);

/** Groups states by component and orders the groups by a fixed scrambling of their names (not alphabetically). */
function componentGroups(states: readonly State[]): State[][] {
  const groups = new Map<string, State[]>();
  for (const state of states) {
    const name = state.component ?? '';
    const list = groups.get(name);
    if (list) list.push(state);
    else groups.set(name, [state]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => nameHash(a) - nameHash(b) || compare(a, b))
    .map(([, list]) => list.sort(byPath));
}

export function selectV2(
  items: readonly SelectionItem[],
  budgets: Budgets,
  declaredEntries: ReadonlySet<string>,
): ReadonlyMap<number, Decision> {
  const remaining: Record<Bucket, number> = { ...budgets };
  const states = items.map((item) => stateOf(item, declaredEntries));

  // -- exact duplicates (repository files only, and only files long enough for a copy to matter) -------------------------------------
  const seen = new Map<string, State>();
  for (const state of [...states].filter((s) => s.item.textDigest !== null).sort(byPath)) {
    const digest = state.item.textDigest ?? '';
    const first = seen.get(digest);
    if (first) state.duplicateOf = first.item.key;
    else seen.set(digest, state);
  }
  const live = states.filter((s) => s.duplicateOf === null);

  const grant = (state: State, bucket: Bucket, maxAdd: number, totalCap: number): number => {
    let added = 0;
    const lengths = state.item.lengths;
    while (state.next < lengths.length) {
      const length = lengths[state.next] ?? 0;
      if (added + length > maxAdd || state.shown + length > totalCap || length > remaining[bucket])
        break;
      remaining[bucket] -= length;
      state.shown += length;
      state.next += 1;
      added += length;
    }
    return added;
  };

  /**
   * One pass of rounds over `groups` (round r offers the r-th member of every group). `pool` is how much of the bucket the pass may spend;
   * `headMax` is the head a member gets; the head shrinks (never below one passage) so that a whole round fits when it can.
   */
  const rounds = (
    groups: readonly (readonly State[])[],
    bucket: Bucket,
    pool: number,
    headMax: number,
    totalCap: number,
  ): void => {
    let poolLeft = Math.min(pool, remaining[bucket]);
    for (let r = 0; ; r += 1) {
      const members = groups.map((g) => g[r]).filter((s): s is State => s !== undefined);
      if (members.length === 0) return;
      // the head is sized so that EVERY file still waiting (this round and all later ones) can afford one, not just this round's files
      const waiting = groups.reduce((n, g) => n + Math.max(0, g.length - r), 0);
      const fit = Math.floor(poolLeft / waiting / PASSAGE) * PASSAGE;
      const head = Math.max(PASSAGE, Math.min(headMax, fit));
      for (const member of members) {
        if (poolLeft < PASSAGE && poolLeft < (member.item.lengths[member.next] ?? 0)) continue;
        const added = grant(member, bucket, Math.min(head, poolLeft), totalCap);
        poolLeft -= added;
      }
      if (poolLeft <= 0 || remaining[bucket] <= 0) return;
    }
  };

  /** Deepen already-headed artifacts one passage per visit, round-robin, until nothing more can be added. */
  const deepen = (
    order: readonly State[],
    bucket: Bucket,
    pool: number,
    totalCap: number,
  ): void => {
    let poolLeft = Math.min(pool, remaining[bucket]);
    for (;;) {
      let progressed = false;
      for (const state of order) {
        if (state.next >= state.item.lengths.length) continue;
        const added = grant(state, bucket, Math.min(PASSAGE, poolLeft), totalCap);
        if (added > 0) {
          poolLeft -= added;
          progressed = true;
        }
        if (poolLeft <= 0) return;
      }
      if (!progressed) return;
    }
  };

  // -- statement bucket (prose): heads in prose order, then depth round-robin under a per-artifact cap, then spill -----------------------
  {
    const bucket: Bucket = 'statement';
    const prose = live.filter((s) => s.item.bucket === bucket).sort(byPath);
    const budget = budgets.statement;
    const classHead = (s: State): number =>
      s.item.sourceType === 'devpost'
        ? 24_000
        : s.rank[1] === 0
          ? 12_000
          : s.rank[1] === 1
            ? 4_800
            : s.rank[1] === 3
              ? PASSAGE
              : 2_400;
    // heads in classes (a class's heads are fitted together, so a document class cannot starve the class after it)
    const classes = [...new Set(prose.map((s) => `${String(s.rank[0])}/${String(s.rank[1])}`))];
    const membersOf = (klass: string): State[] =>
      prose.filter((s) => `${String(s.rank[0])}/${String(s.rank[1])}` === klass);
    classes.forEach((klass, position) => {
      const members = membersOf(klass);
      const headMax = classHead(members[0] as State);
      // a class never takes what the classes after it need for one passage per document (when the budget can afford that at all)
      const reserved = classes
        .slice(position + 1)
        .reduce((total, later) => total + membersOf(later).length * PASSAGE, 0);
      const available = Math.max(0, remaining[bucket] - reserved);
      const fit = Math.floor(available / members.length / PASSAGE) * PASSAGE;
      const head = Math.max(PASSAGE, Math.min(headMax, fit));
      for (const member of members) grant(member, bucket, head, Infinity);
    });
    const cap = Math.floor(budget * 0.25);
    deepen(prose, bucket, remaining[bucket], cap);
    deepen(prose, bucket, remaining[bucket], Infinity);
  }

  // -- metadata bucket: a head each, then spill ----------------------------------------------------------------------------------------
  {
    const bucket: Bucket = 'metadata';
    const metadata = live.filter((s) => s.item.bucket === bucket).sort(byPath);
    rounds(
      metadata.map((s) => [s]),
      bucket,
      remaining[bucket],
      2_400,
      Infinity,
    );
    deepen(metadata, bucket, remaining[bucket], Infinity);
  }

  // -- source bucket ----------------------------------------------------------------------------------------------------------------------
  {
    const bucket: Bucket = 'source';
    const budget = budgets.source;
    const source = live.filter((s) => s.item.bucket === bucket);
    const ofRole = (...roles: Decision['role'][]) => source.filter((s) => roles.includes(s.role));
    const deployment = ofRole('deployment').sort(byPath);
    const manifests = ofRole('manifest').sort(byPath);
    const configs = ofRole('config').sort(byPath);
    const implementation = ofRole('implementation', 'observation');
    const tests = ofRole('test');
    const generated = ofRole('generated').sort(byPath);

    // 1. deployment, manifests and configuration: short and decisive; at most 20% of the budget; one file per "group" so rounds are plain lists
    const small = [...deployment, ...manifests, ...configs];
    rounds(
      small.map((s) => [s]),
      bucket,
      Math.floor(budget * 0.2),
      2_400,
      Infinity,
    );

    // 2. implementation heads, fair across components; tests keep a reserved share
    const testReserve = tests.length > 0 ? Math.floor(budget * 0.15) : 0;
    const groups = componentGroups(implementation);
    rounds(groups, bucket, Math.max(0, remaining[bucket] - testReserve), 3_600, Infinity);

    // 3. test heads, fair across components, within their reservation (and what is left)
    rounds(
      componentGroups(tests),
      bucket,
      Math.min(remaining[bucket], testReserve),
      2_400,
      Infinity,
    );

    // 4. depth: implementation first (component round-robin order), no artifact over a quarter of the budget
    const depthOrder = (() => {
      const order: State[] = [];
      for (let r = 0; ; r += 1) {
        const round = groups
          .map((g) => g[r])
          .filter((s): s is State => s !== undefined && s.next > 0);
        if (round.length === 0 && groups.every((g) => r >= g.length)) break;
        order.push(...round);
      }
      return order;
    })();
    deepen(depthOrder, bucket, remaining[bucket], Math.floor(budget * 0.25));

    // 5. spill: caps lifted; implementation, then the small files, then tests, then generated files (heads, then depth)
    deepen(depthOrder, bucket, remaining[bucket], Infinity);
    const smallHeaded = small.filter((s) => s.next > 0);
    deepen(smallHeaded, bucket, remaining[bucket], Infinity);
    const unseenImplementation = groups.flat().filter((s) => s.next === 0);
    rounds(
      unseenImplementation.map((s) => [s]),
      bucket,
      remaining[bucket],
      PASSAGE,
      Infinity,
    );
    // deployment, manifest and configuration files the 20% pool could not hold still outrank tests and generated files
    rounds(
      small.filter((s) => s.next === 0).map((s) => [s]),
      bucket,
      remaining[bucket],
      PASSAGE,
      Infinity,
    );
    const testOrder = componentGroups(tests).flat();
    rounds(
      testOrder.filter((s) => s.next === 0).map((s) => [s]),
      bucket,
      remaining[bucket],
      PASSAGE,
      Infinity,
    );
    deepen(
      testOrder.filter((s) => s.next > 0),
      bucket,
      remaining[bucket],
      Infinity,
    );
    rounds(
      generated.map((s) => [s]),
      bucket,
      remaining[bucket],
      PASSAGE,
      Infinity,
    );
    deepen(
      generated.filter((s) => s.next > 0),
      bucket,
      remaining[bucket],
      Infinity,
    );
  }

  const decisions = new Map<number, Decision>();
  for (const state of states) {
    decisions.set(state.item.id, {
      shown: state.next,
      duplicateOf: state.duplicateOf,
      role: state.role,
      component: state.component,
    });
  }
  return decisions;
}
