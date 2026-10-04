import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';

// The guard in tests/support/no-network.mjs is preloaded for every test file.
describe('test network guard', () => {
  it('blocks outbound connections to non-loopback hosts', () => {
    expect(() => connect({ host: 'example.com', port: 443 })).toThrow(
      /External network access is forbidden/,
    );
    expect(() => connect(80, '93.184.216.34')).toThrow(/External network access is forbidden/);
  });

  it('blocks fetch to external hosts', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow();
  });
});
