import { createLogger } from '@judge-copilot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME, type ApiApp } from './app.js';
import { ApiEnv, loadApiEnv } from './env.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
let app: ApiApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns the structured liveness status', async () => {
    app = buildApp({ logger });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ status: 'ok', service: 'judge-copilot-api' });
  });

  it('responds 404 for routes that do not exist in M0', async () => {
    app = buildApp({ logger });
    const response = await app.inject({ method: 'GET', url: '/projects' });
    expect(response.statusCode).toBe(404);
  });

  it('serves /health over a real loopback socket and closes cleanly', async () => {
    app = buildApp({ logger });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const response = await fetch(`${address}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: SERVICE_NAME });

    await app.close();
    expect(app.server.listening).toBe(false);
  });
});

describe('api environment', () => {
  it('boots without a DATABASE_URL and uses safe local defaults', () => {
    expect(loadApiEnv({})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: 3001,
    });
  });

  it('rejects an out-of-range port', () => {
    expect(ApiEnv.safeParse({ API_PORT: '65536' }).success).toBe(false);
  });
});
