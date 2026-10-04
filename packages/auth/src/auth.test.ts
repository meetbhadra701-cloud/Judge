import type { webcrypto } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

type CryptoKey = webcrypto.CryptoKey;
import { beforeAll, describe, expect, it } from 'vitest';
import { createDevVerifier, createJwtVerifier, rolesFromClaim } from './index.js';

const ISSUER = 'https://idp.example.test/';
const AUDIENCE = 'judge-copilot-api';

describe('JWT/JWKS verifier', () => {
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;
  let jwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    otherKey = (await generateKeyPair('ES256')).privateKey;
  });

  const verifier = () =>
    createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [jwk] } });
  const sign = (
    claims: Record<string, unknown>,
    options: { key?: CryptoKey; exp?: string; iss?: string; aud?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(options.iss ?? ISSUER)
      .setAudience(options.aud ?? AUDIENCE)
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime(options.exp ?? '5m')
      .sign(options.key ?? privateKey);

  it('accepts a valid token and returns only known roles', async () => {
    const token = await sign({ roles: ['judge', 'organizer', 'admin'] });
    expect(await verifier().verify(token)).toEqual({
      issuer: ISSUER,
      subject: 'user-123',
      roles: ['judge', 'organizer'],
    });
  });

  it('rejects wrong signature, issuer, audience, expiry, garbage and unsigned tokens', async () => {
    const v = verifier();
    expect(await v.verify(await sign({ roles: ['organizer'] }, { key: otherKey }))).toBeNull();
    expect(
      await v.verify(await sign({ roles: ['organizer'] }, { iss: 'https://evil.test/' })),
    ).toBeNull();
    expect(await v.verify(await sign({ roles: ['organizer'] }, { aud: 'other' }))).toBeNull();
    expect(await v.verify(await sign({ roles: ['organizer'] }, { exp: '-10m' }))).toBeNull();
    expect(await v.verify('not.a.jwt')).toBeNull();
    expect(await v.verify('')).toBeNull();
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: 'x',
        iss: ISSUER,
        aud: AUDIENCE,
        exp: 9_999_999_999,
        roles: ['organizer'],
      }),
    ).toString('base64url');
    expect(await v.verify(`${header}.${body}.`)).toBeNull();
  });

  it('refuses symmetric or none algorithms and missing key sources at construction', () => {
    expect(() =>
      createJwtVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: { keys: [] },
        algorithms: ['HS256'],
      }),
    ).toThrow();
    expect(() =>
      createJwtVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: { keys: [] },
        algorithms: ['none'],
      }),
    ).toThrow();
    expect(() => createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE })).toThrow();
    expect(() =>
      createJwtVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: 'http://idp.example.test/jwks',
      }),
    ).toThrow();
  });

  it('parses roles from arrays or space-separated strings', () => {
    expect(rolesFromClaim('judge organizer')).toEqual(['judge', 'organizer']);
    expect(rolesFromClaim(['judge', 7, 'root'])).toEqual(['judge']);
    expect(rolesFromClaim(undefined)).toEqual([]);
  });
});

describe('development verifier', () => {
  it('accepts only the two fixed development actors', async () => {
    const v = createDevVerifier({ nodeEnv: 'development' });
    expect(await v.verify('dev-organizer')).toMatchObject({
      subject: 'dev-organizer',
      roles: ['organizer'],
    });
    expect(await v.verify('dev-judge')).toMatchObject({ roles: ['judge'] });
    expect(await v.verify('dev-admin')).toBeNull();
    expect(await v.verify('constructor')).toBeNull();
  });

  it('cannot be created in production', () => {
    expect(() => createDevVerifier({ nodeEnv: 'production' })).toThrow(/refused in production/);
  });
});
