/*
 * Guards the M1 scope (docs/V1_CONTRACT.md): no model/provider integration, no project
 * ingestion, evidence, scoring or question generation. If a later milestone legitimately adds
 * one of these, update this test in that milestone together with its milestone report.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** Packages that must remain README-only placeholders until their milestone. */
const NOT_YET_IMPLEMENTED = [
  'evidence', // M3
  'scoring', // M4
  'uncertainty', // M6
  'questions', // M6
  'github', // M2
  'devpost', // M2
  'browser', // M2+
  'llm', // model provider abstraction (first used no earlier than M5)
  'prompts',
];

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
];

const PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'integrate.api.nvidia.com',
  'api.cohere.ai',
  'api.mistral.ai',
];

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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.next'].includes(entry.name) ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('M1 milestone scope', () => {
  it('keeps later-milestone packages as README-only placeholders', () => {
    for (const name of NOT_YET_IMPLEMENTED) {
      const dir = join(ROOT, 'packages', name);
      expect(statSync(dir).isDirectory(), `${name} placeholder exists`).toBe(true);
      expect(existsSync(join(dir, 'package.json')), `${name} must not be implemented yet`).toBe(
        false,
      );
      expect(readdirSync(dir)).toEqual(['README.md']);
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
    const offenders = ['apps', 'packages']
      .flatMap((group) => sourceFiles(join(ROOT, group)))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return PROVIDER_HOSTS.some((host) => text.includes(host));
      });
    expect(offenders).toEqual([]);
  });
});
