import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeTransport, pinnedLookup, pinnedRequestOptions } from './index.js';

/*
 * Exercises the real Node transport against a loopback server. The URL names a host that does
 * not exist in DNS (`.invalid`); the request can only succeed because the connection is pinned
 * to the supplied address without any resolution, and the server still sees the original Host.
 */
describe('pinned node transport', () => {
  let port = 0;
  let seen: IncomingHttpHeaders | undefined;
  const server = createServer((request, response) => {
    seen = request.headers;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('pinned');
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('connects to the pinned address while preserving the Host header', async () => {
    const url = new URL(`http://rebind-target.invalid:${String(port)}/path?q=1`);
    const response = await nodeTransport({
      url,
      address: '127.0.0.1',
      family: 4,
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(5_000),
    });
    let body = '';
    for await (const chunk of response.body) body += Buffer.from(chunk).toString();
    response.close();
    expect(response.status).toBe(200);
    expect(body).toBe('pinned');
    expect(seen?.host).toBe(`rebind-target.invalid:${String(port)}`);
    expect(seen?.cookie).toBeUndefined();
  });

  it('pins lookups to one host and address and keeps SNI for https', () => {
    const options = pinnedRequestOptions({
      url: new URL('https://app.example/x'),
      address: '93.184.216.34',
      family: 4,
      headers: {},
      signal: new AbortController().signal,
    });
    expect(options).toMatchObject({
      hostname: 'app.example',
      servername: 'app.example',
      path: '/x',
    });
    expect(options.headers).toMatchObject({ host: 'app.example' });
    const answers: unknown[] = [];
    const lookup = pinnedLookup('app.example', '93.184.216.34', 4);
    lookup('app.example', {}, (error, address) => answers.push([error, address]));
    lookup('app.example', { all: true }, (error, address) => answers.push([error, address]));
    lookup('other.example', {}, (error) => answers.push((error as { code?: string } | null)?.code));
    expect(answers).toEqual([
      [null, '93.184.216.34'],
      [null, [{ address: '93.184.216.34', family: 4 }]],
      'ENOTFOUND',
    ]);
  });
});
