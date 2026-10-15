import type { WindowingResult, SourceArtifact } from '../windowing.js';

/*
 * The ORACLE for the evidence-coverage experiments (P6B-beta3, R9-B1). It judges a selection by what was actually SHOWN (the passages: artifact key
 * plus code-point range) against the original artifacts, and it classifies files with its own, simple, path-only rules. It imports nothing from
 * the selection code (not even the router): if the selection and the oracle shared a classifier, the oracle could not catch the classifier's mistakes.
 */

export type Role =
  | 'prose'
  | 'manifest'
  | 'config'
  | 'deployment'
  | 'test'
  | 'generated'
  | 'implementation'
  | 'other';

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'vue', 'svelte', 'sql', 'sh', 'tf',
]); // prettier-ignore

const MONOREPO_ROOTS = new Set([
  'packages',
  'apps',
  'libs',
  'services',
  'modules',
  'crates',
  'cmd',
]);

/** The repository path of a captured file artifact, or null for the capture's own metadata artifacts. */
export const pathOf = (
  artifact: Pick<SourceArtifact, 'key' | 'kind' | 'sourceType'>,
): string | null =>
  artifact.sourceType === 'github' && artifact.kind === 'file' && artifact.key.startsWith('files/')
    ? artifact.key.slice('files/'.length)
    : null;

export function oracleRole(path: string): Role {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const base = segments[segments.length - 1] ?? '';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (
    segments.includes('generated') ||
    segments.includes('__snapshots__') ||
    (segments.includes('meta') && lower.includes('snapshot')) ||
    ext === 'snap' ||
    base.endsWith('.min.js') ||
    base.endsWith('.lock') ||
    base === 'package-lock.json'
  ) {
    return 'generated';
  }
  if (['md', 'mdx', 'rst', 'txt', 'adoc'].includes(ext) || segments.slice(0, -1).includes('docs'))
    return 'prose';
  if (
    base.startsWith('dockerfile') ||
    base.startsWith('docker-compose') ||
    base.startsWith('compose.') ||
    lower.startsWith('.github/workflows/') ||
    ['infra', 'deploy', 'k8s', 'terraform', 'helm'].some((dir) =>
      segments.slice(0, -1).includes(dir),
    ) ||
    base === 'vercel.json' ||
    base === 'netlify.toml'
  ) {
    return 'deployment';
  }
  if (
    segments.slice(0, -1).some((s) => s === 'test' || s === 'tests' || s === '__tests__') ||
    base.includes('.test.') ||
    base.includes('.spec.')
  ) {
    return 'test';
  }
  if (
    [
      'package.json',
      'pyproject.toml',
      'cargo.toml',
      'go.mod',
      'requirements.txt',
      'gemfile',
    ].includes(base)
  )
    return 'manifest';
  if (
    base.startsWith('tsconfig') ||
    base.includes('.config.') ||
    ['json', 'yaml', 'yml', 'toml', 'ini', 'cfg'].includes(ext)
  )
    return 'config';
  if (SOURCE_EXTENSIONS.has(ext)) return 'implementation';
  return 'other';
}

/** `packages/x`, `apps/y`, ... for a monorepo package; otherwise the top-level directory; `(root)` for a file at the root. */
export function componentOf(path: string): string {
  const segments = path.split('/');
  if (segments.length === 1) return '(root)';
  const first = segments[0] ?? '';
  if (MONOREPO_ROOTS.has(first) && segments.length >= 3) return `${first}/${segments[1] ?? ''}`;
  return first;
}

interface FileFacts {
  readonly key: string;
  readonly path: string;
  readonly role: Role;
  readonly component: string;
  readonly total: number;
  readonly shown: number;
  readonly bucket: 'statement' | 'source' | 'metadata';
}

export interface RoleCoverage {
  readonly files: number;
  readonly filesShown: number;
  readonly codePoints: number;
  readonly codePointsShown: number;
}

export interface Metrics {
  readonly byRole: Readonly<Record<Role, RoleCoverage>>;
  /** Components that contain at least one implementation file, and how many have at least one implementation passage shown. */
  readonly implementationComponents: {
    readonly total: number;
    readonly covered: number;
    readonly uncovered: readonly string[];
  };
  readonly componentCoverage: number;
  /** The largest share of its bucket's BUDGET that one file consumed, over the three buckets. */
  readonly maxArtifactShare: { readonly key: string; readonly share: number };
  /** Some eligible file of the source bucket was not shown at all. */
  readonly unshownEligibleSourceFiles: number;
  /**
   * Implementation files with nothing shown, EXCLUDING byte-identical copies of a file that was shown (a copy carries no unseen content).
   * Oracle refinement after the first v2 run (reported); computed from the artifact texts, not from the selection's own duplicate detection.
   */
  readonly unshownDistinctImplementationFiles: number;
  readonly buckets: WindowingResult['buckets'];
  readonly rootReadmeShown: number;
  readonly rootReadmeLength: number;
  readonly deployment: {
    readonly files: number;
    readonly headsShown: number;
    readonly codePoints: number;
  };
  readonly testShareOfSource: number;
  readonly generatedShareOfSource: number;
  readonly sourceUtilization: number;
}

const ROLES: readonly Role[] = [
  'prose',
  'manifest',
  'config',
  'deployment',
  'test',
  'generated',
  'implementation',
  'other',
];

/** Code points shown per artifact key, from the passages. */
export function shownByKey(result: WindowingResult): Map<string, number> {
  const shown = new Map<string, number>();
  for (const passage of result.passages) {
    shown.set(
      passage.artifactKey,
      (shown.get(passage.artifactKey) ?? 0) + (passage.end - passage.start),
    );
  }
  return shown;
}

export function measure(artifacts: readonly SourceArtifact[], result: WindowingResult): Metrics {
  const shown = shownByKey(result);
  const bucketOfRoute = new Map(
    result.passages.map(
      (p) => [p.artifactKey, p.route === 'statement' ? 'statement' : 'source'] as const,
    ),
  );
  const facts: FileFacts[] = [];
  for (const artifact of artifacts) {
    const path = pathOf(artifact);
    if (path === null) continue;
    const role = oracleRole(path);
    let total = 0;
    for (const _ of artifact.text) total += 1; // code points
    facts.push({
      key: artifact.key,
      path,
      role,
      component: componentOf(path),
      total,
      shown: shown.get(artifact.key) ?? 0,
      bucket: role === 'prose' ? 'statement' : (bucketOfRoute.get(artifact.key) ?? 'source'),
    });
  }
  const byRole = Object.fromEntries(
    ROLES.map((role) => {
      const rows = facts.filter((f) => f.role === role);
      return [
        role,
        {
          files: rows.length,
          filesShown: rows.filter((f) => f.shown > 0).length,
          codePoints: rows.reduce((s, f) => s + f.total, 0),
          codePointsShown: rows.reduce((s, f) => s + f.shown, 0),
        },
      ];
    }),
  ) as Record<Role, RoleCoverage>;

  const implementation = facts.filter((f) => f.role === 'implementation');
  const components = [...new Set(implementation.map((f) => f.component))].sort();
  const uncovered = components.filter(
    (c) => !implementation.some((f) => f.component === c && f.shown > 0),
  );
  const budget = (b: 'statement' | 'source' | 'metadata') =>
    result.buckets.find((x) => x.bucket === b)?.budget ?? 1;
  let max = { key: '', share: 0 };
  for (const f of facts) {
    const share = f.shown / budget(f.bucket);
    if (share > max.share) max = { key: f.key, share };
  }
  const textOf = new Map(artifacts.map((a) => [a.key, a.text] as const));
  const shownTexts = new Set(facts.filter((f) => f.shown > 0).map((f) => textOf.get(f.key)));
  const unshownDistinctImplementation = implementation.filter(
    (f) => f.shown === 0 && !shownTexts.has(textOf.get(f.key)),
  ).length;
  const sourceFacts = facts.filter((f) => f.role !== 'prose');
  const sourceShown = sourceFacts.reduce((s, f) => s + f.shown, 0);
  const readme = facts.find((f) => f.path.toLowerCase() === 'readme.md');
  const deployment = facts.filter((f) => f.role === 'deployment');
  const sourceBucket = result.buckets.find((b) => b.bucket === 'source');
  return {
    byRole,
    implementationComponents: {
      total: components.length,
      covered: components.length - uncovered.length,
      uncovered,
    },
    componentCoverage:
      components.length === 0 ? 1 : (components.length - uncovered.length) / components.length,
    maxArtifactShare: max,
    unshownDistinctImplementationFiles: unshownDistinctImplementation,
    unshownEligibleSourceFiles: sourceFacts.filter((f) => f.shown === 0 && f.role !== 'generated')
      .length,
    buckets: result.buckets,
    rootReadmeShown: readme?.shown ?? 0,
    rootReadmeLength: readme?.total ?? 0,
    deployment: {
      files: deployment.length,
      // Oracle refinement after the first v2 run (reported): a passage ends at a line boundary, so a file's first passage may hold fewer than
      // 1,200 code points; "head shown" means the first passage was shown, not a fixed number of code points.
      headsShown: deployment.filter((f) => f.shown > 0).length,
      codePoints: deployment.reduce((s, f) => s + f.total, 0),
    },
    testShareOfSource: sourceShown === 0 ? 0 : byRole.test.codePointsShown / sourceShown,
    generatedShareOfSource: sourceShown === 0 ? 0 : byRole.generated.codePointsShown / sourceShown,
    sourceUtilization:
      sourceBucket && sourceBucket.eligibleCodePoints > 0
        ? sourceBucket.shownCodePoints /
          Math.min(sourceBucket.budget, sourceBucket.eligibleCodePoints)
        : 1,
  };
}
