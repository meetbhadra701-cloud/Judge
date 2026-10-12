import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { describe, expect, it } from 'vitest';
import { PROMPT_REGISTRY } from './templates.js';
import {
  buildPipelineConfig,
  checkPipelineConfig,
  currentPromptIdentities,
} from './pipeline-config.js';

const MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
} as const;
const hashOf = (value: unknown) => sha256Hex(canonicalJson(value));

describe('the shared pipeline configuration (API and worker)', () => {
  it('has the SAME canonical hash it had when it lived in the worker (P6A moved it; no identity changed)', () => {
    // recorded at ed0259b, before the move, with the same options
    expect(
      hashOf(buildPipelineConfig({ provider: { id: 'replay', mode: 'replay' }, models: MODELS })),
    ).toBe('eb9201ad3dc9a80c1e6494b6d3aa0e49213519394b7e91fde794b29298b7bbe8');
    expect(
      hashOf(
        buildPipelineConfig({ provider: { id: 'scripted', mode: 'scripted' }, models: MODELS }),
      ),
    ).toBe('e894fd682e6ddc6b00a0a02dce6c67b94fa169465765de67940cb30651697924');
  });

  it('carries exactly the current prompt identities, in stage order, and nothing secret', () => {
    const config = buildPipelineConfig({
      provider: { id: 'replay', mode: 'replay' },
      models: MODELS,
    });
    expect(config.prompts).toEqual(currentPromptIdentities());
    expect(config.prompts).toHaveLength(PROMPT_REGISTRY.length);
    expect(config.fallbackAnchorsVersion).toBeNull();
    expect(JSON.stringify(config)).not.toMatch(/https?:|sk-|secret|password/i);
  });

  it('is checked against the provider that runs it and against stale prompts', () => {
    const config = buildPipelineConfig({
      provider: { id: 'replay', mode: 'replay' },
      models: MODELS,
    });
    const run = { providerId: 'replay', providerMode: 'replay' };
    expect(checkPipelineConfig(config, run)).toMatchObject({ ok: true });
    expect(checkPipelineConfig(config, { ...run, providerMode: 'live' })).toEqual({
      ok: false,
      code: 'provider_mode_mismatch',
    });
    expect(checkPipelineConfig(config, { ...run, providerId: 'other' })).toEqual({
      ok: false,
      code: 'provider_id_mismatch',
    });
    const stale = {
      ...config,
      prompts: config.prompts.map((p, i) => (i === 0 ? { ...p, version: 'v0' } : p)),
    };
    expect(checkPipelineConfig(stale, run)).toEqual({ ok: false, code: 'pipeline_config_stale' });
    expect(checkPipelineConfig({ ...config, unexpected: 1 }, run)).toEqual({
      ok: false,
      code: 'pipeline_config_invalid',
    });
  });

  it('refuses an invalid combination at build time (unknown model syntax, out-of-range numbers)', () => {
    expect(() =>
      buildPipelineConfig({
        provider: { id: 'replay', mode: 'replay' },
        models: { ...MODELS, critic: 'bad model!' },
      }),
    ).toThrow();
    expect(() =>
      buildPipelineConfig({
        provider: { id: 'replay', mode: 'replay' },
        models: MODELS,
        timeoutMs: 1,
      }),
    ).toThrow();
  });
});
