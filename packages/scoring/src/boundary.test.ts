import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as publicApi from './index.js';
import { createTrustedScoringContext, type CreateTrustedScoringContextInput } from './context.js';
import { baseWorld, lockedSnapshot } from './testing/builders.js';

/*
 * The model trust boundary (docs/milestones/M4-design.md §2.2, §8): no public or model-facing M4
 * input can provide trusted attestations, override effective verification, supply weights for
 * privileged verification levels, or alter the published rubric. M4 validates STRUCTURE; it never
 * claims to have verified semantic relevance.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Code only: comments (which describe the boundary) are removed. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
}

const productionFiles = sourceFiles(SRC).filter(
  (file) => !file.endsWith('.test.ts') && !file.includes(join(SRC, 'testing')),
);

describe('the public API has exactly the intended entry points', () => {
  it('exports a closed list of names', () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'FALLBACK_RUBRIC_DEFINITION',
        'SCORING_PARAMETERS',
        'createTrustedScoringContext',
        'isTrustedScoringContext',
        'parametersHash',
        'scoreProject',
        'selectRubric',
        'validatePublishedWeights',
      ].sort(),
    );
  });

  it('offers no way to supply attestations, override trust or set weights for privileged levels', () => {
    for (const name of Object.keys(publicApi)) {
      expect(name).not.toMatch(/attest|override|grant|elevate|promote/i);
    }
    expect(publicApi.SCORING_PARAMETERS.levelFactor).not.toHaveProperty('machine_verified');
    expect(publicApi.SCORING_PARAMETERS.levelFactor).not.toHaveProperty('judge_verified');
    expect(publicApi.SCORING_PARAMETERS.levelFactor).not.toHaveProperty('live_verified');
  });

  it('has no attestation identifier anywhere in production code (comments excepted)', () => {
    const offenders = productionFiles.filter((file) => /\battestations?\b/i.test(code(file)));
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });

  it('the trusted-context input type has no attestation, override or weight field (checked by the compiler)', () => {
    const graph = baseWorld().build();
    const locked = lockedSnapshot();
    const withAttestations: CreateTrustedScoringContextInput = {
      ...graph,
      locked,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
      // @ts-expect-error `attestations` is not a field of the trusted context input
      attestations: [],
    };
    const withLevelWeights: CreateTrustedScoringContextInput = {
      ...graph,
      locked,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
      // @ts-expect-error `levelWeights` is not a field of the trusted context input
      levelWeights: { machine_verified: 1 },
    };
    // Extra runtime properties are ignored: they change nothing, and trust is never read from them.
    const result = createTrustedScoringContext(withAttestations);
    const other = createTrustedScoringContext(withLevelWeights);
    expect(result.ok && other.ok).toBe(true);
    expect(result.ok && Object.keys(result.context).sort()).toEqual(
      [
        'declaredTrackKeys',
        'eventId',
        'graph',
        'graphDiagnostics',
        'graphFingerprint',
        'known',
        'projectId',
        'rubric',
      ].sort(),
    );
    expect(result.ok && other.ok && result.context.graphFingerprint).toBe(
      other.ok ? other.context.graphFingerprint : '',
    );
  });
});

describe('the engine is pure and deterministic (layer 2)', () => {
  const forbidden: [RegExp, string][] = [
    [
      /from ['"](node:)?(fs|fs\/promises|net|tls|http|https|dgram|child_process|vm|os|worker_threads|dns|path|url)['"]/,
      'node I/O module',
    ],
    [
      /from ['"](drizzle-orm|postgres|fastify|next|react|zod)(\/[^'"]*)?['"]/,
      'infrastructure or direct zod import',
    ],
    [
      /from ['"]@judge-copilot\/(llm|prompts|database|auth|safe-http|github|devpost|deployment|video|browser)['"]/,
      'adapter package',
    ],
    [/process\./, 'process access'],
    [/\bfetch\(/, 'network'],
    [/\bDate\b/, 'clock'],
    [/Math\.random\(/, 'randomness'],
    [
      /Math\.(pow|exp|log|log2|log10|sqrt|cbrt|sin|cos|tan|atan|hypot|expm1|log1p)\(/,
      'non-exact math function',
    ],
    [/\*\*/, 'exponentiation operator'],
    [/\beval\s*\(|new Function\s*\(/, 'dynamic code'],
    [/\bimport\(/, 'dynamic import'],
    [/\b(openai|anthropic|gemini|langchain|ollama)\b/i, 'model provider'],
  ];

  it.each(productionFiles.map((file) => [relative(SRC, file), file] as const))(
    '%s',
    (_name, file) => {
      const text = code(file);
      for (const [pattern, label] of forbidden) {
        // The rounding scale is an exact power of ten computed once from an integer constant.
        if (label === 'exponentiation operator' && file.endsWith('canonical.ts')) continue;
        expect(pattern.test(text), `${label}: ${pattern.source}`).toBe(false);
      }
      const builtins = [...text.matchAll(/from ['"](node:[a-z/_]+)['"]/g)].map((m) => m[1]);
      expect(builtins).toEqual([]);
    },
  );

  it('has only the intended workspace dependencies', () => {
    const imports = new Set(
      productionFiles.flatMap((file) =>
        [...code(file).matchAll(/from ['"](@judge-copilot\/[a-z-]+)['"]/g)].map((m) => m[1] ?? ''),
      ),
    );
    expect([...imports].sort()).toEqual([
      '@judge-copilot/context',
      '@judge-copilot/evidence',
      '@judge-copilot/schemas',
    ]);
  });
});

describe('semantic relevance is never claimed', () => {
  it('the report states that relevance is not verified, and no code path computes it', () => {
    const text = productionFiles.map(code).join('\n');
    expect(text).toContain("semanticRelevance: 'not_verified'");
    expect(/relevan(t|ce)\s*(score|check|verified)/i.test(text)).toBe(false);
  });
});
