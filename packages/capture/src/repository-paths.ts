/*
 * Deterministic repository file selection. Repository contents are data: they are read through
 * read-only APIs, stored as bounded text and never executed, installed, built or imported
 * (invariants 7, 21). Secret-prone paths are never fetched at all, so their content cannot reach
 * a snapshot, a log or a later model prompt. More files never means a better project.
 */

export type RepositoryOmissionReason =
  | 'secret_prone_path'
  | 'ignored_directory'
  | 'binary_extension'
  | 'lockfile'
  | 'unsupported_file_type'
  | 'symlink'
  | 'path_too_long'
  | 'unsafe_path'
  | 'submodule'
  | 'file_too_large'
  | 'binary_content'
  | 'file_count_limit'
  | 'total_text_limit'
  | 'blob_unavailable'
  | 'blob_integrity_mismatch'
  | 'time_budget_exhausted';

export type PathClassification =
  | { readonly include: true; readonly priority: number }
  | { readonly include: false; readonly reason: RepositoryOmissionReason };

/**
 * True when a repository path is a plain relative path of ordinary segments. A hostile or malformed tree can contain anything: traversal
 * (`..`), absolute paths, backslashes (a Windows separator), drive letters, empty segments and control characters (NUL included). Such a path is
 * never a file of the repository as Git defines it (Git itself refuses `..`, empty and `.git` components), and it must never become an artifact
 * key, a database row or a file name on someone's disk.
 */
export function isSafeRepositoryPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/u.test(path)) return false;
  const segments = path.split('/');
  if (/^[A-Za-z]:/.test(segments[0] ?? '')) return false;
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Generated, vendored or VCS trees that are skipped entirely. */
export const IGNORED_DIRECTORIES: readonly string[] = [
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  'coverage',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'bower_components',
  '.turbo',
];

/** Directories that conventionally hold credentials. */
export const SECRET_DIRECTORIES: readonly string[] = ['.ssh', '.aws', '.gnupg', '.kube'];

const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.ppk'];
const SECRET_PREFIXES = [
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'secrets',
  'service-account',
];
const SECRET_NAMES = ['.npmrc', '.pypirc', '.netrc', '.htpasswd', '.git-credentials', '.dockercfg'];

/**
 * Secret-prone file names (case-insensitive): `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`,
 * `*.pfx`, `id_rsa*`, `id_ed25519*`, `credentials*`, `secrets*`, `service-account*` and similar.
 */
export function isSecretProneName(basename: string): boolean {
  const name = basename.toLowerCase();
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    SECRET_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    SECRET_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    SECRET_NAMES.includes(name)
  );
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tif', 'tiff', 'psd', 'heic', 'avif',
  'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ogg',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war', 'apk', 'ipa', 'dmg', 'iso',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'pyo', 'wasm', 'node',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'db', 'pkl', 'pickle', 'npy', 'npz', 'h5', 'onnx', 'pt', 'pth', 'ckpt', 'safetensors', 'parquet',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages',
  'blend', 'fbx', 'glb', 'unitypackage', 'uasset',
]); // prettier-ignore

/** Source, configuration and documentation formats captured as text. */
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'py', 'ipynb', 'rs', 'go', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'ino',
  'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'swift', 'm', 'mm', 'cs', 'fs', 'dart',
  'v', 'sv', 'svh', 'vhd', 'vhdl', 'xdc', 'tcl',
  'rb', 'php', 'lua', 'r', 'jl', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'zig', 'nim', 'sol',
  'sql', 'graphql', 'gql', 'proto', 'prisma', 'tf',
  'sh', 'bash', 'zsh', 'ps1',
  'md', 'mdx', 'rst', 'txt', 'adoc',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'plist',
  'css', 'scss', 'sass', 'less', 'html', 'htm',
]); // prettier-ignore

/** Well-known manifests and configuration files without a captured extension (lowercase). */
const KNOWN_TEXT_NAMES = new Set([
  'dockerfile',
  'containerfile',
  'makefile',
  'procfile',
  'gemfile',
  'rakefile',
  'pipfile',
  'justfile',
  'vagrantfile',
  'license',
  'licence',
  'copying',
  'notice',
  'readme',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.nvmrc',
  '.python-version',
  '.tool-versions',
  'go.mod',
]);

/** Root-level manifests captured before ordinary source files. */
const ROOT_MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'pipfile',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'gemfile',
  'composer.json',
  'deno.json',
  'tsconfig.json',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
  'makefile',
  'cmakelists.txt',
  'vercel.json',
  'netlify.toml',
  'app.json',
]);

function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : '';
}

/**
 * Classifies a repository path without looking at its content. Lower priority values are
 * selected first: 0 root README, 1 root manifests and licences, 2 other READMEs and docs, 3 the
 * rest. Ties are broken by depth, then by path (see `compareSelection`).
 */
export function classifyRepositoryPath(path: string): PathClassification {
  if (!isSafeRepositoryPath(path)) return { include: false, reason: 'unsafe_path' };
  const segments = path.split('/');
  const basename = segments[segments.length - 1] ?? '';
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  if (directories.some((segment) => SECRET_DIRECTORIES.includes(segment))) {
    return { include: false, reason: 'secret_prone_path' };
  }
  if (isSecretProneName(basename)) return { include: false, reason: 'secret_prone_path' };
  if (directories.some((segment) => IGNORED_DIRECTORIES.includes(segment))) {
    return { include: false, reason: 'ignored_directory' };
  }
  const lower = basename.toLowerCase();
  if (LOCKFILES.has(lower)) return { include: false, reason: 'lockfile' };
  const extension = extensionOf(basename);
  if (BINARY_EXTENSIONS.has(extension)) return { include: false, reason: 'binary_extension' };
  const isReadme = lower === 'readme' || lower.startsWith('readme.');
  const isText = TEXT_EXTENSIONS.has(extension) || KNOWN_TEXT_NAMES.has(lower) || isReadme;
  if (!isText) return { include: false, reason: 'unsupported_file_type' };
  const atRoot = directories.length === 0;
  if (atRoot && isReadme) return { include: true, priority: 0 };
  if (atRoot && (ROOT_MANIFESTS.has(lower) || lower.startsWith('license'))) {
    return { include: true, priority: 1 };
  }
  if (isReadme || directories[0] === 'docs') return { include: true, priority: 2 };
  return { include: true, priority: 3 };
}

/** Deterministic selection order: priority, then depth, then path by code unit. */
export function compareSelection(
  a: { readonly path: string; readonly priority: number },
  b: { readonly path: string; readonly priority: number },
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const depth = a.path.split('/').length - b.path.split('/').length;
  if (depth !== 0) return depth;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

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

/**
 * The part of a repository a path belongs to: `packages/x` for a monorepo package, otherwise its top-level directory, `(root)` for a file at
 * the root. It must agree with `repositoryComponent` of the assessment package (tests/integration pins the two together), because capture
 * decides which files exist at all and selection decides which of those a model sees.
 */
export function captureComponent(path: string): string {
  const segments = path.split('/');
  if (segments.length === 1) return '(root)';
  const first = segments[0] ?? '';
  return MONOREPO_ROOTS.has(first.toLowerCase()) && segments.length >= 3
    ? `${first}/${segments[1] ?? ''}`
    : first;
}

function scrambled(name: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/**
 * The order in which candidate files are taken when the file-count or total-text limit will cut the list. Root README and manifests first
 * (priority 0 and 1), then the rest ROUND-ROBIN across components: one file of every component before a second of any, each component's own
 * files in `compareSelection` order. The previous order (priority, depth, then path across the whole repository) let the alphabet decide which
 * parts of a large repository existed at all in the snapshot: a repository of thirty packages lost whole packages. Components are visited in
 * a fixed scrambled order, never alphabetically and never by size.
 */
export function orderCandidatesForCapture<
  T extends { readonly path: string; readonly priority: number },
>(candidates: readonly T[]): T[] {
  const head = candidates.filter((c) => c.priority <= 1).sort(compareSelection);
  const groups = new Map<string, T[]>();
  for (const candidate of candidates.filter((c) => c.priority > 1)) {
    const name = captureComponent(candidate.path);
    const list = groups.get(name);
    if (list) list.push(candidate);
    else groups.set(name, [candidate]);
  }
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => scrambled(a) - scrambled(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([, list]) => list.sort(compareSelection));
  const rest: T[] = [];
  for (let round = 0; ; round += 1) {
    let any = false;
    for (const list of ordered) {
      const item = list[round];
      if (item) {
        rest.push(item);
        any = true;
      }
    }
    if (!any) break;
  }
  return [...head, ...rest];
}

/** True when decoded content looks binary (NUL bytes). Such files are never stored. */
export function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}
