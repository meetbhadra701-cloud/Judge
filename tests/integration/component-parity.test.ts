import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureComponent } from '../../packages/capture/src/index.js';
import { repositoryComponent } from '../../packages/assessment/src/repository-roles.js';

/*
 * P6B-beta3: capture decides which files of a repository exist at all, and selection decides which of those a model is shown. Both group files by
 * "component" (a monorepo package or a top-level directory) to stay fair across the parts of a project. The two implementations live in packages
 * that may not depend on each other, so this test pins them together on every path of the real recorded repository and on hostile cases.
 */
describe('capture and selection agree on what a component is', () => {
  const recording = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../fixtures/real-github/recorded-judge-9459c98.json'),
      'utf8',
    ),
  ) as { routes: Record<string, { json?: { tree?: { path: string }[] } }> };
  const treeUrl = Object.keys(recording.routes).find((url) => url.includes('/git/trees/')) ?? '';
  const real = (recording.routes[treeUrl]?.json?.tree ?? []).map((entry) => entry.path);

  it('has a real corpus', () => {
    expect(real.length).toBeGreaterThan(300);
  });

  it.each([
    ...real.map((p) => [p] as const),
    ['README.md'],
    ['Packages/Core/src/a.ts'],
    ['packages/only-two.ts'],
    ['apps/web/app/page.tsx'],
    ['a/b/c/d/e.ts'],
    ['.github/workflows/ci.yml'],
    ['services/api'],
  ])('%s', (path) => {
    expect(captureComponent(path)).toBe(repositoryComponent(path));
  });
});
