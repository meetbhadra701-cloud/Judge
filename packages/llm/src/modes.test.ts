import { describe, expect, it } from 'vitest';
import { assertProviderAllowed, ProviderNotAllowedError } from './modes.js';

describe('provider modes', () => {
  it('allows only live providers in production', () => {
    expect(() => {
      assertProviderAllowed('live', 'production');
    }).not.toThrow();
    expect(() => {
      assertProviderAllowed('replay', 'production');
    }).toThrow(ProviderNotAllowedError);
    expect(() => {
      assertProviderAllowed('scripted', 'production');
    }).toThrow(ProviderNotAllowedError);
  });
  it('allows every mode in development, test and when unset', () => {
    for (const env of ['development', 'test', undefined]) {
      for (const mode of ['live', 'replay', 'scripted'] as const) {
        expect(() => {
          assertProviderAllowed(mode, env);
        }).not.toThrow();
      }
    }
  });
});
