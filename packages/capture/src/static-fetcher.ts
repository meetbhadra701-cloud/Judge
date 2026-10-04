import type {
  HttpFetcher,
  HttpFetchResult,
  HttpRequestOptions,
  HttpResponseData,
} from './ports.js';

/*
 * A deterministic in-memory HttpFetcher for adapter tests: it serves canned results per URL and
 * records every request. It performs no policy checks (adapters are tested for SSRF behaviour
 * end-to-end with the real SafeHttpClient in front of a fixture network).
 */

export type StaticRoute =
  | { readonly response: Partial<HttpResponseData> & { readonly status: number } }
  | { readonly failure: Extract<HttpFetchResult, { ok: false }>['failure'] };

export interface StaticFetcher extends HttpFetcher {
  readonly requests: readonly { readonly url: string; readonly options: HttpRequestOptions }[];
}

export function createStaticHttpFetcher(
  routes: Readonly<Record<string, StaticRoute>>,
): StaticFetcher {
  const requests: { url: string; options: HttpRequestOptions }[] = [];
  return {
    requests,
    get(url, options) {
      requests.push({ url, options });
      const route = routes[url];
      if (!route) {
        return Promise.resolve({
          ok: false,
          failure: { category: 'connection_failure', metadata: {} },
        });
      }
      if ('failure' in route) return Promise.resolve({ ok: false, failure: route.failure });
      const body = route.response.body ?? null;
      const contentType = route.response.contentType ?? null;
      const allowed = contentType !== null && options.contentTypes.includes(contentType);
      if (!allowed && options.disallowedContentType === 'fail') {
        return Promise.resolve({
          ok: false,
          failure: {
            category: 'unsupported_content_type',
            metadata: { httpStatus: route.response.status },
          },
        });
      }
      let text = allowed ? body : null;
      let truncated = false;
      if (text !== null && Buffer.byteLength(text) > options.maxBodyBytes) {
        if (options.oversize === 'fail') {
          return Promise.resolve({
            ok: false,
            failure: { category: 'response_too_large', metadata: {} },
          });
        }
        text = Buffer.from(text).subarray(0, options.maxBodyBytes).toString('utf8');
        truncated = true;
      }
      return Promise.resolve({
        ok: true,
        response: {
          requestedUrl: url,
          finalUrl: url,
          headers: {},
          redirects: [],
          elapsedMs: 1,
          ...route.response,
          contentType,
          body: text,
          bodyBytes: text === null ? 0 : Buffer.byteLength(text),
          truncated,
          bodyOmitted: !allowed,
        },
      });
    },
  };
}
