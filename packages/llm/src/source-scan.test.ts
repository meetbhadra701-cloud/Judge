import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * P1 invariant scans of the llm package source: no vendor SDK, no network, no filesystem, no environment access,
 * no key material, no raw error messages. (The Anthropic adapter, P6, will live under src/anthropic/ and get its
 * own explicit allowance in the milestone-scope guard.)
 */
const SRC = resolve(import.meta.dirname);
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

describe('packages/llm source (P1)', () => {
  const sources = files(SRC);

  it('has real source files to scan', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each([
    ['a vendor SDK', /from ['"](@anthropic-ai\/|openai|@google\/|cohere|ollama|langchain)/],
    [
      'a provider host',
      /api\.(anthropic|openai)\.com|generativelanguage\.googleapis|localhost:11434/,
    ],
    [
      'network access',
      /\bfetch\(|XMLHttpRequest|from ['"](node:)?(http|https|net|tls|dgram|dns|undici)['"]/,
    ],
    ['filesystem access', /from ['"](node:)?fs(\/promises)?['"]/],
    ['process execution', /from ['"](node:)?(child_process|vm|worker_threads)['"]/],
    ['a key literal', /sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9_-]{8,}|x-api-key/],
    ['console output', /\bconsole\./],
    ['dynamic evaluation', /\beval\s*\(|new Function\s*\(/],
    ['unseeded randomness in library code', /Math\.random\(/],
  ])('contains no %s', (_name, pattern) => {
    for (const file of sources) {
      expect(pattern.test(code(file)), relative(SRC, file)).toBe(false);
    }
  });

  it('reads the environment in exactly one place, and reads only NODE_ENV there', () => {
    const readers = sources.filter((file) => /process\.env/.test(code(file)));
    expect(readers.map((file) => relative(SRC, file))).toEqual(['modes.ts']);
    const reads = [
      ...code(join(SRC, 'modes.ts')).matchAll(
        /process\.env(?:\[['"]([A-Z_]+)['"]\]|\.([A-Z_]+))?/g,
      ),
    ];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read[1] ?? read[2]).toBe('NODE_ENV');
  });

  it('never reads an error message (SDK errors can carry request headers and keys)', () => {
    for (const file of sources) {
      expect(/\.message\b/.test(code(file)), relative(SRC, file)).toBe(false);
    }
  });

  it('keeps wall-clock access inside the one clock module', () => {
    const offenders = sources.filter(
      (file) =>
        /Date\.now\(|new Date\(|setTimeout\(|setInterval\(/.test(code(file)) &&
        !file.endsWith('clock.ts'),
    );
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});
