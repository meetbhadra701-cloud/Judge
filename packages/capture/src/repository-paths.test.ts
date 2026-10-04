import { describe, expect, it } from 'vitest';
import { classifyRepositoryPath, compareSelection, looksBinary } from './index.js';

describe('repository path rules', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.example',
    'config/.ENV.production',
    'certs/server.pem',
    'tls.key',
    'store.p12',
    'store.pfx',
    'id_rsa',
    'id_rsa.pub',
    'deploy/id_ed25519',
    'credentials.json',
    'secrets.yaml',
    'service-account-prod.json',
    '.ssh/config',
    'home/.aws/config',
    '.npmrc',
  ])('never fetches secret-prone path %s', (path) => {
    expect(classifyRepositoryPath(path)).toEqual({ include: false, reason: 'secret_prone_path' });
  });

  it.each([
    'node_modules/react/index.js',
    'vendor/lib.go',
    'dist/app.js',
    'build/out.js',
    '.next/server.js',
    'coverage/lcov.info',
    '.git/config',
    'packages/web/node_modules/x/y.js',
  ])('skips generated or vendored path %s', (path) => {
    expect(classifyRepositoryPath(path)).toEqual({ include: false, reason: 'ignored_directory' });
  });

  it('skips binaries, lockfiles and unknown formats; includes source and manifests', () => {
    expect(classifyRepositoryPath('logo.png')).toEqual({
      include: false,
      reason: 'binary_extension',
    });
    expect(classifyRepositoryPath('app.exe')).toEqual({
      include: false,
      reason: 'binary_extension',
    });
    expect(classifyRepositoryPath('pnpm-lock.yaml')).toEqual({
      include: false,
      reason: 'lockfile',
    });
    expect(classifyRepositoryPath('data.weird')).toEqual({
      include: false,
      reason: 'unsupported_file_type',
    });
    expect(classifyRepositoryPath('README.md')).toEqual({ include: true, priority: 0 });
    expect(classifyRepositoryPath('package.json')).toEqual({ include: true, priority: 1 });
    expect(classifyRepositoryPath('Makefile')).toEqual({ include: true, priority: 1 });
    expect(classifyRepositoryPath('docs/setup.md')).toEqual({ include: true, priority: 2 });
    expect(classifyRepositoryPath('src/main.rs')).toEqual({ include: true, priority: 3 });
    expect(classifyRepositoryPath('rtl/top.sv')).toEqual({ include: true, priority: 3 });
  });

  it('orders selection deterministically by priority, depth and path', () => {
    const entries = ['src/b.ts', 'src/a.ts', 'README.md', 'package.json', 'a/b/c.ts', 'z.ts'].map(
      (path) => {
        const decision = classifyRepositoryPath(path);
        return { path, priority: decision.include ? decision.priority : 99 };
      },
    );
    const sorted = [...entries].sort(compareSelection).map((entry) => entry.path);
    expect(sorted).toEqual([
      'README.md',
      'package.json',
      'z.ts',
      'src/a.ts',
      'src/b.ts',
      'a/b/c.ts',
    ]);
    expect(
      [...entries]
        .reverse()
        .sort(compareSelection)
        .map((entry) => entry.path),
    ).toEqual(sorted);
  });

  it('detects binary content by NUL bytes', () => {
    expect(looksBinary('abc\u0000def')).toBe(true);
    expect(looksBinary('plain text')).toBe(false);
  });
});
