import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * P3 invariant scans of the assessment package source. It is Layer 2: pure, deterministic and network-free. It must never import
 * `llm`, `prompts`, `database`, a model SDK or a worker, and must contain no I/O, clock, randomness, environment or fresh identifier.
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

describe('packages/assessment source (P3)', () => {
  const sources = files(SRC);

  it('has real source files to scan', () => {
    expect(sources.length).toBeGreaterThanOrEqual(18);
  });

  it.each([
    ['the llm package', /@judge-copilot\/llm/],
    ['the prompts package', /@judge-copilot\/prompts/],
    ['the database package', /@judge-copilot\/database/],
    ['a worker, api or web app', /@judge-copilot\/(worker|api|web)/],
    ['a vendor SDK', /from ['"](@anthropic-ai\/|openai|@google\/|cohere|ollama|langchain)/],
    [
      'network access',
      /\bfetch\(|XMLHttpRequest|from ['"](node:)?(http|https|net|tls|dgram|dns|undici)['"]/,
    ],
    ['filesystem access', /from ['"](node:)?fs(\/promises)?['"]|readFileSync|writeFileSync/],
    ['process execution', /from ['"](node:)?(child_process|vm|worker_threads)['"]/],
    ['environment access', /\bprocess\./],
    ['console output', /\bconsole\./],
    ['dynamic evaluation', /\beval\s*\(|new Function\s*\(/],
    ['a clock', /Date\.now\(|new Date\(|performance\.now/],
    [
      'randomness or fresh identifiers',
      /Math\.random\(|randomUUID|randomBytes|getRandomValues|randomIdAllocator/,
    ],
    ['a key literal', /sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9_-]{8,}|x-api-key/],
    ['a reference to the unapproved anchors document', /fallback-anchors-draft|M5-fallback/],
    [
      'a privileged verification level assignment',
      /['"](?:repo_corroborated|machine_verified|judge_verified|live_verified)['"]/,
    ],
  ])('contains no %s', (_name, pattern) => {
    for (const file of sources) {
      expect(pattern.test(code(file)), relative(SRC, file)).toBe(false);
    }
  });

  it('imports workspace packages only through their roots, and only the approved pure ones', () => {
    for (const file of sources) {
      for (const match of code(file).matchAll(/from ['"](@judge-copilot\/[^'"]+)['"]/g)) {
        expect(match[1], relative(SRC, file)).toMatch(
          /^@judge-copilot\/(context|evidence|schemas|scoring)$/,
        );
      }
    }
  });
});
