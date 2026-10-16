import { sha256Hex } from '@judge-copilot/context';
import type { CoverageProblem, CoverageRecord } from '@judge-copilot/schemas';

/*
 * TEST SUPPORT: the eleven forged-record scenarios of the R7E review, as edits to a legitimate record. `reforge` (forge-coverage.ts) then makes
 * each result agree with itself. Used by the unit test (invented foreign ids) and by the database-level test (a real artifact of another project).
 */

export interface ForeignArtifact {
  readonly artifactId: string;
  readonly snapshotId: string;
  readonly key: string;
  readonly textSha256: string;
  readonly totalCodePoints: number;
}
export type Forgery = readonly [
  name: string,
  change: (r: CoverageRecord) => void,
  expected: readonly CoverageProblem[],
];

type Entry = CoverageRecord['artifacts'][number];
const firstWhere = (r: CoverageRecord, f: (a: Entry) => boolean): Entry => {
  const found = r.artifacts.find(f);
  if (!found) throw new Error('the base record has no artifact of the needed kind');
  return found;
};
export const unseenImplementation = (a: Entry): boolean =>
  a.role === 'implementation' && a.status === 'unseen';
export const partiallyShown = (a: Entry): boolean =>
  a.status === 'partial' && a.shownCodePoints > 0;

const claimShownInFull = (e: Entry): void => {
  e.status = 'full';
  e.shownCodePoints = e.totalCodePoints;
  e.shownEnd = e.totalCodePoints;
  e.passagesShown = Math.max(1, Math.ceil(e.totalCodePoints / 1_200));
  e.unshown = [];
};

export function forgeries(base: CoverageRecord, foreign: ForeignArtifact): Forgery[] {
  const unseen = firstWhere(base, unseenImplementation);
  const partial = firstWhere(base, partiallyShown);
  return [
    [
      '1 forged complete verdict (every entry rewritten as fully inspected)',
      (r) => {
        for (const e of r.artifacts) claimShownInFull(e);
      },
      ['provenance_selection_mismatch'],
    ],
    [
      '2 partial capture substituted by captured',
      (r) => {
        for (const s of r.snapshots) {
          s.status = 'captured';
          s.partialReasons = [];
        }
      },
      ['provenance_snapshot_mismatch'],
    ],
    [
      '3 twenty invented, fully inspected artifacts',
      (r) => {
        const template = firstWhere(r, (e) => e.role === 'implementation');
        for (let i = 0; i < 20; i += 1) {
          r.artifacts.push({
            ...template,
            artifactId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
            key: `files/packages/invented-${String(i)}/src/index.ts`,
            component: `packages/invented-${String(i)}`,
            textSha256: sha256Hex(`invented-${String(i)}`),
          });
          claimShownInFull(r.artifacts[r.artifacts.length - 1] as Entry);
        }
      },
      ['provenance_artifact_mismatch'],
    ],
    [
      '4 correct artifact ids, false hashes',
      (r) => {
        for (const e of r.artifacts.slice(0, 5)) e.textSha256 = sha256Hex(`forged:${e.artifactId}`);
      },
      ['provenance_artifact_mismatch'],
    ],
    [
      '5 correct hashes, false lengths',
      (r) => {
        for (const e of r.artifacts.slice(0, 5)) {
          e.totalCodePoints += 1_000;
          e.shownEnd = Math.min(e.shownEnd, e.totalCodePoints);
        }
      },
      ['provenance_artifact_mismatch'],
    ],
    [
      '6 forged shown ranges (an unseen implementation file claimed as shown in full)',
      (r) => {
        claimShownInFull(firstWhere(r, (x) => x.artifactId === unseen.artifactId));
      },
      ['provenance_selection_mismatch'],
    ],
    [
      '7 forged omitted ranges (what was not shown is shifted)',
      (r) => {
        const e = firstWhere(r, (x) => x.artifactId === partial.artifactId);
        e.unshown = [[Math.max(0, e.shownEnd - 100), e.totalCodePoints]];
      },
      ['provenance_selection_mismatch'],
    ],
    [
      '8 cross-project artifact substitution (an artifact of another project in place of a pinned one)',
      (r) => {
        const e = firstWhere(r, (x) => x.artifactId === unseen.artifactId);
        e.artifactId = foreign.artifactId;
        e.snapshotId = foreign.snapshotId;
        e.key = foreign.key;
        e.textSha256 = foreign.textSha256;
        e.totalCodePoints = foreign.totalCodePoints;
        e.shownEnd = 0;
        e.unshown = [[0, foreign.totalCodePoints]];
      },
      ['provenance_artifact_mismatch'],
    ],
    [
      '9 correct snapshot id, false provenance (organizer-supplied or fetched claimed the other way)',
      (r) => {
        for (const s of r.snapshots)
          s.provenance = s.provenance === 'fetched' ? 'organizer_supplied' : 'fetched';
      },
      ['provenance_snapshot_mismatch'],
    ],
    [
      '10 changed selected passage count',
      (r) => {
        firstWhere(r, (x) => x.artifactId === partial.artifactId).passagesShown += 3;
      },
      ['provenance_selection_mismatch'],
    ],
    [
      '11 false measures that follow from forged documentation entries',
      (r) => {
        for (const e of r.artifacts.filter((x) => x.bucket === 'statement')) claimShownInFull(e);
      },
      ['provenance_selection_mismatch'],
    ],
  ];
}
