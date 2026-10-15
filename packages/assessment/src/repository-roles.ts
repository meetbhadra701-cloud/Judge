/*
 * What a repository file IS, from its path alone (source-selection/v2). Deterministic, content-independent: the text of a file can never move it
 * between roles, so a file cannot talk its way into the evidence budget. The roles decide how a file competes for the SOURCE budget; they do not
 * say that any role is "better" evidence than another.
 */

export const REPOSITORY_ROLE_VALUES = [
  'deployment',
  'manifest',
  'config',
  'implementation',
  'test',
  'generated',
] as const;
export type RepositoryRole = (typeof REPOSITORY_ROLE_VALUES)[number];

const MONOREPO_ROOTS = new Set([
  'packages',
  'apps',
  'libs',
  'services',
  'modules',
  'crates',
  'cmd',
  'plugins',
  'workspaces',
]);
const GENERATED_DIRECTORIES = new Set([
  'generated',
  '__generated__',
  '__snapshots__',
  'snapshots',
  '.generated',
  'gen',
]);
const DEPLOYMENT_DIRECTORIES = new Set([
  'deploy',
  'deployment',
  'infra',
  'infrastructure',
  'k8s',
  'kubernetes',
  'helm',
  'terraform',
  'ansible',
  '.circleci',
]);
const TEST_DIRECTORIES = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  '__mocks__',
  'fixtures',
]);
const MANIFESTS = new Set([
  'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'requirements.txt', 'pipfile', 'gemfile', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'deno.json', 'setup.py', 'cmakelists.txt',
]); // prettier-ignore
const DEPLOYMENT_NAMES = new Set([
  'vercel.json', 'netlify.toml', 'fly.toml', 'render.yaml', 'serverless.yml', 'serverless.yaml', 'procfile', 'app.yaml', 'now.json',
  'railway.json', 'wrangler.toml', 'firebase.json', 'amplify.yml',
]); // prettier-ignore
const CONFIG_EXTENSIONS = new Set([
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'plist',
  'env',
]);

const lower = (value: string): string => value.toLowerCase();
const extensionOf = (base: string): string =>
  base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';

/** The role of a repository path (the path after `files/`). */
export function repositoryRole(path: string): RepositoryRole {
  const segments = lower(path).split('/');
  const base = segments[segments.length - 1] ?? '';
  const directories = segments.slice(0, -1);
  const extension = extensionOf(base);
  if (
    directories.some((d) => GENERATED_DIRECTORIES.has(d)) ||
    // schema/migration snapshots written by a tool (drizzle, prisma, alembic): `.../meta/0007_snapshot.json`
    (directories.includes('meta') && base.includes('snapshot')) ||
    extension === 'snap' ||
    extension === 'map' ||
    base.endsWith('.min.js') ||
    base.endsWith('.min.css') ||
    base.endsWith('.d.ts') ||
    base.endsWith('.lock') ||
    base === 'package-lock.json' ||
    base.includes('.generated.')
  ) {
    return 'generated';
  }
  if (
    base.startsWith('dockerfile') ||
    base.startsWith('containerfile') ||
    base.startsWith('docker-compose') ||
    /^compose\.ya?ml$/.test(base) ||
    path.startsWith('.github/workflows/') ||
    path.startsWith('.gitlab-ci') ||
    DEPLOYMENT_NAMES.has(base) ||
    directories.some((d) => DEPLOYMENT_DIRECTORIES.has(d))
  ) {
    return 'deployment';
  }
  if (
    directories.some((d) => TEST_DIRECTORIES.has(d)) ||
    base.includes('.test.') ||
    base.includes('.spec.') ||
    base.startsWith('test_') ||
    base.endsWith('_test.go') ||
    base.endsWith('_test.py')
  ) {
    return 'test';
  }
  if (MANIFESTS.has(base)) return 'manifest';
  if (
    base.startsWith('tsconfig') ||
    base.includes('.config.') ||
    base.startsWith('.eslintrc') ||
    base.startsWith('.prettierrc') ||
    CONFIG_EXTENSIONS.has(extension)
  ) {
    return 'config';
  }
  return 'implementation';
}

/**
 * The unit a repository path belongs to: `packages/x`, `apps/y`, ... in a monorepo, otherwise the top-level directory; `(root)` for a file at the
 * root. Components are the unit of FAIRNESS: no component's implementation may be left unseen while another is read in depth.
 */
export function repositoryComponent(path: string): string {
  const segments = path.split('/');
  if (segments.length === 1) return '(root)';
  const first = segments[0] ?? '';
  if (MONOREPO_ROOTS.has(lower(first)) && segments.length >= 3)
    return `${first}/${segments[1] ?? ''}`;
  return first;
}

/** 32-bit FNV-1a: a fixed, content-independent scrambling of names, so no component is favoured by where it sorts alphabetically. */
export function nameHash(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
