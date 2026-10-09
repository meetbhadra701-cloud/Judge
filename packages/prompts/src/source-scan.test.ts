import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * P2 invariant scans of the prompts package source. The package is a pure function library: no provider, no SDK, no network,
 * no filesystem, no environment, no clock, no randomness, no fresh identifiers, no model import (layer rule: prompts and llm
 * are siblings and never depend on each other).
 */
const SRC = resolve(import.meta.dirname);
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : files(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

describe('packages/prompts source (P2)', () => {
  const sources = files(SRC);

  it('has real source files to scan', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it.each([
    ['a vendor SDK', /from ['"](@anthropic-ai\/|openai|@google\/|cohere|ollama|langchain)/],
    ['the llm package', /@judge-copilot\/llm|\.\.\/\.\.\/llm/],
    [
      'a provider host',
      /api\.(anthropic|openai)\.com|generativelanguage\.googleapis|localhost:11434/,
    ],
    [
      'network access',
      /\bfetch\(|XMLHttpRequest|from ['"](node:)?(http|https|net|tls|dgram|dns|undici)['"]/,
    ],
    ['filesystem access', /from ['"](node:)?fs(\/promises)?['"]|readFileSync|writeFileSync/],
    ['process execution', /from ['"](node:)?(child_process|vm|worker_threads)['"]/],
    ['environment access', /\bprocess\./],
    ['a key literal', /sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9_-]{8,}|x-api-key/],
    ['console output', /\bconsole\./],
    ['dynamic evaluation', /\beval\s*\(|new Function\s*\(/],
    ['a clock', /Date\.now\(|new Date\(|performance\.now/],
    [
      'randomness or fresh identifiers',
      /Math\.random\(|randomUUID|randomBytes|getRandomValues|uuid/i,
    ],
    ['a reference to the unapproved anchors document', /fallback-anchors-draft|M5-fallback/],
  ])('contains no %s', (_name, pattern) => {
    for (const file of sources) {
      expect(pattern.test(code(file)), relative(SRC, file)).toBe(false);
    }
  });

  it('imports workspace packages only through their roots', () => {
    for (const file of sources) {
      for (const match of code(file).matchAll(/from ['"](@judge-copilot\/[^'"]+)['"]/g)) {
        expect(match[1], relative(SRC, file)).toMatch(/^@judge-copilot\/(context|schemas)$/);
      }
    }
  });

  it('keeps the trusted instruction text free of interpolation and data', () => {
    const system = readFileSync(join(SRC, 'system.ts'), 'utf8');
    expect(system).not.toMatch(/\$\{/);
  });
});
