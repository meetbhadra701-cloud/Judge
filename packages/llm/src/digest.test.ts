import { describe, expect, it } from 'vitest';
import { computeRequestDigest, REQUEST_DIGEST_VERSION } from './digest.js';
import { request } from './testing/builders.js';

describe('request digest (exact effective serialized request)', () => {
  const base = request();
  const [u0 = '', u1 = '', u2 = ''] = base.user;
  const digest = computeRequestDigest(base);

  it('is a 64-hex SHA-256 and stable', () => {
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRequestDigest(request())).toBe(digest);
    expect(REQUEST_DIGEST_VERSION).toBe('request-digest/v2');
  });

  it('changes when ANY model-visible or output-changing field changes', () => {
    const variants = {
      stage: request({ stage: 'critic' }),
      promptId: request({ promptId: 'other' }),
      promptVersion: request({ promptVersion: 'v2' }),
      promptTemplateHash: request({ promptTemplateHash: 'b'.repeat(64) }),
      schemaId: request({ schemaId: 'other' }),
      schemaVersion: request({ schemaVersion: 'v2' }),
      provider: request({ provider: 'other' }),
      model: request({ model: 'claude-sonnet-5-5' }),
      system: request({ system: `${base.system}!` }),
      oneCharacterInAUserBlock: request({
        user: [u0, 'P-0001: The app tracks water intake dail.', u2],
      }),
      extraUserBlock: request({ user: [...base.user, 'x'] }),
      reorderedUserBlocks: request({ user: [u1, u0, u2] }),
      jsonSchemaKey: request({
        jsonSchema: {
          type: 'object',
          properties: { claims: { type: 'array' } },
          additionalProperties: false,
        },
      }),
      jsonSchemaValue: request({
        jsonSchema: { type: 'object', properties: { claims: { type: 'object' } } },
      }),
      effort: request({ generation: { ...base.generation, effort: 'high' } }),
      noEffort: request({ generation: { maxOutputTokens: 1_000, timeoutMs: 120_000 } }),
      maxOutputTokens: request({ generation: { ...base.generation, maxOutputTokens: 1_001 } }),
    };
    const seen = new Set([digest]);
    for (const [name, variant] of Object.entries(variants)) {
      const value = computeRequestDigest(variant);
      expect(value, name).not.toBe(digest);
      seen.add(value);
    }
    expect(seen.size).toBe(Object.keys(variants).length + 1);
  });

  it('ignores the timeout (it changes aborting, never content) and object key order', () => {
    expect(
      computeRequestDigest(request({ generation: { ...base.generation, timeoutMs: 5 } })),
    ).toBe(digest);
    const reordered = request({
      jsonSchema: { properties: { claims: { type: 'array' } }, type: 'object' },
    });
    expect(computeRequestDigest(reordered)).toBe(digest);
  });

  it('keeps user-block boundaries significant', () => {
    expect(computeRequestDigest(request({ user: ['ab', 'c'] }))).not.toBe(
      computeRequestDigest(request({ user: ['a', 'bc'] })),
    );
    expect(computeRequestDigest(request({ user: ['ab'] }))).not.toBe(
      computeRequestDigest(request({ user: ['a', 'b'] })),
    );
  });

  it('commits to every code point (Unicode is not normalized away)', () => {
    expect(computeRequestDigest(request({ user: ['café'] }))).not.toBe(
      computeRequestDigest(request({ user: ['café'] })),
    );
  });

  it('cannot be supplied by a caller: extra properties on the request object do not matter', () => {
    const forged = { ...base, requestDigest: 'f'.repeat(64), extra: 'x' } as typeof base;
    expect(computeRequestDigest(forged)).toBe(digest);
  });
});
