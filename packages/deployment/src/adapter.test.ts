import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createStaticHttpFetcher,
  validateCaptureResult,
  type StaticRoute,
} from '@judge-copilot/capture';
import { describe, expect, it } from 'vitest';
import { createDeploymentAdapter } from './index.js';

const HOME = readFileSync(
  resolve(import.meta.dirname, '../../../tests/fixtures/source-capture/pages/atlas-home.html'),
  'utf8',
);
const URL_ = 'https://atlas.example.org/';

async function capture(route: StaticRoute, url = URL_) {
  const http = createStaticHttpFetcher({ [URL_]: route });
  const result = await createDeploymentAdapter({ http }).capture({
    sourceType: 'deployment',
    url,
    signal: new AbortController().signal,
  });
  return { result: validateCaptureResult('deployment', result), http };
}

function artifactJson(result: Awaited<ReturnType<typeof capture>>['result'], key: string) {
  if (result.status !== 'captured' && result.status !== 'partial') throw new Error(result.status);
  return JSON.parse(result.artifacts.find((a) => a.key === key)?.textContent ?? 'null') as Record<
    string,
    unknown
  >;
}

describe('deployment adapter', () => {
  it('captures an HTTP 200 page with status, allow-listed headers, metadata and text', async () => {
    const { result, http } = await capture({
      response: { status: 200, contentType: 'text/html', body: HOME, headers: { server: 'edge' } },
    });
    expect(result).toMatchObject({
      status: 'captured',
      metadata: { httpStatus: 200, title: 'Synthetic Atlas — offline maps' },
    });
    expect(artifactJson(result, 'response.json')).toMatchObject({
      httpStatus: 200,
      headers: { server: 'edge' },
    });
    expect(artifactJson(result, 'page.json')).toMatchObject({
      scriptCount: 2,
      canonicalUrl: 'https://atlas.example.org/',
    });
    // One request only: scripts and links on the page are never fetched or run.
    expect(http.requests.map((request) => request.url)).toEqual([URL_]);
    expect(http.requests[0]?.options).toMatchObject({
      allowHttp: true,
      disallowedContentType: 'omit_body',
    });
  });

  it.each([404, 500])('captures HTTP %s as an observation, not a failure', async (status) => {
    const { result } = await capture({
      response: { status, contentType: 'text/html', body: '<title>Error</title><p>nope</p>' },
    });
    expect(result).toMatchObject({ status: 'captured', metadata: { httpStatus: status } });
    expect(artifactJson(result, 'response.json')).toMatchObject({ httpStatus: status });
  });

  it.each([
    ['timeout', 'failed'],
    ['tls_failure', 'failed'],
    ['connection_failure', 'failed'],
    ['dns_failure', 'failed'],
    ['ssrf_rejected', 'rejected'],
    ['too_many_redirects', 'rejected'],
  ] as const)('maps transport outcome %s to %s with safe metadata', async (category, status) => {
    const { result } = await capture({
      failure: { category, metadata: { host: 'atlas.example.org', elapsedMs: 5 } },
    });
    expect(result).toEqual({
      status,
      failure: {
        category,
        metadata: { host: 'atlas.example.org', elapsedMs: 5, adapter: 'deployment' },
      },
    });
  });

  it('enforces the body limit as an explicit partial result', async () => {
    const { result } = await capture({
      response: {
        status: 200,
        contentType: 'text/html',
        body: `<p>${'x'.repeat(2 * 1024 * 1024)}</p>`,
      },
    });
    expect(result).toMatchObject({ status: 'partial', partialReasons: ['body_truncated'] });
    expect(artifactJson(result, 'response.json')).toMatchObject({
      bodyTruncated: true,
      bodyBytesRead: 1024 * 1024,
    });
  });

  it('records disallowed content types without reading or storing the body', async () => {
    const { result } = await capture({
      response: { status: 200, contentType: 'application/octet-stream', body: 'BINARY' },
    });
    expect(result).toMatchObject({ status: 'partial', partialReasons: ['body_not_captured'] });
    if (result.status === 'partial') {
      expect(result.artifacts.map((a) => a.key)).toEqual(['response.json']);
      expect(JSON.stringify(result)).not.toContain('BINARY');
    }
  });

  it('rejects malformed URLs before any request', async () => {
    const { result, http } = await capture(
      { response: { status: 200 } },
      'ftp://atlas.example.org/',
    );
    expect(result).toMatchObject({ status: 'rejected', failure: { category: 'invalid_url' } });
    expect(http.requests).toEqual([]);
  });
});
