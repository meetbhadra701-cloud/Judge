import {
  nameHash,
  repositoryComponent,
  repositoryRole,
  type RepositoryRole,
} from './repository-roles.js';
import type { Bucket, RoutedSourceType } from './routing.js';

/*
 * source-selection/v3 (R7D remediation of v2; v2 stays selectable and unchanged in selection-v2.ts): WHICH passages of the routed artifacts are shown within each bucket's budget. Pure, deterministic and content-independent
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
 *   4. NO ARTIFACT RUNS AHEAD. Depth is added one passage per file per visit, round-robin, so a huge file never takes the budget while another file is
 *      still at its head; a file only keeps growing alone once every other file has nothing left to add (work conservation).
 *   5. WORK-CONSERVING. Whatever budget remains afterwards is spent (caps lifted, tests then generated files), so a bucket never wastes its budget
 *      and a passage that does not fit never closes the bucket for smaller ones.
 *   6. PROSE. Devpost text first; then the root README; other READMEs; other documents; then history/licence-style files (CHANGELOG, LICENSE...).
 */

export const PASSAGE = 1_200;

/** A component with fewer implementation code points than this is a STUB: visited after every meaningful component (a class, never a ranking). */
export const STUB_COMPONENT_BELOW = 600;

export const PROSE_CATEGORY_VALUES = [
  'submission',
  'root_readme',
  'deployment_page',
  'video',
  'key_docs',
  'package_readme',
  'other_docs',
  'history',
] as const;
export type ProseCategory = (typeof PROSE_CATEGORY_VALUES)[number];

/** Share of the prose budget each repository-prose category may spend on HEADS before anything is read deeper (the rest flows to depth). */
export const PROSE_CATEGORY_SHARE: Readonly<Partial<Record<ProseCategory, number>>> = Object.freeze(
  {
    key_docs: 0.3,
    package_readme: 0.25,
    other_docs: 0.25,
    history: 0.05,
  },
);

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
  /** For prose: its documentation category (see PROSE_CATEGORY_VALUES); null otherwise. */
  readonly category: ProseCategory | null;
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
  readonly category: ProseCategory | null;
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

const KEY_DOC_WORDS =
  /(^|[-_. ])(architecture|design|overview|api|deployment|deploy|setup|install(ation)?|usage|getting[-_ ]?started|how[-_ ]?it[-_ ]?works|spec(ification)?|protocol|data[-_ ]?model|threat[-_ ]?model|security[-_ ]?model|pipeline|adr[-_ ]?\d*|rfc[-_ ]?\d*)([-_. ]|$)/i;
const KEY_DOC_DIRECTORIES = new Set([
  'architecture',
  'design',
  'adr',
  'adrs',
  'rfc',
  'rfcs',
  'specs',
  'spec',
]);

/** The documentation category of a prose artifact, from its source type and path alone. */
export function proseCategoryOf(sourceType: RoutedSourceType, path: string): ProseCategory {
  if (sourceType === 'devpost') return 'submission';
  if (sourceType === 'deployment') return 'deployment_page';
  if (sourceType === 'video') return 'video';
  const segments = path.split('/');
  const basename = segments[segments.length - 1] ?? '';
  const directories = segments.slice(0, -1).map((d) => d.toLowerCase());
  if (/^readme(\.|$)/i.test(basename))
    return segments.length === 1 ? 'root_readme' : 'package_readme';
  if (HISTORY_PROSE.test(basename)) return 'history';
  if (KEY_DOC_WORDS.test(basename) || directories.some((d) => KEY_DOC_DIRECTORIES.has(d)))
    return 'key_docs';
  return 'other_docs';
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
    return {
      ...base,
      path: item.key,
      role,
      component: null,
      category: item.bucket === 'statement' ? proseCategoryOf(item.sourceType, item.key) : null,
      depth: 0,
      rank: [item.priority],
    };
  }
  const path = repositoryPath(item.key);
  const segments = path.split('/');
  const depth = segments.length;
  if (item.bucket === 'statement') {
    const category = proseCategoryOf(item.sourceType, path);
    return {
      ...base,
      path,
      role: 'statement',
      component: null,
      category,
      depth,
      rank: [item.priority, PROSE_CATEGORY_VALUES.indexOf(category), depth],
    };
  }
  const role = repositoryRole(path);
  const component = repositoryComponent(path);
  const entry = isEntry(path, declared) ? 0 : 1;
  return {
    ...base,
    path,
    role,
    component,
    category: null,
    depth,
    rank: [item.priority, entry, depth],
  };
}

const byPath = (a: State, b: State): number =>
  compareRank(a.rank, b.rank) || compare(a.path, b.path);

/**
 * Groups states by component and orders the groups. Meaningful components come before STUBS (a class: below STUB_COMPONENT_BELOW implementation
 * code points); within a class, components are interleaved ACROSS THEIR ROOTS (`packages`, `apps`, `services`, a top-level directory...), one from
 * each root in turn, so flooding one root with components cannot push the components of the others out; inside a root the order is a fixed
 * scrambling of the names. No ordering of this kind is adversary-proof (a public function can be ground against): the guarantee that does not
 * depend on it is that the coverage report itemizes every component that was not inspected, with its volume.
 */
function componentGroups(states: readonly State[]): State[][] {
  const groups = new Map<string, State[]>();
  for (const state of states) {
    const name = state.component ?? '';
    const list = groups.get(name);
    if (list) list.push(state);
    else groups.set(name, [state]);
  }
  const volume = (list: readonly State[]): number =>
    list.reduce((n, s) => n + s.item.lengths.reduce((a, b) => a + b, 0), 0);
  const rootOf = (name: string): string => (name.includes('/') ? (name.split('/')[0] ?? '') : name);
  const ordered: State[][] = [];
  for (const meaningful of [true, false]) {
    const byRoot = new Map<string, [string, State[]][]>();
    for (const entry of groups.entries()) {
      if (volume(entry[1]) >= STUB_COMPONENT_BELOW !== meaningful) continue;
      const root = rootOf(entry[0]);
      const list = byRoot.get(root);
      if (list) list.push(entry);
      else byRoot.set(root, [entry]);
    }
    const roots = [...byRoot.entries()]
      .sort(([a], [b]) => nameHash(a) - nameHash(b) || compare(a, b))
      .map(([, list]) => list.sort(([a], [b]) => nameHash(a) - nameHash(b) || compare(a, b)));
    for (let k = 0; roots.some((r) => r.length > k); k += 1) {
      for (const list of roots) {
        const entry = list[k];
        if (entry) ordered.push(entry[1].sort(byPath));
      }
    }
  }
  return ordered;
}

export function selectV3(
  items: readonly SelectionItem[],
  budgets: Budgets,
  declaredEntries: ReadonlySet<string>,
): ReadonlyMap<number, Decision> {
  const remaining: Record<Bucket, number> = { ...budgets };
  const states = items.map((item) => stateOf(item, declaredEntries));

  // -- exact duplicates: same bucket, SAME ROLE and the same bytes (a test file never stands in for an implementation file) -----------------
  const seen = new Map<string, State>();
  for (const state of [...states].filter((s) => s.item.textDigest !== null).sort(byPath)) {
    const digest = `${state.item.bucket}:${state.role}:${state.item.textDigest ?? ''}`;
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

  // -- statement bucket (prose): CATEGORIES with their own head pools, directories taking turns inside a category, then depth round-robin -----
  {
    const bucket: Bucket = 'statement';
    const total = budgets.statement;
    const prose = live.filter((s) => s.item.bucket === bucket).sort(byPath);
    const HEAD: Readonly<Record<ProseCategory, number>> = {
      submission: 24_000,
      root_readme: 12_000,
      deployment_page: 2_400,
      video: 2_400,
      key_docs: 4_800,
      package_readme: 2_400,
      other_docs: 2_400,
      history: PASSAGE,
    };
    /** Files of a category grouped by directory: a flood in one directory is ONE group among the others, and groups take turns. */
    const directoryGroups = (members: readonly State[]): State[][] => {
      const byDirectory = new Map<string, State[]>();
      for (const member of members) {
        const directory = member.path.includes('/')
          ? member.path.slice(0, member.path.lastIndexOf('/'))
          : '';
        const list = byDirectory.get(directory);
        if (list) list.push(member);
        else byDirectory.set(directory, [member]);
      }
      return [...byDirectory.entries()]
        .sort(([a], [b]) => nameHash(a) - nameHash(b) || compare(a, b))
        .map(([, list]) => list.sort(byPath));
    };
    for (const category of PROSE_CATEGORY_VALUES) {
      const members = prose.filter((s) => s.category === category);
      if (members.length === 0) continue;
      const share = PROSE_CATEGORY_SHARE[category];
      const pool = share === undefined ? remaining[bucket] : Math.floor(total * share);
      // a category's head pool is its own: package READMEs cannot spend the key documents' share, and a flood of documents cannot spend the READMEs'
      rounds(directoryGroups(members), bucket, pool, HEAD[category], Infinity);
    }
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
      category: state.category,
    });
  }
  return decisions;
}
