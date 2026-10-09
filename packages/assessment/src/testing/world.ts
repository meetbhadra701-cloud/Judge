/* Test-only fixtures for the assessment package. Excluded from the build; never exported from the package root. */
import { lockedContentHash } from '@judge-copilot/context';
import type { EventContextDocument, EventContextLockedSnapshot } from '@judge-copilot/schemas';
import type { PlanWorld, SourceArtifact } from '../index.js';

export const uid = (n: number, prefix = '00000000'): string =>
  `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const PROJECT_ID = uid(1, 'a0000001');
export const OTHER_PROJECT_ID = uid(1, 'a0000002');
export const EVENT_ID = uid(1, 'e0000001');
export const VERSION_ID = uid(1, 'c0000001');

export const SNAPSHOT = {
  devpost: uid(1, '50000001'),
  github: uid(2, '50000001'),
  deployment: uid(3, '50000001'),
  video: uid(4, '50000001'),
} as const;

/** A tiny deterministic PRNG (mulberry32) for the seeded property tests. Never `Math.random`. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEVPOST_TEXT = [
  'HydroTrack',
  'Track your water intake without thinking about it.',
  '',
  'Inspiration',
  'We noticed that students forget to drink water during long study sessions.',
  '',
  'What it does',
  'HydroTrack sends a reminder every two hours and stores each intake entry in SQLite.',
  'It works offline and never sends your data to a server.',
  '',
].join('\n');

export const README_TEXT = [
  '# HydroTrack',
  '',
  'HydroTrack is a small command line tool for tracking water intake.',
  '',
  '## Usage',
  'Run `hydro add 250` to record a glass of water.',
  '',
].join('\n');

export const CODE_TEXT = [
  "import { db } from './db.js';",
  '',
  'export function addIntake(amount: number): void {',
  "  if (amount <= 0) throw new RangeError('amount must be positive');",
  '  db.insert({ amount, at: Date.now() });',
  '}',
  '',
].join('\n');

export const PAGE_TEXT = 'HydroTrack - track your water.\nSign in to see your history.\n';

export const RESPONSE_JSON =
  '{\n  "finalUrl": "https://hydrotrack.example/",\n  "status": 200\n}\n';

export function artifact(
  overrides: Partial<SourceArtifact> & Pick<SourceArtifact, 'key' | 'text'>,
): SourceArtifact {
  const sourceType = overrides.sourceType ?? 'github';
  const n = Math.abs(hash(`${sourceType}:${overrides.key}`)) % 0xffffffff;
  return {
    snapshotId: SNAPSHOT[sourceType],
    artifactId: uid(n, 'b0000001'),
    sourceType,
    snapshotStatus: 'captured',
    kind:
      sourceType === 'github' ? 'file' : sourceType === 'devpost' ? 'submission_text' : 'page_text',
    mediaType: 'text/plain',
    ...overrides,
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h | 0;
}

/** A project with a Devpost text, a README, one source file and a deployment observation. */
export function hydroTrackArtifacts(): SourceArtifact[] {
  return [
    artifact({
      sourceType: 'devpost',
      key: 'submission.txt',
      kind: 'submission_text',
      text: DEVPOST_TEXT,
    }),
    artifact({
      sourceType: 'github',
      key: 'files/README.md',
      mediaType: 'text/markdown',
      text: README_TEXT,
    }),
    artifact({ sourceType: 'github', key: 'files/src/intake.ts', text: CODE_TEXT }),
    artifact({ sourceType: 'deployment', key: 'page.txt', kind: 'page_text', text: PAGE_TEXT }),
    artifact({
      sourceType: 'deployment',
      key: 'response.json',
      kind: 'http_response',
      mediaType: 'application/json',
      text: RESPONSE_JSON,
    }),
  ];
}

export function planWorld(
  artifacts: readonly SourceArtifact[],
  extra: Partial<PlanWorld> = {},
): PlanWorld {
  const snapshots = [...new Map(artifacts.map((a) => [a.snapshotId, a])).values()].map((a) => ({
    id: a.snapshotId,
    sourceType: a.sourceType,
    status: a.snapshotStatus as 'captured' | 'partial',
  }));
  return { projectId: PROJECT_ID, eventId: EVENT_ID, snapshots, artifacts, ...extra };
}

// -- Event Context fixtures ---------------------------------------------------------------------------------------------

const fact = (
  n: number,
  statement = 'Not stated.',
  certainty: 'explicit' | 'interpreted' | 'unclear' = 'unclear',
) => ({
  id: uid(n, 'd0000001'),
  statement,
  certainty,
  sourceIds: [],
  origin: 'human' as const,
  humanModified: false,
});

export interface CriterionFixture {
  key: string;
  name?: string;
  description?: string;
  weight: number | null;
  anchors?: { score: number; description: string }[];
}

export function lockedSnapshot(
  options: {
    criteria?: CriterionFixture[];
    trackKeys?: string[];
    rules?: { statement: string; certainty: 'explicit' | 'interpreted' | 'unclear' }[];
    requirements?: {
      statement: string;
      certainty: 'explicit' | 'interpreted' | 'unclear';
      trackKey: string | null;
    }[];
    scale?: { min: number; max: number };
    noRubric?: boolean;
  } = {},
): EventContextLockedSnapshot {
  const date = (n: number) => ({ ...fact(n), value: null });
  const criteria = options.criteria ?? [
    {
      key: 'problem_fit',
      weight: 0.5,
      anchors: [
        { score: 0, description: 'No coherent problem.' },
        { score: 10, description: 'A precisely defined problem that is clearly solved.' },
      ],
    },
    { key: 'usability', weight: 0.5 },
  ];
  const document: EventContextDocument = {
    dates: {
      startsAt: date(1),
      endsAt: date(2),
      judgingStartsAt: date(3),
      submissionDeadline: date(4),
    },
    judgingFormat: fact(5),
    rules: (options.rules ?? []).map((rule, i) => fact(20 + i, rule.statement, rule.certainty)),
    submissionRequirements: (options.requirements ?? []).map((requirement, i) => ({
      ...fact(40 + i, requirement.statement, requirement.certainty),
      trackKey: requirement.trackKey,
    })),
    priorWorkPolicy: { ...fact(6), stance: 'unclear' },
    organizerGuidance: [],
    conflicts: [],
    tracks: (options.trackKeys ?? []).map((key) => ({
      key,
      name: `Track ${key}`,
      description: `Projects in the ${key} track must address ${key}.`,
      sourceIds: [],
      origin: 'human' as const,
      humanModified: false,
    })),
    rubrics: options.noRubric
      ? []
      : [
          {
            scope: 'overall',
            trackKey: null,
            name: 'Official rubric',
            scaleMin: options.scale?.min ?? 0,
            scaleMax: options.scale?.max ?? 10,
            sourceIds: [],
            origin: 'human',
            humanModified: false,
            criteria: criteria.map((criterion) => ({
              key: criterion.key,
              name: criterion.name ?? criterion.key,
              description: criterion.description ?? `Published description of ${criterion.key}.`,
              weight: criterion.weight,
              anchors: criterion.anchors ?? [],
              sourceIds: [],
              origin: 'human' as const,
              humanModified: false,
            })),
          },
        ],
  };
  return {
    eventId: EVENT_ID,
    versionId: VERSION_ID,
    version: 1,
    status: 'locked',
    lockedAt: '2031-04-12T00:00:00.000Z',
    lockedContentHash: lockedContentHash({ document, sources: [] }),
    supersedesId: null,
    changeReason: null,
    summary: null,
    sources: [],
    document,
  };
}
