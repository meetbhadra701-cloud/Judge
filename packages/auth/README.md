# packages/auth — authentication adapters

**Milestone:** M2 · **Layer:** 3 (I/O adapter)

Implementations of the `AuthVerifier` port defined in `@judge-copilot/domain`:

- `createJwtVerifier` — provider-neutral bearer JWTs verified with `jose` against the identity
  provider's JWKS (issuer, audience, expiry; asymmetric algorithms only). Roles come from one
  configurable claim and are filtered to `organizer` / `judge`.
- `createDevVerifier` — explicit, development-only synthetic actors (`dev-organizer`,
  `dev-judge`); it throws when `NODE_ENV=production`, and the API refuses `AUTH_MODE=dev` there.

There is no password handling, user store or session system anywhere in Judge Copilot.
