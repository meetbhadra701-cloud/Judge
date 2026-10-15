import { describe, expect, it } from 'vitest';
import { artifactsOf, filler, type RepoFile } from './testing/coverage-repos.js';
import { buildCoverageReport, type ArtifactCoverage } from './coverage.js';
import { buildPassages, SELECTION_POLICY } from './windowing.js';

/*
 * P6B-beta3-R1 (R7D finding 1): a byte-identical copy is INSPECTED only through a twin that is of the same role AND was actually shown. The
 * inventory keeps the copy either way; what changes is whether it may be counted as examined.
 */

const same = filler('shared', 3_000);
const distinct = (n: number): RepoFile[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `packages/d${String(i).padStart(3, '0')}/src/index.ts`,
    bytes: 3_000,
  }));
const run = (files: RepoFile[], source: number) =>
  buildPassages(
    artifactsOf({ name: 'x', description: '', files }),
    { statement: 6_000, source, metadata: 1_000 },
    SELECTION_POLICY,
  );

describe('which byte-identical copies count as inspected', () => {
  // two copies, each in a component of its own, among many distinct components and a budget that shows only a few files
  const files: RepoFile[] = [
    { path: 'README.md', bytes: 800 },
    { path: 'packages/copy-a/src/index.ts', bytes: 0, text: same },
    { path: 'packages/copy-b/src/index.ts', bytes: 0, text: same },
    ...distinct(40),
  ];

  it('a copy whose twin was never shown is unseen, not represented (so it cannot raise the inspected share)', () => {
    const r = run(files, 7_200);
    const byKey = new Map(r.coverage.artifacts.map((a) => [a.artifactKey, a] as const));
    const copy = r.coverage.artifacts.find((a) => a.status === 'duplicate');
    expect(copy).toBeDefined();
    const twin = byKey.get(copy?.duplicateOf ?? '');
    // precondition of this test: the twin is among the files the budget did not reach
    expect(twin?.shownCodePoints).toBe(0);
    expect(copy).toMatchObject({ represented: false, representedCodePoints: 0 });
    expect(r.coverage.concerns).toContain('duplicates_not_represented');
    const impl = r.coverage.measures.implementation;
    expect(impl.filesRepresented).toBe(0);
    const component = r.coverage.components.find((c) => c.component === copy?.component);
    expect(component?.implementationFilesRepresented).toBe(0);
    expect(component?.implementationCodePointsRepresented).toBe(0);
    expect(impl.filesUnseen).toBe(impl.files - impl.filesShown);
  });

  it('a copy whose twin was shown is represented, with exactly the twin’s shown volume (bounded by its own size)', () => {
    const r = run(files, 60_000);
    const copy = r.coverage.artifacts.find((a) => a.status === 'duplicate');
    const twin = r.coverage.artifacts.find((a) => a.artifactKey === copy?.duplicateOf);
    expect(twin?.shownCodePoints).toBeGreaterThan(0);
    expect(copy).toMatchObject({ represented: true });
    expect(copy?.representedCodePoints).toBe(
      Math.min(twin?.shownCodePoints ?? 0, copy?.totalCodePoints ?? 0),
    );
  });

  it('a copy is never represented by a twin of another role, even when that twin was shown', () => {
    const r = run(
      [
        { path: 'README.md', bytes: 800 },
        { path: 'test/index.ts', bytes: 0, text: same },
        { path: 'packages/a/src/index.ts', bytes: 0, text: same },
      ],
      60_000,
    );
    expect(r.coverage.artifacts.filter((a) => a.status === 'duplicate')).toEqual([]);
    expect(r.coverage.measures.implementation.filesShown).toBe(1);
  });
});

describe('the dominant-component gate is independent of the other gates', () => {
  // The selection visits large components early, so this state is built from entries directly: the gate is a property of the REPORT, whatever produced it.
  const entry = (component: string, total: number, shown: number): ArtifactCoverage => ({
    snapshotId: 's',
    artifactId: component,
    artifactKey: `files/${component}/src/index.ts`,
    sourceType: 'github',
    bucket: 'source',
    role: 'implementation',
    component,
    category: null,
    status: shown === 0 ? 'unseen' : shown >= total ? 'full' : 'partial',
    totalCodePoints: total,
    shownCodePoints: shown,
    passagesShown: shown === 0 ? 0 : 1,
    shownEnd: shown,
    shownRanges: shown === 0 ? [] : [{ start: 0, end: shown }],
    unshownRanges: shown >= total ? [] : [{ start: shown, end: total }],
    textSha256: 'a'.repeat(64),
    duplicateOf: null,
    represented: false,
    representedCodePoints: 0,
  });
  it('a component holding at least a quarter of the code that nothing of was inspected makes the verdict insufficient, although most components and most code are inspected', () => {
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => entry(`packages/s${String(i)}`, 5_000, 5_000)),
      entry('packages/huge', 30_000, 0),
    ];
    const r = buildCoverageReport(entries, SELECTION_POLICY);
    expect(r.measures.implementation.inspectedShare).toBeGreaterThan(0.5);
    expect(r.measures.components.meaningfulWithShownFile).toBe(10);
    expect(r.concerns).toContain('dominant_component_unseen');
    expect(r.concerns).not.toContain('largest_components_unseen');
    expect(r.verdict).toBe('insufficient');
  });
  it('the same repository with the huge component partly inspected is not insufficient', () => {
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => entry(`packages/s${String(i)}`, 5_000, 5_000)),
      entry('packages/huge', 30_000, 1_200),
    ];
    const r = buildCoverageReport(entries, SELECTION_POLICY);
    expect(r.concerns).not.toContain('dominant_component_unseen');
    expect(r.verdict).toBe('partial');
  });
});

describe('documentation categories have pools of their own', () => {
  const md = (path: string, lines: number): RepoFile => ({
    path,
    bytes: 0,
    text: filler(path, lines * 100),
  });
  it('a flood of key documents cannot spend the package READMEs’ share', () => {
    const files: RepoFile[] = [
      { path: 'packages/p/src/index.ts', bytes: 3_000 },
      md('packages/p/README.md', 30),
      ...Array.from({ length: 200 }, (_, i) =>
        md(`docs/architecture/a${String(i).padStart(3, '0')}.md`, 30),
      ),
    ];
    const r = buildPassages(
      artifactsOf({ name: 'x', description: '', files }),
      { statement: 40_000, source: 6_000, metadata: 1_000 },
      SELECTION_POLICY,
    );
    const readme = r.coverage.artifacts.find((a) => a.artifactKey === 'files/packages/p/README.md');
    expect(readme?.category).toBe('package_readme');
    expect(readme?.shownCodePoints).toBeGreaterThan(0);
  });
});
