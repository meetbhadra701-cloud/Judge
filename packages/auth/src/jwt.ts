import type { AuthVerifier, VerifiedIdentity } from '@judge-copilot/domain';
import { ACTOR_ROLE_VALUES, type ActorRole } from '@judge-copilot/schemas';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

/*
 * Provider-neutral bearer-token verification: any OIDC/OAuth identity provider that issues
 * asymmetrically signed JWTs and publishes a JWKS works. Signature, issuer, audience, expiry and
 * not-before are checked by `jose` (no custom crypto). Symmetric (HS*) and `none` algorithms are
 * never accepted. Roles come from one configurable claim and are filtered to the known roles.
 * No password handling exists anywhere in Judge Copilot.
 */

export const DEFAULT_JWT_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'ES384', 'EdDSA'] as const;

export interface JwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Remote JWKS endpoint of the identity provider (https). */
  readonly jwksUrl?: string;
  /** A static key set, for tests or air-gapped deployments. */
  readonly jwks?: JSONWebKeySet;
  /** Claim holding the roles: an array of strings or a space-separated string. Default `roles`. */
  readonly rolesClaim?: string;
  readonly algorithms?: readonly string[];
  readonly clockToleranceSeconds?: number;
}

const ROLES = new Set<string>(ACTOR_ROLE_VALUES);

export function rolesFromClaim(value: unknown): ActorRole[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : [];
  return [
    ...new Set(
      raw.filter((role): role is ActorRole => typeof role === 'string' && ROLES.has(role)),
    ),
  ].sort();
}

export function createJwtVerifier(options: JwtVerifierOptions): AuthVerifier {
  const algorithms = [...(options.algorithms ?? DEFAULT_JWT_ALGORITHMS)];
  if (algorithms.some((algorithm) => algorithm === 'none' || algorithm.startsWith('HS'))) {
    throw new Error('Only asymmetric JWT algorithms are allowed');
  }
  let keys: JWTVerifyGetKey;
  if (options.jwks) {
    keys = createLocalJWKSet(options.jwks);
  } else if (options.jwksUrl) {
    const url = new URL(options.jwksUrl);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('The JWKS URL must use https');
    }
    keys = createRemoteJWKSet(url, { timeoutDuration: 5_000, cooldownDuration: 30_000 });
  } else {
    throw new Error('A JWKS URL or key set is required');
  }
  const rolesClaim = options.rolesClaim ?? 'roles';

  return {
    name: 'jwt',
    async verify(credential: string): Promise<VerifiedIdentity | null> {
      if (credential.length === 0 || credential.length > 16_384) return null;
      try {
        const { payload } = await jwtVerify(credential, keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms,
          clockTolerance: options.clockToleranceSeconds ?? 30,
          requiredClaims: ['sub', 'exp', 'iss'],
        });
        const subject = payload.sub;
        if (typeof subject !== 'string' || subject.length === 0 || subject.length > 255)
          return null;
        return { issuer: options.issuer, subject, roles: rolesFromClaim(payload[rolesClaim]) };
      } catch {
        // Invalid signature, expiry, wrong issuer/audience, unreachable JWKS: unauthenticated.
        // The error (which may quote token contents) is deliberately discarded.
        return null;
      }
    },
  };
}
