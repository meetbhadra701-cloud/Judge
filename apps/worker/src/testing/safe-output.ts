import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

/*
 * Writing captured material to a directory on someone's disk (the `capture:smoke` development tool).
 *
 * Artifact keys come from an EXTERNAL source (a repository's tree: `files/<path>`), so a key is untrusted text, not a file name. This module is the
 * only place that turns one into a path, and it guarantees, for any key whatsoever:
 *   - nothing is ever written outside the root, whatever the key contains (traversal, absolute, backslash, drive letter, NUL, ...);
 *   - no component of the destination is a symbolic link (a pre-existing link cannot redirect output), checked on every component and again with
 *     O_NOFOLLOW on the file itself;
 *   - nothing already on disk is overwritten (exclusive create): a collision (same name differing by case, a file where a directory is needed and
 *     vice versa, an existing file) is stored under `_collisions/` instead, and the manifest says where each artifact went.
 * A key that is not an ordinary relative path is stored under `_unsafe/<sha256>.txt`: the content is kept, the hostile name is not used.
 * Failure is safe: the checks run before the first write of that file, and an error leaves no file outside the root.
 */

const SAFE_SEGMENT = /^[\p{L}\p{N}._@+=,~#()[\]{}!$%&'^-][\p{L}\p{N}._@+=,~#()[\]{}!$%&'^ -]*$/u;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_SEGMENT = 120;
const MAX_DEPTH = 24;

/** True when this key can be mirrored as a relative path on every common file system. */
export function isMirrorablePath(key: string): boolean {
  if (key === '' || key.length > 600) return false;
  const segments = key.split('/');
  if (segments.length > MAX_DEPTH) return false;
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment.length <= MAX_SEGMENT &&
      segment !== '.' &&
      segment !== '..' &&
      SAFE_SEGMENT.test(segment) &&
      !segment.endsWith(' ') &&
      !segment.endsWith('.') &&
      !WINDOWS_DEVICE.test(segment),
  );
}

export interface StoredFile {
  /** Path relative to the root, with `/` separators. */
  readonly storedAs: string;
  /** False when the key was not an ordinary path (or collided) and the content went to `_unsafe/` or `_collisions/`. */
  readonly mirrored: boolean;
}

export class UnsafeOutputError extends Error {}

const hashName = (key: string) =>
  createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);

export interface OutputWriter {
  readonly root: string;
  write(key: string, text: string): Promise<StoredFile>;
}

/** Creates the root if needed and returns a writer confined to it. */
export async function createOutputWriter(root: string): Promise<OutputWriter> {
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  // lowercase relative paths already used: file names and directory names share one namespace on case-insensitive file systems
  const files = new Set<string>();
  const directories = new Set<string>();

  async function ensureDirectories(segments: readonly string[]): Promise<string> {
    let current = realRoot;
    for (const segment of segments) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current, { mode: 0o755 });
        continue;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new UnsafeOutputError(`not a plain directory: ${current.slice(realRoot.length)}`);
      }
    }
    const resolved = await realpath(current);
    if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
      throw new UnsafeOutputError('destination resolves outside the output root');
    }
    return current;
  }

  async function createExclusive(relative: string, text: string): Promise<boolean> {
    const segments = relative.split('/');
    const name = segments[segments.length - 1] ?? '';
    const directory = await ensureDirectories(segments.slice(0, -1));
    let handle;
    try {
      handle = await open(
        join(directory, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ELOOP' || code === 'EISDIR') return false;
      throw error;
    }
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  }

  function claim(relative: string): boolean {
    const segments = relative.toLowerCase().split('/');
    const path = segments.join('/');
    if (files.has(path) || directories.has(path)) return false;
    for (let index = 1; index < segments.length; index += 1) {
      if (files.has(segments.slice(0, index).join('/'))) return false;
    }
    files.add(path);
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
    return true;
  }

  return {
    root: realRoot,
    async write(key: string, text: string): Promise<StoredFile> {
      const attempts: { relative: string; mirrored: boolean }[] = [];
      if (isMirrorablePath(key)) attempts.push({ relative: key, mirrored: true });
      else attempts.push({ relative: `_unsafe/${hashName(key)}.txt`, mirrored: false });
      attempts.push({
        relative: `_collisions/${hashName(key)}-${hashName(text)}.txt`,
        mirrored: false,
      });
      for (const attempt of attempts) {
        if (!claim(attempt.relative)) continue;
        if (await createExclusive(attempt.relative, text)) {
          return { storedAs: attempt.relative, mirrored: attempt.mirrored };
        }
      }
      throw new UnsafeOutputError('no safe destination for an artifact');
    },
  };
}
