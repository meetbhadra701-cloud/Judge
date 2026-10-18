import { defineConfig } from 'vitest/config';

// The real-browser smoke test (P6B-alpha). Separate from the default suite: it needs a built web app (`pnpm --filter @judge-copilot/web build`)
// and a Chromium that Playwright can find. Run it with `pnpm test:browser`. It opens only loopback sockets and uses no network model.
const conditions = ['@judge-copilot/source', 'import', 'module', 'node', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['tests/r10/**/*.browser.ts'],
    setupFiles: ['./tests/support/no-network.mjs'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
