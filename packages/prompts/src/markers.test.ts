import { ASSESSMENT_STAGE_VALUES } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import {
  ITEM_BEGIN,
  ITEM_CODE_PLACEHOLDER,
  ITEM_END,
  ITEM_HANDLE_PLACEHOLDER,
  markerClause,
} from './frame.js';
import { renderPrompt } from './render.js';
import { VALID_INPUTS } from './testing/fixtures.js';
import { parseBlocks } from './testing/parse-blocks.js';

/*
 * The instructions in the trusted system message describe the record markers; the renderer emits them. These tests pin the two
 * together: the format the model is told about is, character for character, the format it receives.
 */

/** Pulls the two quoted record-marker templates out of the clause, exactly as the model reads them. */
function describedTemplates(system: string): { begin: string; end: string } {
  const line = system
    .split('\n')
    .find((candidate) => candidate.startsWith('Inside a block, each record'));
  if (!line) throw new Error('no record-marker instruction in the system text');
  const quoted = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');
  const [begin, end] = quoted;
  if (begin === undefined || end === undefined)
    throw new Error('the instruction does not quote both markers');
  return { begin, end };
}

describe('the marker instructions agree with the emitted markers', () => {
  it.each(ASSESSMENT_STAGE_VALUES)(
    '%s: every emitted record marker is exactly the described template with its values substituted',
    (stage) => {
      const rendered = renderPrompt(stage, VALID_INPUTS[stage]);
      const { begin, end } = describedTemplates(rendered.system);
      const instantiate = (template: string, handle: string, code: string) =>
        template
          .replaceAll(ITEM_HANDLE_PLACEHOLDER, handle)
          .replaceAll(ITEM_CODE_PLACEHOLDER, code);
      let checked = 0;
      for (const [index, block] of parseBlocks(rendered.user, rendered.boundary).entries()) {
        const lines = (rendered.user[index] ?? '').split('\n');
        for (const item of block.items) {
          expect(lines).toContain(instantiate(begin, item.handle, item.code));
          expect(lines).toContain(instantiate(end, item.handle, item.code));
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(0);
    },
  );

  it('states the closing delimiter as exactly three angle brackets, never four', () => {
    const { begin, end } = describedTemplates(renderPrompt('critic', VALID_INPUTS.critic).system);
    expect(begin).toBe('<<<ITEM {handle} {code}>>>');
    expect(end).toBe('<<<END ITEM {handle} {code}>>>');
    expect(begin).not.toMatch(/>>>>/);
    expect(end).not.toMatch(/>>>>/);
    expect(renderPrompt('critic', VALID_INPUTS.critic).system).not.toMatch(/>>>>/);
  });

  it('uses the same formatters for emission and description, so they cannot drift apart', () => {
    expect(ITEM_BEGIN('E-001', 'abcdef0123456789')).toBe('<<<ITEM E-001 abcdef0123456789>>>');
    expect(ITEM_END('E-001', 'abcdef0123456789')).toBe('<<<END ITEM E-001 abcdef0123456789>>>');
    const clause = markerClause('DATA-0123', ['data']);
    expect(clause).toContain(`"${ITEM_BEGIN(ITEM_HANDLE_PLACEHOLDER, ITEM_CODE_PLACEHOLDER)}"`);
    expect(clause).toContain(`"${ITEM_END(ITEM_HANDLE_PLACEHOLDER, ITEM_CODE_PLACEHOLDER)}"`);
  });

  it('keeps the placeholders out of anything a handle or a code can be', () => {
    expect(ITEM_HANDLE_PLACEHOLDER).not.toMatch(/^[A-Z]-\d{3,6}$/);
    expect(ITEM_CODE_PLACEHOLDER).not.toMatch(/^[0-9a-f]{16}$/);
  });
});
