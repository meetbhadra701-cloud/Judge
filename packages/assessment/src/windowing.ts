import { createHash } from 'node:crypto';
import { isPassageBarrier, hasVisibleContent, sliceOf, toCodePoints } from './text.js';
import { repositoryComponent, repositoryRole } from './repository-roles.js';
import { selectV2, type Decision, type SelectionItem } from './selection-v2.js';
import {
  routeArtifact,
  type Bucket,
  type InterpretClass,
  type RoutedSourceType,
  type SkipReason,
} from './routing.js';

/*
 * Deterministic selection and windowing of captured text into PASSAGES (design §4.1, §12.3.1-12.3.2).
 *
 * A passage is an exact, contiguous slice [start, end) of ONE artifact's stored text, in code points of the ORIGINAL text. It is
 * never normalized, trimmed or re-encoded, so `slice(original, start, end) === passage.text` always holds, and a quote located
 * inside a passage maps back to a span of the original by simple addition.
 *
 * Splitting rules (windowing/v1):
 *   - A line ends after "\n", "\r\n" or a lone "\r". The terminator stays with its line. A passage never splits "\r\n".
 *   - A passage holds whole lines and at most PASSAGE_MAX_CODE_POINTS code points. A longer line is cut at a code-point boundary
 *     (never inside a surrogate pair, never between "\r" and "\n").
 *   - Characters that may not appear in passage text (see `isPassageBarrier`) are excluded and separate passages, so no quote can
 *     span them. Their offsets are still counted, so every offset stays that of the original text.
 *   - A passage with no visible character is dropped (its offsets are not shown to anyone).
 *
 * Selection (source-selection/v2, default; v1 is kept so that earlier runs stay reproducible): see selection-v2.ts. Heads before depth, fair
 * across monorepo components, roles (deployment/manifest/config/implementation/test/generated), a per-file cap, exact duplicates suppressed
 * and a work-conserving budget. The result carries a COVERAGE REPORT: for every artifact exactly which code-point ranges were shown and which
 * were not, and a verdict (complete / partial / insufficient) that downstream stages must honour. An unseen range is UNKNOWN, never negative.
 *
 * Selection (source-selection/v1): priority classes first (Devpost, README/docs, deployment, video, repository metadata, source),
 * source files by manifests and entry points, then breadth-first round-robin across top-level directories, ties by path in code-point
 * order. Never by size, line count, commit count, stars or keywords. Every omission is returned with a reason; nothing disappears
 * silently. Handles `P-0001`... follow the final order, so identical inputs give identical handles regardless of input order.
 */

export const WINDOWING_POLICY = 'windowing/v1' as const;
export const SELECTION_POLICY_V1 = 'source-selection/v1' as const;
export const SELECTION_POLICY = 'source-selection/v2' as const;
export const SELECTION_POLICY_VALUES = [SELECTION_POLICY_V1, SELECTION_POLICY] as const;
export type SelectionPolicyId = (typeof SELECTION_POLICY_VALUES)[number];
export const PASSAGE_MAX_CODE_POINTS = 1_200;

export interface WindowingBudgets {
  /** Code points of statement text shown. */
  readonly statement: number;
  /** Code points of repository source / configuration shown. */
  readonly source: number;
  /** Code points of repository metadata and deployment observations shown. */
  readonly metadata: number;
}

export const DEFAULT_BUDGETS: WindowingBudgets = Object.freeze({
  statement: 120_000,
  source: 240_000,
  metadata: 30_000,
});

/** One captured artifact with its exact stored text. Built by the trusted reader (P4); never by a model. */
export interface SourceArtifact {
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly sourceType: RoutedSourceType;
  /** Only `captured` and `partial` snapshots carry content. */
  readonly snapshotStatus: string;
  readonly key: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly text: string;
}

export interface Passage {
  readonly handle: string;
  readonly route: 'statement' | 'interpret';
  readonly sourceType: RoutedSourceType;
  /** Set for `interpret` passages. */
  readonly artifactClass: InterpretClass | null;
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly artifactKey: string;
  /** Code-point offsets into the ORIGINAL artifact text, half-open. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export const OMISSION_REASON_VALUES = [
  'snapshot_not_content_bearing',
  'budget_exhausted',
  'no_visible_content',
  'duplicate_content',
  'duplicate_structured_form',
  'listing_only',
  'commit_history_not_routed',
  'code_authored_source_gap',
  'unrecognized_artifact',
] as const;
export type OmissionReason = (typeof OMISSION_REASON_VALUES)[number] | SkipReason;

export interface Omission {
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly artifactKey: string;
  readonly sourceType: RoutedSourceType;
  readonly reason: OmissionReason;
  readonly totalCodePoints: number;
  readonly shownCodePoints: number;
}

export interface BucketUse {
  readonly bucket: Bucket;
  readonly budget: number;
  readonly shownCodePoints: number;
  /** Code points of passage text that was eligible (before the budget). */
  readonly eligibleCodePoints: number;
  readonly sampled: boolean;
}

export type CoverageStatus = 'full' | 'partial' | 'unseen' | 'duplicate';

/** Exactly what of one artifact's text reached the model stages. Ranges are code-point offsets into the ORIGINAL text, half-open. */
export interface ArtifactCoverage {
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly artifactKey: string;
  readonly sourceType: RoutedSourceType;
  readonly bucket: Bucket;
  /** From the path alone (source-selection/v2): deployment, manifest, config, implementation, test, generated; statement/metadata/observation otherwise. */
  readonly role: Decision['role'];
  readonly component: string | null;
  readonly status: CoverageStatus;
  readonly totalCodePoints: number;
  readonly shownCodePoints: number;
  readonly shownRanges: readonly Range[];
  /** The part never shown: UNKNOWN to every later stage, not evidence of anything. */
  readonly unshownRanges: readonly Range[];
  readonly duplicateOf: string | null;
}

export interface ComponentCoverage {
  readonly component: string;
  readonly implementationFiles: number;
  readonly implementationFilesShown: number;
  readonly implementationCodePoints: number;
  readonly implementationCodePointsShown: number;
}

export type CoverageVerdict = 'complete' | 'partial' | 'insufficient';

export interface CoverageReport {
  readonly artifacts: readonly ArtifactCoverage[];
  /** Implementation components (monorepo packages / top-level directories), in a fixed order. */
  readonly components: readonly ComponentCoverage[];
  readonly verdict: CoverageVerdict;
  /** Stable codes saying why the verdict is not `complete`; each is a fact about the SELECTION, never about the project. */
  readonly concerns: readonly CoverageConcern[];
}

export const COVERAGE_CONCERN_VALUES = [
  'implementation_components_unseen',
  'implementation_partially_seen',
  'no_implementation_shown',
  'documentation_partially_seen',
  'configuration_partially_seen',
  'tests_partially_seen',
] as const;
export type CoverageConcern = (typeof COVERAGE_CONCERN_VALUES)[number];

/**
 * Verdict rules (fixed, documented in docs/ARCHITECTURE.md): `insufficient` when implementation exists but none of it was shown, or fewer than
 * half of the implementation components have any shown file; `partial` when anything eligible (apart from duplicates) went unshown; otherwise
 * `complete`. These are selection facts; they say nothing about the quality of the project.
 */
export const COVERAGE_POLICY = Object.freeze({
  insufficientBelowComponentFraction: 0.5,
});

export interface WindowingResult {
  readonly passages: readonly Passage[];
  readonly omissions: readonly Omission[];
  readonly buckets: readonly BucketUse[];
  readonly coverage: CoverageReport;
  readonly policy: {
    readonly windowing: typeof WINDOWING_POLICY;
    readonly selection: SelectionPolicyId;
  };
}

/** Plain code-point order (not UTF-16 code-unit order), as the design requires for path ties. */
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done === true && y.done === true) return 0;
    if (x.done === true) return -1;
    if (y.done === true) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

// -- Splitting one artifact's text into passages ---------------------------------------------------------------------------

export interface Range {
  readonly start: number;
  readonly end: number;
}

/** Maximal runs of code points that are not barriers. */
function runsOf(points: readonly string[]): Range[] {
  const runs: Range[] = [];
  let start = -1;
  points.forEach((point, index) => {
    if (isPassageBarrier(point)) {
      if (start >= 0) runs.push({ start, end: index });
      start = -1;
    } else if (start < 0) {
      start = index;
    }
  });
  if (start >= 0) runs.push({ start, end: points.length });
  return runs;
}

/** Line ranges of a run: a line includes its terminator ("\n", "\r\n" or a lone "\r"). */
function linesOf(points: readonly string[], run: Range): Range[] {
  const lines: Range[] = [];
  let start = run.start;
  for (let index = run.start; index < run.end; index += 1) {
    const point = points[index];
    if (point === '\n') {
      lines.push({ start, end: index + 1 });
      start = index + 1;
    } else if (point === '\r') {
      const end = points[index + 1] === '\n' && index + 1 < run.end ? index + 2 : index + 1;
      lines.push({ start, end });
      start = end;
      index = end - 1;
    }
  }
  if (start < run.end) lines.push({ start, end: run.end });
  return lines;
}

/** Cuts a line longer than the maximum into chunks, never inside a "\r\n" pair. */
function chunksOf(points: readonly string[], line: Range, max: number): Range[] {
  const chunks: Range[] = [];
  let start = line.start;
  while (line.end - start > max) {
    let cut = start + max;
    if (points[cut - 1] === '\r' && points[cut] === '\n') cut -= 1;
    if (cut <= start) cut = start + 1;
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: line.end });
  return chunks;
}

/** The passage ranges of one artifact text. Pure; the ranges are disjoint, ordered and within the text. */
export function passageRanges(text: string, max: number = PASSAGE_MAX_CODE_POINTS): Range[] {
  const points = toCodePoints(text);
  return rangesOfPoints(points, max);
}

function rangesOfPoints(points: readonly string[], max: number): Range[] {
  const ranges: Range[] = [];
  for (const run of runsOf(points)) {
    let current: Range | null = null;
    const flush = () => {
      if (current) ranges.push(current);
      current = null;
    };
    for (const line of linesOf(points, run)) {
      const pieces = line.end - line.start > max ? chunksOf(points, line, max) : [line];
      for (const piece of pieces) {
        if (current && piece.end - current.start <= max) {
          current = { start: current.start, end: piece.end };
        } else {
          flush();
          current = piece;
        }
      }
    }
    flush();
  }
  return ranges.filter((range) => hasVisibleContent(sliceOf(points, range.start, range.end)));
}

// -- Selection -----------------------------------------------------------------------------------------------------

const SOURCE_RANK: Readonly<Record<RoutedSourceType, number>> = {
  devpost: 0,
  github: 1,
  deployment: 2,
  video: 3,
};

interface Candidate {
  readonly artifact: SourceArtifact;
  readonly route: 'statement' | 'interpret';
  readonly bucket: Bucket;
  readonly priority: number;
  readonly artifactClass: InterpretClass | null;
  readonly points: readonly string[];
  readonly ranges: readonly Range[];
  /** Position inside its priority class (for source files: manifest/entry first, then round-robin). */
  order: number;
}

const repositoryPath = (key: string): string =>
  key.startsWith('files/') ? key.slice('files/'.length) : key;

const ENTRY_BASENAMES = new Set(['index', 'main', 'app', 'server']);

/** `main` and `bin` paths declared by a root package.json (data only: used to ORDER files, never to rank by size or quality). */
function declaredEntryPoints(artifacts: readonly SourceArtifact[]): ReadonlySet<string> {
  const entries = new Set<string>();
  const manifest = artifacts.find(
    (artifact) => artifact.sourceType === 'github' && artifact.key === 'files/package.json',
  );
  if (!manifest) return entries;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.text);
  } catch {
    return entries;
  }
  if (typeof parsed !== 'object' || parsed === null) return entries;
  const record = parsed as Record<string, unknown>;
  const add = (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 300) return;
    const normalized = value.replace(/^\.\//, '');
    if (normalized.split('/').includes('..') || normalized.startsWith('/')) return;
    entries.add(normalized);
  };
  add(record['main']);
  const bin = record['bin'];
  if (typeof bin === 'string') add(bin);
  else if (typeof bin === 'object' && bin !== null) Object.values(bin).forEach(add);
  return entries;
}

function sourceRank(path: string, entries: ReadonlySet<string>): number {
  if (path === 'package.json') return 0;
  if (entries.has(path)) return 1;
  const segments = path.split('/');
  const base = segments[segments.length - 1] ?? '';
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const inRootOrSrc = segments.length === 1 || (segments.length === 2 && segments[0] === 'src');
  return inRootOrSrc && ENTRY_BASENAMES.has(stem) ? 1 : 2;
}

/** Orders source files: manifest, entry points, then round-robin across top-level directories (breadth first). */
function orderSourceFiles(files: readonly Candidate[], entries: ReadonlySet<string>): Candidate[] {
  const ranked = files.map((file) => ({ file, path: repositoryPath(file.artifact.key) }));
  const first = ranked
    .filter(({ path }) => sourceRank(path, entries) < 2)
    .sort(
      (a, b) =>
        sourceRank(a.path, entries) - sourceRank(b.path, entries) ||
        compareCodePoints(a.path, b.path),
    );
  const rest = ranked.filter(({ path }) => sourceRank(path, entries) === 2);
  const groups = new Map<string, typeof rest>();
  for (const item of rest) {
    const segments = item.path.split('/');
    const top = segments.length > 1 ? (segments[0] ?? '') : '';
    const list = groups.get(top);
    if (list) list.push(item);
    else groups.set(top, [item]);
  }
  const depth = (path: string) => path.split('/').length;
  for (const list of groups.values()) {
    list.sort((a, b) => depth(a.path) - depth(b.path) || compareCodePoints(a.path, b.path));
  }
  const names = [...groups.keys()].sort(compareCodePoints);
  const interleaved: typeof rest = [];
  for (let round = 0; ; round += 1) {
    let any = false;
    for (const name of names) {
      const item = groups.get(name)?.[round];
      if (item) {
        interleaved.push(item);
        any = true;
      }
    }
    if (!any) break;
  }
  return [...first, ...interleaved].map(({ file }) => file);
}

function artifactOrder(a: Candidate, b: Candidate): number {
  return (
    a.priority - b.priority ||
    SOURCE_RANK[a.artifact.sourceType] - SOURCE_RANK[b.artifact.sourceType] ||
    a.order - b.order ||
    compareCodePoints(a.artifact.key, b.artifact.key) ||
    compareCodePoints(a.artifact.snapshotId, b.artifact.snapshotId) ||
    compareCodePoints(a.artifact.artifactId, b.artifact.artifactId)
  );
}

const CONTENT_BEARING = new Set(['captured', 'partial']);

/**
 * Selects and windows the captured text. Pure and order-independent: any permutation of `artifacts` gives an identical result.
 */
export function buildPassages(
  artifacts: readonly SourceArtifact[],
  budgets: WindowingBudgets = DEFAULT_BUDGETS,
  policy: SelectionPolicyId = SELECTION_POLICY,
): WindowingResult {
  const omissions: Omission[] = [];
  const candidates: Candidate[] = [];
  const omit = (artifact: SourceArtifact, reason: OmissionReason, total: number, shown = 0) =>
    omissions.push({
      snapshotId: artifact.snapshotId,
      artifactId: artifact.artifactId,
      artifactKey: artifact.key,
      sourceType: artifact.sourceType,
      reason,
      totalCodePoints: total,
      shownCodePoints: shown,
    });

  for (const artifact of artifacts) {
    const points = toCodePoints(artifact.text);
    if (!CONTENT_BEARING.has(artifact.snapshotStatus)) {
      omit(artifact, 'snapshot_not_content_bearing', points.length);
      continue;
    }
    const decision = routeArtifact(artifact);
    if (decision.route === 'skip') {
      omit(artifact, decision.reason, points.length);
      continue;
    }
    const ranges = rangesOfPoints(points, PASSAGE_MAX_CODE_POINTS);
    if (ranges.length === 0) {
      omit(artifact, 'no_visible_content', points.length);
      continue;
    }
    candidates.push({
      artifact,
      route: decision.route,
      bucket: decision.bucket,
      priority: decision.priority,
      artifactClass: decision.route === 'interpret' ? decision.artifactClass : null,
      points,
      ranges,
      order: 0,
    });
  }

  const entries = declaredEntryPoints(artifacts);
  const sourceFiles = candidates.filter(
    (candidate) => candidate.artifact.sourceType === 'github' && candidate.bucket === 'source',
  );
  orderSourceFiles(sourceFiles, entries).forEach((candidate, index) => {
    candidate.order = index;
  });
  const ordered = [...candidates].sort(artifactOrder);

  const eligible: Record<Bucket, number> = { statement: 0, source: 0, metadata: 0 };
  const shown: Record<Bucket, number> = { statement: 0, source: 0, metadata: 0 };
  const passages: Passage[] = [];
  const coverage: ArtifactCoverage[] = [];

  /** How many leading passages of each candidate are shown (v1: first-come; v2: see selection-v2.ts). */
  const decisions = new Map<Candidate, Decision>();
  if (policy === SELECTION_POLICY_V1) {
    const remaining: Record<Bucket, number> = {
      statement: budgets.statement,
      source: budgets.source,
      metadata: budgets.metadata,
    };
    const closed: Record<Bucket, boolean> = { statement: false, source: false, metadata: false };
    for (const candidate of ordered) {
      let count = 0;
      for (const range of candidate.ranges) {
        const length = range.end - range.start;
        if (closed[candidate.bucket]) continue;
        if (length > remaining[candidate.bucket]) {
          closed[candidate.bucket] = true;
          continue;
        }
        remaining[candidate.bucket] -= length;
        count += 1;
      }
      decisions.set(candidate, {
        shown: count,
        duplicateOf: null,
        role: 'statement',
        component: null,
      });
    }
  } else {
    const items = new Map<number, Candidate>();
    const selectionItems: SelectionItem[] = ordered.map((candidate, id) => {
      items.set(id, candidate);
      const isFile =
        candidate.artifact.sourceType === 'github' && candidate.artifact.key.startsWith('files/');
      return {
        id,
        key: candidate.artifact.key,
        sourceType: candidate.artifact.sourceType,
        bucket: candidate.bucket,
        priority: candidate.priority,
        lengths: candidate.ranges.map((range) => range.end - range.start),
        textDigest:
          isFile && candidate.points.length >= 200
            ? `${candidate.bucket}:${createHash('sha256').update(candidate.artifact.text).digest('hex')}`
            : null,
        artifactClass: candidate.artifactClass,
      };
    });
    const chosen = selectV2(selectionItems, budgets, entries);
    for (const [id, decision] of chosen) {
      const candidate = items.get(id);
      if (candidate) decisions.set(candidate, decision);
    }
  }

  for (const candidate of ordered) {
    const { artifact, bucket } = candidate;
    const decision = decisions.get(candidate);
    const count = decision?.shown ?? 0;
    const duplicateOf = decision?.duplicateOf ?? null;
    const total = candidate.ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
    const shownRanges = candidate.ranges.slice(0, count);
    let shownHere = 0;
    for (const range of shownRanges) {
      shownHere += range.end - range.start;
      passages.push({
        handle: '',
        route: candidate.route,
        sourceType: artifact.sourceType,
        artifactClass: candidate.artifactClass,
        snapshotId: artifact.snapshotId,
        artifactId: artifact.artifactId,
        artifactKey: artifact.key,
        start: range.start,
        end: range.end,
        text: sliceOf(candidate.points, range.start, range.end),
      });
    }
    // A byte-identical copy of a file that IS shown adds nothing to the evidence: it is reported, not counted as unseen material.
    if (duplicateOf === null) eligible[bucket] += total;
    shown[bucket] += shownHere;
    if (shownHere < total) {
      omit(
        artifact,
        duplicateOf !== null ? 'duplicate_content' : 'budget_exhausted',
        total,
        shownHere,
      );
    }
    const unshown: Range[] = [];
    if (shownHere < total) {
      const lastShown = shownRanges[shownRanges.length - 1];
      unshown.push({ start: lastShown ? lastShown.end : 0, end: candidate.points.length });
    }
    coverage.push({
      snapshotId: artifact.snapshotId,
      artifactId: artifact.artifactId,
      artifactKey: artifact.key,
      sourceType: artifact.sourceType,
      bucket,
      role: decision?.role ?? 'statement',
      component: decision?.component ?? null,
      status:
        duplicateOf !== null
          ? 'duplicate'
          : shownHere === 0
            ? 'unseen'
            : shownHere < total
              ? 'partial'
              : 'full',
      totalCodePoints: total,
      shownCodePoints: shownHere,
      shownRanges: shownRanges.map(({ start, end }) => ({ start, end })),
      unshownRanges: unshown,
      duplicateOf,
    });
  }

  const handled = passages.map((passage, index) => ({
    ...passage,
    handle: `P-${String(index + 1).padStart(4, '0')}`,
  }));
  const bucketUse = (bucket: Bucket): BucketUse => ({
    bucket,
    budget: budgets[bucket],
    shownCodePoints: shown[bucket],
    eligibleCodePoints: eligible[bucket],
    sampled: shown[bucket] < eligible[bucket],
  });
  return {
    passages: handled,
    omissions: omissions.sort(
      (a, b) =>
        compareCodePoints(a.artifactKey, b.artifactKey) ||
        compareCodePoints(a.snapshotId, b.snapshotId) ||
        compareCodePoints(a.reason, b.reason),
    ),
    buckets: (['statement', 'source', 'metadata'] as const).map(bucketUse),
    coverage: coverageReport(coverage, policy),
    policy: { windowing: WINDOWING_POLICY, selection: policy },
  };
}

/** Components and the verdict, computed from the per-artifact records only. */
function coverageReport(
  artifacts: readonly ArtifactCoverage[],
  policy: SelectionPolicyId,
): CoverageReport {
  const ordered = [...artifacts].sort(
    (a, b) =>
      compareCodePoints(a.artifactKey, b.artifactKey) ||
      compareCodePoints(a.snapshotId, b.snapshotId) ||
      compareCodePoints(a.artifactId, b.artifactId),
  );
  // v1 records no roles; its components are derived here from the path so that old and new selections are measured identically.
  const isImplementation = (a: ArtifactCoverage): boolean =>
    a.sourceType === 'github' &&
    a.bucket === 'source' &&
    a.status !== 'duplicate' &&
    (policy === SELECTION_POLICY_V1
      ? implementationLike(a.artifactKey)
      : a.role === 'implementation');
  const byComponent = new Map<string, ComponentCoverage>();
  for (const a of ordered.filter(isImplementation)) {
    const name = repositoryComponent(a.artifactKey.slice('files/'.length));
    const current = byComponent.get(name) ?? {
      component: name,
      implementationFiles: 0,
      implementationFilesShown: 0,
      implementationCodePoints: 0,
      implementationCodePointsShown: 0,
    };
    byComponent.set(name, {
      component: name,
      implementationFiles: current.implementationFiles + 1,
      implementationFilesShown: current.implementationFilesShown + (a.shownCodePoints > 0 ? 1 : 0),
      implementationCodePoints: current.implementationCodePoints + a.totalCodePoints,
      implementationCodePointsShown: current.implementationCodePointsShown + a.shownCodePoints,
    });
  }
  const components = [...byComponent.values()].sort((a, b) =>
    compareCodePoints(a.component, b.component),
  );
  const concerns: CoverageConcern[] = [];
  const unfinished = (roles: readonly Decision['role'][], bucket: Bucket) =>
    ordered.some(
      (a) =>
        a.bucket === bucket &&
        roles.includes(a.role) &&
        (a.status === 'partial' || a.status === 'unseen'),
    );
  const implementationShown = components.reduce((n, c) => n + c.implementationFilesShown, 0);
  const seenComponents = components.filter((c) => c.implementationFilesShown > 0).length;
  const implementationUnfinished = ordered.some(
    (a) => isImplementation(a) && (a.status === 'partial' || a.status === 'unseen'),
  );
  let insufficient = false;
  if (components.length > 0 && implementationShown === 0) {
    concerns.push('no_implementation_shown');
    insufficient = true;
  } else if (components.length > 0 && seenComponents < components.length) {
    concerns.push('implementation_components_unseen');
    if (seenComponents / components.length < COVERAGE_POLICY.insufficientBelowComponentFraction)
      insufficient = true;
  }
  if (implementationUnfinished && !concerns.includes('no_implementation_shown'))
    concerns.push('implementation_partially_seen');
  if (policy !== SELECTION_POLICY_V1) {
    if (unfinished(['statement'], 'statement')) concerns.push('documentation_partially_seen');
    if (unfinished(['deployment', 'manifest', 'config'], 'source'))
      concerns.push('configuration_partially_seen');
    if (unfinished(['test'], 'source')) concerns.push('tests_partially_seen');
  } else if (
    ordered.some(
      (a) => a.bucket === 'statement' && (a.status === 'partial' || a.status === 'unseen'),
    )
  ) {
    concerns.push('documentation_partially_seen');
  }
  const anyUnshown = ordered.some((a) => a.status === 'partial' || a.status === 'unseen');
  const verdict: CoverageVerdict = insufficient
    ? 'insufficient'
    : anyUnshown
      ? 'partial'
      : 'complete';
  return { artifacts: ordered, components, verdict, concerns };
}

/** v1 recorded no roles: a source-bucket file counts as implementation when its path does not look like a test, config or generated file. */
function implementationLike(key: string): boolean {
  return repositoryRole(key.slice('files/'.length)) === 'implementation';
}

/** A label for a prompt: the artifact key, shortened deterministically when it exceeds the prompt label limit. */
export function artifactLabel(key: string, maxCodePoints = 200): string {
  const points = toCodePoints(key);
  if (points.length <= maxCodePoints) return key;
  const head = Math.floor((maxCodePoints - 1) / 2);
  const tail = maxCodePoints - 1 - head;
  return `${sliceOf(points, 0, head)}…${sliceOf(points, points.length - tail, points.length)}`;
}

export interface StatementPassageView {
  readonly handle: string;
  readonly sourceType: RoutedSourceType;
  readonly artifact: string;
  readonly text: string;
}
export interface InterpretPassageView extends StatementPassageView {
  readonly artifactClass: InterpretClass;
}

/** Plain objects in the shape the S2 prompt takes. (The prompts package validates them; this package never imports it.) */
export function statementViews(passages: readonly Passage[]): StatementPassageView[] {
  return passages
    .filter((passage) => passage.route === 'statement')
    .map((passage) => ({
      handle: passage.handle,
      sourceType: passage.sourceType,
      artifact: artifactLabel(passage.artifactKey),
      text: passage.text,
    }));
}

/** Plain objects in the shape the S3 prompt takes. */
export function interpretViews(passages: readonly Passage[]): InterpretPassageView[] {
  return passages.flatMap((passage) =>
    passage.route === 'interpret' && passage.artifactClass !== null
      ? [
          {
            handle: passage.handle,
            sourceType: passage.sourceType,
            artifact: artifactLabel(passage.artifactKey),
            artifactClass: passage.artifactClass,
            text: passage.text,
          },
        ]
      : [],
  );
}
