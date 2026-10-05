import { isIP } from 'node:net';
import type { CaptureFailure } from '@judge-copilot/capture';
import { failure, safeHost } from '@judge-copilot/capture';
import { classifyAddress } from './ip-policy.js';

/** Ports a fetch may target. Default ports (empty in a WHATWG URL) are always allowed. */
export const ALLOWED_PORTS: readonly string[] = ['', '80', '443', '8080', '8443'];

/** Host names that never resolve to a public service. */
function isInternalHostName(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa') ||
    !hostname.includes('.')
  );
}

export function hostLiteral(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Syntactic checks applied to the original URL and again to every redirect target before any
 * DNS lookup: scheme, credentials, port, IP-literal ranges and internal host names.
 */
export function checkUrlPolicy(url: URL, options: { allowHttp: boolean }): CaptureFailure | null {
  const host = safeHost(url.href);
  const meta = host ? { host } : {};
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    return failure('invalid_url', { ...meta, reason: 'scheme_not_allowed' });
  }
  if (url.username !== '' || url.password !== '') {
    return failure('invalid_url', { ...meta, reason: 'credentials_in_url' });
  }
  if (!ALLOWED_PORTS.includes(url.port)) {
    return failure('ssrf_rejected', { ...meta, reason: 'port_not_allowed' });
  }
  const literal = hostLiteral(url);
  if (isIP(literal) !== 0) {
    return classifyAddress(literal).allowed
      ? null
      : failure('ssrf_rejected', { ...meta, reason: 'address_not_public' });
  }
  if (literal === '' || isInternalHostName(literal)) {
    return failure('ssrf_rejected', { ...meta, reason: 'host_not_allowed' });
  }
  return null;
}
