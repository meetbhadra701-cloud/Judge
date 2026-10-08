import { describe, expect, it } from 'vitest';
import { jsonSchemaFor } from './json-schema.js';
import { MAX_MODEL_JSON_CHARS, parseModelJson } from './parse.js';
import {
  ASSESSMENT_STAGE_OUTPUT_SCHEMAS,
  ASSESSMENT_STAGE_VALUES,
  parseStageOutput,
} from '@judge-copilot/schemas';

describe('strict model JSON parsing: reject, never repair', () => {
  it.each([
    ['plain object', '{"claims":[]}'],
    ['surrounding whitespace', '  \n {"claims":[]}\n '],
    ['array', '[1,2]'],
    ['nested', '{"a":{"b":[1,{"c":null}]}}'],
  ])('accepts %s', (_name, text) => {
    expect(parseModelJson(text).ok).toBe(true);
  });

  it.each([
    ['a markdown fence', '```json\n{"claims":[]}\n```'],
    ['a leading remark', 'Here is the JSON: {"claims":[]}'],
    ['a trailing remark', '{"claims":[]} Hope this helps!'],
    ['two documents', '{"a":1}{"b":2}'],
    ['truncated JSON', '{"claims":[{"ref":"c1"'],
    ['single quotes', "{'claims': []}"],
    ['a trailing comma', '{"claims":[],}'],
    ['a BOM', '﻿{"claims":[]}'],
    ['a comment', '{"claims":[] /* x */}'],
    ['NaN', '{"score":NaN}'],
    ['Infinity', '{"score":Infinity}'],
  ])('rejects %s', (_name, text) => {
    expect(parseModelJson(text)).toEqual({ ok: false, reason: 'not_json' });
  });

  it('rejects empty and oversized answers before parsing', () => {
    expect(parseModelJson('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseModelJson('   \n ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseModelJson(`"${'a'.repeat(MAX_MODEL_JSON_CHARS)}"`)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('keeps a hostile __proto__ key as inert data that the strict schemas then reject', () => {
    const parsed = parseModelJson('{"claims":[],"__proto__":{"polluted":true}}');
    expect(parsed.ok).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(parsed.ok && parseStageOutput('claim_extraction', parsed.value).ok).toBe(false);
  });
});

describe('provider-side JSON schema generation', () => {
  it.each(ASSESSMENT_STAGE_VALUES)(
    'derives a closed object schema for %s from the Zod schema',
    (stage) => {
      const schema = jsonSchemaFor(ASSESSMENT_STAGE_OUTPUT_SCHEMAS[stage]);
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
      expect(Object.keys(schema['properties'] as object).length).toBeGreaterThan(0);
    },
  );

  it('is deterministic for the same schema (so the request digest is stable)', () => {
    expect(JSON.stringify(jsonSchemaFor(ASSESSMENT_STAGE_OUTPUT_SCHEMAS.critic))).toBe(
      JSON.stringify(jsonSchemaFor(ASSESSMENT_STAGE_OUTPUT_SCHEMAS.critic)),
    );
  });
});
