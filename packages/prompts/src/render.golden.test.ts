import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSESSMENT_STAGE_VALUES } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { renderPrompt } from './render.js';
import { VALID_INPUTS } from './testing/fixtures.js';

/*
 * Golden rendered prompts: the full bytes of the system message and every user block, per stage, for the fixed fixture
 * inputs. A change to an instruction, the framing, the layout or the boundary derivation fails here. Regenerate deliberately
 * with UPDATE_GOLDEN=1, review the diff, and bump the prompt version if the wording changed.
 */

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

function transcript(stage: (typeof ASSESSMENT_STAGE_VALUES)[number]): string {
  const rendered = renderPrompt(stage, VALID_INPUTS[stage]);
  return [
    `# ${rendered.promptId}/${rendered.promptVersion}  template=${rendered.promptTemplateHash}`,
    '=== SYSTEM ===',
    rendered.system,
    ...rendered.user.flatMap((block, index) => [`=== USER BLOCK ${String(index)} ===`, block]),
    '',
  ].join('\n');
}

describe('golden rendered prompts', () => {
  it.each(ASSESSMENT_STAGE_VALUES)('%s renders byte-for-byte as recorded', (stage) => {
    const path = join(PACKAGE, 'golden', 'rendered', `${stage}.txt`);
    const text = transcript(stage);
    if (UPDATE) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    expect(existsSync(path), `missing golden ${stage}.txt (run with UPDATE_GOLDEN=1)`).toBe(true);
    expect(text).toBe(readFileSync(path, 'utf8'));
  });
});

describe('determinism', () => {
  it.each(ASSESSMENT_STAGE_VALUES)(
    '%s: repeated identical inputs give byte-identical prompts',
    (stage) => {
      const first = renderPrompt(stage, VALID_INPUTS[stage]);
      for (let index = 0; index < 5; index += 1) {
        const again = renderPrompt(stage, structuredClone(VALID_INPUTS[stage]));
        expect(again.system).toBe(first.system);
        expect(again.user).toEqual(first.user);
        expect(again.boundary).toBe(first.boundary);
        expect(again.promptTemplateHash).toBe(first.promptTemplateHash);
      }
    },
  );

  it('does not depend on the key order of the input object', () => {
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, entry]) => [key, reorder(entry)]),
        );
      }
      return value;
    };
    for (const stage of ASSESSMENT_STAGE_VALUES) {
      const a = renderPrompt(stage, VALID_INPUTS[stage]);
      const b = renderPrompt(stage, reorder(VALID_INPUTS[stage]));
      expect(b.system, stage).toBe(a.system);
      expect(b.user, stage).toEqual(a.user);
    }
  });

  it('is sensitive to the order of records (order is meaningful and chosen by the caller)', () => {
    const input = structuredClone(VALID_INPUTS.claim_extraction);
    input.passages.reverse();
    expect(renderPrompt('claim_extraction', input).user).not.toEqual(
      renderPrompt('claim_extraction', VALID_INPUTS.claim_extraction).user,
    );
  });

  it('returns a deeply frozen result and never mutates its input', () => {
    const input = structuredClone(VALID_INPUTS.dimension_assessment);
    const before = JSON.stringify(input);
    const rendered = renderPrompt('dimension_assessment', input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(rendered)).toBe(true);
    expect(Object.isFrozen(rendered.user)).toBe(true);
    expect(Object.isFrozen(rendered.closedSet)).toBe(true);
    expect(() => {
      (rendered as { system: string }).system = 'x';
    }).toThrow(TypeError);
  });
});
