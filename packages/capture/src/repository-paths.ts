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

/** True when decoded content looks binary (NUL bytes). Such files are never stored. */
export function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}
