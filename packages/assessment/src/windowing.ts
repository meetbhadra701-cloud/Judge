import { isPassageBarrier, hasVisibleContent, sliceOf, toCodePoints } from './text.js';
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
 * Selection (source-selection/v1): priority classes first (Devpost, README/docs, deployment, video, repository metadata, source),
 * source files by manifests and entry points, then breadth-first round-robin across top-level directories, ties by path in code-point
 * order. Never by size, line count, commit count, stars or keywords. Every omission is returned with a reason; nothing disappears
 * silently. Handles `P-0001`... follow the final order, so identical inputs give identical handles regardless of input order.
 */

export const WINDOWING_POLICY = 'windowing/v1' as const;
export const SELECTION_POLICY = 'source-selection/v1' as const;
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

export interface WindowingResult {
  readonly passages: readonly Passage[];
  readonly omissions: readonly Omission[];
  readonly buckets: readonly BucketUse[];
  readonly policy: {
    readonly windowing: typeof WINDOWING_POLICY;
    readonly selection: typeof SELECTION_POLICY;
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

interface Range {
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

  const remaining: Record<Bucket, number> = {
    statement: budgets.statement,
    source: budgets.source,
    metadata: budgets.metadata,
  };
  const closed: Record<Bucket, boolean> = { statement: false, source: false, metadata: false };
  const eligible: Record<Bucket, number> = { statement: 0, source: 0, metadata: 0 };
  const shown: Record<Bucket, number> = { statement: 0, source: 0, metadata: 0 };
  const passages: Passage[] = [];

  for (const candidate of ordered) {
    const { artifact, bucket } = candidate;
    let shownHere = 0;
    for (const range of candidate.ranges) {
      const length = range.end - range.start;
      eligible[bucket] += length;
      if (closed[bucket]) continue;
      if (length > remaining[bucket]) {
        closed[bucket] = true;
        continue;
      }
      remaining[bucket] -= length;
      shown[bucket] += length;
      shownHere += length;
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
    const total = candidate.ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
    if (shownHere < total) omit(artifact, 'budget_exhausted', total, shownHere);
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
    policy: { windowing: WINDOWING_POLICY, selection: SELECTION_POLICY },
  };
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
