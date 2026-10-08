import type { ProviderMode } from '@judge-copilot/schemas';

export class ProviderNotAllowedError extends Error {
  constructor(mode: ProviderMode) {
    super(`The ${mode} provider is refused in production`);
    this.name = 'ProviderNotAllowedError';
  }
}

/** Replay and scripted providers exist for tests and local demonstrations only (design §12.1). */
export function assertProviderAllowed(mode: ProviderMode, nodeEnv: string | undefined): void {
  if (mode !== 'live' && nodeEnv === 'production') throw new ProviderNotAllowedError(mode);
}
