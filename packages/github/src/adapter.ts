import {
  classifyRepositoryPath,
  compareSelection,
  failure,
  IGNORED_DIRECTORIES,
  failureResult,
  jsonArtifact,
  looksBinary,
  parseGithubRepositoryUrl,
  textArtifact,
  type CaptureFailure,
  type CaptureInput,
  type CaptureResult,
  type CapturedArtifact,
  type HttpFetcher,
  type JsonObject,
  type ProjectSourceAdapter,
  type RepositoryOmissionReason,
} from '@judge-copilot/capture';
import { SOURCE_INGESTION_LIMITS, type CapturePartialReason } from '@judge-copilot/schemas';
import { z } from 'zod';
import { gitBlobSha } from './git.js';

/*
 * Read-only GitHub repository capture through the REST API.
 *
 *  1. resolve owner/repo from the declared URL (repository roots only);
 *  2. GET the repository metadata and its default branch;
 *  3. resolve the branch to an EXACT commit SHA (one ref lookup per snapshot);
 *  4. read everything else by Git object id only: the commit, its tree, its history
 *     (`commits?sha=<sha>`) and individual blobs, each blob verified against its Git SHA-1.
 * The moving branch is never read again during the snapshot, so a later push cannot change it.
 *
 * Only GET requests to https://api.github.com are made. No clone, no git executable, no GraphQL,
 * no write endpoint. The optional token is sent only to the API origin (the HTTP client drops it
 * on any cross-origin redirect) and is never logged or stored. Repository content is data: it is
 * never executed, installed, built or imported. Counts (files, commits, stars) are data only.
 */

export const GITHUB_ADAPTER_VERSION = 'github-capture/v1';
export const GITHUB_API_ORIGIN = 'https://api.github.com';

export const GITHUB_CAPTURE_LIMITS = {
  maxTreeEntries: 20_000,
  maxCommits: 250,
  maxFileBytes: 256 * 1024,
  maxTotalTextBytes: 8 * 1024 * 1024,
  /** Each file is one API request; this bounds request volume and rate-limit use. */
  maxFiles: 400,
  maxOmittedPathsPerReason: 200,
  apiJsonMaxBytes: 2 * 1024 * 1024,
  treeJsonMaxBytes: 16 * 1024 * 1024,
  requestTimeoutMs: 20_000,
  timeBudgetMs: 120_000,
  blobConcurrency: 4,
} as const;
export type GithubCaptureLimits = { -readonly [K in keyof typeof GITHUB_CAPTURE_LIMITS]: number };

export interface GithubAdapterOptions {
  readonly http: HttpFetcher;
  /** Optional read-only token. Public repositories need none. */
  readonly token?: string | null;
  readonly limits?: Partial<GithubCaptureLimits>;
  readonly now?: () => number;
}

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

const RepositoryResponse = z.object({
  name: z.string(),
  full_name: z.string(),
  html_url: z.string().nullish(),
  description: z.string().nullish(),
  homepage: z.string().nullish(),
  default_branch: z.string().min(1).max(255),
  language: z.string().nullish(),
  license: z.object({ spdx_id: z.string().nullish() }).nullish(),
  topics: z.array(z.string()).nullish(),
  visibility: z.string().nullish(),
  private: z.boolean().nullish(),
  fork: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  created_at: z.string().nullish(),
  stargazers_count: z.number().nullish(),
  forks_count: z.number().nullish(),
  open_issues_count: z.number().nullish(),
  size: z.number().nullish(),
});

const RefObject = z.object({ ref: z.string(), object: z.object({ sha: Sha, type: z.string() }) });
const RefResponse = z.union([RefObject, z.array(RefObject)]);

const CommitResponse = z.object({
  sha: Sha,
  tree: z.object({ sha: Sha }),
  parents: z.array(z.object({ sha: Sha })),
  message: z.string(),
  author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
  committer: z.object({ date: z.string().nullish() }).nullish(),
});

const TreeResponse = z.object({
  sha: Sha,
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: Sha,
      size: z.number().int().min(0).optional(),
    }),
  ),
});

const CommitListResponse = z.array(
  z.object({
    sha: Sha,
    parents: z.array(z.object({ sha: Sha })),
    commit: z.object({
      message: z.string(),
      author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
      committer: z.object({ date: z.string().nullish() }).nullish(),
    }),
  }),
);

const BlobResponse = z.object({
  sha: Sha,
  size: z.number().int().min(0),
  encoding: z.literal('base64'),
  content: z.string(),
});

class CaptureAbort extends Error {
  constructor(readonly failure: CaptureFailure) {
    super(failure.category);
  }
}

type TreeEntry = z.infer<typeof TreeResponse>['tree'][number];

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function mediaTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'text/markdown';
  if (lower.endsWith('.json') || lower.endsWith('.ipynb')) return 'application/json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml';
  return 'text/plain';
}

function subjectOf(message: string): string {
  return (message.split('\n')[0] ?? '').trim().slice(0, 300);
}

function retryAfter(
  headers: Readonly<Record<string, string>>,
  nowSeconds: number,
): number | undefined {
  const after = Number(headers['retry-after']);
  if (Number.isInteger(after) && after >= 0) return after;
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isInteger(reset) && reset > nowSeconds) return reset - Math.floor(nowSeconds);
  return undefined;
}

export function createGithubAdapter(options: GithubAdapterOptions): ProjectSourceAdapter {
  const limits: GithubCaptureLimits = { ...GITHUB_CAPTURE_LIMITS, ...options.limits };
  const token = options.token?.trim() ? options.token.trim() : null;
  const now = options.now ?? (() => Date.now());

  async function api<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    maxBodyBytes = limits.apiJsonMaxBytes,
  ): Promise<T> {
    const url = `${GITHUB_API_ORIGIN}${path}`;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    // The token is attached only to requests this adapter builds for the API origin.
    if (token && new URL(url).origin === GITHUB_API_ORIGIN)
      headers['authorization'] = `Bearer ${token}`;
    const result = await options.http.get(url, {
      headers,
      maxBodyBytes,
      oversize: 'fail',
      contentTypes: ['application/json'],
      disallowedContentType: 'fail',
      timeoutMs: limits.requestTimeoutMs,
      signal,
    });
    if (!result.ok) {
      throw new CaptureAbort(
        failure(result.failure.category, { ...result.failure.metadata, adapter: 'github' }),
      );
    }
    const { status, headers: responseHeaders } = result.response;
    const meta = { adapter: 'github', host: 'api.github.com', httpStatus: status };
    if (status === 404) throw new CaptureAbort(failure('not_found', meta));
    const remaining = responseHeaders['x-ratelimit-remaining'];
    if (status === 429 || ((status === 403 || status === 401) && remaining === '0')) {
      const seconds = retryAfter(responseHeaders, now() / 1000);
      throw new CaptureAbort(
        failure(
          'rate_limited',
          seconds === undefined ? meta : { ...meta, retryAfterSeconds: seconds },
        ),
      );
    }
    if (status !== 200) throw new CaptureAbort(failure('http_api_error', meta));
    let json: unknown;
    try {
      json = JSON.parse(result.response.body ?? '');
    } catch {
      throw new CaptureAbort(
        failure('parse_failure', { adapter: 'github', reason: 'invalid_json' }),
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new CaptureAbort(
        failure('parse_failure', { adapter: 'github', reason: 'unexpected_shape' }),
      );
    }
    return parsed.data;
  }

  async function capture(input: CaptureInput): Promise<CaptureResult> {
    const ref = parseGithubRepositoryUrl(input.url);
    if (typeof ref === 'string') {
      return failureResult(
        failure(
          ref === 'unsupported_host' || ref === 'unsupported_path'
            ? 'unsupported_source'
            : 'invalid_url',
          {
            adapter: 'github',
            reason: ref,
          },
        ),
      );
    }
    const started = now();
    const deadline = AbortSignal.any([input.signal, AbortSignal.timeout(limits.timeBudgetMs)]);
    const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
    const partial = new Set<CapturePartialReason>();
    try {
      // 1–3: metadata, default branch, exact HEAD commit SHA.
      const repository = await api(base, RepositoryResponse, deadline);
      const branch = repository.default_branch;
      const refs = await api(`${base}/git/ref/heads/${encodePath(branch)}`, RefResponse, deadline);
      const match = (Array.isArray(refs) ? refs : [refs]).find(
        (candidate) =>
          candidate.ref === `refs/heads/${branch}` && candidate.object.type === 'commit',
      );
      if (!match) {
        throw new CaptureAbort(
          failure('parse_failure', { adapter: 'github', reason: 'branch_not_resolved' }),
        );
      }
      const revision = match.object.sha;

      // 4: everything below is addressed by Git object id, never by branch name.
      const commit = await api(`${base}/git/commits/${revision}`, CommitResponse, deadline);
      if (commit.sha !== revision) {
        throw new CaptureAbort(
          failure('parse_failure', { adapter: 'github', reason: 'revision_mismatch' }),
        );
      }
      const tree = await api(
        `${base}/git/trees/${commit.tree.sha}?recursive=1`,
        TreeResponse,
        deadline,
        limits.treeJsonMaxBytes,
      );
      if (tree.sha !== commit.tree.sha) {
        throw new CaptureAbort(
          failure('parse_failure', { adapter: 'github', reason: 'tree_mismatch' }),
        );
      }

      const history: z.infer<typeof CommitListResponse> = [];
      for (let page = 1; history.length <= limits.maxCommits; page += 1) {
        const batch = await api(
          `${base}/commits?sha=${revision}&per_page=100&page=${String(page)}`,
          CommitListResponse,
          deadline,
        );
        history.push(...batch);
        if (batch.length < 100) break;
      }
      if (history[0] && history[0].sha !== revision) {
        throw new CaptureAbort(
          failure('parse_failure', { adapter: 'github', reason: 'history_mismatch' }),
        );
      }
      if (history.length > limits.maxCommits) partial.add('commit_limit');
      const commits = history.slice(0, limits.maxCommits).map((item) => ({
        sha: item.sha,
        parents: item.parents.map((parent) => parent.sha),
        authorName: item.commit.author?.name ?? null,
        authoredAt: item.commit.author?.date ?? null,
        committedAt: item.commit.committer?.date ?? null,
        subject: subjectOf(item.commit.message),
      }));

      // Tree: deterministic order, bounded entry count.
      if (tree.truncated) partial.add('tree_truncated');
      const sortedEntries = [...tree.tree].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      if (sortedEntries.length > limits.maxTreeEntries) partial.add('tree_entry_limit');
      const entries = sortedEntries.slice(0, limits.maxTreeEntries);

      // File selection from the tree alone (no content read yet).
      const omitted = new Map<RepositoryOmissionReason, string[]>();
      const ignoredDirectories = new Map<string, number>();
      const omit = (reason: RepositoryOmissionReason, path: string) => {
        const list = omitted.get(reason) ?? [];
        list.push(path);
        omitted.set(reason, list);
      };
      const candidates: (TreeEntry & { priority: number })[] = [];
      for (const entry of entries) {
        if (entry.type === 'tree') continue;
        if (entry.type === 'commit') {
          omit('submodule', entry.path);
          continue;
        }
        if (entry.mode === '120000') {
          omit('symlink', entry.path);
          continue;
        }
        if (entry.type !== 'blob') continue;
        const decision = classifyRepositoryPath(entry.path);
        if (!decision.include) {
          if (decision.reason === 'ignored_directory') {
            const segments = entry.path.split('/');
            const index = segments.findIndex(
              (segment, position) =>
                position < segments.length - 1 &&
                IGNORED_DIRECTORIES.includes(segment.toLowerCase()),
            );
            const directory = segments.slice(0, Math.max(index, 0) + 1).join('/');
            ignoredDirectories.set(directory, (ignoredDirectories.get(directory) ?? 0) + 1);
          }
          omit(decision.reason, entry.path);
          continue;
        }
        if (`files/${entry.path}`.length > SOURCE_INGESTION_LIMITS.artifactKeyMaxChars) {
          omit('path_too_long', entry.path);
          continue;
        }
        candidates.push({ ...entry, priority: decision.priority });
      }
      candidates.sort(compareSelection);
      const selected: TreeEntry[] = [];
      let plannedBytes = 0;
      for (const candidate of candidates) {
        const size = candidate.size ?? 0;
        if (size > limits.maxFileBytes) {
          omit('file_too_large', candidate.path);
          partial.add('file_size_limit');
        } else if (selected.length >= limits.maxFiles) {
          omit('file_count_limit', candidate.path);
          partial.add('file_count_limit');
        } else if (plannedBytes + size > limits.maxTotalTextBytes) {
          omit('total_text_limit', candidate.path);
          partial.add('total_text_limit');
        } else {
          selected.push(candidate);
          plannedBytes += size;
        }
      }

      // Blobs by object id, verified, bounded concurrency, stopping on rate limit or deadline.
      const files: CapturedArtifact[] = [];
      // Once set, remaining selected files are recorded under this reason instead of fetched.
      let stop: 'blob_unavailable' | 'time_budget_exhausted' | null = null;
      let next = 0;
      const blobMaxBytes = Math.ceil((limits.maxFileBytes * 4) / 3) + 16 * 1024;
      const worker = async () => {
        while (next < selected.length) {
          const entry = selected[next];
          next += 1;
          if (!entry) break;
          if (stop !== null || deadline.aborted) {
            if (input.signal.aborted) return;
            stop ??= 'time_budget_exhausted';
            omit(stop, entry.path);
            continue;
          }
          let blob: z.infer<typeof BlobResponse>;
          try {
            blob = await api(
              `${base}/git/blobs/${entry.sha}`,
              BlobResponse,
              deadline,
              blobMaxBytes,
            );
          } catch (error) {
            if (!(error instanceof CaptureAbort)) throw error;
            if (error.failure.category === 'rate_limited') stop = 'blob_unavailable';
            if (error.failure.category === 'timeout' && !input.signal.aborted) {
              stop ??= 'time_budget_exhausted';
              omit('time_budget_exhausted', entry.path);
              continue;
            }
            omit('blob_unavailable', entry.path);
            continue;
          }
          const bytes = Buffer.from(blob.content.replace(/\s+/g, ''), 'base64');
          if (blob.sha !== entry.sha || gitBlobSha(bytes) !== entry.sha) {
            omit('blob_integrity_mismatch', entry.path);
            continue;
          }
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            omit('binary_content', entry.path);
            continue;
          }
          if (looksBinary(text)) {
            omit('binary_content', entry.path);
            continue;
          }
          if (bytes.byteLength > limits.maxFileBytes) {
            omit('file_too_large', entry.path);
            partial.add('file_size_limit');
            continue;
          }
          files.push(
            textArtifact(`files/${entry.path}`, 'file', mediaTypeFor(entry.path), text, {
              gitBlobSha: entry.sha,
              mode: entry.mode,
            }),
          );
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, limits.blobConcurrency) }, worker));
      if (input.signal.aborted) {
        throw new CaptureAbort(failure('timeout', { adapter: 'github', reason: 'cancelled' }));
      }
      if (omitted.has('blob_unavailable') || omitted.has('blob_integrity_mismatch')) {
        partial.add('blob_unavailable');
      }
      if (omitted.has('time_budget_exhausted')) partial.add('time_budget_exhausted');
      files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

      const omissionCounts: Record<string, number> = {};
      const omissionPaths: Record<string, string[]> = {};
      for (const [reason, paths] of [...omitted.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        omissionCounts[reason] = paths.length;
        if (reason !== 'ignored_directory') {
          omissionPaths[reason] = [...paths].sort().slice(0, limits.maxOmittedPathsPerReason);
        }
      }
      const totalTextBytes = files.reduce((sum, file) => sum + file.byteLength, 0);

      const repositoryJson: JsonObject = {
        owner: ref.owner,
        name: ref.repo,
        fullName: repository.full_name,
        htmlUrl: repository.html_url ?? null,
        description: repository.description ?? null,
        homepage: repository.homepage ?? null,
        defaultBranch: branch,
        primaryLanguage: repository.language ?? null,
        license: repository.license?.spdx_id ?? null,
        topics: [...(repository.topics ?? [])].sort().slice(0, 50),
        visibility: repository.visibility ?? (repository.private ? 'private' : 'public'),
        fork: repository.fork ?? null,
        archived: repository.archived ?? null,
        createdAt: repository.created_at ?? null,
        stars: repository.stargazers_count ?? null,
        forks: repository.forks_count ?? null,
        openIssues: repository.open_issues_count ?? null,
        sizeKb: repository.size ?? null,
      };
      const artifacts: CapturedArtifact[] = [
        jsonArtifact('repository.json', 'repository_metadata', repositoryJson),
        jsonArtifact('commits.json', 'commit_history', {
          revision,
          headCommit: {
            sha: commit.sha,
            parents: commit.parents.map((parent) => parent.sha),
            authorName: commit.author?.name ?? null,
            authoredAt: commit.author?.date ?? null,
            committedAt: commit.committer?.date ?? null,
            subject: subjectOf(commit.message),
          },
          commits,
          truncated: history.length > limits.maxCommits,
          limit: limits.maxCommits,
        }),
        jsonArtifact('tree.json', 'tree', {
          revision,
          treeSha: tree.sha,
          truncatedByGithub: tree.truncated,
          entryCount: tree.tree.length,
          entryLimit: limits.maxTreeEntries,
          entries: entries.map((entry) => ({
            path: entry.path,
            type: entry.type,
            mode: entry.mode,
            sha: entry.sha,
            size: entry.size ?? null,
          })),
        }),
        jsonArtifact('omissions.json', 'omissions', {
          counts: omissionCounts,
          paths: omissionPaths,
          ignoredDirectories: Object.fromEntries([...ignoredDirectories.entries()].sort()),
          limits: {
            maxFileBytes: limits.maxFileBytes,
            maxFiles: limits.maxFiles,
            maxTotalTextBytes: limits.maxTotalTextBytes,
          },
          note: 'Omitted content was never fetched or stored. Omission is not evidence about quality.',
        }),
        ...files,
      ];
      const reasons = [...partial].sort();
      return {
        status: reasons.length > 0 ? 'partial' : 'captured',
        revision,
        metadata: {
          adapterVersion: GITHUB_ADAPTER_VERSION,
          owner: ref.owner,
          repo: ref.repo,
          defaultBranch: branch,
          treeSha: tree.sha,
          treeEntryCount: tree.tree.length,
          fileCount: files.length,
          totalTextBytes,
          commitCount: commits.length,
        },
        artifacts,
        partialReasons: reasons,
      };
    } catch (error) {
      if (error instanceof CaptureAbort) {
        return failureResult(
          failure(error.failure.category, {
            ...error.failure.metadata,
            elapsedMs: Math.max(0, Math.round(now() - started)),
          }),
        );
      }
      // Never let a raw error (which might carry request details) cross the adapter boundary.
      return failureResult(failure('internal_error', { adapter: 'github' }));
    }
  }

  return { sourceType: 'github', version: GITHUB_ADAPTER_VERSION, capture };
}
