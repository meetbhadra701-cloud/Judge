import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript source so tests never depend on a prior build.
const conditions = ['@judge-copilot/source', 'import', 'module', 'node', 'default'];

export default defineConfig({
  resolve: { conditions },
  // the web UI's presentational components are rendered to static markup in tests
  esbuild: { jsx: 'automatic' },
  // Tests run in Vite's SSR (server) environment, which has its own resolver settings.
  ssr: { resolve: { conditions } },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/web/app/**/*.test.tsx',
      'tests/**/*.test.ts',
    ],
    setupFiles: ['./tests/support/no-network.mjs'],
    environment: 'node',
    // Real-PostgreSQL runs share one disposable database that each file rebuilds, so files must not overlap.
    fileParallelism: !process.env['TEST_DATABASE_URL'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
