import type { ResolvedAddress, Resolver } from './resolver.js';
import type { Transport, TransportRequest, TransportResponse } from './transport.js';

/*
 * A deterministic, in-memory "internet" for tests and explicitly enabled local demos. It replaces
 * only the resolver and the transport: the real SafeHttpClient policy (URL checks, address
 * checks, pinning, redirects, limits) still runs in front of it. Every connection attempt is
 * recorded with the address it was pinned to, so tests can prove that a private target was never
 * contacted. It never opens a socket. The worker refuses to enable it in production.
 */

export type FixtureNetworkError = 'connection_refused' | 'connection_reset' | 'tls' | 'hang';

export interface FixtureResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Text body (UTF-8). */
  readonly body?: string;
  /** A JSON body; serialized and served as `application/json` unless headers say otherwise. */
  readonly json?: unknown;
  /** Body repeated to this many bytes (oversized-response fixtures). */
  readonly repeatToBytes?: number;
  /** Simulated failure instead of a response. `hang` waits until the request is aborted. */
  readonly error?: FixtureNetworkError;
}

export interface FixtureWorld {
  /**
   * DNS answers per host name. A list of addresses is returned for every lookup; a list of lists
   * is a sequence of answers (one per lookup, the last repeating), used for rebinding fixtures.
   */
  readonly hosts: Readonly<Record<string, readonly string[] | readonly (readonly string[])[]>>;
  /**
   * Responses per absolute URL. A list is served in sequence (the last repeating), used for
   * moving-branch fixtures.
   */
  readonly routes: Readonly<Record<string, FixtureResponse | readonly FixtureResponse[]>>;
}

export interface FixtureContact {
  readonly url: string;
  readonly host: string;
  readonly address: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FixtureNetwork {
  readonly resolver: Resolver;
  readonly transport: Transport;
  /** Every connection the transport accepted, in order. */
  readonly contacts: readonly FixtureContact[];
  /** Every DNS lookup, in order. */
  readonly lookups: readonly string[];
}

function isSequence(
  value: readonly string[] | readonly (readonly string[])[],
): value is readonly (readonly string[])[] {
  return value.length > 0 && Array.isArray(value[0]);
}

function errorFor(kind: Exclude<FixtureNetworkError, 'hang'>): Error {
  const code =
    kind === 'connection_refused'
      ? 'ECONNREFUSED'
      : kind === 'connection_reset'
        ? 'ECONNRESET'
        : 'ERR_TLS_CERT_ALTNAME_INVALID';
  return Object.assign(new Error(`fixture ${kind}`), { code });
}

function bodyOf(response: FixtureResponse): { bytes: Uint8Array; contentType: string } {
  let text = response.body ?? '';
  let contentType = 'text/plain; charset=utf-8';
  if (response.json !== undefined) {
    text = JSON.stringify(response.json);
    contentType = 'application/json; charset=utf-8';
  }
  if (response.repeatToBytes !== undefined) {
    const unit = text === '' ? 'x' : text;
    text = unit
      .repeat(Math.ceil(response.repeatToBytes / unit.length))
      .slice(0, response.repeatToBytes);
  }
  return { bytes: new TextEncoder().encode(text), contentType };
}

async function* chunked(bytes: Uint8Array, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const size = 16 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    yield bytes.subarray(offset, offset + size);
    await Promise.resolve();
  }
}

export function createFixtureNetwork(world: FixtureWorld): FixtureNetwork {
  const contacts: FixtureContact[] = [];
  const lookups: string[] = [];
  const lookupCounts = new Map<string, number>();
  const routeCounts = new Map<string, number>();

  const resolver: Resolver = (hostname) => {
    lookups.push(hostname);
    const answers = world.hosts[hostname];
    if (!answers) {
      return Promise.reject(Object.assign(new Error('fixture NXDOMAIN'), { code: 'ENOTFOUND' }));
    }
    let addresses: readonly string[];
    if (isSequence(answers)) {
      const count = lookupCounts.get(hostname) ?? 0;
      lookupCounts.set(hostname, count + 1);
      addresses = answers[Math.min(count, answers.length - 1)] ?? [];
    } else {
      addresses = answers;
    }
    return Promise.resolve(
      addresses.map((address): ResolvedAddress => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );
  };

  const transport: Transport = (request: TransportRequest) => {
    const host = request.url.hostname;
    contacts.push({
      url: request.url.href,
      host,
      address: request.address,
      headers: { ...request.headers },
    });
    const route = world.routes[request.url.href];
    let response: FixtureResponse | undefined;
    if (Array.isArray(route)) {
      const count = routeCounts.get(request.url.href) ?? 0;
      routeCounts.set(request.url.href, count + 1);
      response = (route as readonly FixtureResponse[])[Math.min(count, route.length - 1)];
    } else {
      response = route as FixtureResponse | undefined;
    }
    if (!response) return Promise.reject(errorFor('connection_refused'));
    if (response.error === 'hang') {
      return new Promise<TransportResponse>((_resolve, reject) => {
        const abort = () => {
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (response.error) return Promise.reject(errorFor(response.error));
    const { bytes, contentType } = bodyOf(response);
    let closed = false;
    const body = chunked(bytes, request.signal);
    return Promise.resolve({
      status: response.status ?? 200,
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
        ...Object.fromEntries(
          Object.entries(response.headers ?? {}).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        ),
      },
      body: {
        [Symbol.asyncIterator]: () => {
          if (closed) throw new Error('fixture body closed');
          return body;
        },
      },
      close: () => {
        closed = true;
      },
    });
  };

  return { resolver, transport, contacts, lookups };
}
