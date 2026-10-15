import { describe, expect, it } from 'vitest';
import { artifactsOf, filler, type RepoFile } from './testing/coverage-repos.js';
import { nameHash } from './repository-roles.js';
import { COVERAGE_POLICY } from './coverage.js';
import { collectLimitations } from './limitations.js';
import {
  buildPassages,
  DEFAULT_BUDGETS,
  SELECTION_POLICY,
  type WindowingResult,
} from './windowing.js';

/*
 * P6B-beta3-R1 (R7D findings 1, 2, 5, 6): the coverage gate against files arranged to mislead it. These tests state what the report may and may
 * not claim; none of them asserts that a model understood anything: `relevance` is always `not_established`, and the verdicts are heuristics over
 * path-derived metadata. Each scenario was reproduced against the previous implementation (docs/milestones/P6B_BETA3_R1_REMEDIATION_REPORT.md).
 */

const run = (files: RepoFile[], budgets = DEFAULT_BUDGETS): WindowingResult =>
  buildPassages(artifactsOf({ name: 'x', description: '', files }), budgets, SELECTION_POLICY);
const impl = (r: WindowingResult) => r.coverage.measures.implementation;
const entry = (r: WindowingResult, key: string) => {
  const found = r.coverage.artifacts.find((a) => a.artifactKey === `files/${key}`);
  if (!found) throw new Error(`no coverage entry for ${key}`);
  return found;
};
const pad = (n: number, width = 3): string => String(n).padStart(width, '0');

describe('inventory versus deduplicated consumption (finding 1)', () => {
  const same = filler('boilerplate', 3_000);
  const copies: RepoFile[] = Array.from({ length: 100 }, (_, i) => ({
    path: `packages/pkg-${pad(i)}/src/index.ts`,
    bytes: 0,
    text: same,
  }));

  it('a test file that happens to be byte-identical does not stand in for the implementation files, and the verdict is not "complete"', () => {
    const r = run([
      { path: 'README.md', bytes: 2_000 },
      { path: 'test/index.ts', bytes: 0, text: same },
      ...copies,
    ]);
    expect(entry(r, 'test/index.ts').role).toBe('test');
    // implementation copies are duplicates of EACH OTHER (same role), never of the test file
    const dup = r.coverage.artifacts.filter((a) => a.status === 'duplicate');
    expect(dup.length).toBe(99);
    expect(
      dup.every((a) => a.role === 'implementation' && a.duplicateOf?.startsWith('files/packages/')),
    ).toBe(true);
    // the inventory keeps all 100 implementation files and their full volume
    expect(impl(r).files).toBe(100);
    expect(impl(r).codePoints).toBe(300_000);
    expect(impl(r).filesShown).toBe(1);
    expect(impl(r).filesRepresented).toBe(99);
    expect(r.coverage.measures.components.total).toBe(100);
    expect(r.coverage.verdict).not.toBe('insufficient'); // identical bytes of the same role WERE inspected, once
  });

  it('identical implementation files whose only same-role twin is NOT shown are not counted as inspected', () => {
    const other = Array.from({ length: 30 }, (_, i) => ({
      path: `packages/big-${pad(i)}/src/main.ts`,
      bytes: 40_000,
    }));
    // 5 copies of a file under a path that sorts last; the budget is spent on the other components first
    const r = run(
      [
        ...other,
        ...Array.from({ length: 5 }, (_, i) => ({
          path: `zz/c${i}/src/index.ts`,
          bytes: 0,
          text: same,
        })),
      ],
      {
        statement: 1_000,
        source: 30_000,
        metadata: 1_000,
      },
    );
    const copiesCoverage = r.coverage.artifacts.filter((a) =>
      a.artifactKey.startsWith('files/zz/'),
    );
    for (const c of copiesCoverage) {
      if (c.status === 'duplicate')
        expect(c.represented).toBe(
          c.shownCodePoints > 0 || entry(r, c.duplicateOf?.slice(6) ?? '').shownCodePoints > 0,
        );
    }
    const unrepresented = copiesCoverage.filter(
      (c) => c.status !== 'full' && !c.represented && c.shownCodePoints === 0,
    );
    expect(unrepresented.length).toBe(
      copiesCoverage.filter((c) => c.shownCodePoints === 0 && !c.represented).length,
    );
    // whatever was not inspected is in the denominator: shown + represented + unseen = total
    const m = impl(r);
    expect(m.codePointsShown + m.codePointsRepresented + m.codePointsUnseen).toBe(m.codePoints);
  });

  it('copies placed under generated directories are generated, not implementation, and cannot make implementation look inspected', () => {
    const real = Array.from({ length: 4 }, (_, i) => ({
      path: `packages/core-${i}/src/engine.ts`,
      bytes: 80_000,
    }));
    const r = run(
      [...real, { path: 'generated/engine-copy.ts', bytes: 0, text: filler('x', 5_000) }],
      { statement: 1_000, source: 12_000, metadata: 1_000 },
    );
    expect(entry(r, 'generated/engine-copy.ts').role).toBe('generated');
    expect(impl(r).files).toBe(4);
  });

  it('the inventory accounts for every eligible artifact exactly once', () => {
    const r = run([{ path: 'README.md', bytes: 2_000 }, ...copies]);
    const files = r.coverage.artifacts.filter((a) => a.artifactKey.startsWith('files/'));
    expect(files.length).toBe(1 + 100);
    expect(r.coverage.measures.fileRepresentation.eligibleFiles).toBe(r.coverage.artifacts.length);
    const f = r.coverage.measures.fileRepresentation;
    expect(f.withShownPassage + f.representedByTwin + f.unseen).toBe(f.eligibleFiles);
  });
});

describe('component proliferation (findings 2 and 5)', () => {
  const real = (n: number, bytes = 5_000): RepoFile[] =>
    Array.from({ length: n }, (_, i) => ({ path: `packages/real-${pad(i)}/src/main.ts`, bytes }));
  const junk = (n: number): RepoFile[] =>
    Array.from({ length: n }, (_, i) => ({
      path: `packages/junk-${pad(i, 4)}/src/index.ts`,
      bytes: 0,
      text: `export const j${i} = ${i};\n// stub ${'x'.repeat(30)}${i}`,
    }));

  it('thousands of tiny components do not push meaningful components out, and do not turn an insufficient verdict into a reassuring one', () => {
    const base = run(real(600));
    const diluted = run([...real(600), ...junk(1_500)]);
    const seenReal = (r: WindowingResult) =>
      r.coverage.artifacts.filter((a) => a.artifactKey.includes('/real-') && a.shownCodePoints > 0)
        .length;
    expect(seenReal(diluted)).toBe(seenReal(base)); // stubs are visited after every meaningful component
    expect(base.coverage.verdict).toBe('insufficient');
    expect(diluted.coverage.verdict).toBe('insufficient');
    expect(diluted.coverage.measures.components.stubs).toBe(1_500);
    expect(diluted.coverage.measures.components.meaningful).toBe(600);
    expect(diluted.coverage.concerns).toContain('component_flood');
    expect(impl(diluted).inspectedShare).toBeLessThan(COVERAGE_POLICY.mostlyUnseenBelowShare);
  });

  it('a project whose largest components are wholly unseen cannot be called partial because small ones were inspected', () => {
    // five large real components cut out by 300 smaller (but meaningful) ones whose names are ground to sort first
    const realFiles: RepoFile[] = Array.from({ length: 5 }, (_, i) => ({
      path: `packages/realcore${i}/src/main.ts`,
      bytes: 6_000,
    }));
    const lowest = Math.min(
      ...realFiles.map((f) => nameHash(f.path.split('/').slice(0, 2).join('/'))),
    );
    const names: string[] = [];
    for (let i = 0; names.length < 300 && i < 400_000; i += 1) {
      const n = `packages/zz${i}`;
      if (nameHash(n) < lowest) names.push(n);
    }
    expect(names.length).toBe(300);
    const r = run([
      ...realFiles,
      ...names.map((n) => ({ path: `${n}/src/index.ts`, bytes: 1_200 })),
    ]);
    // the order IS predictable (a public function of the name) and the ground names did displace the real components:
    expect(realFiles.every((f) => entry(r, f.path).shownCodePoints === 0)).toBe(true);
    // ... but the report cannot be steered into reassurance: the largest components are unseen, so the gate refuses, and they are named first
    expect(r.coverage.concerns).toContain('largest_components_unseen');
    expect(r.coverage.verdict).toBe('insufficient');
    const limitation = collectLimitations({ windowing: r }).find(
      (l) => l.code === 'implementation_components_unseen',
    );
    expect(limitation?.subjects.slice(0, 5).every((s) => s.startsWith('packages/realcore'))).toBe(
      true,
    );
  });

  it('flooding one root with components does not starve the components of the other roots', () => {
    const apps = Array.from({ length: 5 }, (_, i) => ({
      path: `apps/app-${i}/src/main.ts`,
      bytes: 6_000,
    }));
    const flood = Array.from({ length: 400 }, (_, i) => ({
      path: `packages/flood-${pad(i)}/src/index.ts`,
      bytes: 3_000,
    }));
    const r = run([...flood, ...apps]);
    expect(apps.every((f) => entry(r, f.path).shownCodePoints > 0)).toBe(true);
  });

  it('renaming components cannot change the totals the report states', () => {
    const volumes = [90_000, 70_000, 40_000, 20_000, 8_000, 3_000];
    const build = (prefix: string) =>
      volumes.map((bytes, i) => ({ path: `packages/${prefix}${i}/src/main.ts`, bytes }));
    const totals = ['alpha', 'zeta', 'q9', 'AAA', 'mm'].map((prefix) =>
      impl(run(build(prefix), { statement: 1_000, source: 60_000, metadata: 1_000 })),
    );
    for (const m of totals) {
      expect(m.codePoints).toBe(totals[0]?.codePoints);
      expect(m.codePointsShown + m.codePointsRepresented + m.codePointsUnseen).toBe(m.codePoints);
    }
  });

  it('a large generated-looking tree is reported as generated volume, not as implementation coverage', () => {
    const r = run([
      { path: 'src/index.ts', bytes: 20_000 },
      ...Array.from({ length: 30 }, (_, i) => ({
        path: `generated/part-${pad(i)}.ts`,
        bytes: 20_000,
      })),
    ]);
    expect(r.coverage.measures.generatedShareOfSourceInventory).toBeGreaterThan(0.9);
    expect(r.coverage.concerns).toContain('generated_volume_large');
    expect(impl(r).files).toBe(1);
  });
});

describe('a huge core hidden beyond the file heads (the gate does not claim understanding)', () => {
  it('states the inspected share exactly, and refuses when almost none of the implementation was inspected', () => {
    const small = run([
      { path: 'src/core.ts', bytes: 30_000 },
      { path: 'src/util.ts', bytes: 3_000 },
    ]);
    expect(small.coverage.verdict).toBe('complete'); // everything fits: all of it was inspected
    const huge = run([
      { path: 'src/core.ts', bytes: 3_000_000 },
      { path: 'src/util.ts', bytes: 3_000 },
    ]);
    expect(impl(huge).inspectedShare).toBeLessThan(
      COVERAGE_POLICY.insufficientBelowInspectedShare + 0.1,
    );
    const huger = run([
      { path: 'src/core.ts', bytes: 9_000_000 },
      { path: 'src/util.ts', bytes: 3_000 },
    ]);
    expect(huger.coverage.verdict).toBe('insufficient');
    for (const r of [small, huge, huger]) expect(r.coverage.relevance).toBe('not_established');
  });
});

describe('documentation floods (finding 6)', () => {
  const flood: RepoFile[] = [
    { path: 'README.md', bytes: 6_000 },
    { path: 'docs/zz-architecture.md', bytes: 20_000 },
    { path: 'docs/zz-security-model.md', bytes: 20_000 },
    ...Array.from({ length: 300 }, (_, i) => ({
      path: `packages/p${pad(i)}/README.md`,
      bytes: 3_000,
    })),
    ...Array.from({ length: 300 }, (_, i) => ({ path: `docs/notes/n${pad(i)}.md`, bytes: 3_000 })),
    { path: 'src/index.ts', bytes: 4_000 },
  ];

  it('300 package READMEs and 300 note files cannot starve the architecture and security-model documents or the root README', () => {
    const r = run(flood);
    expect(entry(r, 'docs/zz-architecture.md').shownCodePoints).toBeGreaterThan(0);
    expect(entry(r, 'docs/zz-security-model.md').shownCodePoints).toBeGreaterThan(0);
    expect(entry(r, 'README.md').shownCodePoints).toBeGreaterThanOrEqual(6_000);
  });

  it('reports documentation coverage by category, honestly', () => {
    const r = run(flood);
    const byCategory = Object.fromEntries(
      r.coverage.measures.documentation.map((c) => [c.category, c]),
    );
    expect(byCategory['root_readme']).toMatchObject({ files: 1, filesShown: 1 });
    expect(byCategory['key_docs']?.files).toBe(2);
    expect(byCategory['key_docs']?.filesShown).toBe(2);
    expect(byCategory['package_readme']?.files).toBe(300);
    expect(byCategory['package_readme']?.filesShown).toBeLessThan(300); // not every document can be inspected within the budget, and it says so
    expect(r.coverage.concerns).toContain('documentation_partially_seen');
  });

  it('a category that received nothing is named', () => {
    const r = run(
      [
        { path: 'README.md', bytes: 1_000 },
        { path: 'docs/architecture/overview.md', bytes: 5_000 },
        { path: 'src/index.ts', bytes: 2_000 },
      ],
      { statement: 1_200, source: 10_000, metadata: 1_000 },
    );
    expect(
      r.coverage.concerns.some(
        (c) => c === 'documentation_partially_seen' || c === 'documentation_category_unseen',
      ),
    ).toBe(true);
  });

  it('documentation that contradicts the implementation does not change which implementation is inspected', () => {
    const files: RepoFile[] = [
      {
        path: 'README.md',
        bytes: 3_000,
        text: `${'This project has no authentication and never stores passwords.\n'.repeat(60)}`,
      },
      {
        path: 'docs/architecture.md',
        bytes: 4_000,
        text: `${'The auth module stores salted password hashes.\n'.repeat(80)}`,
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        path: `packages/mod-${i}/src/index.ts`,
        bytes: 9_000,
      })),
    ];
    const withDocs = run(files);
    const without = run(files.filter((f) => f.path.endsWith('.ts')));
    const shownImpl = (r: WindowingResult) =>
      r.coverage.artifacts
        .filter((a) => a.role === 'implementation')
        .map((a) => [a.artifactKey, a.shownCodePoints]);
    expect(shownImpl(withDocs)).toEqual(shownImpl(without));
  });
});
