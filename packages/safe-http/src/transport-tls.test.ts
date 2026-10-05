import { generateKeyPairSync, sign } from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeTransport, pinnedRequestOptions } from './index.js';

/*
 * Certificate verification must not depend on the process environment. Node honours
 * NODE_TLS_REJECT_UNAUTHORIZED=0 process-wide unless a request says otherwise, so the pinned
 * transport sets `rejectUnauthorized: true` itself. These tests use a REAL local TLS server with a
 * self-signed certificate generated at run time (a minimal DER encoder over node:crypto: no
 * committed key material, no child process, no dependency).
 */

const HOST = 'app.example';

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 128
      ? Buffer.from([body.length])
      : body.length < 256
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (...bytes: number[]) => der(0x06, Buffer.from(bytes));
const utf8 = (text: string) => der(0x0c, Buffer.from(text));
const utcTime = (date: Date) =>
  der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));

/** A throwaway self-signed ECDSA P-256 certificate for `HOST` (and its private key), as PEM. */
function selfSignedCertificate(): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaSha256 = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
  const name = seq(der(0x31, seq(oid(0x55, 0x04, 0x03), utf8(HOST))));
  const now = Date.now();
  const subjectAltName = seq(oid(0x55, 0x1d, 0x11), der(0x04, seq(der(0x82, Buffer.from(HOST)))));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    ecdsaSha256,
    name,
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(subjectAltName)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = seq(
    tbs,
    ecdsaSha256,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const pem = (label: string, body: Buffer) =>
    `-----BEGIN ${label}-----\n${(body.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
  return {
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('pinned transport TLS verification', () => {
  const credential = 'Bearer synthetic-test-credential';
  let port = 0;
  let served = 0;
  let credentialSeen = false;
  const material = selfSignedCertificate();
  const server = https.createServer(material, (request, response) => {
    served += 1;
    if (request.headers.authorization !== undefined) credentialSeen = true;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('impostor');
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  const request = () =>
    nodeTransport({
      url: new URL(`https://${HOST}:${String(port)}/`),
      address: '127.0.0.1',
      family: 4,
      headers: { authorization: credential },
      signal: AbortSignal.timeout(5_000),
    });

  function plainGet(options: https.RequestOptions): Promise<number> {
    return new Promise((resolve, reject) => {
      const outgoing = https.request(
        {
          hostname: '127.0.0.1',
          port,
          servername: HOST,
          lookup: (_name, _options, callback) => {
            (callback as (e: null, a: string, f: number) => void)(null, '127.0.0.1', 4);
          },
          agent: new https.Agent({ keepAlive: false }),
          ...options,
        },
        (incoming) => {
          incoming.resume();
          resolve(incoming.statusCode ?? 0);
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  }

  it('sets rejectUnauthorized for https and leaves plain http alone', () => {
    const signal = new AbortController().signal;
    const secure = pinnedRequestOptions({
      url: new URL('https://app.example/x'),
      address: '93.184.216.34',
      family: 4,
      headers: {},
      signal,
    });
    expect(secure.rejectUnauthorized).toBe(true);
    expect((secure.agent as https.Agent).options.rejectUnauthorized).toBe(true);
    // SNI, Host and the pinned address are unchanged.
    expect(secure).toMatchObject({ hostname: 'app.example', servername: 'app.example' });
    expect(secure.headers).toMatchObject({ host: 'app.example' });
    const plain = pinnedRequestOptions({
      url: new URL('http://app.example/x'),
      address: '93.184.216.34',
      family: 4,
      headers: {},
      signal,
    });
    expect('rejectUnauthorized' in plain).toBe(false);
  });

  it('controls: the impostor works, and the environment variable really disables checks', async () => {
    const saved = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    try {
      // The server and certificate are usable when verification is explicitly off ...
      expect(await plainGet({ rejectUnauthorized: false })).toBe(200);
      // ... a default Node request verifies and refuses the self-signed certificate ...
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      await expect(plainGet({})).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
      // ... and with the variable set, that same default request is silently accepted.
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      expect(await plainGet({})).toBe(200);
    } finally {
      if (saved === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = saved;
    }
  });

  it('still rejects a self-signed server with NODE_TLS_REJECT_UNAUTHORIZED=0 and sends it no credential', async () => {
    const saved = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    served = 0;
    credentialSeen = false;
    try {
      for (const value of [undefined, '0']) {
        if (value === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
        else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = value;
        await expect(request()).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
      }
    } finally {
      if (saved === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = saved;
    }
    // No HTTP request reached the impostor, so the Authorization header was never delivered.
    expect(served).toBe(0);
    expect(credentialSeen).toBe(false);
  });
});
