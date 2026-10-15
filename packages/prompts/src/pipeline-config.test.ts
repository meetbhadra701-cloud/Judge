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
    // P6B-beta3-R1 moved it again, to source-selection/v3 (role-sensitive duplicates, inventory-based coverage, per-category documentation pools).
    expect(
      hashOf(buildPipelineConfig({ provider: { id: 'replay', mode: 'replay' }, models: MODELS })),
    ).toBe('8d69736837f6bd0e05a2a68e4b469917a1b41e86296b845c40be03d18d6987ca');
    expect(
      hashOf(
        buildPipelineConfig({ provider: { id: 'scripted', mode: 'scripted' }, models: MODELS }),
      ),
    ).toBe('31a256af605e5aebff51b529c042b090a70f38b41488c4a467049fb46badac4b');
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
    const frozenV2 = {
      ...config,
      policies: { ...config.policies, selection: 'source-selection/v2' },
    };
    expect(checkPipelineConfig(frozenV2, runtime)).toMatchObject({ ok: true });
    const unknown = {
      ...config,
      policies: { ...config.policies, selection: 'source-selection/v4' },
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
