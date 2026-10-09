/*
 * M5 P3: source-routing/v1 must decide EVERY artifact key the M2 adapters can produce. The adapters are Layer 3 and the assessment
 * package is Layer 2, so this contract is checked here (a source scan of the adapters, plus the routing table itself). If an adapter
 * starts emitting a key the table does not decide, this test fails and the table must be extended deliberately.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeArtifact, type RoutedSourceType } from '../../packages/assessment/src/index.js';

const ROOT = resolve(import.meta.dirname, '../..');
const ADAPTERS: Record<RoutedSourceType, string> = {
  devpost: 'packages/devpost/src/adapter.ts',
  github: 'packages/github/src/adapter.ts',
  deployment: 'packages/deployment/src/adapter.ts',
  video: 'packages/video/src/adapter.ts',
};

interface Emission {
  readonly key: string;
  readonly kind: string;
  readonly template: boolean;
}

/** `textArtifact('key', 'kind', ...)`, `jsonArtifact('key', 'kind', ...)`, including template-literal keys such as `files/${path}`. */
function emissions(source: string): Emission[] {
  const found: Emission[] = [];
  const pattern = /(?:textArtifact|jsonArtifact)\(\s*(['`])([^'`]+)\1\s*,\s*'([a-z_]+)'/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[2] ?? '';
    found.push({ key, kind: match[3] ?? '', template: match[1] === '`' && key.includes('${') });
  }
  return found;
}

describe('source routing covers the artifacts the M2 adapters actually produce', () => {
  for (const [sourceType, file] of Object.entries(ADAPTERS) as [RoutedSourceType, string][]) {
    it(`${sourceType}: every emitted key has an explicit routing decision`, () => {
      const found = emissions(readFileSync(resolve(ROOT, file), 'utf8'));
      expect(found.length).toBeGreaterThan(0);
      for (const emission of found) {
        // a template key is the repository file family: probe it with a concrete example path
        const key = emission.template
          ? emission.key.replace(/\$\{[^}]+\}/, 'src/example.ts')
          : emission.key;
        const decision = routeArtifact({
          sourceType,
          key,
          kind: emission.kind,
          mediaType: 'text/plain',
        });
        // decided: routed, or skipped for a DOCUMENTED reason (never the fail-closed fallback for an unknown artifact)
        expect(
          decision.route === 'skip' && decision.reason === 'unrecognized_artifact',
          `${sourceType} ${emission.key}`,
        ).toBe(false);
      }
    });
  }

  it('routes or deliberately skips each key, and the skipped ones are exactly the documented set', () => {
    const skipped: string[] = [];
    for (const [sourceType, file] of Object.entries(ADAPTERS) as [RoutedSourceType, string][]) {
      for (const emission of emissions(readFileSync(resolve(ROOT, file), 'utf8'))) {
        const key = emission.template
          ? emission.key.replace(/\$\{[^}]+\}/, 'src/example.ts')
          : emission.key;
        const decision = routeArtifact({
          sourceType,
          key,
          kind: emission.kind,
          mediaType: 'text/plain',
        });
        if (decision.route === 'skip')
          skipped.push(`${sourceType}:${emission.key}:${decision.reason}`);
      }
    }
    expect(skipped.sort()).toEqual([
      'devpost:submission.json:duplicate_structured_form',
      'github:commits.json:commit_history_not_routed',
      'github:omissions.json:code_authored_source_gap',
      'github:tree.json:listing_only',
    ]);
  });

  it('the scan found the artifact keys the design assumed (risk U8 verified against M2)', () => {
    const keys = new Set<string>();
    for (const [sourceType, file] of Object.entries(ADAPTERS)) {
      for (const emission of emissions(readFileSync(resolve(ROOT, file), 'utf8')))
        keys.add(`${sourceType}:${emission.key}`);
    }
    for (const expected of [
      'devpost:submission.json',
      'devpost:submission.txt',
      'github:repository.json',
      'github:commits.json',
      'github:tree.json',
      'github:omissions.json',
      'github:files/${entry.path}',
      'deployment:response.json',
      'deployment:page.txt',
      'deployment:page.json',
      'video:metadata.json',
    ]) {
      expect(keys.has(expected), expected).toBe(true);
    }
  });
});
