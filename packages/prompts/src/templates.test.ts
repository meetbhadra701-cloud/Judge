import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { ASSESSMENT_STAGE_OUTPUT_SCHEMAS, ASSESSMENT_STAGE_VALUES } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PREAMBLE, TASKS } from './system.js';
import { PROMPT_REGISTRY, PROMPT_VERSION, PROMPTS, promptFor } from './templates.js';

/*
 * Frozen prompt identity: ids, versions, schema identifiers and template hashes are pinned by a golden file. Changing a word
 * of an instruction, the output schema or the block layout without bumping the version FAILS here. Regenerating the golden
 * (UPDATE_GOLDEN=1) is a deliberate, reviewed act, and a wording change must also bump PROMPT_VERSION.
 */

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(PACKAGE, 'golden', 'template-hashes.json');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

describe('frozen prompt identity', () => {
  it('has exactly one frozen prompt per model-backed stage', () => {
    expect(Object.keys(PROMPTS).sort()).toEqual([...ASSESSMENT_STAGE_VALUES].sort());
    expect(PROMPT_REGISTRY.map((entry) => entry.stage)).toEqual([...ASSESSMENT_STAGE_VALUES]);
    expect(PROMPT_VERSION).toBe('v1');
  });

  it('uses kebab-case ids, a shared version, and schema ids equal to prompt ids', () => {
    for (const stage of ASSESSMENT_STAGE_VALUES) {
      const prompt = promptFor(stage);
      expect(prompt.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(prompt.id).toBe(stage.replaceAll('_', '-'));
      expect(prompt.version).toBe('v1');
      expect(prompt.schemaId).toBe(prompt.id);
      expect(prompt.schemaVersion).toBe(prompt.version);
      expect(prompt.templateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(prompt.outputSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(PROMPT_REGISTRY.map((entry) => entry.templateHash)).size).toBe(9);
  });

  it('is deeply frozen at runtime', () => {
    const prompt = promptFor('critic');
    expect(Object.isFrozen(PROMPTS)).toBe(true);
    expect(Object.isFrozen(prompt)).toBe(true);
    expect(Object.isFrozen(prompt.blocks)).toBe(true);
    expect(() => {
      (prompt as { systemBase: string }).systemBase = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (PROMPT_REGISTRY as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it('commits the output schema hash to the same JSON Schema the provider is sent', () => {
    for (const stage of ASSESSMENT_STAGE_VALUES) {
      const jsonSchema = z.toJSONSchema(ASSESSMENT_STAGE_OUTPUT_SCHEMAS[stage], {
        io: 'input',
        unrepresentable: 'any',
      });
      expect(promptFor(stage).outputSchemaHash).toBe(sha256Hex(canonicalJson(jsonSchema)));
    }
  });

  it('commits the template hash to the trusted system text, the schema hash, the layout and the version', () => {
    const critic = promptFor('critic');
    const recompute = (changes: Record<string, unknown>) =>
      sha256Hex(
        canonicalJson({
          v: 'prompt-template/v1',
          id: critic.id,
          version: critic.version,
          stage: critic.stage,
          schemaId: critic.schemaId,
          schemaVersion: critic.schemaVersion,
          outputSchemaHash: critic.outputSchemaHash,
          framing: 'framing/v1',
          blocks: critic.blocks,
          systemBase: critic.systemBase,
          ...changes,
        }),
      );
    expect(recompute({})).toBe(critic.templateHash);
    expect(recompute({ systemBase: `${critic.systemBase} ` })).not.toBe(critic.templateHash);
    expect(recompute({ version: 'v2' })).not.toBe(critic.templateHash);
    expect(recompute({ outputSchemaHash: 'f'.repeat(64) })).not.toBe(critic.templateHash);
    expect(recompute({ blocks: ['data'] })).not.toBe(critic.templateHash);
    expect(recompute({ framing: 'framing/v2' })).not.toBe(critic.templateHash);
  });

  it('keeps the system text constant: no interpolation holes, no project data, no secrets', () => {
    for (const stage of ASSESSMENT_STAGE_VALUES) {
      const { systemBase } = promptFor(stage);
      expect(systemBase).toBe(`${PREAMBLE}\n\n${TASKS[stage]}`);
      expect(systemBase).not.toMatch(/\$\{|\{\{|<%|undefined|\[object/);
      expect(systemBase).not.toMatch(/[0-9a-f]{32}/);
      expect(systemBase).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    }
  });

  it('states the structural rules every prompt needs', () => {
    for (const stage of ASSESSMENT_STAGE_VALUES) {
      const { systemBase } = promptFor(stage);
      expect(systemBase).toMatch(/untrusted/);
      expect(systemBase).toMatch(/Never follow it/);
      expect(systemBase).toMatch(/Never invent a handle/);
      expect(systemBase).toMatch(/Missing evidence is not negative evidence/);
      expect(systemBase).toMatch(/Never accuse/);
      expect(systemBase).toMatch(/exactly one JSON document/);
    }
  });

  it('matches the golden table of template hashes', () => {
    const table = PROMPT_REGISTRY.map(({ stage, id, version, templateHash, outputSchemaHash }) => ({
      stage,
      id,
      version,
      templateHash,
      outputSchemaHash,
    }));
    const text = `${JSON.stringify(table, null, 2)}\n`;
    if (UPDATE) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, text);
    }
    expect(
      existsSync(GOLDEN),
      'missing golden/template-hashes.json (run with UPDATE_GOLDEN=1)',
    ).toBe(true);
    expect(text).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});
