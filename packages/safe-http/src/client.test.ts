import type { HttpRequestOptions } from '@judge-copilot/capture';
import { describe, expect, it } from 'vitest';
import {
  checkUrlPolicy,
  createFixtureNetwork,
  createSafeHttpClient,
  type FixtureWorld,
} from './index.js';

const PUBLIC = '93.184.216.34';
const HTML: HttpRequestOptions = {
  allowHttp: true,
  maxBodyBytes: 64 * 1024,
  oversize: 'fail',
  contentTypes: ['text/html'],
  disallowedContentType: 'fail',
  timeoutMs: 2_000,
};
const page = {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: '<p>ok</p>',
};

function setup(world: Partial<FixtureWorld>) {
  const network = createFixtureNetwork({ hosts: {}, routes: {}, ...world });
  const client = createSafeHttpClient({ resolver: network.resolver, transport: network.transport });
  return { network, client };
}

describe('SafeHttpClient URL policy', () => {
  it.each([
    ['file:///etc/passwd', 'invalid_url', 'scheme_not_allowed'],
    ['data:text/html,<p>x</p>', 'invalid_url', 'scheme_not_allowed'],
    ['ftp://files.example/x', 'invalid_url', 'scheme_not_allowed'],
    ['gopher://x.example/', 'invalid_url', 'scheme_not_allowed'],
    ['javascript:alert(1)', 'invalid_url', 'scheme_not_allowed'],
    ['blob:https://x.example/1', 'invalid_url', 'scheme_not_allowed'],
    ['https://user:pass@app.example/', 'invalid_url', 'credentials_in_url'],
    ['https://app.example:22/', 'ssrf_rejected', 'port_not_allowed'],
    ['http://localhost/', 'ssrf_rejected', 'host_not_allowed'],
    ['http://admin.localhost/', 'ssrf_rejected', 'host_not_allowed'],
    ['http://metadata.google.internal/', 'ssrf_rejected', 'host_not_allowed'],
    ['http://intranet/', 'ssrf_rejected', 'host_not_allowed'],
    ['http://127.0.0.1/', 'ssrf_rejected', 'address_not_public'],
    ['http://2130706433/', 'ssrf_rejected', 'address_not_public'],
    ['http://0x7f.1/', 'ssrf_rejected', 'address_not_public'],
    ['http://169.254.169.254/latest/meta-data/', 'ssrf_rejected', 'address_not_public'],
    ['http://[::1]/', 'ssrf_rejected', 'address_not_public'],
    ['http://[::ffff:10.0.0.1]/', 'ssrf_rejected', 'address_not_public'],
    ['http://[fe80::1]/', 'ssrf_rejected', 'address_not_public'],
  ])('refuses %s before any DNS lookup or connection', async (url, category, reason) => {
    const { client, network } = setup({});
    const result = await client.get(url, HTML);
    expect(result).toMatchObject({ ok: false, failure: { category, metadata: { reason } } });
    expect(network.lookups).toEqual([]);
    expect(network.contacts).toEqual([]);
  });

  it('refuses plain http unless the caller allows it', () => {
    expect(checkUrlPolicy(new URL('http://app.example/'), { allowHttp: false })).toMatchObject({
      category: 'invalid_url',
    });
    expect(checkUrlPolicy(new URL('http://app.example/'), { allowHttp: true })).toBeNull();
  });
});

describe('SafeHttpClient DNS and pinning', () => {
  it('connects only to the validated, pinned address', async () => {
    const { client, network } = setup({
      hosts: { 'app.example': [PUBLIC] },
      routes: { 'https://app.example/': page },
    });
    const result = await client.get('https://app.example/', HTML);
    expect(result).toMatchObject({ ok: true, response: { status: 200, body: '<p>ok</p>' } });
    expect(network.contacts.map((contact) => contact.address)).toEqual([PUBLIC]);
  });

  it.each([
    ['private', ['10.0.0.8']],
    ['metadata', ['169.254.169.254']],
    ['loopback v6', ['::1']],
    ['mixed public and private', [PUBLIC, '192.168.0.10']],
    ['mixed private first', ['127.0.0.1', PUBLIC]],
  ])('rejects a host whose DNS answer is %s', async (_label, addresses) => {
    const { client, network } = setup({
      hosts: { 'evil.example': addresses },
      routes: { 'https://evil.example/': page },
    });
    const result = await client.get('https://evil.example/', HTML);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: 'ssrf_rejected',
        metadata: { reason: 'address_not_public', host: 'evil.example' },
      },
    });
    expect(network.contacts).toEqual([]);
  });

  it('defeats DNS rebinding: the second (private) answer is never used for the connection', async () => {
    const { client, network } = setup({
      hosts: { 'rebind.example': [[PUBLIC], ['127.0.0.1']] },
      routes: { 'https://rebind.example/': page },
    });
    const result = await client.get('https://rebind.example/', HTML);
    expect(result.ok).toBe(true);
    expect(network.lookups).toEqual(['rebind.example']);
    expect(network.contacts).toHaveLength(1);
    expect(network.contacts[0]?.address).toBe(PUBLIC);
    // A later request resolves afresh and is refused when the answer turns private.
    const second = await client.get('https://rebind.example/', HTML);
    expect(second).toMatchObject({ ok: false, failure: { category: 'ssrf_rejected' } });
    expect(network.contacts).toHaveLength(1);
  });

  it('maps resolver failures to dns_failure', async () => {
    const { client } = setup({});
    expect(await client.get('https://nowhere.example/', HTML)).toMatchObject({
      ok: false,
      failure: { category: 'dns_failure', metadata: { host: 'nowhere.example' } },
    });
  });
});

describe('SafeHttpClient redirects', () => {
  it('re-validates every redirect and refuses public -> private metadata', async () => {
    const { client, network } = setup({
      hosts: { 'app.example': [PUBLIC] },
      routes: {
        'https://app.example/': {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        },
        'http://169.254.169.254/latest/meta-data/': { status: 200, body: 'SECRET' },
      },
    });
    const result = await client.get('https://app.example/', HTML);
    expect(result).toMatchObject({ ok: false, failure: { category: 'ssrf_rejected' } });
    expect(network.contacts.map((contact) => contact.address)).toEqual([PUBLIC]);
  });

  it('refuses a redirect to a host that resolves privately', async () => {
    const { client, network } = setup({
      hosts: { 'app.example': [PUBLIC], 'internal.example': ['10.1.2.3'] },
      routes: {
        'https://app.example/': { status: 301, headers: { location: 'https://internal.example/' } },
      },
    });
    const result = await client.get('https://app.example/', HTML);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: 'ssrf_rejected',
        metadata: { host: 'internal.example', redirectCount: 1 },
      },
    });
    expect(network.contacts).toHaveLength(1);
  });

  it('refuses an https -> http downgrade', async () => {
    const { client } = setup({
      hosts: { 'app.example': [PUBLIC] },
      routes: {
        'https://app.example/': { status: 302, headers: { location: 'http://app.example/' } },
      },
    });
    expect(await client.get('https://app.example/', HTML)).toMatchObject({
      ok: false,
      failure: { category: 'ssrf_rejected', metadata: { reason: 'redirect_downgrade' } },
    });
  });

  it('follows at most 5 redirects', async () => {
    const routes: Record<string, FixtureWorld['routes'][string]> = {};
    for (let index = 0; index < 7; index += 1) {
      routes[`https://app.example/${String(index)}`] = {
        status: 307,
        headers: { location: `/${String(index + 1)}` },
      };
    }
    const endless = { ...routes };
    routes['https://app.example/5'] = page;
    const ok = setup({ hosts: { 'app.example': [PUBLIC] }, routes });
    const fine = await ok.client.get('https://app.example/0', HTML);
    expect(fine).toMatchObject({ ok: true, response: { finalUrl: 'https://app.example/5' } });
    if (fine.ok) expect(fine.response.redirects).toHaveLength(5);

    const tooMany = setup({ hosts: { 'app.example': [PUBLIC] }, routes: endless });
    expect(await tooMany.client.get('https://app.example/0', HTML)).toMatchObject({
      ok: false,
      failure: { category: 'too_many_redirects', metadata: { redirectCount: 5 } },
    });
    expect(tooMany.network.contacts).toHaveLength(6);
  });

  it('never forwards credentials or caller headers across origins and never sends cookies', async () => {
    const { client, network } = setup({
      hosts: { 'api.example': [PUBLIC], 'cdn.example': ['93.184.216.35'] },
      routes: {
        'https://api.example/x': { status: 302, headers: { location: 'https://cdn.example/x' } },
        'https://cdn.example/x': { ...page, headers: { ...page.headers, 'set-cookie': 'sid=1' } },
      },
    });
    const result = await client.get('https://api.example/x', {
      ...HTML,
      headers: { authorization: 'Bearer secret-token', cookie: 'sid=0', 'x-custom': '1' },
    });
    expect(result.ok).toBe(true);
    const [first, second] = network.contacts;
    expect(first?.headers['authorization']).toBe('Bearer secret-token');
    expect(first?.headers['cookie']).toBeUndefined();
    expect(second?.headers['authorization']).toBeUndefined();
    expect(second?.headers['x-custom']).toBeUndefined();
    expect(second?.headers['accept']).toBe('text/html');
    expect(second?.headers['accept-encoding']).toBe('identity');
    if (result.ok) expect(JSON.stringify(result.response)).not.toContain('sid=1');
  });
});

describe('SafeHttpClient limits', () => {
  const hosts = { 'app.example': [PUBLIC] };

  it('fails oversized responses or truncates them when asked to', async () => {
    const routes = { 'https://app.example/': { ...page, repeatToBytes: 100_000 } };
    const strict = setup({ hosts, routes });
    expect(await strict.client.get('https://app.example/', HTML)).toMatchObject({
      ok: false,
      failure: { category: 'response_too_large', metadata: { limitValue: 65_536 } },
    });
    const lenient = setup({ hosts, routes });
    const truncated = await lenient.client.get('https://app.example/', {
      ...HTML,
      oversize: 'truncate',
    });
    expect(truncated).toMatchObject({ ok: true, response: { truncated: true, bodyBytes: 65_536 } });
  });

  it('times out a hanging request', async () => {
    const { client } = setup({ hosts, routes: { 'https://app.example/': { error: 'hang' } } });
    const started = Date.now();
    expect(await client.get('https://app.example/', { ...HTML, timeoutMs: 50 })).toMatchObject({
      ok: false,
      failure: { category: 'timeout', metadata: { host: 'app.example' } },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('enforces the content-type allowlist without reading the body', async () => {
    const routes = {
      'https://app.example/video.mp4': {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
        body: 'MEDIA',
      },
    };
    const strict = setup({ hosts, routes });
    expect(await strict.client.get('https://app.example/video.mp4', HTML)).toMatchObject({
      ok: false,
      failure: { category: 'unsupported_content_type', metadata: { reason: 'content_type' } },
    });
    const omit = setup({ hosts, routes });
    const result = await omit.client.get('https://app.example/video.mp4', {
      ...HTML,
      disallowedContentType: 'omit_body',
    });
    expect(result).toMatchObject({
      ok: true,
      response: { body: null, bodyOmitted: true, contentType: 'video/mp4', bodyBytes: 0 },
    });
  });

  it('refuses compressed bodies (identity only) and maps network errors', async () => {
    const encoded = setup({
      hosts,
      routes: {
        'https://app.example/': {
          ...page,
          headers: { ...page.headers, 'content-encoding': 'gzip' },
        },
      },
    });
    expect(await encoded.client.get('https://app.example/', HTML)).toMatchObject({
      ok: false,
      failure: { category: 'unsupported_content_type', metadata: { reason: 'content_encoding' } },
    });
    for (const [error, category] of [
      ['connection_refused', 'connection_failure'],
      ['connection_reset', 'connection_failure'],
      ['tls', 'tls_failure'],
    ] as const) {
      const { client } = setup({ hosts, routes: { 'https://app.example/': { error } } });
      expect(await client.get('https://app.example/', HTML)).toMatchObject({
        ok: false,
        failure: { category },
      });
    }
  });

  it('records only allow-listed response headers', async () => {
    const { client } = setup({
      hosts,
      routes: {
        'https://app.example/': {
          ...page,
          headers: { ...page.headers, server: 'edge', 'set-cookie': 'a=b', 'x-secret': 'token' },
        },
      },
    });
    const result = await client.get('https://app.example/', HTML);
    expect(result.ok && result.response.headers).toEqual({
      'content-length': '9',
      'content-type': 'text/html; charset=utf-8',
      server: 'edge',
    });
  });
});
