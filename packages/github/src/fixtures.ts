import { createHash } from 'node:crypto';
import { GITHUB_API_ORIGIN } from './adapter.js';
import { gitBlobSha } from './git.js';

/*
 * Development/test tool: expands a small synthetic repository description into the exact GitHub
 * REST responses the adapter requests, with real Git blob ids (so integrity checks run for real)
 * and deterministic synthetic commit and tree ids. It is pure data generation: nothing here
 * contacts GitHub. The result plugs into the fixture network of `@judge-copilot/safe-http`.
 */

/** Structurally compatible with `FixtureResponse` from `@judge-copilot/safe-http`. */
export interface GithubFixtureResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly body?: string;
  readonly error?: 'connection_refused' | 'connection_reset' | 'tls' | 'hang';
}

export type GithubFixtureFile =
  string | { readonly base64: string } | { readonly fill: string; readonly bytes: number };

export interface GithubFixtureCommit {
  /** Fixture-local name, e.g. `A`. The commit SHA is derived from it deterministically. */
  readonly id: string;
  readonly message: string;
  readonly date: string;
  readonly author?: string;
  /** Full file set of the repository at this commit. */
  readonly files: Readonly<Record<string, GithubFixtureFile>>;
}

export interface GithubFixtureRepository {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch?: string;
  readonly description?: string;
  readonly language?: string;
  readonly stars?: number;
  /** Oldest first; each commit's parent is the previous one. */
  readonly commits: readonly GithubFixtureCommit[];
  /** Commit ids the default branch resolves to on successive lookups (branch movement). */
  readonly headSequence?: readonly string[];
  readonly treeTruncated?: boolean;
  /** Extra synthetic commits prepended to history (to exercise the commit limit). */
  readonly extraHistory?: number;
  /** Serve every blob request as a rate-limit response. */
  readonly rateLimitBlobs?: boolean;
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function fixtureCommitSha(repository: GithubFixtureRepository, id: string): string {
  return sha1(`fixture-commit:${repository.owner}/${repository.repo}:${id}`);
}

function fileBytes(file: GithubFixtureFile): Buffer {
  if (typeof file === 'string') return Buffer.from(file, 'utf8');
  if ('base64' in file) return Buffer.from(file.base64, 'base64');
  return Buffer.from(
    file.fill.repeat(Math.ceil(file.bytes / Math.max(file.fill.length, 1))).slice(0, file.bytes),
    'utf8',
  );
}

function directoriesOf(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return [...directories];
}

const json = (value: unknown): GithubFixtureResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'x-ratelimit-remaining': '4999' },
  json: value,
});

/** Builds `{ url: response }` routes for one synthetic repository. */
export function githubFixtureRoutes(
  repository: GithubFixtureRepository,
): Record<string, GithubFixtureResponse | GithubFixtureResponse[]> {
  const branch = repository.defaultBranch ?? 'main';
  const base = `${GITHUB_API_ORIGIN}/repos/${repository.owner}/${repository.repo}`;
  const routes: Record<string, GithubFixtureResponse | GithubFixtureResponse[]> = {};
  const lastCommit = repository.commits[repository.commits.length - 1];
  if (!lastCommit) throw new Error('A fixture repository needs at least one commit');

  routes[base] = json({
    name: repository.repo,
    full_name: `${repository.owner}/${repository.repo}`,
    html_url: `https://github.com/${repository.owner}/${repository.repo}`,
    description: repository.description ?? null,
    homepage: null,
    default_branch: branch,
    language: repository.language ?? null,
    license: { spdx_id: 'MIT' },
    topics: ['hackathon'],
    visibility: 'public',
    private: false,
    fork: false,
    archived: false,
    created_at: '2026-09-01T10:00:00Z',
    stargazers_count: repository.stars ?? 0,
    forks_count: 0,
    open_issues_count: 0,
    size: 12,
  });

  const heads = (repository.headSequence ?? [lastCommit.id]).map((id) =>
    fixtureCommitSha(repository, id),
  );
  routes[`${base}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`] =
    heads.map((sha) => json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }));

  const extra = Array.from({ length: repository.extraHistory ?? 0 }, (_, index) => ({
    sha: sha1(`fixture-extra:${repository.owner}/${repository.repo}:${String(index)}`),
    message: `Earlier work ${String(index)}`,
    date: '2026-09-02T00:00:00Z',
    author: 'Synthetic Dev',
  }));

  const commitList: { sha: string; message: string; date: string; author: string }[] = [...extra];
  for (const commit of repository.commits) {
    const sha = fixtureCommitSha(repository, commit.id);
    const parent = commitList[commitList.length - 1]?.sha;
    commitList.push({
      sha,
      message: commit.message,
      date: commit.date,
      author: commit.author ?? 'Synthetic Dev',
    });

    const paths = Object.keys(commit.files).sort();
    const blobs = paths.map((path) => {
      const bytes = fileBytes(commit.files[path] ?? '');
      return { path, bytes, sha: gitBlobSha(bytes) };
    });
    const entries = [
      ...directoriesOf(paths).map((path) => ({
        path,
        mode: '040000',
        type: 'tree',
        sha: sha1(`tree:${sha}:${path}`),
      })),
      ...blobs.map((blob) => ({
        path: blob.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
        size: blob.bytes.byteLength,
      })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    const treeSha = sha1(`tree:${sha}:${JSON.stringify(entries)}`);

    routes[`${base}/git/commits/${sha}`] = json({
      sha,
      tree: { sha: treeSha },
      parents: parent ? [{ sha: parent }] : [],
      message: commit.message,
      author: {
        name: commit.author ?? 'Synthetic Dev',
        email: 'dev@example.invalid',
        date: commit.date,
      },
      committer: { name: commit.author ?? 'Synthetic Dev', date: commit.date },
    });
    routes[`${base}/git/trees/${treeSha}?recursive=1`] = json({
      sha: treeSha,
      truncated: repository.treeTruncated ?? false,
      tree: entries,
    });
    for (const blob of blobs) {
      routes[`${base}/git/blobs/${blob.sha}`] = repository.rateLimitBlobs
        ? {
            status: 403,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'x-ratelimit-remaining': '0',
              'retry-after': '60',
            },
            json: { message: 'API rate limit exceeded' },
          }
        : json({
            sha: blob.sha,
            size: blob.bytes.byteLength,
            encoding: 'base64',
            content: blob.bytes.toString('base64').replace(/(.{60})/g, '$1\n'),
          });
    }

    // History for this head, newest first, in pages of 100.
    const history = [...commitList].reverse();
    for (let page = 1; page <= Math.max(1, Math.ceil(history.length / 100)) + 1; page += 1) {
      routes[`${base}/commits?sha=${sha}&per_page=100&page=${String(page)}`] = json(
        history.slice((page - 1) * 100, page * 100).map((item, index, pageItems) => ({
          sha: item.sha,
          parents: pageItems[index + 1] ? [{ sha: pageItems[index + 1]?.sha }] : [],
          commit: {
            message: item.message,
            author: { name: item.author, email: 'dev@example.invalid', date: item.date },
            committer: { name: item.author, date: item.date },
          },
        })),
      );
    }
  }
  return routes;
}
