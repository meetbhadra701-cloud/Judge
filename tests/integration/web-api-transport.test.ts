import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, classifyTransportFailure } from '../../apps/web/lib/api.js';

/*
 * R7B: a lost response must never be reported with a message that is false. Two different situations used to share one code:
 *   - the connection was never established (the request did not leave): the outcome is KNOWN -- nothing was saved;
 *   - the request may have been sent but no answer arrived (reset, timeout, torn stream): the outcome is UNKNOWN.
 * These tests drive the real fetch against real sockets on loopback, so the classification rests on what the runtime actually reports.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function apiAt(url: string) {
  vi.resetModules();
  vi.stubEnv('JUDGE_API_URL', url);
  return (await import('../../apps/web/lib/api.js')).apiRequest;
}

describe('apiRequest transport failures', () => {
  it('a refused connection (nothing listening) is API_UNREACHABLE and says the request was not sent', async () => {
    const port = await freePort();
    const request = await apiAt(`http://127.0.0.1:${String(port)}`);
    const result = await request('POST', '/anything', { a: 1 });
    expect(result).toMatchObject({ ok: false, code: 'API_UNREACHABLE' });
    expect(!result.ok && result.message).toMatch(/not sent/i);
  });

  it('a connection that is reset AFTER the request was received is API_NO_ANSWER: the outcome is unknown, and the message says so', async () => {
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.destroy(); // the request arrived; the answer never will
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const request = await apiAt(`http://127.0.0.1:${String(port)}`);
    const post = await request('POST', '/x', { a: 1 });
    expect(post).toMatchObject({ ok: false, code: 'API_NO_ANSWER' });
    expect(!post.ok && post.message).toMatch(/may or may not have been processed/i);
    const get = await request('GET', '/x');
    expect(get).toMatchObject({ ok: false, code: 'API_NO_ANSWER' });
    expect(!get.ok && get.message).not.toMatch(/processed|saved/i);
  });

  it('classifies by the error codes the runtime reports, and treats anything it does not know as unknown', () => {
    const withCode = (code: string) => Object.assign(new Error('x'), { code });
    expect(classifyTransportFailure(withCode('ECONNREFUSED'))).toBe('API_UNREACHABLE');
    expect(classifyTransportFailure(withCode('ENOTFOUND'))).toBe('API_UNREACHABLE');
    expect(
      classifyTransportFailure(new Error('fetch failed', { cause: withCode('EAI_AGAIN') })),
    ).toBe('API_UNREACHABLE');
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR']) {
      expect(classifyTransportFailure(withCode(code))).toBe('API_NO_ANSWER');
    }
    expect(classifyTransportFailure(new DOMException('timed out', 'TimeoutError'))).toBe(
      'API_NO_ANSWER',
    );
    expect(classifyTransportFailure('not even an error')).toBe('API_NO_ANSWER');
  });

  it('exports the same function the page code uses', () => {
    expect(typeof apiRequest).toBe('function');
  });
});
