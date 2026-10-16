import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type { CoverageProblem, CoverageRecord } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { checkCoverageIdentity, recomputeCoverage } from './coverage-provenance.js';
import { verifyCoverageRecord } from './coverage-record.js';
import { filler } from './testing/coverage-repos.js';
import { reforge } from './testing/forge-coverage.js';
import { forgeries as forgeriesFor } from './testing/forgeries.js';
import {
  makeWorld,
  OTHER_PROJECT_ID,
  uuidOf,
  type World,
  type WorldFile,
  type WorldOptions,
} from './testing/provenance-world.js';

/*
 * P6B-beta3-R2 (P2): a self-consistent coverage record is not proof that it describes the actual source. These tests build trusted evidence
 * and the record the pipeline would write, then FORGE records the way an actor with write access to the table could: every forgery below is
 * rewritten so that it agrees with itself (entries, measures, verdict, concerns, limitations, hash, mirror) and with the run's pinned snapshot
 * ids -- which is all the R1 implementation checked. `oldAccepts` replays exactly that check; `newAccepts` is the repaired verification.
 */

const repo = (n = 30, docsFlood = true): WorldFile[] => [
  { sourceType: 'github', key: 'files/README.md', text: filler('README.md', 4_000) },
  {
    sourceType: 'github',
    key: 'files/docs/architecture.md',
    text: filler('docs/architecture.md', 6_000),
  },
  ...Array.from({ length: n }, (_, i) => ({
    sourceType: 'github' as const,
    key: `files/packages/p${String(i).padStart(2, '0')}/src/index.ts`,
    text: filler(`p${String(i)}`, 6_000),
  })),
  ...Array.from({ length: docsFlood ? 40 : 0 }, (_, i) => ({
    sourceType: 'github' as const,
    key: `files/docs/notes/n${String(i).padStart(2, '0')}.md`,
    text: filler(`docs/notes/n${String(i)}.md`, 6_000),
    mediaType: 'text/markdown',
  })),
  {
    sourceType: 'devpost',
    key: 'submission.json',
    text: filler('submission.json', 3_000),
    mediaType: 'application/json',
  },
];
const TIGHT = { baseBudgets: { source: 12_000 } };

/** The R1 implementation: the record agrees with itself, the pinned snapshot ids and the stored limitations. */
function oldAccepts(world: World, record: CoverageRecord): boolean {
  const canonical = canonicalJson(record);
  return verifyCoverageRecord(
    { canonical, sha256: sha256Hex(canonical), mirror: JSON.parse(canonical) as unknown },
    {
      pinnedSnapshotIds: world.evidence.pins.map((p) => p.snapshotId),
      storedLimitations: record.assessorInputs.limitations,
    },
  ).ok;
}
/** The repaired verification: internal integrity AND recomputation from the trusted evidence. */
function newVerdict(
  world: World,
  record: CoverageRecord,
  evidence = world.evidence,
): { accepted: boolean; problems: CoverageProblem[] } {
  const canonical = canonicalJson(record);
  const internal = verifyCoverageRecord(
    { canonical, sha256: sha256Hex(canonical), mirror: JSON.parse(canonical) as unknown },
    {
      pinnedSnapshotIds: evidence.pins.map((p) => p.snapshotId),
      storedLimitations: record.assessorInputs.limitations,
    },
  );
  const external = recomputeCoverage(record, { evidence, artifacts: world.texts });
  const problems = [...internal.problems, ...external.problems];
  return { accepted: internal.ok && external.problems.length === 0, problems };
}

describe('legitimate records verify against the evidence they describe', () => {
  const cases: [string, WorldFile[], WorldOptions][] = [
    ['complete: a small project that fits', repo(3, false), {}],
    [
      'partial: a medium project under a limited source budget',
      repo(12),
      { baseBudgets: { source: 40_000 } },
    ],
    ['insufficient: a large project under a tight source budget', repo(), TIGHT],
    [
      'partial capture and an organizer-supplied Devpost page',
      repo(),
      { ...TIGHT, partial: ['github'], suppliedDevpost: true },
    ],
    [
      'a run refused at the gate (no source extraction exists)',
      repo(80),
      { baseBudgets: { source: 2_000 }, noExtraction: true },
    ],
    ['a run on a reduced ladder step (75% of the source budget)', repo(), { ...TIGHT, step: 1 }],
    ['source-selection/v1', repo(), { ...TIGHT, selection: 'source-selection/v1' }],
    ['source-selection/v2', repo(), { ...TIGHT, selection: 'source-selection/v2' }],
    ['source-selection/v3', repo(), { ...TIGHT, selection: 'source-selection/v3' }],
  ];
  it.each(cases)('%s', (_name, files, options) => {
    const world = makeWorld(files, options);
    expect(newVerdict(world, world.record)).toEqual({ accepted: true, problems: [] });
    expect(oldAccepts(world, world.record)).toBe(true);
  });

  it('covers every verdict', () => {
    const verdicts = new Set(
      cases.map(([, files, options]) => makeWorld(files, options).record.verdict),
    );
    expect([...verdicts].sort()).toEqual(['complete', 'insufficient', 'partial']);
  });

  it('reports how the budget was established: pinned by the extraction identity, or only one of the allowed budgets', () => {
    const bound = makeWorld(repo(), TIGHT);
    expect(checkCoverageIdentity(bound.record, bound.evidence).budgetBinding).toBe(
      'pinned_by_extraction',
    );
    const unbound = makeWorld(repo(80), { baseBudgets: { source: 2_000 }, noExtraction: true });
    expect(checkCoverageIdentity(unbound.record, unbound.evidence).budgetBinding).toBe(
      'allowed_set_only',
    );
  });
});

describe('the eleven forged-record scenarios of R7E (each internally consistent)', () => {
  const world = makeWorld(repo(), { ...TIGHT, partial: ['github'], suppliedDevpost: true });
  const base = world.record;
  expect(base.verdict).not.toBe('complete');

  const foreign = {
    artifactId: uuidOf('artifact:other-project'),
    snapshotId: uuidOf('snapshot:other-project'),
    key: 'files/other/README.md',
    textSha256: sha256Hex('other project readme'),
    totalCodePoints: 777,
  };
  const forgeries = forgeriesFor(base, foreign);

  it.each(forgeries)('%s', (_name, change, expected) => {
    const forged = reforge(base, change);
    expect(canonicalJson(forged)).not.toBe(canonicalJson(base));
    // the forgery agrees with itself: the R1 implementation accepts it
    expect(oldAccepts(world, forged)).toBe(true);
    // the repaired verification rejects it, naming the kind of disagreement
    const verdict = newVerdict(world, forged);
    expect(verdict.accepted).toBe(false);
    for (const code of expected) expect(verdict.problems).toContain(code);
  });

  it('every forgery is rejected, and the stage that needs no text already rejects the ones about identity', () => {
    for (const [name, change] of forgeries) {
      const forged = reforge(base, change);
      const identity = checkCoverageIdentity(forged, world.evidence).problems;
      if (/^(2|3|4|5|8|9) /.test(name)) {
        expect(identity.length, name).toBeGreaterThan(0);
      }
    }
  });

  it('a record valid for OTHER evidence is rejected (the same record against another project’s pins and artifacts)', () => {
    const other = makeWorld(repo(10), TIGHT);
    const verdict = newVerdict(world, world.record, {
      ...other.evidence,
      projectId: OTHER_PROJECT_ID,
    });
    expect(verdict.accepted).toBe(false);
  });

  it('a pin whose recorded content hash differs from the pinned one is rejected', () => {
    const tampered = {
      ...world.evidence,
      pins: world.evidence.pins.map((pin, i) =>
        i === 0 ? { ...pin, pinnedContentHash: 'f'.repeat(64) } : pin,
      ),
    };
    expect(newVerdict(world, world.record, tampered).problems).toContain(
      'provenance_snapshot_mismatch',
    );
  });
});

describe('budgets cannot be chosen by the record', () => {
  it('a larger allowed budget than the extraction was made under is rejected when the extraction pins the plan', () => {
    const world = makeWorld(repo(), { ...TIGHT, step: 2 });
    const bigger = makeWorld(repo(), { ...TIGHT, step: 0 });
    const forged = reforge(bigger.record, () => undefined);
    const verdict = newVerdict(world, forged);
    expect(verdict.accepted).toBe(false);
    expect(verdict.problems).toContain('provenance_budget_mismatch');
  });

  it('a budget that is on no ladder step is rejected even without an extraction', () => {
    const world = makeWorld(repo(), { ...TIGHT, noExtraction: true });
    const forged = reforge(world.record, (r) => {
      r.budgets.source += 7;
    });
    expect(newVerdict(world, forged).problems).toContain('provenance_budget_mismatch');
  });

  it('a configuration that no longer parses is "unavailable", never verified', () => {
    const world = makeWorld(repo(3));
    const broken = { ...world.evidence, config: null };
    expect(newVerdict(world, world.record, broken)).toMatchObject({ accepted: false });
    expect(checkCoverageIdentity(world.record, broken).problems).toEqual([
      'provenance_unavailable',
    ]);
  });

  it('a different selection policy in the record than in the frozen configuration is rejected', () => {
    const world = makeWorld(repo(), { ...TIGHT, selection: 'source-selection/v3' });
    const forged = reforge(world.record, (r) => {
      r.policy.selection = 'source-selection/v2';
    });
    expect(newVerdict(world, forged).problems).toContain('provenance_policy_mismatch');
  });
});

const at = <T>(items: T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error('empty list');
  return item;
};

describe('stage 1 alone (no stored text) rejects each kind of identity disagreement on its own', () => {
  const world = makeWorld(repo(), { ...TIGHT, partial: ['github'], suppliedDevpost: true });
  const clone = (): CoverageRecord => JSON.parse(JSON.stringify(world.record)) as CoverageRecord;
  const problemsOf = (change: (r: CoverageRecord) => void): CoverageProblem[] => {
    const record = clone();
    change(record);
    return [...checkCoverageIdentity(record, world.evidence).problems];
  };
  it('accepts the genuine record', () => {
    expect(checkCoverageIdentity(world.record, world.evidence).problems).toEqual([]);
  });

  it.each([
    [
      'a snapshot status',
      (r: CoverageRecord) => {
        at(r.snapshots).status = at(r.snapshots).status === 'partial' ? 'captured' : 'partial';
      },
    ],
    [
      'a snapshot provenance',
      (r: CoverageRecord) => {
        at(r.snapshots).provenance =
          at(r.snapshots).provenance === 'fetched' ? 'organizer_supplied' : 'fetched';
      },
    ],
    [
      'a snapshot content hash',
      (r: CoverageRecord) => {
        at(r.snapshots).contentHash = 'e'.repeat(64);
      },
    ],
    [
      'a snapshot source type',
      (r: CoverageRecord) => {
        at(r.snapshots).sourceType = at(r.snapshots).sourceType === 'github' ? 'devpost' : 'github';
      },
    ],
    [
      'the partial-capture reasons',
      (r: CoverageRecord) => {
        at(r.snapshots).partialReasons = ['tree_truncated', 'file_count_limit'];
      },
    ],
    [
      'a snapshot id that was not pinned',
      (r: CoverageRecord) => {
        at(r.snapshots).snapshotId = uuidOf('not-pinned');
      },
    ],
    [
      'a missing snapshot',
      (r: CoverageRecord) => {
        r.snapshots.pop();
      },
    ],
  ])('%s', (_name, change) => {
    expect(problemsOf(change)).toContain('provenance_snapshot_mismatch');
  });

  it.each([
    [
      'the selection policy',
      (r: CoverageRecord) => {
        r.policy.selection = 'source-selection/v1';
      },
    ],
    [
      'the windowing policy',
      (r: CoverageRecord) => {
        r.policy.windowing = 'windowing/v0';
      },
    ],
    [
      'the routing policy',
      (r: CoverageRecord) => {
        r.policy.routing = 'source-routing/v0';
      },
    ],
  ])('%s', (_name, change) => {
    expect(problemsOf(change)).toContain('provenance_policy_mismatch');
  });

  it.each([
    [
      'an artifact id that does not exist',
      (r: CoverageRecord) => {
        at(r.artifacts).artifactId = uuidOf('ghost');
      },
    ],
    [
      'an artifact key',
      (r: CoverageRecord) => {
        at(r.artifacts).key = 'files/other.ts';
      },
    ],
    [
      'an artifact hash',
      (r: CoverageRecord) => {
        at(r.artifacts).textSha256 = 'd'.repeat(64);
      },
    ],
    [
      'an artifact length',
      (r: CoverageRecord) => {
        at(r.artifacts).totalCodePoints += 1;
      },
    ],
    [
      'an artifact that belongs to an unpinned snapshot',
      (r: CoverageRecord) => {
        at(r.artifacts).snapshotId = uuidOf('not-pinned');
      },
    ],
    [
      'the same artifact listed twice',
      (r: CoverageRecord) => {
        r.artifacts.push({ ...at(r.artifacts) });
      },
    ],
  ])('%s', (_name, change) => {
    expect(problemsOf(change)).toContain('provenance_artifact_mismatch');
  });

  it('a snapshot of another project among the pins is not accepted as this run’s evidence', () => {
    const foreignPin = {
      ...world.evidence,
      pins: world.evidence.pins.map((p, i) =>
        i === 0 ? { ...p, projectId: OTHER_PROJECT_ID } : p,
      ),
    };
    expect(checkCoverageIdentity(world.record, foreignPin).problems).toContain(
      'provenance_snapshot_mismatch',
    );
  });
});
