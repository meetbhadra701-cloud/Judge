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
  it('has the pinned canonical hash of the current configuration (the identity moves ONLY when a policy or prompt does)', () => {
    // P6A recorded eb9201ad.../e894fd68... at ed0259b. P6B-beta3 changed `policies.selection` from source-selection/v1 to v2 (a deliberate identity
    // change: a run frozen under v1 keeps v1 and its old hash; checkPipelineConfig still accepts it), which moves these two values and nothing else.
    expect(
      hashOf(buildPipelineConfig({ provider: { id: 'replay', mode: 'replay' }, models: MODELS })),
    ).toBe('e4710a40807392c60a10b755004149c48f81c9f882150c9865fc01291d536a1b');
    expect(
      hashOf(
        buildPipelineConfig({ provider: { id: 'scripted', mode: 'scripted' }, models: MODELS }),
      ),
    ).toBe('fcb8e3447e223575d2783b9f5cf975ae417f76af85b734478908004e4756a933');
  });

  it('still accepts a configuration frozen under source-selection/v1 (earlier runs stay reproducible) and refuses an unknown policy', () => {
    const config = buildPipelineConfig({
      provider: { id: 'replay', mode: 'replay' },
      models: MODELS,
    });
    const runtime = {
      providerId: 'replay',
      providerMode: 'replay',
      prompts: currentPromptIdentities(),
    };
    const frozenV1 = {
      ...config,
      policies: { ...config.policies, selection: 'source-selection/v1' },
    };
    expect(checkPipelineConfig(frozenV1, runtime)).toMatchObject({ ok: true });
    const unknown = {
      ...config,
      policies: { ...config.policies, selection: 'source-selection/v3' },
    };
    expect(checkPipelineConfig(unknown, runtime)).toEqual({
      ok: false,
      code: 'pipeline_config_invalid',
    });
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
