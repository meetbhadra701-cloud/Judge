import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';

/*
 * The default transport: Node's http/https with the connection pinned to an address that the
 * client has already resolved and validated. Node's `lookup` hook is replaced by a function that
 * only ever returns that address, so no second, uncontrolled DNS resolution can happen (DNS
 * rebinding defence). The URL's host name is kept for the Host header and TLS SNI/certificate
 * verification, which is forced on (`rejectUnauthorized: true`) whatever the process environment says. A fresh agent per request means no connection reuse, no cookies, no proxy from
 * the environment and no state shared between captures.
 */

export interface TransportRequest {
  readonly url: URL;
  /** The validated address to connect to. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Releases the connection without reading the rest of the body. */
  close(): void;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** A lookup that answers only for `hostname`, and only with the pinned address. */
export function pinnedLookup(hostname: string, address: string, family: 4 | 6): LookupFunction {
  return (requested, options, callback) => {
    if (requested.toLowerCase() !== hostname.toLowerCase()) {
      const error = Object.assign(new Error('Unexpected host lookup'), { code: 'ENOTFOUND' });
      callback(error, '', 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ]);
      return;
    }
    callback(null, address, family);
  };
}

export function hostnameOf(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Request options for the pinned connection (exported so the pinning can be asserted). */
export function pinnedRequestOptions(request: TransportRequest): https.RequestOptions {
  const { url } = request;
  const hostname = hostnameOf(url);
  const secure = url.protocol === 'https:';
  const literal = isIP(hostname) !== 0;
  const agentOptions = { keepAlive: false, maxSockets: 1 };
  return {
    protocol: url.protocol,
    // For a host name, the pinned lookup supplies the address; an IP literal needs no lookup.
    hostname: literal ? request.address : hostname,
    family: request.family,
    port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { ...request.headers, host: url.host },
    lookup: pinnedLookup(hostname, request.address, request.family),
    ...(secure && !literal ? { servername: hostname } : {}),
    // Certificates are ALWAYS verified. Without this, NODE_TLS_REJECT_UNAUTHORIZED=0 in the
    // worker's environment would silently disable verification for every capture.
    ...(secure ? { rejectUnauthorized: true } : {}),
    agent: secure
      ? new https.Agent({ ...agentOptions, rejectUnauthorized: true })
      : new http.Agent(agentOptions),
    signal: request.signal,
  };
}

export const nodeTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const options = pinnedRequestOptions(request);
    const send = request.url.protocol === 'https:' ? https.request : http.request;
    const outgoing = send(options, (incoming) => {
      resolve({
        status: incoming.statusCode ?? 0,
        headers: incoming.headers,
        body: incoming,
        close: () => {
          incoming.destroy();
          outgoing.destroy();
          (options.agent as http.Agent).destroy();
        },
      });
    });
    outgoing.on('error', (error) => {
      (options.agent as http.Agent).destroy();
      reject(error);
    });
    outgoing.end();
  });
