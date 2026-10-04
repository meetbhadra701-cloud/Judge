/* Test-only HttpFetcher serving canned routes. Excluded from the package build. */
import type { HttpFetcher, HttpRequestOptions } from '@judge-copilot/capture';
import type { GithubFixtureResponse } from '../fixtures.js';

export interface RecordedRequest {
  readonly url: string;
  readonly options: HttpRequestOptions;
}

export function fakeHttp(routes: Record<string, GithubFixtureResponse | GithubFixtureResponse[]>) {
  const requests: RecordedRequest[] = [];
  const counts = new Map<string, number>();
  const http: HttpFetcher = {
    get(url, options) {
      requests.push({ url, options });
      const route = routes[url];
      let response: GithubFixtureResponse | undefined;
      if (Array.isArray(route)) {
        const count = counts.get(url) ?? 0;
        counts.set(url, count + 1);
        response = route[Math.min(count, route.length - 1)];
      } else {
        response = route;
      }
      if (!response) {
        return Promise.resolve({
          ok: false,
          failure: { category: 'connection_failure', metadata: {} },
        });
      }
      if (response.error === 'hang') {
        return Promise.resolve({
          ok: false,
          failure: { category: 'timeout', metadata: { host: new URL(url).hostname } },
        });
      }
      const body =
        response.json === undefined ? (response.body ?? '') : JSON.stringify(response.json);
      return Promise.resolve({
        ok: true,
        response: {
          requestedUrl: url,
          finalUrl: url,
          status: response.status ?? 200,
          contentType: 'application/json',
          headers: response.headers ?? {},
          body,
          bodyBytes: Buffer.byteLength(body),
          truncated: false,
          bodyOmitted: false,
          redirects: [],
          elapsedMs: 1,
        },
      });
    },
  };
  return { http, requests };
}
