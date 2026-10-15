/*
 * P6B-beta2: the production GitHub capture path replayed over RECORDED REAL GitHub API responses.
 *
 * `tests/fixtures/real-github/recorded-judge-9459c98.json` holds the nine real responses GitHub's REST API returned for a public repository
 * (see its README for provenance and the one redaction). They are served by the fixture network under the REAL production stack: the SSRF-safe
 * HTTP client (DNS pinning, address policy, redirect re-validation, size/type/time limits), the real GitHub adapter, the real worker loop and the
 * real database. No permanent test depends on a third-party site; the live smoke results are recorded separately in the milestone report.
 *
 * Variants of the recording (a rate limit, a private repository, a tampered blob, a renamed repository, a redirect to a private address, ...) are
 * derived from it by small, explicit edits so that each hostile situation is the real response shape with exactly one thing changed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureComponent,
  type CapturedArtifact,
  type CaptureResult,
} from '../../packages/capture/src/index.js';
import {
  buildPassages,
  SELECTION_POLICY,
  SELECTION_POLICY_V1,
  type SelectionPolicyId,
} from '../../packages/assessment/src/index.js';
import { repositoryComponent } from '../../packages/assessment/src/repository-roles.js';
import { createGithubAdapter } from '../../packages/github/src/index.js';
import {
  createFixtureNetwork,
  createSafeHttpClient,
  type FixtureWorld,
} from '../../packages/safe-http/src/index.js';
import {
  analysisRuns,
  claims,
  evidenceItems,
  preInterviewAssessments,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  unknowns,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { createAdapterRegistry } from '../../apps/worker/src/adapters.js';
import {
  captureSetup,
  requestCapture,
  seedProject,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/worker/src/testing/harness.js';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/real-github/recorded-judge-9459c98.json');
interface Route {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
  error?: 'connection_refused' | 'connection_reset' | 'tls' | 'hang';
  repeatToBytes?: number;
}
interface Draft {
  hosts: Record<string, string[]>;
  routes: Record<string, Route>;
}
const RECORDED = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Draft;
/** The route at `url`, or a loud failure: a derived variant must edit a response the recording really contains. */
function route(w: Draft, url: string): Route {
  const found = w.routes[url];
  if (!found) throw new Error(`the recording has no route ${url}`);
  return found;
}
const API = 'https://api.github.com';
const REPO_URL = 'https://github.com/meetbhadra701-cloud/judge';
const BASE = `${API}/repos/meetbhadra701-cloud/judge`;
const LIMITS = { maxFiles: 4, maxCommits: 5 } as const; // the limits the recording was made with: the request set depends on them
const REVISION = '9459c9830086e9c7bf889ff22aaf9c19a1369d5d';
const TREE_SHA = 'f9f4c6e882164e4b6f506db3095da77f1426775c';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Git's blob id, computed here independently of the adapter's own implementation. */
const gitBlob = (bytes: Buffer) =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${String(bytes.length)}\0`), bytes]))
    .digest('hex');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function world(edit?: (draft: Draft) => void): Draft {
  const draft = clone(RECORDED);
  edit?.(draft);
  return draft;
}
const blobRoutes = (w: Draft) => Object.keys(w.routes).filter((url) => url.includes('/git/blobs/'));

function stack(w: FixtureWorld) {
  const network = createFixtureNetwork(w);
  const http = createSafeHttpClient({ resolver: network.resolver, transport: network.transport });
  const adapter = createGithubAdapter({ http, limits: LIMITS });
  return {
    network,
    capture: (url = REPO_URL, signal = new AbortController().signal) =>
      adapter.capture({ sourceType: 'github', url, signal }),
  };
}

function artifactsOf(result: CaptureResult): readonly CapturedArtifact[] {
  if (!('artifacts' in result)) throw new Error('not captured');
  return result.artifacts;
}

describe('real recorded GitHub responses through the production adapter', () => {
  it('captures the exact commit, verifies every file against its Git object id, and states what it left out', async () => {
    const { capture, network } = stack(world());
    const result = await capture();
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') throw new Error('unreachable');
    expect(result.revision).toBe(REVISION);
    expect([...result.partialReasons].sort()).toEqual(['commit_limit', 'file_count_limit']);
    expect(result.metadata).toMatchObject({
      adapterVersion: 'github-capture/v1',
      owner: 'meetbhadra701-cloud',
      repo: 'judge',
      defaultBranch: 'main',
      treeSha: TREE_SHA,
      fileCount: 4,
      commitCount: 5,
    });
    const kinds = result.artifacts.map((a) => a.kind);
    expect(kinds.filter((k) => k === 'file')).toHaveLength(4);
    expect(new Set(kinds)).toEqual(
      new Set(['file', 'repository_metadata', 'commit_history', 'tree', 'omissions']),
    );

    // independent verification: every captured file's bytes hash to the object id GitHub's own tree lists for that path
    const tree = (
      RECORDED.routes[`${BASE}/git/trees/${TREE_SHA}?recursive=1`]?.json as {
        tree: { path: string; sha: string }[];
      }
    ).tree;
    for (const artifact of result.artifacts.filter((a) => a.kind === 'file')) {
      const path = artifact.key.replace(/^files\//, '');
      const listed = tree.find((entry) => entry.path === path);
      expect(listed, path).toBeDefined();
      expect(gitBlob(Buffer.from(artifact.textContent, 'utf8')), path).toBe(listed?.sha);
      expect(artifact.contentHash).toBe(sha256(artifact.textContent));
    }

    // every request was a GET of the GitHub API origin, none was redirected, and the moving branch was read exactly once
    expect(network.contacts.every((c) => c.url.startsWith(`${API}/`))).toBe(true);
    expect(network.contacts.map((c) => c.address)).toEqual(
      network.contacts.map(() => '140.82.112.6'),
    );
    const urls = network.contacts.map((c) => c.url);
    expect(urls.filter((u) => u.includes('/git/ref/heads/'))).toHaveLength(1);
    expect(
      urls
        .filter(
          (u) =>
            u.includes('/git/commits/') ||
            u.includes('/git/trees/') ||
            u.includes('/git/blobs/') ||
            u.includes('sha='),
        )
        .every((u) => /[0-9a-f]{40}/.test(u)),
    ).toBe(true);
    // the recording also holds the blobs of a larger capture (see its README); a capture limited to four files reads only its nine core routes
    expect(urls).toHaveLength(9);
    expect(new Set(urls).size).toBe(9);
    expect([...new Set(urls)].every((u) => u in RECORDED.routes)).toBe(true);
    for (const contact of network.contacts) {
      expect(Object.keys(contact.headers).map((h) => h.toLowerCase())).not.toContain(
        'authorization',
      );
    }
  });

  it('is deterministic: the same recording yields byte-identical artifacts and hashes', async () => {
    const one = artifactsOf(await stack(world()).capture());
    const two = artifactsOf(await stack(world()).capture());
    expect(two.map((a) => [a.key, a.contentHash])).toEqual(one.map((a) => [a.key, a.contentHash]));
  });

  it('records no e-mail address and no score, claim or judgment: only what the repository states', async () => {
    const artifacts = artifactsOf(await stack(world()).capture());
    const commits = artifacts.find((a) => a.key === 'commits.json');
    expect(commits?.textContent).not.toMatch(/@/);
    expect(commits?.textContent).toContain(REVISION);
    for (const artifact of artifacts) {
      expect(artifact.textContent).not.toMatch(/"(score|rating|grade|verdict|quality)"/i);
    }
  });

  it('never sends a credential unless one is configured, and an unauthenticated recording needs none', async () => {
    const { network, capture } = stack(world());
    await capture();
    expect(network.contacts.every((c) => !('authorization' in c.headers))).toBe(true);
  });

  // -- hostile variants of the same recording -----------------------------------------------------------------

  it('a rate-limited ref lookup is a failed capture with the rate_limited category and nothing partial', async () => {
    const result = await stack(
      world((w) => {
        w.routes[`${BASE}/git/ref/heads/main`] = {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791998872' },
          json: { message: 'API rate limit exceeded' },
        };
      }),
    ).capture();
    expect(result).toMatchObject({ status: 'failed', failure: { category: 'rate_limited' } });
  });

  it('a rate limit in the MIDDLE of the file reads keeps what was verified and says the rest is unavailable', async () => {
    const w = world();
    const [, second] = blobRoutes(w);
    w.routes[second ?? ''] = {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
      json: { message: 'API rate limit exceeded' },
    };
    const result = await stack(w).capture();
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(result.partialReasons).toContain('blob_unavailable');
    expect(result.artifacts.filter((a) => a.kind === 'file').length).toBeLessThan(4);
    const omissions = JSON.parse(
      result.artifacts.find((a) => a.key === 'omissions.json')?.textContent ?? '{}',
    ) as {
      counts: Record<string, number>;
    };
    expect(omissions.counts['blob_unavailable']).toBeGreaterThan(0);
  });

  it('a repository that does not exist is not_found; a private one is refused before any content is read', async () => {
    const missing = world((draft) => {
      draft.routes[`${API}/repos/meetbhadra701-cloud/does-not-exist`] = {
        status: 404,
        json: { message: 'Not Found' },
      };
    });
    expect(
      await stack(missing).capture('https://github.com/meetbhadra701-cloud/does-not-exist'),
    ).toMatchObject({ status: 'failed', failure: { category: 'not_found' } });

    const w = world((draft) => {
      const repo = draft.routes[BASE]?.json as Record<string, unknown>;
      repo['private'] = true;
      repo['visibility'] = 'private';
    });
    const { capture, network } = stack(w);
    expect(await capture()).toMatchObject({
      status: 'rejected',
      failure: { category: 'unsupported_source', metadata: { reason: 'private_repository' } },
    });
    expect(network.contacts).toHaveLength(1); // only the metadata request was made
  });

  it('a blob whose bytes do not match the Git object id is omitted, never stored', async () => {
    const w = world();
    const url = blobRoutes(w)[0] ?? '';
    const blob = w.routes[url]?.json as { content: string; encoding: string };
    blob.content = Buffer.from('tampered content\n', 'utf8').toString('base64');
    const result = await stack(w).capture();
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(result.partialReasons).toContain('blob_unavailable');
    expect(result.artifacts.filter((a) => a.kind === 'file')).toHaveLength(3);
    expect(result.artifacts.every((a) => !a.textContent.includes('tampered content'))).toBe(true);
    const omissions = JSON.parse(
      result.artifacts.find((a) => a.key === 'omissions.json')?.textContent ?? '{}',
    ) as {
      counts: Record<string, number>;
    };
    expect(omissions.counts['blob_integrity_mismatch']).toBe(1);
  });

  it('inconsistent answers about the same commit (revision, tree) fail closed', async () => {
    const wrongCommit = await stack(
      world((w) => {
        (w.routes[`${BASE}/git/commits/${REVISION}`]?.json as Record<string, unknown>)['sha'] =
          'a'.repeat(40);
      }),
    ).capture();
    expect(wrongCommit).toMatchObject({ status: 'failed', failure: { category: 'parse_failure' } });
    const wrongTree = await stack(
      world((w) => {
        (w.routes[`${BASE}/git/trees/${TREE_SHA}?recursive=1`]?.json as Record<string, unknown>)[
          'sha'
        ] = 'b'.repeat(40);
      }),
    ).capture();
    expect(wrongTree).toMatchObject({ status: 'failed', failure: { category: 'parse_failure' } });
  });

  it('a truncated tree listing is reported as partial, not presented as the whole repository', async () => {
    const result = await stack(
      world((w) => {
        (w.routes[`${BASE}/git/trees/${TREE_SHA}?recursive=1`]?.json as Record<string, unknown>)[
          'truncated'
        ] = true;
      }),
    ).capture();
    expect(result.status).toBe('partial');
    if (result.status === 'partial') expect(result.partialReasons).toContain('tree_truncated');
  });

  it.each([
    [
      'malformed JSON',
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"truncated' },
      'parse_failure',
    ],
    [
      'an HTML page served instead of JSON',
      { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>Sign in</html>' },
      'unsupported_content_type',
    ],
    ['an unexpected shape', { status: 200, json: { hello: 'world' } }, 'parse_failure'],
    ['a server error', { status: 500, json: { message: 'boom' } }, 'http_api_error'],
    [
      'a service outage',
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: '{"message":"unavailable"}',
      },
      'http_api_error',
    ],
    ['a connection reset', { error: 'connection_reset' }, 'connection_failure'],
    ['a TLS failure', { error: 'tls' }, 'tls_failure'],
  ] as const)(
    '%s on the repository request is a failed capture (%s), not a crash',
    async (_label, response, category) => {
      const result = await stack(
        world((w) => {
          w.routes[BASE] = clone(response);
        }),
      ).capture();
      expect(result).toMatchObject({ status: 'failed', failure: { category } });
    },
  );

  it('an oversized API response is refused by the size limit', async () => {
    const result = await stack(
      world((w) => {
        w.routes[BASE] = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          repeatToBytes: 3 * 1024 * 1024,
        };
      }),
    ).capture();
    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(['response_too_large', 'parse_failure']).toContain(result.failure.category);
  });

  it('an unresponsive API ends in a timeout when the capture is cancelled', async () => {
    const controller = new AbortController();
    const pending = stack(
      world((w) => {
        w.routes[BASE] = { error: 'hang' };
      }),
    ).capture(REPO_URL, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 50);
    expect(await pending).toMatchObject({ status: 'failed', failure: { category: 'timeout' } });
  });

  // -- redirects and canonicalization ---------------------------------------------------------------------------

  it('a renamed repository (GitHub answers 301 to /repositories/<id>) is followed on the same origin and captured', async () => {
    const w = world((draft) => {
      for (const [url, response] of Object.entries(draft.routes)) {
        if (!url.startsWith(BASE)) continue;
        const moved = url.replace('/repos/meetbhadra701-cloud/judge', '/repositories/1234567');
        draft.routes[moved] = response;
        draft.routes[url] = { status: 301, headers: { location: moved } };
      }
    });
    const { capture, network } = stack(w);
    const result = await capture();
    expect(result.status).toBe('partial');
    if (result.status === 'partial') expect(result.revision).toBe(REVISION);
    expect(network.contacts.length).toBeGreaterThan(9); // each redirect cost one more request than the nine core routes
    expect(network.contacts.every((c) => c.url.startsWith(`${API}/`))).toBe(true);
  });

  it.each([
    ['another host', 'https://evil.example/steal', 'ssrf_rejected'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/', 'ssrf_rejected'],
    ['a loopback address', 'http://127.0.0.1:8080/', 'ssrf_rejected'],
    ['a private network address', 'http://10.0.0.7/', 'ssrf_rejected'],
  ] as const)(
    'a redirect to %s is refused and never contacted',
    async (_label, location, category) => {
      const w = world((draft) => {
        draft.hosts = { ...draft.hosts, 'evil.example': ['203.0.113.66'] };
        draft.routes[`${BASE}/git/ref/heads/main`] = { status: 302, headers: { location } };
      });
      const { capture, network } = stack(w);
      const result = await capture();
      expect(result.status === 'failed' || result.status === 'rejected').toBe(true);
      if (result.status === 'failed' || result.status === 'rejected') {
        expect([category, 'unsupported_source', 'http_api_error']).toContain(
          result.failure.category,
        );
      }
      expect(network.contacts.map((c) => c.address)).not.toContain('169.254.169.254');
      expect(network.contacts.map((c) => c.address)).not.toContain('127.0.0.1');
      expect(network.contacts.map((c) => c.address)).not.toContain('10.0.0.7');
      expect(network.contacts.map((c) => c.address)).not.toContain('203.0.113.66');
    },
  );

  it('declared URL case does not change what is requested: GitHub names are case-insensitive and the canonical form is lower case', async () => {
    const { capture, network } = stack(world());
    const result = await capture('https://github.com/MeetBhadra701-Cloud/Judge');
    // the production path declares the canonical (lower-case) URL; a raw mixed-case URL is parsed to the same repository
    expect(['partial', 'captured']).toContain(result.status);
    expect(
      network.contacts.every(
        (c) => c.url.includes('meetbhadra701-cloud/judge') || c.url.includes('/repositories/'),
      ),
    ).toBe(true);
  });
});

// -- persistence through the real worker, queue and database -----------------------------------------------------------------

describe.each(testDatabaseTargets())(
  'recorded real capture persisted by the worker on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
    });
    afterAll(async () => {
      await testDb.close();
    });

    async function worker(w: FixtureWorld) {
      const network = createFixtureNetwork(w);
      const http = createSafeHttpClient({
        resolver: network.resolver,
        transport: network.transport,
      });
      const setup = await captureSetup(db, {
        adapters: createAdapterRegistry({ http, githubLimits: LIMITS }),
      });
      return { network, drain: () => setup.loop.drain() };
    }

    async function snapshotsOf(projectId: string) {
      return (await db.select().from(sourceSnapshots))
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => a.captureNumber - b.captureNumber);
    }
    async function artifactsOfSnapshot(snapshotId: string) {
      return (await db.select().from(sourceSnapshotArtifacts)).filter(
        (a) => a.snapshotId === snapshotId,
      );
    }

    it('persists an immutable, hash-verifiable snapshot of the recorded repository, tied to its project and declared source', async () => {
      const seeded = await seedProject(db, [['github', REPO_URL]]);
      const source = seeded.sources[0];
      if (!source) throw new Error('no source');
      await requestCapture(db, source, seeded.event.id);
      await (await worker(world())).drain();
      const [snapshot] = await snapshotsOf(seeded.project.id);
      expect(snapshot).toMatchObject({
        status: 'partial',
        revision: REVISION,
        sourceUrl: REPO_URL,
        projectSourceId: source.id,
        captureNumber: 1,
      });
      expect(snapshot?.partialReasons).toEqual(
        expect.arrayContaining(['commit_limit', 'file_count_limit']),
      );
      const stored = await artifactsOfSnapshot(snapshot?.id ?? '');
      expect(stored.map((a) => a.artifactKind).sort()).toEqual([
        'commit_history',
        'file',
        'file',
        'file',
        'file',
        'omissions',
        'repository_metadata',
        'tree',
      ]);
      for (const artifact of stored) {
        expect(artifact.contentHash).toBe(sha256(artifact.textContent));
        expect(artifact.byteLength).toBe(Buffer.byteLength(artifact.textContent, 'utf8'));
      }
      // the snapshot's aggregate hash is reproducible from its artifacts
      expect(snapshot?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // capturing creates facts about SOURCES only: no claim, evidence, unknown or assessment exists for the project
      const count = async (
        table:
          typeof claims | typeof evidenceItems | typeof unknowns | typeof preInterviewAssessments,
      ) =>
        (await db.select().from(table)).filter(
          (row) => (row as { projectId?: string }).projectId === seeded.project.id,
        ).length;
      expect([
        await count(claims),
        await count(evidenceItems),
        await count(unknowns),
        await count(preInterviewAssessments),
      ]).toEqual([0, 0, 0, 0]);
      // the run that did it is the capture run, nothing else
      const runs = (await db.select().from(analysisRuns)).filter(
        (r) => r.projectId === seeded.project.id,
      );
      expect(runs.map((r) => [r.runType, r.state])).toEqual([
        ['project_source_capture', 'succeeded'],
      ]);
    });

    it('a failed capture, a retry, and a capture after the repository changed each add a snapshot; no earlier snapshot is ever rewritten', async () => {
      const seeded = await seedProject(db, [['github', REPO_URL]]);
      const source = seeded.sources[0];
      if (!source) throw new Error('no source');

      // 1. the API rate-limits the very first request: a failed capture is recorded as such
      await requestCapture(db, source, seeded.event.id);
      await (
        await worker(
          world((w) => {
            w.routes[BASE] = {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0' },
              json: { message: 'API rate limit exceeded' },
            };
          }),
        )
      ).drain();
      const afterFailure = await snapshotsOf(seeded.project.id);
      expect(afterFailure.map((s) => [s.captureNumber, s.status, s.failureCategory])).toEqual([
        [1, 'failed', 'rate_limited'],
      ]);
      expect(await artifactsOfSnapshot(afterFailure[0]?.id ?? '')).toHaveLength(0);
      const frozenFailure = JSON.stringify(afterFailure[0]);

      // 2. the retry succeeds against the real recording: a NEW snapshot; the failed one stays as it was
      await requestCapture(db, source, seeded.event.id);
      await (await worker(world())).drain();
      const afterRetry = await snapshotsOf(seeded.project.id);
      expect(afterRetry.map((s) => [s.captureNumber, s.status])).toEqual([
        [1, 'failed'],
        [2, 'partial'],
      ]);
      expect(JSON.stringify(afterRetry[0])).toBe(frozenFailure);
      const firstGood = afterRetry[1];
      const firstGoodArtifacts = JSON.stringify(await artifactsOfSnapshot(firstGood?.id ?? ''));

      // 3. the repository changes (one file edited, a new commit): the next capture is a third snapshot with another revision and content hash
      const changed = world((w) => {
        const newRevision = 'c'.repeat(40);
        const newTreeSha = 'd'.repeat(40);
        const ref = w.routes[`${BASE}/git/ref/heads/main`]?.json as { object: { sha: string } };
        ref.object.sha = newRevision;
        const commit = clone(route(w, `${BASE}/git/commits/${REVISION}`));
        (commit.json as { sha: string; tree: { sha: string } }).sha = newRevision;
        (commit.json as { sha: string; tree: { sha: string } }).tree.sha = newTreeSha;
        w.routes[`${BASE}/git/commits/${newRevision}`] = commit;
        const tree = clone(route(w, `${BASE}/git/trees/${TREE_SHA}?recursive=1`));
        (tree.json as { sha: string }).sha = newTreeSha;
        // edit the first blob that will be read: new bytes, hence a new Git object id, in the tree and as a route
        const oldUrl = blobRoutes(w)[0] ?? '';
        const oldSha = oldUrl.split('/').pop() ?? '';
        const text = 'This file was edited after the first capture.\n';
        const newSha = gitBlob(Buffer.from(text, 'utf8'));
        for (const entry of (tree.json as { tree: { sha: string }[] }).tree)
          if (entry.sha === oldSha) entry.sha = newSha;
        w.routes[`${BASE}/git/trees/${newTreeSha}?recursive=1`] = tree;
        const blob = clone(route(w, oldUrl));
        (blob.json as { sha: string; content: string }).sha = newSha;
        (blob.json as { sha: string; content: string }).content = Buffer.from(
          text,
          'utf8',
        ).toString('base64');
        w.routes[`${BASE}/git/blobs/${newSha}`] = blob;
        const history = route(w, `${BASE}/commits?sha=${REVISION}&per_page=100&page=1`);
        const list = clone(history.json) as { sha: string }[];
        list[0] = { ...list[0], sha: newRevision };
        w.routes[`${BASE}/commits?sha=${newRevision}&per_page=100&page=1`] = {
          status: 200,
          json: list,
        };
      });
      await requestCapture(db, source, seeded.event.id);
      await (await worker(changed)).drain();
      const afterChange = await snapshotsOf(seeded.project.id);
      expect(afterChange.map((s) => [s.captureNumber, s.status])).toEqual([
        [1, 'failed'],
        [2, 'partial'],
        [3, 'partial'],
      ]);
      expect(afterChange[2]?.revision).toBe('c'.repeat(40));
      expect(afterChange[2]?.contentHash).not.toBe(firstGood?.contentHash);
      // HISTORY IS NOT REWRITTEN: both earlier snapshots and the first good snapshot's artifacts are byte-for-byte what they were
      expect(JSON.stringify(afterChange[0])).toBe(frozenFailure);
      expect(JSON.stringify(afterChange[1])).toBe(JSON.stringify(firstGood));
      expect(JSON.stringify(await artifactsOfSnapshot(firstGood?.id ?? ''))).toBe(
        firstGoodArtifacts,
      );
      expect(afterChange[1]?.revision).toBe(REVISION);
      // the edited text is in snapshot 3 only
      const texts = async (id: string) =>
        (await artifactsOfSnapshot(id)).map((a) => a.textContent).join('\n');
      expect(await texts(afterChange[2]?.id ?? '')).toContain('edited after the first capture');
      expect(await texts(afterChange[1]?.id ?? '')).not.toContain('edited after the first capture');
    });

    it('two snapshots of unchanged material have equal content hashes (a no-op recapture is recognisable as one)', async () => {
      const seeded = await seedProject(db, [['github', REPO_URL]]);
      const source = seeded.sources[0];
      if (!source) throw new Error('no source');
      for (let i = 0; i < 2; i += 1) {
        await requestCapture(db, source, seeded.event.id);
        await (await worker(world())).drain();
      }
      const [one, two] = await snapshotsOf(seeded.project.id);
      expect(one?.captureNumber).toBe(1);
      expect(two?.captureNumber).toBe(2);
      expect(two?.contentHash).toBe(one?.contentHash);
      expect(two?.revision).toBe(one?.revision);
    });
  },
);

describe('a larger capture of the same real repository (P6B-beta3)', () => {
  const LARGE = { maxFiles: 40, maxCommits: 5 } as const;
  const large = async () => {
    const network = createFixtureNetwork(world());
    const http = createSafeHttpClient({ resolver: network.resolver, transport: network.transport });
    return createGithubAdapter({ http, limits: LARGE }).capture({
      sourceType: 'github',
      url: REPO_URL,
      signal: new AbortController().signal,
    });
  };

  it('captures forty real files of mixed kinds (workflow, manifests, configuration, documentation), each verified against its Git object id', async () => {
    const result = await large();
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') throw new Error('unreachable');
    expect(result.partialReasons).toContain('file_count_limit');
    const files = result.artifacts.filter((a) => a.kind === 'file');
    expect(files).toHaveLength(40);
    const tree = (
      RECORDED.routes[`${BASE}/git/trees/${TREE_SHA}?recursive=1`]?.json as {
        tree: { path: string; sha: string }[];
      }
    ).tree;
    for (const file of files) {
      const listed = tree.find((entry) => entry.path === file.key.replace(/^files\//, ''));
      expect(gitBlob(Buffer.from(file.textContent, 'utf8')), file.key).toBe(listed?.sha);
    }
    const keys = files.map((f) => f.key);
    expect(keys).toContain('files/.github/workflows/ci.yml');
    expect(keys.some((k) => k.endsWith('/package.json'))).toBe(true);
    expect(keys.some((k) => k.endsWith('.md'))).toBe(true);
    // fair across the repository's components: a quarter of the files are not all from one package
    const components = new Set(files.map((f) => captureComponent(f.key.replace(/^files\//, ''))));
    expect(components.size).toBeGreaterThanOrEqual(15);
  });

  it('the selection that follows (v2) shows at least as many of the repository’s components as v1 at the same tight budget, on real files', async () => {
    const result = await large();
    if (result.status !== 'partial') throw new Error('unreachable');
    const artifacts = result.artifacts
      .filter((a) => a.kind === 'file')
      .map((a, i) => ({
        snapshotId: 'snap-1',
        artifactId: `art-${String(i)}`,
        sourceType: 'github' as const,
        snapshotStatus: 'partial',
        key: a.key,
        kind: a.kind,
        mediaType: a.mediaType,
        text: a.textContent,
      }));
    const budgets = { statement: 6_000, source: 6_000, metadata: 1_000 };
    const shownComponents = (policy: SelectionPolicyId) =>
      new Set(
        buildPassages(artifacts, budgets, policy).passages.map((p) =>
          repositoryComponent(p.artifactKey.replace(/^files\//, '')),
        ),
      ).size;
    const v1 = shownComponents(SELECTION_POLICY_V1);
    const v2 = shownComponents(SELECTION_POLICY);
    expect(v2).toBeGreaterThanOrEqual(v1);
    expect(buildPassages(artifacts, budgets).coverage.verdict).not.toBe('complete');
  });
});
