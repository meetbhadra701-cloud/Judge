/*
 * Conservative, fail-closed classification of repository snapshot artifacts, using only the
 * metadata M2 actually records: the artifact key, kind and media type.
 *
 * M2 stores GitHub repository files as kind `file`, key `files/<repository path>`, with a media
 * type derived from the extension (`text/markdown`, `application/json`, `text/html`,
 * `application/yaml`, otherwise `text/plain`). Every other GitHub artifact (`repository.json`,
 * `commits.json`, `tree.json`, `omissions.json`) has another kind.
 *
 * Why this exists: a README is still prose written by the team, and so are documentation,
 * commit messages and descriptions. Living inside a GitHub snapshot does not make them
 * corroborating repository material. Only evidence anchored in an artifact classified
 * `source_code` may carry `repo_corroborated`. Anything that cannot be classified safely is
 * `unclassified`, which also cannot corroborate.
 *
 * Limitation: classification is per file. A span inside a source file may still quote a comment
 * the team wrote; the planner cannot tell, and this module does not pretend to.
 */

export type RepositoryArtifactClass = 'team_prose' | 'source_code' | 'unclassified';

export interface ArtifactMetadata {
  readonly key: string;
  readonly kind: string;
  readonly mediaType: string;
}

/** Prose and documentation extensions (team-authored text). */
const PROSE_EXTENSIONS = new Set([
  'md',
  'mdx',
  'markdown',
  'rst',
  'txt',
  'adoc',
  'asciidoc',
  'html',
  'htm',
]);

/** Media types M2 assigns to prose. `text/plain` is deliberately absent: it is M2's default for everything. */
const PROSE_MEDIA_TYPES = new Set([
  'text/markdown',
  'text/x-markdown',
  'text/html',
  'text/asciidoc',
]);

/** Base names (without extension, lowercase) that are documentation whatever their extension. */
const PROSE_BASENAMES = new Set(['readme', 'changelog', 'contributing', 'authors', 'notice']);

/** Directory names that hold documentation. Everything beneath them is prose. */
const DOC_DIRECTORIES = new Set(['docs', 'doc', 'documentation', 'wiki']);

/** Programming-language source extensions. Configuration, data and lock files are NOT included. */
const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'cs',
  'rb',
  'php',
  'dart',
  'lua',
  'ex',
  'exs',
  'erl',
  'hs',
  'clj',
  'sql',
  'sol',
  'vue',
  'svelte',
]);

/** The repository path of a `file` artifact (`files/src/a.ts` → `src/a.ts`). */
function repositoryPath(key: string): string {
  return key.startsWith('files/') ? key.slice('files/'.length) : key;
}

export function classifyRepositoryArtifact(artifact: ArtifactMetadata): RepositoryArtifactClass {
  // Metadata artifacts (repository description, commit history, tree listing, omissions) are not
  // repository source: commit messages and descriptions are team-authored text.
  if (artifact.kind !== 'file') return 'unclassified';

  const path = repositoryPath(artifact.key).toLowerCase();
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const basename = segments[segments.length - 1] ?? '';
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const extension = dot > 0 ? basename.slice(dot + 1) : '';

  // Prose is decided first, so example code inside docs/ or README.* stays prose.
  if (
    PROSE_MEDIA_TYPES.has(artifact.mediaType) ||
    PROSE_BASENAMES.has(stem) ||
    PROSE_EXTENSIONS.has(extension) ||
    segments.slice(0, -1).some((segment) => DOC_DIRECTORIES.has(segment))
  ) {
    return 'team_prose';
  }
  if (SOURCE_EXTENSIONS.has(extension)) return 'source_code';
  return 'unclassified';
}
