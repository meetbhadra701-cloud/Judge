import { describe, expect, it } from 'vitest';
import {
  classifyRepositoryPath,
  captureComponent,
  compareSelection,
  orderCandidatesForCapture,
  isSafeRepositoryPath,
  looksBinary,
} from './index.js';

describe('repository path safety (R9-7)', () => {
  it.each([
    'README.md',
    'packages/core/src/index.ts',
    '.github/workflows/ci.yml',
    'docs/a b/c.md',
    'ünï/ファイル.ts',
  ])('accepts the ordinary path %j', (path) => {
    expect(isSafeRepositoryPath(path)).toBe(true);
  });

  it.each([
    '',
    '/etc/passwd',
    '../x',
    'a/../../x',
    'a/./b',
    'a//b',
    'a/',
    'a\\b',
    '..\\..\\x',
    'C:\\x',
    'C:/x',
    'a\u0000b',
    'a\nb',
    'a\u2028b',
    'a\u007fb',
  ])('refuses %j and classifies it as unsafe_path, whatever its extension', (path) => {
    expect(isSafeRepositoryPath(path)).toBe(false);
    if (path !== '' && !path.endsWith('/')) {
      expect(classifyRepositoryPath(`${path}.md`)).toEqual({
        include: false,
        reason: 'unsafe_path',
      });
    }
    expect(classifyRepositoryPath(path)).toEqual({ include: false, reason: 'unsafe_path' });
  });
});

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

describe('capture order for repositories larger than the file limit (P6B-beta3)', () => {
  const thirty = Array.from({ length: 30 }, (_, p) => `packages/pkg-${String(p).padStart(2, '0')}`);
  const entries = [
    { path: 'README.md', priority: 0 },
    { path: 'package.json', priority: 1 },
    ...thirty.flatMap((dir) =>
      Array.from({ length: 100 }, (_, f) => ({
        path: `${dir}/src/file-${String(f).padStart(3, '0')}.ts`,
        priority: 3,
      })),
    ),
  ];
  const components = (list: readonly { path: string }[]) =>
    new Set(list.map((e) => captureComponent(e.path)));

  it('REPRODUCTION: the previous order (depth, then path) filled the limit with the first packages of the alphabet', () => {
    const before = [...entries].sort(compareSelection).slice(0, 400);
    expect(components(before.filter((e) => e.path.startsWith('packages/'))).size).toBeLessThan(5);
  });

  it('keeps README and manifests first and then takes one file of every component before a second of any', () => {
    const order = orderCandidatesForCapture(entries);
    expect(order.slice(0, 2).map((e) => e.path)).toEqual(['README.md', 'package.json']);
    expect(order).toHaveLength(entries.length);
    const kept = order.slice(0, 400).filter((e) => e.path.startsWith('packages/'));
    expect(components(kept).size).toBe(30);
    const counts = thirty.map((dir) => kept.filter((e) => e.path.startsWith(`${dir}/`)).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('is a pure permutation, independent of input order, and does not favour the alphabet', () => {
    const a = orderCandidatesForCapture(entries).map((e) => e.path);
    const b = orderCandidatesForCapture([...entries].reverse()).map((e) => e.path);
    expect(b).toEqual(a);
    expect([...a].sort()).toEqual(entries.map((e) => e.path).sort());
    const firstOfEach = a.slice(2, 32).map((path) => captureComponent(path));
    expect(firstOfEach).not.toEqual([...firstOfEach].sort());
  });
});
