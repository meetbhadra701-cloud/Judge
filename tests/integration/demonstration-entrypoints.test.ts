import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * P6D: the REAL entry points (`apps/api/src/main.ts`, `apps/worker/src/main.ts`, run as separate processes exactly as `pnpm dev` runs them) refuse
 * to start with a demonstration provider unless NODE_ENV was set explicitly to development or test. This is the behavioral guard the R8A review
 * found missing: it fails if the refusal is removed from the loaders, from the wiring in main.ts, or if a new default sneaks in.
 * No database is contacted: the configuration is rejected before any connection is opened.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const PROD_AUTH = {
  AUTH_MODE: 'jwt',
  AUTH_JWT_ISSUER: 'https://issuer.example',
  AUTH_JWT_AUDIENCE: 'judge',
  AUTH_JWKS_URL: 'https://issuer.example/.well-known/jwks.json',
};

interface Result {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

function run(
  app: 'api' | 'worker',
  env: Record<string, string>,
  aliveMs = 25_000,
): Promise<Result> {
  const dir = join(ROOT, 'apps', app);
  // a clean environment: nothing from this test process (NODE_ENV=test, DATABASE_URL, ...) leaks into the process under test
  const clean: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    ...env,
  };
  return new Promise((done) => {
    const child = spawn(
      join(ROOT, 'node_modules/.bin/tsx'),
      ['--conditions=@judge-copilot/source', 'src/main.ts'],
      {
        cwd: dir,
        env: clean,
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), aliveMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, output });
    });
  });
}

const refused = (result: Result) => {
  expect(result.signal, result.output).toBeNull(); // it exited by itself, it was not killed while running
  expect(result.code, result.output).not.toBe(0);
  expect(result.output).toMatch(/ConfigError|Invalid environment configuration/);
};

const DB = { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/never_contacted' };

describe('the built processes refuse a demonstration provider outside an explicit development or test environment', () => {
  const cases: [string, 'api' | 'worker', Record<string, string>, RegExp][] = [
    [
      'API, production, scripted',
      'api',
      { ...DB, ...PROD_AUTH, NODE_ENV: 'production', ASSESSMENT_PROVIDER: 'scripted' },
      /scripted demonstration provider is for development and tests only/,
    ],
    [
      'worker, production, scripted',
      'worker',
      { ...DB, NODE_ENV: 'production', ASSESSMENT_PROVIDER: 'scripted' },
      /scripted demonstration provider is for development and tests only/,
    ],
    [
      'API, production, replay',
      'api',
      {
        ...DB,
        ...PROD_AUTH,
        NODE_ENV: 'production',
        ASSESSMENT_PROVIDER: 'replay',
        ASSESSMENT_REPLAY_FIXTURE: '/x.json',
      },
      /ASSESSMENT_PROVIDER/,
    ],
    [
      'worker, production, replay',
      'worker',
      {
        ...DB,
        NODE_ENV: 'production',
        ASSESSMENT_PROVIDER: 'replay',
        ASSESSMENT_REPLAY_FIXTURE: '/x.json',
      },
      /ASSESSMENT_PROVIDER/,
    ],
    [
      'API, NODE_ENV unset, scripted',
      'api',
      { ...DB, AUTH_MODE: 'dev', ASSESSMENT_PROVIDER: 'scripted' },
      /requires NODE_ENV to be set explicitly/,
    ],
    [
      'worker, NODE_ENV unset, scripted',
      'worker',
      { ...DB, ASSESSMENT_PROVIDER: 'scripted' },
      /requires NODE_ENV to be set explicitly/,
    ],
    [
      'API, NODE_ENV empty, scripted',
      'api',
      { ...DB, AUTH_MODE: 'dev', NODE_ENV: '', ASSESSMENT_PROVIDER: 'scripted' },
      /requires NODE_ENV to be set explicitly/,
    ],
    [
      'worker, NODE_ENV=Production (misspelt), scripted',
      'worker',
      { ...DB, NODE_ENV: 'Production', ASSESSMENT_PROVIDER: 'scripted' },
      /NODE_ENV/,
    ],
    [
      'API, NODE_ENV=staging, scripted',
      'api',
      { ...DB, AUTH_MODE: 'dev', NODE_ENV: 'staging', ASSESSMENT_PROVIDER: 'scripted' },
      /NODE_ENV/,
    ],
  ];

  it('refuses every unsafe combination and says why', async () => {
    const results = await Promise.all(cases.map(([, app, env]) => run(app, env)));
    results.forEach((result, i) => {
      const [label, , , message] = cases[i] ?? ['', 'api', {}, /^$/];
      refused(result);
      expect(result.output, label).toMatch(message);
    });
  }, 120_000);

  it('positive control: with an explicit development environment the worker starts (so the refusals above are about the provider, not about a broken harness)', async () => {
    // no DATABASE_URL: the worker idles with no handlers; it must not exit on its own within the window
    const result = await run(
      'worker',
      { NODE_ENV: 'development', ASSESSMENT_PROVIDER: 'scripted' },
      8_000,
    );
    expect(result.signal, result.output).toBe('SIGKILL');
    expect(result.output).not.toMatch(/ConfigError|Invalid environment configuration/);
  }, 60_000);
});
