import type { ProviderMode } from '@judge-copilot/schemas';

/*
 * Replay and scripted providers exist for tests and local demonstrations only (design §12.1). The restriction is
 * enforced from the ACTUAL runtime environment, so it cannot be bypassed by omitting an argument:
 *
 *  - The runtime value is read here from `NODE_ENV` — the repository's single environment switch (BaseEnv). This is the
 *    ONLY environment read in this package, and it reads nothing else.
 *  - A non-live provider is allowed only when the runtime environment is exactly `development` or `test`. An unset
 *    `NODE_ENV` is `development` (the same default `BaseEnv` applies); `production`, a differently cased or misspelled
 *    value, or anything unrecognized is REFUSED. The check fails closed.
 *  - A caller-supplied environment name may only make the check STRICTER. `requestedNodeEnv: 'production'` refuses even in
 *    a development process; `requestedNodeEnv: 'test'` can never relax a production runtime. Tests simulate production
 *    with a real environment override (for example `vi.stubEnv`), never with an argument that could bypass it.
 */

export class ProviderNotAllowedError extends Error {
  constructor(mode: ProviderMode) {
    super(`The ${mode} provider is refused outside development and test`);
    this.name = 'ProviderNotAllowedError';
  }
}

const NON_LIVE_ALLOWED_ENVIRONMENTS: readonly string[] = ['development', 'test'];

/** The actual runtime environment name. Unset means `development`, exactly as `BaseEnv` defaults it. */
export function runtimeNodeEnv(): string {
  return process.env['NODE_ENV'] ?? 'development';
}

export function assertProviderAllowed(mode: ProviderMode, requestedNodeEnv?: string): void {
  if (mode === 'live') return;
  const runtime = runtimeNodeEnv();
  const runtimeAllowed = NON_LIVE_ALLOWED_ENVIRONMENTS.includes(runtime);
  // An explicit request can tighten (refuse in more situations) but never loosen.
  const requestAllows =
    requestedNodeEnv === undefined || NON_LIVE_ALLOWED_ENVIRONMENTS.includes(requestedNodeEnv);
  if (!runtimeAllowed || !requestAllows) throw new ProviderNotAllowedError(mode);
}
