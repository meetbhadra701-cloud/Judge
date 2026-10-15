import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOutputWriter, isMirrorablePath, UnsafeOutputError } from './safe-output.js';

/*
 * R9-7: artifact keys come from a repository's tree, so they are hostile text. Every test runs in a disposable directory next to a SENTINEL file
 * outside the output root; a hostile key must never create, change or reach anything outside the root, and nothing already inside is overwritten.
 */

let base = '';
let root = '';
const SENTINEL = 'sentinel: untouched';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'judge-safe-output-'));
  root = join(base, 'out');
  writeFileSync(join(base, 'sentinel.txt'), SENTINEL);
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 'victim.txt'), SENTINEL);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Every file under a directory, relative, sorted. */
function walk(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort();
}
/** The sentinel files are unchanged and nothing else was created beside the output root (the root itself, a link target and the input fixture excepted). */
const outsideIntact = () =>
  readFileSync(join(base, 'sentinel.txt'), 'utf8') === SENTINEL &&
  readFileSync(join(base, 'outside', 'victim.txt'), 'utf8') === SENTINEL &&
  walk(base)
    .filter(
      (f) =>
        !f.startsWith('out/') &&
        !f.startsWith('real/') &&
        f !== 'hostile-world.json' &&
        f !== 'out',
    )
    .join() === 'outside/victim.txt,sentinel.txt';

describe('the defect this fixes', () => {
  it('REPRODUCTION: joining the key onto the output directory (the previous behaviour) escapes it', () => {
    const key = 'files/../../../escaped.txt';
    expect(resolve(root, 'artifacts', key).startsWith(root)).toBe(false);
  });
});

describe('createOutputWriter', () => {
  it.each([
    ['files/../../escaped.txt'],
    ['files/../../../../../../tmp/escaped.txt'],
    ['/etc/escaped.txt'],
    ['files//double/slash.txt'],
    ['files/a\\..\\..\\escaped.txt'],
    ['files\\..\\..\\escaped.txt'],
    ['C:\\Windows\\escaped.txt'],
    ['files/C:/escaped.txt'],
    ['files/a\u0000b.txt'],
    ['files/line\nbreak.txt'],
    ['files/./x.txt'],
    ['files/trailing-dot./x.txt'],
    ['files/trailing-space /x.txt'],
    ['files/CON.txt'],
    ['files/aux'],
    ['files/' + 'a'.repeat(300)],
    [''],
  ])('stores the hostile key %j under _unsafe/, never outside the root', async (key) => {
    const writer = await createOutputWriter(root);
    const stored = await writer.write(key, 'payload');
    expect(stored.mirrored).toBe(false);
    expect(stored.storedAs).toMatch(/^_unsafe\/[0-9a-f]{32}\.txt$/);
    expect(readFileSync(join(root, stored.storedAs), 'utf8')).toBe('payload');
    expect(outsideIntact()).toBe(true);
    expect(walk(root)).toEqual([stored.storedAs]);
  });

  it('keeps ordinary repository paths mirrored, including unicode and dotfiles', async () => {
    const writer = await createOutputWriter(root);
    const keys = [
      'artifacts/files/README.md',
      'artifacts/files/packages/core/src/index.ts',
      'artifacts/files/.github/workflows/ci.yml',
      'artifacts/files/docs/ünïcode-ファイル.md',
      'artifacts/files/a b/c d.txt',
      'manifest.json',
    ];
    for (const key of keys) expect(isMirrorablePath(key)).toBe(true);
    for (const key of keys) {
      expect(await writer.write(key, key)).toEqual({ storedAs: key, mirrored: true });
    }
    expect(walk(root)).toEqual([...keys].sort());
    expect(outsideIntact()).toBe(true);
  });

  it('a symbolic link inside the root cannot redirect output: a linked directory is refused, and nothing lands outside', async () => {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'artifacts'));
    symlinkSync(join(base, 'outside'), join(root, 'artifacts', 'files'));
    const writer = await createOutputWriter(root);
    await expect(writer.write('artifacts/files/victim.txt', 'overwritten')).rejects.toBeInstanceOf(
      UnsafeOutputError,
    );
    expect(readFileSync(join(base, 'outside', 'victim.txt'), 'utf8')).toBe(SENTINEL);
    expect(readdirSync(join(base, 'outside'))).toEqual(['victim.txt']);
  });

  it('a symbolic link to ANOTHER directory inside the root is refused too: links are never followed, wherever they point', async () => {
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'artifacts', 'files'));
    const writer = await createOutputWriter(root);
    await expect(writer.write('artifacts/files/x.txt', 'payload')).rejects.toBeInstanceOf(
      UnsafeOutputError,
    );
    expect(readdirSync(join(root, 'elsewhere'))).toEqual([]);
  });

  it('a symbolic link in place of the output file is not followed, and the content is stored elsewhere instead', async () => {
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    symlinkSync(join(base, 'outside', 'victim.txt'), join(root, 'artifacts', 'a.txt'));
    const writer = await createOutputWriter(root);
    const stored = await writer.write('artifacts/a.txt', 'payload');
    expect(stored.mirrored).toBe(false);
    expect(stored.storedAs).toMatch(/^_collisions\//);
    expect(readFileSync(join(base, 'outside', 'victim.txt'), 'utf8')).toBe(SENTINEL);
  });

  it('an output root that is itself a link is resolved once, and everything stays under the real directory', async () => {
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), root);
    const writer = await createOutputWriter(root);
    await writer.write('artifacts/files/x.txt', 'x');
    expect(readFileSync(join(base, 'real', 'artifacts', 'files', 'x.txt'), 'utf8')).toBe('x');
    expect(outsideIntact()).toBe(true);
  });

  it('never overwrites: names differing only by case, and a file where a directory is needed, are kept apart', async () => {
    const writer = await createOutputWriter(root);
    const first = await writer.write('artifacts/files/Readme.md', 'one');
    const second = await writer.write('artifacts/files/README.md', 'two');
    const asFile = await writer.write('artifacts/files/dir', 'file');
    const underFile = await writer.write('artifacts/files/dir/child.txt', 'child');
    const again = await writer.write('artifacts/files/Readme.md', 'three');
    expect(first.storedAs).toBe('artifacts/files/Readme.md');
    for (const other of [second, underFile, again])
      expect(other.storedAs).toMatch(/^_collisions\//);
    expect(asFile.storedAs).toBe('artifacts/files/dir');
    const contents = walk(root)
      .map((f) => readFileSync(join(root, f), 'utf8'))
      .sort();
    expect(contents).toEqual(['child', 'file', 'one', 'three', 'two']);
  });

  it('does not overwrite a file that already exists on disk', async () => {
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    writeFileSync(join(root, 'artifacts', 'a.txt'), 'pre-existing');
    const writer = await createOutputWriter(root);
    const stored = await writer.write('artifacts/a.txt', 'new');
    expect(readFileSync(join(root, 'artifacts', 'a.txt'), 'utf8')).toBe('pre-existing');
    expect(stored.storedAs).toMatch(/^_collisions\//);
  });
});

describe('the capture:smoke tool, end to end, against a hostile repository tree', () => {
  it('refuses unsafe tree paths at the adapter, writes only inside --out, and leaves the sentinel alone', () => {
    const recording = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../../../tests/fixtures/real-github/recorded-judge-9459c98.json',
        ),
        'utf8',
      ),
    ) as {
      routes: Record<
        string,
        {
          json?: {
            tree?: { path: string; mode: string; type: string; sha: string; size: number }[];
          };
        }
      >;
    };
    const treeUrl = Object.keys(recording.routes).find((u) => u.includes('/git/trees/')) ?? '';
    const tree = recording.routes[treeUrl]?.json?.tree ?? [];
    const donor = tree.find((entry) => entry.type === 'blob' && entry.path === 'README.md');
    if (!donor) throw new Error('no donor entry');
    for (const path of [
      '../../escaped.txt',
      '/abs/escaped.txt',
      'a\\..\\b.txt',
      'C:\\x.txt',
      'ok/../../up.md',
      'nul\u0000.md',
    ]) {
      tree.push({ ...donor, path });
    }
    const worldFile = join(base, 'hostile-world.json');
    writeFileSync(worldFile, JSON.stringify(recording));
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsx',
        '--conditions=@judge-copilot/source',
        'apps/worker/src/testing/real-capture-smoke.ts',
        'github',
        'https://github.com/meetbhadra701-cloud/Judge',
        '--world',
        worldFile,
        '--out',
        root,
        '--max-files',
        '4',
        '--max-commits',
        '5',
      ],
      { cwd: resolve(import.meta.dirname, '../../../..'), stdio: 'pipe' },
    );
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
      artifacts: { key: string; storedAs: string; mirrored: boolean }[];
    };
    expect(manifest.artifacts.every((a) => a.mirrored)).toBe(true); // the adapter kept hostile paths out of the artifact set entirely
    const omissions = readFileSync(
      join(root, manifest.artifacts.find((a) => a.key === 'omissions.json')?.storedAs ?? ''),
      'utf8',
    );
    expect(
      (JSON.parse(omissions) as { counts: Record<string, number> }).counts['unsafe_path'],
    ).toBe(6);
    expect(outsideIntact()).toBe(true);
    expect(existsSync(join(base, 'escaped.txt'))).toBe(false);
    for (const file of walk(root)) expect(file).not.toMatch(/escaped|\.\./);
  }, 60_000);

  it('refuses to write into a directory that already holds files', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'keep.txt'), 'keep');
    expect(() =>
      execFileSync(
        'pnpm',
        [
          'exec',
          'tsx',
          '--conditions=@judge-copilot/source',
          'apps/worker/src/testing/real-capture-smoke.ts',
          'github',
          'https://github.com/a/b',
          '--world',
          join(base, 'none.json'),
          '--out',
          root,
        ],
        {
          cwd: resolve(import.meta.dirname, '../../../..'),
          stdio: 'pipe',
        },
      ),
    ).toThrow();
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');
  }, 60_000);
});
