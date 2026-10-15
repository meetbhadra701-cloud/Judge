import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFixtureWorld } from './fixtures.js';

/* A fixture's `bodyFile` must stay inside the fixture directory. The check used a bare string prefix, so a sibling directory with the same prefix passed it. */

let base = '';
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'judge-fixtures-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const fixture = (bodyFile: string) =>
  JSON.stringify({
    name: 'x',
    hosts: {},
    routes: { 'https://example.test/a': { status: 200, bodyFile } },
  });

describe('loadFixtureWorld bodyFile', () => {
  it('reads a file inside the directory', async () => {
    const dir = join(base, 'fx');
    mkdirSync(dir);
    writeFileSync(join(dir, 'body.txt'), 'inside');
    writeFileSync(join(dir, 'a.json'), fixture('body.txt'));
    const world = await loadFixtureWorld(dir);
    expect(world.routes['https://example.test/a']).toMatchObject({ body: 'inside' });
  });

  it.each([['../secret.txt'], ['../fx-evil/secret.txt'], ['/etc/hostname']])(
    'refuses %s, including a sibling directory that merely shares the prefix',
    async (bodyFile) => {
      const dir = join(base, 'fx');
      mkdirSync(dir);
      mkdirSync(join(base, 'fx-evil'));
      writeFileSync(join(base, 'fx-evil', 'secret.txt'), 'secret');
      writeFileSync(join(base, 'secret.txt'), 'secret');
      writeFileSync(join(dir, 'a.json'), fixture(bodyFile));
      await expect(loadFixtureWorld(dir)).rejects.toThrow(/escapes/);
    },
  );
});
