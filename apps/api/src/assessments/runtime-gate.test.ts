import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiEnv } from '../env.js';
import { openOfflineGate } from './runtime-gate.js';

/*
 * P6A-R1: the offline provider gate fails closed on the ACTUAL runtime environment. Only `development` and `test` may open the replay
 * provider; `production`, `staging`, a differently cased or misspelled name and anything unrecognized are refused, even with a valid
 * fixture. The check reads the process environment (not an argument), so it cannot be bypassed by omitting one.
 */

const MODELS = { extraction: 'm1', assessment: 'm2', critic: 'm3' };
const VALID_FIXTURE = JSON.stringify({
  version: 'replay-fixtures/v1',
  synthetic: true,
  entries: [],
});
const readFixture = () => Promise.resolve(VALID_FIXTURE);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('openOfflineGate', () => {
  it.each(['development', 'test'])('opens for a valid fixture in %s', async (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    const gate = await openOfflineGate({
      provider: 'replay',
      fixturePath: 'fixture.json',
      models: MODELS,
      readFixture,
    });
    expect(gate.problem).toBeNull();
    expect(gate.runtime?.provider).toEqual({ id: 'replay', mode: 'replay' });
  });

  it.each(['production', 'staging', 'Production', 'PRODUCTION', 'prod', 'preview', ' '])(
    'is refused in the runtime environment "%s", even with a valid fixture',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      const gate = await openOfflineGate({
        provider: 'replay',
        fixturePath: 'fixture.json',
        models: MODELS,
        readFixture,
      });
      expect(gate.runtime).toBeNull();
      expect(gate.problem).toMatch(/refused outside development and test/);
    },
  );

  it('"none" is never a runtime and never a problem, in any environment', async () => {
    for (const environment of ['development', 'production', 'staging']) {
      vi.stubEnv('NODE_ENV', environment);
      expect(
        await openOfflineGate({ provider: 'none', fixturePath: undefined, models: MODELS }),
      ).toEqual({ runtime: null, problem: null });
    }
  });

  it('refuses a missing or invalid fixture even in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(
      (await openOfflineGate({ provider: 'replay', fixturePath: undefined, models: MODELS }))
        .problem,
    ).toMatch(/ASSESSMENT_REPLAY_FIXTURE/);
    const invalid = await openOfflineGate({
      provider: 'replay',
      fixturePath: 'x.json',
      models: MODELS,
      readFixture: () =>
        Promise.resolve(
          JSON.stringify({ version: 'replay-fixtures/v1', synthetic: false, entries: [] }),
        ),
    });
    expect(invalid.runtime).toBeNull();
    expect(invalid.problem).toMatch(/not a valid synthetic fixture/);
  });
});

describe('api environment: the replay provider cannot be configured for production or staging', () => {
  it('refuses ASSESSMENT_PROVIDER=replay when NODE_ENV is production', () => {
    const parsed = ApiEnv.safeParse({
      NODE_ENV: 'production',
      ASSESSMENT_PROVIDER: 'replay',
      ASSESSMENT_REPLAY_FIXTURE: 'f.json',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a staging NODE_ENV outright (it is not a recognized environment, so there is nothing to relax)', () => {
    expect(
      ApiEnv.safeParse({
        NODE_ENV: 'staging',
        ASSESSMENT_PROVIDER: 'replay',
        ASSESSMENT_REPLAY_FIXTURE: 'f.json',
      }).success,
    ).toBe(false);
  });

  it('accepts replay in development and test only with a fixture, and defaults to none', () => {
    expect(ApiEnv.parse({}).ASSESSMENT_PROVIDER).toBe('none');
    for (const NODE_ENV of ['development', 'test']) {
      expect(
        ApiEnv.safeParse({
          NODE_ENV,
          ASSESSMENT_PROVIDER: 'replay',
          ASSESSMENT_REPLAY_FIXTURE: 'f.json',
        }).success,
      ).toBe(true);
      expect(ApiEnv.safeParse({ NODE_ENV, ASSESSMENT_PROVIDER: 'replay' }).success).toBe(false);
    }
  });
});

describe('openOfflineGate: the scripted demonstration provider (P6C)', () => {
  it.each(['development', 'test'])(
    'opens in %s with no fixture, as a scripted provider',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      const gate = await openOfflineGate({
        provider: 'scripted',
        fixturePath: undefined,
        models: MODELS,
      });
      expect(gate.problem).toBeNull();
      expect(gate.runtime?.provider).toEqual({ id: 'scripted', mode: 'scripted' });
    },
  );

  it.each(['production', 'staging', 'Production', 'prod', ' '])(
    'is refused in the runtime environment "%s"',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      const gate = await openOfflineGate({
        provider: 'scripted',
        fixturePath: undefined,
        models: MODELS,
      });
      expect(gate.runtime).toBeNull();
      expect(gate.problem).toContain('refused outside development and test');
    },
  );

  it('the environment schema refuses it in production as well, and accepts it elsewhere without a fixture', () => {
    const base = { AUTH_MODE: 'dev', API_HOST: '127.0.0.1', ASSESSMENT_PROVIDER: 'scripted' };
    expect(ApiEnv.safeParse({ ...base, NODE_ENV: 'production' }).success).toBe(false);
    expect(ApiEnv.safeParse({ ...base, NODE_ENV: 'development' }).success).toBe(true);
  });
});
