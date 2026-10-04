/*
 * Guards the M2 scope (docs/V1_CONTRACT.md). M2 adds projects, read-only source ingestion
 * (GitHub, Devpost, deployment, video), the SSRF-safe HTTP foundation, the capture worker and the
 * authentication boundary. Everything from M3 on must stay unimplemented: no claims or evidence
 * graph, no scoring, no uncertainty or question engine, no model providers or prompts, no
 * assessments. If a later milestone legitimately adds one of these, update this test in that
 * milestone together with its milestone report.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** Packages that must remain README-only placeholders until their milestone. */
const NOT_YET_IMPLEMENTED = [
  'evidence', // M3: claims, evidence graph, relations, contradictions, unknowns
  'scoring', // M4
  'uncertainty', // M6
  'questions', // M6
  'browser', // headless/sandboxed browser inspection (deferred; M2 uses plain HTTP observation)
  'llm', // model provider abstraction (first used no earlier than M5)
  'prompts',
];

/** Packages M2 is allowed to implement. */
const M2_PACKAGES = ['capture', 'safe-http', 'github', 'devpost', 'deployment', 'video', 'auth'];

const MODEL_SDKS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  'cohere-ai',
  '@mistralai/mistralai',
  'ollama',
  'groq-sdk',
  'replicate',
  'langchain',
  '@langchain/core',
  'ai',
  'llamaindex',
  '@huggingface/inference',
];

const PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'integrate.api.nvidia.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'api-inference.huggingface.co',
  'localhost:11434',
];

/** Tables that belong to later milestones. */
const LATER_TABLE_PATTERN =
  /(claim|evidence|contradiction|unknown|assessment|score|question|answer|interview|embedding|ranking|winner)/;

function workspaceManifests(): {
  dir: string;
  manifest: Record<string, Record<string, string> | undefined>;
}[] {
  const dirs = [
    ROOT,
    ...['apps', 'packages'].flatMap((group) =>
      readdirSync(join(ROOT, group)).map((name) => join(ROOT, group, name)),
    ),
  ];
  return dirs
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({
      dir,
      manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >,
    }));
}

function sourceFiles(dir: string, { includeTests = false } = {}): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.next'].includes(entry.name)
        ? []
        : sourceFiles(path, { includeTests });
    }
    if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) return [];
    return includeTests || !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

const applicationSource = ['apps', 'packages'].flatMap((group) => sourceFiles(join(ROOT, group)));

describe('M2 milestone scope', () => {
  it('keeps M3+ packages as README-only placeholders', () => {
    for (const name of NOT_YET_IMPLEMENTED) {
      const dir = join(ROOT, 'packages', name);
      expect(statSync(dir).isDirectory(), `${name} placeholder exists`).toBe(true);
      expect(existsSync(join(dir, 'package.json')), `${name} must not be implemented yet`).toBe(
        false,
      );
      expect(readdirSync(dir)).toEqual(['README.md']);
    }
  });

  it('implements the M2 ingestion packages as workspace packages', () => {
    for (const name of M2_PACKAGES) {
      expect(existsSync(join(ROOT, 'packages', name, 'package.json')), name).toBe(true);
    }
  });

  it('depends on no model or provider SDK', () => {
    for (const { dir, manifest } of workspaceManifests()) {
      const deps = Object.keys({ ...manifest['dependencies'], ...manifest['devDependencies'] });
      expect(
        deps.filter((dep) => MODEL_SDKS.includes(dep)),
        dir,
      ).toEqual([]);
    }
  });

  it('contains no model-provider endpoints in application source', () => {
    const offenders = applicationSource.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return PROVIDER_HOSTS.some((host) => text.includes(host));
    });
    expect(offenders).toEqual([]);
  });

  it('creates no claim, evidence, scoring, question or assessment tables in any migration', () => {
    const migrations = join(ROOT, 'packages/database/drizzle');
    for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql'))) {
      const created = [
        ...readFileSync(join(migrations, file), 'utf8').matchAll(/CREATE TABLE "([a-z_]+)"/g),
      ].map((match) => match[1] ?? '');
      for (const table of created) {
        expect(LATER_TABLE_PATTERN.test(table), `${file}: ${table}`).toBe(false);
      }
    }
  });

  it('exposes no score, evidence, analysis or assessment HTTP routes', () => {
    const routeFiles = sourceFiles(join(ROOT, 'apps/api/src')).filter((file) =>
      file.endsWith('routes.ts'),
    );
    for (const file of routeFiles) {
      const paths = [...readFileSync(file, 'utf8').matchAll(/['`](\/[^'`]*)['`]/g)].map(
        (match) => match[1] ?? '',
      );
      for (const path of paths) {
        expect(
          /score|evidence|analy[sz]e|assessment|question|claim/i.test(path),
          `${relative(ROOT, file)}: ${path}`,
        ).toBe(false);
      }
    }
  });
});

describe('M2 security architecture', () => {
  it('has no code path that executes, installs or imports project content', () => {
    // ESLint already forbids child_process/vm; this is an independent, broader source check.
    const forbidden = [
      /from ['"](node:)?child_process['"]/,
      /from ['"](node:)?vm['"]/,
      /from ['"](node:)?worker_threads['"]/,
      /from ['"](node:)?wasi['"]/,
      /\beval\s*\(/,
      /new Function\s*\(/,
      /\bimport\(\s*[^'"\s)]/, // dynamic import of a computed specifier
      /\brequire\(\s*[^'"\s)]/,
      /npm (install|ci)|pip install|docker build|git clone|make\b.*-C/,
    ];
    const offenders = applicationSource
      .filter((file) => !file.includes(join('apps', 'web')) || !file.endsWith('next-env.d.ts'))
      .flatMap((file) => {
        const text = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/)/.test(line))
          .join('\n');
        return forbidden
          .filter((pattern) => pattern.test(text))
          .map((pattern) => `${relative(ROOT, file)} ${pattern.source}`);
      });
    expect(offenders).toEqual([]);
  });

  it('keeps capture adapters off the filesystem and away from raw sockets and global fetch', () => {
    const adapterDirs = ['capture', 'github', 'devpost', 'deployment', 'video'].map((name) =>
      join(ROOT, 'packages', name, 'src'),
    );
    for (const file of adapterDirs.flatMap((dir) => sourceFiles(dir))) {
      const text = readFileSync(file, 'utf8');
      expect(
        /from ['"](node:)?(fs|fs\/promises|net|tls|http|https|dgram)['"]/.test(text),
        relative(ROOT, file),
      ).toBe(false);
      expect(/\bfetch\(/.test(text), relative(ROOT, file)).toBe(false);
    }
  });

  it('routes all capture network access through the SSRF-safe client', () => {
    // Only safe-http opens connections; the worker composes adapters with it. (Type-only
    // imports, such as the API server's request types, open nothing.)
    const networkModules = applicationSource.filter((file) =>
      /^import (?!type\b)[^;]*from ['"](node:)?(http|https|net|tls|undici)['"]/m.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(networkModules.map((file) => relative(ROOT, file)).sort()).toEqual([
      'packages/safe-http/src/client.ts',
      'packages/safe-http/src/ip-policy.ts',
      'packages/safe-http/src/transport.ts',
      'packages/safe-http/src/url-policy.ts',
    ]);
  });
});
