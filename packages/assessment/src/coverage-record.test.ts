import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { describe, expect, it } from 'vitest';
import { artifactsOf, filler, type RepoFile } from './testing/coverage-repos.js';
import { buildCoverageRecord, verifyCoverageRecord } from './coverage-record.js';
import { buildPassages, SELECTION_POLICY } from './windowing.js';

const files: RepoFile[] = [
  { path: 'README.md', bytes: 2_000 },
  ...Array.from({ length: 30 }, (_, i) => ({
    path: `packages/p${String(i).padStart(2, '0')}/src/index.ts`,
    bytes: 0,
    text: filler(`p${String(i)}`, 9_000),
  })),
];
const windowing = buildPassages(
  artifactsOf({ name: 'x', description: '', files }),
  { statement: 20_000, source: 30_000, metadata: 1_000 },
  SELECTION_POLICY,
);
const built = (snapshots: Parameters<typeof buildCoverageRecord>[0]['snapshots'] = []) =>
  buildCoverageRecord({
    windowing,
    budgets: { statement: 20_000, source: 30_000, metadata: 1_000 },
    snapshots,
    notices: ['sampled_source'],
  });
const stored = (b: ReturnType<typeof built>) => ({
  canonical: b.canonical,
  sha256: b.sha256,
  mirror: JSON.parse(b.canonical) as unknown,
});
const snap = {
  snapshotId: 's1',
  sourceType: 'github' as const,
  status: 'partial' as const,
  contentHash: 'a'.repeat(64),
  provenance: 'fetched' as const,
  partialReasons: ['tree_truncated'],
};

describe('coverage record', () => {
  it('is deterministic, records every inventory artifact and what reached the assessors', () => {
    const a = built([snap]);
    expect(built([snap]).sha256).toBe(a.sha256);
    expect(a.record.artifacts.length).toBe(windowing.coverage.artifacts.length);
    expect(a.record.assessorInputs.limitations.map((l) => l.code)).toContain('partial_capture');
    expect(a.record.relevance).toBe('not_established');
  });

  it('verifies when untouched', () => {
    const b = built([snap]);
    const v = verifyCoverageRecord(stored(b), {
      pinnedSnapshotIds: ['s1'],
      storedLimitations: b.record.assessorInputs.limitations,
    });
    expect(v).toMatchObject({ ok: true, problems: [] });
  });

  it('detects a tampered verdict, an altered hash, a mirror difference, other snapshots, and a limitation missing from the assessment', () => {
    const b = built([snap]);
    const ok = {
      pinnedSnapshotIds: ['s1'],
      storedLimitations: b.record.assessorInputs.limitations,
    };
    const tampered = { ...b.record, verdict: 'complete' as const };
    const canonicalTampered = JSON.stringify(tampered);
    expect(
      verifyCoverageRecord({ canonical: canonicalTampered, sha256: b.sha256, mirror: tampered }, ok)
        .problems,
    ).toContain('record_text_hash_mismatch');
    expect(
      verifyCoverageRecord({ ...stored(b), mirror: { ...b.record, verdict: 'complete' } }, ok)
        .problems,
    ).toContain('record_mirror_differs');
    expect(
      verifyCoverageRecord(stored(b), { ...ok, pinnedSnapshotIds: ['other'] }).problems,
    ).toContain('record_snapshots_mismatch');
    expect(verifyCoverageRecord(stored(b), { ...ok, storedLimitations: [] }).problems).toContain(
      'limitations_missing_from_assessment',
    );
  });

  it('a record whose verdict disagrees with its own entries is inconsistent even when re-hashed consistently', () => {
    const b = built([snap]);
    const forged = { ...b.record, verdict: 'complete' as const, concerns: [] };
    const canonical = canonicalJson(forged);
    const v = verifyCoverageRecord(
      { canonical, sha256: sha256Hex(canonical), mirror: JSON.parse(canonical) as unknown },
      { pinnedSnapshotIds: ['s1'], storedLimitations: null },
    );
    expect(v.ok).toBe(false);
    expect(v.problems).toContain('record_inconsistent');
  });
});
