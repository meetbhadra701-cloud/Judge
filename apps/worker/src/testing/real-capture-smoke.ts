/*
 * `pnpm capture:smoke` -- a BOUNDED, READ-ONLY smoke test of the real capture adapters against a real public URL. Development tool, never part of
 * a test suite (permanent tests use recorded fixtures and never depend on a third-party site).
 *
 *   pnpm capture:smoke <github|devpost> <url> [--out <dir>] [--max-files N] [--max-commits N] [--token-env NAME]
 *
 * `--world <file>` runs the same adapter and the same client policy against a RECORDED world (`{hosts, routes}` of real responses saved earlier)
 * instead of the network, and reports every URL the recording did not contain. It is how recorded real responses are replayed deterministically.
 *
 * `--token-env NAME` reads an OPTIONAL read-only GitHub token from that environment variable (never printed, never written to the manifest); without it
 * the request is anonymous, which is what a public repository needs.
 *
 * It uses the production SSRF-safe client (DNS pinning, IP policy, redirect re-validation, size/type/time limits) exactly as the worker does, wraps it
 * in a recorder that notes every request made (URL, status, bytes, time, redirects) and writes the captured artifacts plus a manifest with their
 * hashes to --out. Nothing is stored in a database; nothing is executed; no model is called. Request volume is capped by the adapter limits below.
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { HttpFetchResult, HttpFetcher, HttpRequestOptions } from '@judge-copilot/capture';
import { createDevpostAdapter } from '@judge-copilot/devpost';
import { createGithubAdapter, GITHUB_CAPTURE_LIMITS } from '@judge-copilot/github';
import {
  createFixtureNetwork,
  createSafeHttpClient,
  type FixtureWorld,
} from '@judge-copilot/safe-http';
import { createOutputWriter } from './safe-output.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

interface RequestRecord {
  readonly url: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly finalUrl?: string;
  readonly contentType?: string | null;
  readonly bytes?: number;
  readonly truncated?: boolean;
  readonly redirects?: number;
  readonly elapsedMs?: number;
  readonly rateRemaining?: string;
  readonly failure?: string;
}

async function main(): Promise<void> {
  const [kind, url] = process.argv.slice(2);
  if ((kind !== 'github' && kind !== 'devpost') || !url) {
    throw new Error(
      'usage: capture:smoke <github|devpost> <url> [--out dir] [--max-files N] [--max-commits N]',
    );
  }
  const out = resolve(option('--out') ?? `capture-smoke-${kind}`);
  const worldFile = option('--world');
  const base = createSafeHttpClient(
    worldFile
      ? createFixtureNetwork(JSON.parse(await readFile(worldFile, 'utf8')) as FixtureWorld)
      : {},
  );
  const requests: RequestRecord[] = [];
  const recorder: HttpFetcher = {
    async get(target: string, options: HttpRequestOptions): Promise<HttpFetchResult> {
      const result = await base.get(target, options);
      if (result.ok) {
        const r = result.response;
        requests.push({
          url: target,
          ok: true,
          status: r.status,
          finalUrl: r.finalUrl,
          contentType: r.contentType,
          bytes: r.bodyBytes,
          truncated: r.truncated,
          redirects: r.redirects.length,
          elapsedMs: Math.round(r.elapsedMs),
          ...(r.headers['x-ratelimit-remaining']
            ? { rateRemaining: r.headers['x-ratelimit-remaining'] }
            : {}),
        });
      } else {
        requests.push({ url: target, ok: false, failure: result.failure.category });
      }
      return result;
    },
  };
  const tokenEnv = option('--token-env');
  const maxFiles = Number(option('--max-files') ?? 40);
  const maxCommits = Number(option('--max-commits') ?? 20);
  const adapter =
    kind === 'github'
      ? createGithubAdapter({
          http: recorder,
          token: tokenEnv ? (process.env[tokenEnv] ?? null) : null,
          limits: { maxFiles, maxCommits },
        })
      : createDevpostAdapter({ http: recorder });
  const started = Date.now();
  const result = await adapter.capture({
    sourceType: kind,
    url,
    signal: new AbortController().signal,
  });
  const elapsedMs = Date.now() - started;
  // The output directory must be new or empty: nothing that is already there is ever overwritten, and an artifact key (which comes from the
  // repository) is never used as a path without the checks in safe-output.ts.
  try {
    if ((await readdir(out)).length > 0) {
      throw new Error(`--out ${out} is not empty; choose a new or empty directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const writer = await createOutputWriter(out);
  const manifest: Record<string, unknown> = {
    kind,
    url,
    adapter: adapter.version,
    status: result.status,
    elapsedMs,
    requestCount: requests.length,
    authenticated: Boolean(tokenEnv && process.env[tokenEnv]),
    limitsUsed: kind === 'github' ? { ...GITHUB_CAPTURE_LIMITS, maxFiles, maxCommits } : undefined,
    requests,
  };
  if ('failure' in result) {
    manifest['failure'] = result.failure;
  } else {
    manifest['revision'] = result.revision;
    manifest['metadata'] = result.metadata;
    manifest['partialReasons'] = result.partialReasons;
    const stored: Record<string, unknown>[] = [];
    for (const artifact of result.artifacts) {
      const placed = await writer.write(`artifacts/${artifact.key}`, artifact.textContent);
      stored.push({
        key: artifact.key,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        contentHash: artifact.contentHash,
        metadata: artifact.metadata,
        storedAs: placed.storedAs,
        mirrored: placed.mirrored,
      });
    }
    manifest['artifacts'] = stored;
  }
  await writer.write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${kind} capture ${result.status} in ${String(elapsedMs)} ms, ${String(requests.length)} requests; manifest: ${resolve(out, 'manifest.json')}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `capture:smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
