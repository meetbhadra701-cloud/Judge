import type { AuthVerifier, VerifiedIdentity } from '@judge-copilot/domain';

/*
 * Development-only synthetic actors for local use of the API and web UI. It must be enabled
 * explicitly (`AUTH_MODE=dev`), it is refused when NODE_ENV=production (here and in the API's
 * environment validation), and it accepts exactly two fixed bearer values. It is not a password
 * system: there are no users, secrets or sessions.
 */

export const DEV_AUTH_ISSUER = 'urn:judge-copilot:dev';

export const DEV_TOKENS: Readonly<Record<string, VerifiedIdentity>> = {
  'dev-organizer': { issuer: DEV_AUTH_ISSUER, subject: 'dev-organizer', roles: ['organizer'] },
  'dev-judge': { issuer: DEV_AUTH_ISSUER, subject: 'dev-judge', roles: ['judge'] },
};

export function createDevVerifier(options: { nodeEnv: string }): AuthVerifier {
  if (options.nodeEnv === 'production') {
    throw new Error('Development authentication is refused in production');
  }
  return {
    name: 'dev',
    verify(credential) {
      return Promise.resolve(
        Object.hasOwn(DEV_TOKENS, credential) ? (DEV_TOKENS[credential] ?? null) : null,
      );
    },
  };
}
