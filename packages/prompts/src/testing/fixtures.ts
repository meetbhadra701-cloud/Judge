import { lockedContentHash } from '@judge-copilot/context';
import type { EventContextDocument, EventContextLockedSnapshot } from '@judge-copilot/schemas';
import type { StageInputs, UnitView } from '../inputs.js';

/** Test-only fixtures. Excluded from the build; never exported from the package root. */

export const EVENT_ID = '11111111-1111-4111-8111-111111111111';
export const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2031-04-12T00:00:00.000Z';

const fact = (n: number) => ({
  id: `33333333-3333-4333-8333-33333333333${String(n)}`,
  statement: 'Not stated.',
  certainty: 'unclear' as const,
  sourceIds: [],
  origin: 'human' as const,
  humanModified: false,
});

export interface RubricCriterionFixture {
  key: string;
  name: string;
  description: string;
  anchors: { score: number; description: string }[];
}

export function lockedSnapshot(
  criteria: RubricCriterionFixture[] = [
    {
      key: 'problem_fit',
      name: 'Problem fit',
      description: 'How well the project addresses a real, clearly stated problem.',
      anchors: [
        {
          score: 10,
          description: 'A precisely defined problem and a solution that clearly solves it.',
        },
        { score: 0, description: 'No coherent problem or an unrelated solution.' },
        { score: 5, description: 'A clear but generic problem with a plausible solution.' },
      ],
    },
    {
      key: 'usability',
      name: 'Usability',
      description: 'How easily a first-time user can complete the main task.',
      anchors: [],
    },
  ],
  overrides: {
    status?: 'locked' | 'superseded';
    scope?: 'overall' | 'track';
    twoOverall?: boolean;
  } = {},
): EventContextLockedSnapshot {
  const date = (n: number) => ({ ...fact(n), value: null });
  const rubric = (name: string) => ({
    scope: overrides.scope ?? ('overall' as const),
    trackKey: overrides.scope === 'track' ? 'robotics' : null,
    name,
    scaleMin: 0,
    scaleMax: 10,
    sourceIds: [],
    origin: 'human' as const,
    humanModified: false,
    criteria: criteria.map((criterion) => ({
      ...criterion,
      weight: null,
      sourceIds: [],
      origin: 'human' as const,
      humanModified: false,
    })),
  });
  const document: EventContextDocument = {
    dates: {
      startsAt: date(1),
      endsAt: date(2),
      judgingStartsAt: date(3),
      submissionDeadline: date(4),
    },
    judgingFormat: fact(5),
    rules: [],
    submissionRequirements: [],
    priorWorkPolicy: { ...fact(6), stance: 'unclear' },
    organizerGuidance: [],
    conflicts: [],
    tracks: [],
    rubrics: overrides.twoOverall
      ? [rubric('Official A'), rubric('Official B')]
      : [rubric('Official rubric')],
  };
  return {
    eventId: EVENT_ID,
    versionId: VERSION_ID,
    version: 1,
    status: overrides.status ?? 'locked',
    lockedAt: NOW,
    lockedContentHash: lockedContentHash({ document, sources: [] }),
    supersedesId: null,
    changeReason: null,
    summary: null,
    sources: [],
    document,
  };
}

export const OFFICIAL_UNIT: UnitView = {
  dimensionId: 'official.problem_fit',
  name: 'Problem fit',
  scale: { min: 0, max: 10 },
  standard: {
    basis: 'official',
    criterionDescription: 'How well the project addresses a real, clearly stated problem.',
    anchors: [
      { score: 0, description: 'No coherent problem or an unrelated solution.' },
      { score: 5, description: 'A clear but generic problem with a plausible solution.' },
      {
        score: 10,
        description: 'A precisely defined problem and a solution that clearly solves it.',
      },
    ],
  },
  notices: ['sampled_source'],
};

export const NO_ANCHOR_UNIT: UnitView = {
  dimensionId: 'official.usability',
  name: 'Usability',
  scale: { min: 0, max: 10 },
  standard: {
    basis: 'official_no_anchors',
    criterionDescription: 'How easily a first-time user can complete the main task.',
  },
  notices: [],
};

const candidates = [
  {
    handle: 'E-001',
    channel: 'submission',
    label: 'team_claim',
    authorship: 'team_statement',
    text: 'The team states that the app sends a reminder every two hours.',
    excerpt: 'It sends reminders every two hours.',
  },
  {
    handle: 'E-002',
    channel: 'source_code',
    label: 'unverified',
    authorship: 'interpreted_fact',
    text: 'addIntake rejects non-positive amounts with a RangeError.',
    excerpt: "if (amount <= 0) throw new RangeError('amount');",
  },
  {
    handle: 'E-003',
    channel: 'event_context',
    label: 'unverified',
    authorship: 'event_reference',
    text: 'The track requires projects to address a health-related problem.',
    excerpt: null,
  },
] as const;

/** One valid input per stage. Free-text values are plain, so tests can inject hostile text into any of them. */
export const VALID_INPUTS: { [S in keyof StageInputs]: StageInputs[S] } = {
  claim_extraction: {
    passages: [
      {
        handle: 'P-0001',
        sourceType: 'devpost',
        artifact: 'sections/description',
        text: 'Our app helps students track daily water intake.\nIt sends reminders every two hours.\n',
      },
      {
        handle: 'P-0002',
        sourceType: 'github',
        artifact: 'files/README.md',
        text: '# HydroTrack\nHydroTrack stores intake in SQLite.\n',
      },
    ],
  },
  evidence_interpretation: {
    passages: [
      {
        handle: 'P-0003',
        sourceType: 'github',
        artifact: 'files/src/intake.ts',
        artifactClass: 'source_code',
        text: "export function addIntake(amount: number) {\n  if (amount <= 0) throw new RangeError('amount');\n  db.insert(amount);\n}\n",
      },
      {
        handle: 'P-0004',
        sourceType: 'deployment',
        artifact: 'observation.json',
        artifactClass: 'deployment_observation',
        text: '{"status":200,"finalUrl":"https://example.test/"}',
      },
    ],
  },
  fidelity_review: {
    items: [
      {
        handle: 'C-001',
        assertion: 'The app sends reminders every two hours.',
        quote: 'It sends reminders every two hours.',
      },
      {
        handle: 'E-002',
        assertion: 'addIntake rejects non-positive amounts.',
        quote: "if (amount <= 0) throw new RangeError('amount');",
      },
    ],
  },
  relation_matching: {
    claims: [{ handle: 'C-001', text: 'The app sends reminders every two hours.' }],
    evidence: [
      {
        handle: 'E-002',
        text: 'addIntake rejects non-positive amounts.',
        quote: "if (amount <= 0) throw new RangeError('amount');",
      },
      { handle: 'E-003', text: 'The deployment answered HTTP 200.', quote: null },
    ],
  },
  relation_verification: {
    pairs: [
      {
        handle: 'X-001',
        claim: 'The app validates input.',
        evidence: 'addIntake rejects non-positive amounts.',
        evidenceQuote: "if (amount <= 0) throw new RangeError('amount');",
      },
    ],
  },
  contradiction_detection: {
    claims: [{ handle: 'C-001', text: 'The app works fully offline.' }],
    evidence: [
      {
        handle: 'E-002',
        text: 'The handler calls a remote API on every request.',
        quote: 'await fetch(API_URL)',
      },
    ],
  },
  unknown_identification: {
    claims: [{ handle: 'C-001', text: 'The app improves hydration by 30 percent.' }],
    evidence: [
      {
        handle: 'E-002',
        text: 'The project stores intake amounts in SQLite.',
        quote: 'db.insert(amount)',
      },
    ],
  },
  dimension_assessment: { unit: OFFICIAL_UNIT, candidates: [...candidates] },
  critic: {
    unit: OFFICIAL_UNIT,
    judgment: {
      outcome: { kind: 'scored', score: 6.5 },
      rationale: 'The submission states a clear problem and the shown handler validates input.',
      citations: [
        {
          evidence: 'E-001',
          directness: 'adjacent',
          specificity: 'partial',
          note: 'team statement',
        },
      ],
    },
    cited: [candidates[0]],
    others: [{ handle: 'E-002', oneLine: 'addIntake rejects non-positive amounts.' }],
    contradictions: [
      {
        description: 'The README and the code disagree about offline mode.',
        sideA: 'C-001',
        sideB: 'E-002',
      },
    ],
    flags: ['only_team_authored_evidence'],
  },
};
