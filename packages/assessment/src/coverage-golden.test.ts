import { describe, expect, it } from 'vitest';
import { checkCoverageIdentity, recomputeCoverage } from './coverage-provenance.js';
import { filler } from './testing/coverage-repos.js';
import { makeWorld, type WorldFile } from './testing/provenance-world.js';

/*
 * P6B-beta3-R2: a released selection policy is FROZEN. Records written under it are verified by recomputation, so a change to what v1, v2 or v3
 * select would make every stored record of that policy fail verification. These hashes pin the canonical coverage record of a fixed repository under
 * each policy; if one changes, the policy's behaviour changed and it needs a new id (and a new golden value), not a silent edit.
 */
const GOLDEN: Record<string, { sha256: string; verdict: string }> = {
  'source-selection/v1': {
    sha256: '122d635ba5ae0ce01f371494651e5271ee9440cb9dd988710d5d7a8472754d1e',
    verdict: 'insufficient',
  },
  'source-selection/v2': {
    sha256: '25181346d839ad3b55e541f995b65d90284043b998cc56904c3f9c46dcae2723',
    verdict: 'partial',
  },
  'source-selection/v3': {
    sha256: '0c790635a3e00eb8fb5499b9227f76da8882d4371fd2336fa8db70b4cdb11733',
    verdict: 'partial',
  },
};

const files: WorldFile[] = [
  { sourceType: 'github', key: 'files/README.md', text: filler('README.md', 4_000) },
  {
    sourceType: 'github',
    key: 'files/docs/architecture.md',
    text: filler('docs/architecture.md', 6_000),
  },
  ...Array.from({ length: 12 }, (_, i) => ({
    sourceType: 'github' as const,
    key: `files/packages/p${String(i).padStart(2, '0')}/src/index.ts`,
    text: filler(`p${String(i)}`, 6_000),
  })),
  {
    sourceType: 'devpost',
    key: 'submission.json',
    text: filler('submission.json', 3_000),
    mediaType: 'application/json',
  },
];

describe('frozen selection policies', () => {
  it.each(Object.keys(GOLDEN))(
    '%s writes the pinned record and that record verifies by recomputation',
    (selection) => {
      const world = makeWorld(files, {
        selection: selection as 'source-selection/v1',
        baseBudgets: { source: 30_000 },
        partial: ['github'],
      });
      expect(world.built.sha256).toBe(GOLDEN[selection]?.sha256);
      expect(world.record.verdict).toBe(GOLDEN[selection]?.verdict);
      expect(checkCoverageIdentity(world.record, world.evidence).problems).toEqual([]);
      expect(
        recomputeCoverage(world.record, { evidence: world.evidence, artifacts: world.texts })
          .problems,
      ).toEqual([]);
    },
  );

  it('the three policies write three different records for the same source (so the policy id is part of what is verified)', () => {
    expect(new Set(Object.values(GOLDEN).map((g) => g.sha256)).size).toBe(3);
  });
});
