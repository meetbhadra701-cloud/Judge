import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loadApiEnv } from './env.js';

/*
 * The development verifier accepts two fixed, publicly known bearer values (`dev-organizer`,
 * `dev-judge`). It must never be reachable by anything but the local machine, whatever NODE_ENV
 * says (it defaults to `development`, so an unset NODE_ENV must not be a way around the rule).
 */
describe('AUTH_MODE=dev requires a loopback API_HOST', () => {
  const dev = (host: string, extra: Record<string, string> = {}) =>
    loadApiEnv({ AUTH_MODE: 'dev', API_HOST: host, ...extra });

  it.each(['127.0.0.1', '::1', 'localhost', '[::1]', 'LOCALHOST', '127.0.0.2', '127.255.255.254'])(
    'accepts %s',
    (host) => {
      expect(dev(host).AUTH_MODE).toBe('dev');
    },
  );

  it.each([
    '0.0.0.0',
    '::',
    '[::]',
    '192.168.1.5',
    '10.0.0.1',
    '203.0.113.7',
    '8.8.8.8',
    'example.com',
    'localhost.example.com',
    '127.0.0.1.example.com',
    '127.0.0.256',
    '127.0.0',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:0:0:2',
    'localhost.',
  ])('refuses %s, with NODE_ENV unset or development', (host) => {
    expect(() => dev(host)).toThrow(/API_HOST/);
    expect(() => dev(host, { NODE_ENV: 'development' })).toThrow(/API_HOST/);
    expect(() => dev(host, { NODE_ENV: 'test' })).toThrow(/API_HOST/);
  });

  it('keeps the production refusal, and the default host and other modes are unaffected', () => {
    expect(() => dev('127.0.0.1', { NODE_ENV: 'production' })).toThrow(/production/);
    expect(loadApiEnv({ AUTH_MODE: 'dev' }).API_HOST).toBe('127.0.0.1');
    // Other modes may bind anywhere; production still requires jwt with a database.
    expect(loadApiEnv({ AUTH_MODE: 'none', API_HOST: '0.0.0.0' }).API_HOST).toBe('0.0.0.0');
    expect(
      loadApiEnv({
        AUTH_MODE: 'jwt',
        API_HOST: '0.0.0.0',
        AUTH_JWT_ISSUER: 'https://issuer.example',
        AUTH_JWT_AUDIENCE: 'judge-copilot',
        AUTH_JWKS_URL: 'https://issuer.example/jwks.json',
      }).AUTH_MODE,
    ).toBe('jwt');
  });

  it('classifies hosts without leaking into other checks', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});
