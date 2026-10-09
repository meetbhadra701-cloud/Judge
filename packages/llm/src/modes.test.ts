import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeRequestDigest } from './digest.js';
import { assertProviderAllowed, ProviderNotAllowedError, runtimeNodeEnv } from './modes.js';
import { ReplayProvider, REPLAY_FIXTURE_VERSION } from './replay.js';
import { ScriptedProvider } from './scripted.js';
import { request } from './testing/builders.js';

/*
 * F2: the production restriction comes from the ACTUAL runtime environment (NODE_ENV). Tests simulate production
 * with a real environment override (vi.stubEnv), never with an argument. An argument can only tighten the check.
 */

const fixtures = () => ({
  version: REPLAY_FIXTURE_VERSION,
  synthetic: true,
  entries: [
    {
      requestDigest: computeRequestDigest(request()),
      stage: 'claim_extraction',
      output: {},
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ],
});
const providers: [string, (nodeEnv?: string) => unknown][] = [
  [
    'replay',
    (nodeEnv) =>
      new ReplayProvider({ fixtures: fixtures(), ...(nodeEnv === undefined ? {} : { nodeEnv }) }),
  ],
  ['scripted', (nodeEnv) => new ScriptedProvider([], nodeEnv === undefined ? {} : { nodeEnv })],
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('actual production mode', () => {
  it.each(providers)('%s: refused when the option is OMITTED', (_name, make) => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => make()).toThrow(ProviderNotAllowedError);
  });

  it.each(providers)(
    '%s: refused when the option CONTRADICTS the runtime (nodeEnv "test"/"development")',
    (_name, make) => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => make('test')).toThrow(ProviderNotAllowedError);
      expect(() => make('development')).toThrow(ProviderNotAllowedError);
    },
  );

  it('refuses through the assertion function itself, whatever the second argument says', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const requested of [undefined, 'test', 'development', 'production', '']) {
      expect(() => {
        assertProviderAllowed('replay', requested);
      }).toThrow(ProviderNotAllowedError);
      expect(() => {
        assertProviderAllowed('scripted', requested);
      }).toThrow(ProviderNotAllowedError);
    }
  });

  it('never restricts a live provider', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => {
      assertProviderAllowed('live');
    }).not.toThrow();
    expect(() => {
      assertProviderAllowed('live', 'production');
    }).not.toThrow();
  });
});

describe('fails closed on anything that is not exactly development or test', () => {
  it.each(['Production', 'PRODUCTION', 'prod', 'staging', 'preview', ' production', 'test ', ''])(
    'refuses a non-live provider when NODE_ENV is %j',
    (value) => {
      vi.stubEnv('NODE_ENV', value);
      // An empty string is a real (set) value, so it is not "unset" and is refused as unrecognized.
      expect(() => {
        assertProviderAllowed('replay');
      }).toThrow(ProviderNotAllowedError);
      expect(() => {
        assertProviderAllowed('scripted');
      }).toThrow(ProviderNotAllowedError);
    },
  );
});

describe('development and test remain permitted, as designed', () => {
  it.each(['development', 'test'])(
    'NODE_ENV=%s allows both providers with the option omitted or consistent',
    (env) => {
      vi.stubEnv('NODE_ENV', env);
      expect(runtimeNodeEnv()).toBe(env);
      for (const [, make] of providers) {
        expect(() => make()).not.toThrow();
        expect(() => make('development')).not.toThrow();
        expect(() => make('test')).not.toThrow();
      }
    },
  );

  it('treats an unset NODE_ENV as development (the BaseEnv default)', () => {
    vi.stubEnv('NODE_ENV', undefined);
    expect(runtimeNodeEnv()).toBe('development');
    expect(() => {
      assertProviderAllowed('replay');
    }).not.toThrow();
  });

  it('lets a caller TIGHTEN the check in development, deterministically', () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const [, make] of providers) {
      expect(() => make('production')).toThrow(ProviderNotAllowedError);
    }
  });
});
