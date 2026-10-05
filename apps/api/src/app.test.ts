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
      EVENT_CONTEXT_EXTRACTOR: 'none',
      AUTH_MODE: 'none',
      AUTH_JWT_ROLES_CLAIM: 'roles',
    });
  });

  it('never enables development auth implicitly and refuses it in production', () => {
    expect(loadApiEnv({}).AUTH_MODE).toBe('none');
    expect(ApiEnv.safeParse({ AUTH_MODE: 'dev' }).success).toBe(true);
    expect(ApiEnv.safeParse({ AUTH_MODE: 'dev', NODE_ENV: 'production' }).success).toBe(false);
    // Production with a database must use JWT verification.
    expect(
      ApiEnv.safeParse({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db/x' }).success,
    ).toBe(false);
    expect(ApiEnv.safeParse({ AUTH_MODE: 'jwt' }).success).toBe(false);
    const jwt = {
      AUTH_MODE: 'jwt',
      AUTH_JWT_ISSUER: 'https://idp.example.test/',
      AUTH_JWT_AUDIENCE: 'judge-copilot-api',
      AUTH_JWKS_URL: 'https://idp.example.test/.well-known/jwks.json',
    };
    expect(
      ApiEnv.safeParse({ ...jwt, NODE_ENV: 'production', DATABASE_URL: 'postgres://db/x' }).success,
    ).toBe(true);
    expect(
      ApiEnv.safeParse({
        ...jwt,
        NODE_ENV: 'production',
        AUTH_JWKS_URL: 'http://idp.example.test/jwks',
      }).success,
    ).toBe(false);
  });

  it('never enables the replay extractor implicitly, and refuses it in production', () => {
    expect(ApiEnv.safeParse({ EVENT_CONTEXT_EXTRACTOR: 'replay' }).success).toBe(false);
    expect(
      ApiEnv.safeParse({ EVENT_CONTEXT_EXTRACTOR: 'replay', EVENT_CONTEXT_REPLAY_DIR: '/fixtures' })
        .success,
    ).toBe(true);
    expect(
      ApiEnv.safeParse({
        NODE_ENV: 'production',
        EVENT_CONTEXT_EXTRACTOR: 'replay',
        EVENT_CONTEXT_REPLAY_DIR: '/fixtures',
      }).success,
    ).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(ApiEnv.safeParse({ API_PORT: '65536' }).success).toBe(false);
  });
});
