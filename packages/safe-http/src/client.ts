import { isIP } from 'node:net';
import type {
  CaptureFailure,
  HttpFetcher,
  HttpFetchResult,
  HttpRequestOptions,
} from '@judge-copilot/capture';
import { failure, safeHost } from '@judge-copilot/capture';
import type { CaptureFailureCategory, CaptureFailureMetadata } from '@judge-copilot/schemas';
import { classifyAddress } from './ip-policy.js';
import { systemResolver, type ResolvedAddress, type Resolver } from './resolver.js';
import { nodeTransport, type Transport, type TransportResponse } from './transport.js';
import { checkUrlPolicy, hostLiteral } from './url-policy.js';

/*
 * SafeHttpClient: the only way capture code reaches the network.
 *
 * For every hop (the original URL and each redirect target) it:
 *   1. checks scheme, credentials, port and IP-literal/internal host names;
 *   2. resolves the host name once and refuses if ANY answer is non-public;
 *   3. connects to the validated address only (pinned lookup, original Host header and SNI);
 *   4. never follows redirects automatically: each Location is re-validated from step 1, an
 *      https → http downgrade is refused, and at most 5 redirects are followed;
 *   5. drops caller headers (credentials) when a redirect leaves the original origin.
 * It sends no cookies, ignores Set-Cookie, requests `identity` encoding, enforces a total timeout,
 * a body byte limit and a content-type allowlist, and never stores a response it was not asked
 * for. Failures are sanitized categories with allow-listed metadata: never a raw error, header or
 * body.
 */

export const MAX_REDIRECTS = 5;
export const USER_AGENT = 'JudgeCopilot-SourceCapture/1 (read-only snapshot)';

/** Response headers that may be recorded (lowercase). Values are capped at 1,000 characters. */
export const RECORDED_RESPONSE_HEADERS: readonly string[] = [
  'cache-control',
  'content-language',
  'content-length',
  'content-security-policy',
  'content-type',
  'etag',
  'last-modified',
  'retry-after',
  'server',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'x-powered-by',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
];

/** Caller headers that survive a cross-origin redirect. */
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['accept']);
/** Headers a caller may never set. */
const FORBIDDEN_HEADERS = new Set([
  'cookie',
  'host',
  'accept-encoding',
  'connection',
  'proxy-authorization',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeHttpClientOptions {
  readonly resolver?: Resolver;
  readonly transport?: Transport;
  readonly now?: () => number;
}

class FetchFailure extends Error {
  constructor(readonly failure: CaptureFailure) {
    super(failure.category);
  }
}

function fail(category: CaptureFailureCategory, metadata: CaptureFailureMetadata): never {
  throw new FetchFailure(failure(category, metadata));
}

function header(headers: TransportResponse['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function mediaType(contentType: string | undefined): { essence: string | null; charset: string } {
  if (!contentType) return { essence: null, charset: 'utf-8' };
  const [essence = '', ...params] = contentType.split(';').map((part) => part.trim().toLowerCase());
  const charset = params
    .find((param) => param.startsWith('charset='))
    ?.slice(8)
    .replace(/"/g, '');
  return { essence: essence === '' ? null : essence, charset: charset ?? 'utf-8' };
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Maps a transport/resolver error to a sanitized category. The error itself is discarded. */
export function categorizeNetworkError(
  error: unknown,
  signal: AbortSignal,
): CaptureFailureCategory {
  if (signal.aborted) return 'timeout';
  const rawCode = (error as { code?: unknown } | null)?.code;
  const rawName = (error as { name?: unknown } | null)?.name;
  const code = typeof rawCode === 'string' ? rawCode : '';
  const name = typeof rawName === 'string' ? rawName : '';
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR') return 'timeout';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'dns_failure';
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('CERT_') ||
    code.startsWith('UNABLE_TO_') ||
    code.includes('SELF_SIGNED') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'EPROTO'
  ) {
    return 'tls_failure';
  }
  return 'connection_failure';
}

/** Rejects as soon as `signal` aborts, so a slow resolver cannot outlive the request deadline. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('resolver failure'));
      },
    );
  });
}

export function createSafeHttpClient(options: SafeHttpClientOptions = {}): HttpFetcher {
  const resolver = options.resolver ?? systemResolver;
  const transport = options.transport ?? nodeTransport;
  const now = options.now ?? (() => performance.now());

  async function resolveTarget(url: URL, signal: AbortSignal): Promise<ResolvedAddress> {
    const literal = hostLiteral(url);
    const host = safeHost(url.href);
    const meta = host ? { host } : {};
    const family = isIP(literal);
    if (family !== 0) {
      // Already range-checked by checkUrlPolicy; no DNS involved.
      return { address: literal, family: family === 6 ? 6 : 4 };
    }
    let answers: readonly ResolvedAddress[];
    try {
      answers = await abortable(resolver(literal), signal);
    } catch (error) {
      fail(categorizeNetworkError(error, signal) === 'timeout' ? 'timeout' : 'dns_failure', meta);
    }
    if (signal.aborted) fail('timeout', meta);
    if (answers.length === 0) fail('dns_failure', meta);
    // Every answer must be public: a mixed answer set is refused, never "pick the good one".
    for (const answer of answers) {
      if (!classifyAddress(answer.address).allowed) {
        fail('ssrf_rejected', { ...meta, reason: 'address_not_public' });
      }
    }
    const [first] = answers;
    if (!first) fail('dns_failure', meta);
    return first;
  }

  function requestHeaders(
    request: HttpRequestOptions,
    sameOrigin: boolean,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: request.contentTypes.join(', ') || '*/*',
    };
    for (const [rawName, value] of Object.entries(request.headers ?? {})) {
      const name = rawName.toLowerCase();
      if (FORBIDDEN_HEADERS.has(name)) continue;
      if (!sameOrigin && !CROSS_ORIGIN_SAFE_HEADERS.has(name)) continue;
      headers[name] = value;
    }
    headers['accept-encoding'] = 'identity';
    return headers;
  }

  async function readBody(
    response: TransportResponse,
    request: HttpRequestOptions,
    meta: CaptureFailureMetadata,
  ): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const declared = Number(header(response.headers, 'content-length'));
    if (
      request.oversize === 'fail' &&
      Number.isFinite(declared) &&
      declared > request.maxBodyBytes
    ) {
      response.close();
      fail('response_too_large', {
        ...meta,
        limit: 'max_body_bytes',
        limitValue: request.maxBodyBytes,
      });
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      if (total + chunk.byteLength > request.maxBodyBytes) {
        if (request.oversize === 'fail') {
          response.close();
          fail('response_too_large', {
            ...meta,
            limit: 'max_body_bytes',
            limitValue: request.maxBodyBytes,
          });
        }
        chunks.push(chunk.subarray(0, request.maxBodyBytes - total));
        total = request.maxBodyBytes;
        truncated = true;
        response.close();
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, truncated };
  }

  async function get(rawUrl: string, request: HttpRequestOptions): Promise<HttpFetchResult> {
    const started = now();
    const maxRedirects = Math.min(request.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS);
    const signals = [AbortSignal.timeout(request.timeoutMs)];
    if (request.signal) signals.push(request.signal);
    const signal = AbortSignal.any(signals);
    const elapsed = () => Math.max(0, Math.round(now() - started));
    let host: string | undefined;
    const redirects: { status: number; url: string }[] = [];
    try {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return { ok: false, failure: failure('invalid_url', { reason: 'unparsable' }) };
      }
      const origin = url.origin;
      for (;;) {
        host = safeHost(url.href);
        const meta: CaptureFailureMetadata = host ? { host } : {};
        const refusal = checkUrlPolicy(url, { allowHttp: request.allowHttp ?? false });
        if (refusal) {
          return {
            ok: false,
            failure: failure(refusal.category, {
              ...refusal.metadata,
              redirectCount: redirects.length,
            }),
          };
        }
        const target = await resolveTarget(url, signal);
        let response: TransportResponse;
        try {
          response = await transport({
            url,
            address: target.address,
            family: target.family,
            headers: requestHeaders(request, url.origin === origin),
            signal,
          });
        } catch (error) {
          fail(categorizeNetworkError(error, signal), { ...meta, elapsedMs: elapsed() });
        }

        const location = header(response.headers, 'location');
        if (REDIRECT_STATUSES.has(response.status) && location !== undefined) {
          response.close();
          if (redirects.length >= maxRedirects) {
            fail('too_many_redirects', {
              ...meta,
              redirectCount: redirects.length,
              limitValue: maxRedirects,
            });
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            fail('invalid_url', { ...meta, reason: 'invalid_redirect' });
          }
          if (url.protocol === 'https:' && next.protocol === 'http:') {
            fail('ssrf_rejected', { ...meta, reason: 'redirect_downgrade' });
          }
          next.hash = '';
          redirects.push({ status: response.status, url: next.href });
          url = next;
          continue;
        }

        const contentTypeHeader = header(response.headers, 'content-type');
        const { essence, charset } = mediaType(contentTypeHeader);
        const headers: Record<string, string> = {};
        for (const name of RECORDED_RESPONSE_HEADERS) {
          const value = header(response.headers, name);
          if (value !== undefined) headers[name] = value.slice(0, 1_000);
        }
        const base = {
          requestedUrl: rawUrl,
          finalUrl: url.href,
          status: response.status,
          contentType: essence,
          headers,
          redirects,
        };
        const encoding = (header(response.headers, 'content-encoding') ?? 'identity').toLowerCase();
        const allowedType = essence !== null && request.contentTypes.includes(essence);
        if (!allowedType || encoding !== 'identity') {
          // The body is never read: no downloads of unexpected or encoded content.
          response.close();
          if (request.disallowedContentType === 'fail') {
            fail('unsupported_content_type', {
              ...meta,
              httpStatus: response.status,
              reason: allowedType ? 'content_encoding' : 'content_type',
            });
          }
          return {
            ok: true,
            response: {
              ...base,
              body: null,
              bodyBytes: 0,
              truncated: false,
              bodyOmitted: true,
              elapsedMs: elapsed(),
            },
          };
        }
        let body: { bytes: Uint8Array; truncated: boolean };
        try {
          body = await readBody(response, request, { ...meta, httpStatus: response.status });
        } catch (error) {
          if (error instanceof FetchFailure) throw error;
          response.close();
          fail(categorizeNetworkError(error, signal), { ...meta, elapsedMs: elapsed() });
        }
        return {
          ok: true,
          response: {
            ...base,
            body: decode(body.bytes, charset),
            bodyBytes: body.bytes.byteLength,
            truncated: body.truncated,
            bodyOmitted: false,
            elapsedMs: elapsed(),
          },
        };
      }
    } catch (error) {
      if (error instanceof FetchFailure) {
        return {
          ok: false,
          failure: failure(error.failure.category, {
            elapsedMs: elapsed(),
            ...error.failure.metadata,
            ...(redirects.length > 0 ? { redirectCount: redirects.length } : {}),
          }),
        };
      }
      return {
        ok: false,
        failure: failure(categorizeNetworkError(error, signal), {
          ...(host ? { host } : {}),
          elapsedMs: elapsed(),
        }),
      };
    }
  }

  return { get };
}
