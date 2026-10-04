/* Test-only builders for small, valid Event Context inputs. Excluded from the package build. */
import type { EventContextExtraction, EventSourceAuthority } from '@judge-copilot/schemas';

export const RULES_ID = '0d6f3c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6';
export const RUBRIC_ID = '1e7a4d2b-2c3d-4e5f-9a01-b2c3d4e5f6a7';
export const JUDGE_ID = '2f8b5e3c-3d4e-4f5a-8b12-c3d4e5f6a7b8';
export const ORGANIZER_ID = '3a9c6f4d-4e5f-4a6b-9c23-d4e5f6a7b8c9';
export const OTHER_EVENT_SOURCE_ID = '4bad7a5e-5f6a-4b7c-8d34-e5f6a7b8c9d0';

export function sampleSources(
  extra: Record<string, EventSourceAuthority> = {},
): Map<string, EventSourceAuthority> {
  return new Map<string, EventSourceAuthority>([
    [RULES_ID, 'official_event_rules'],
    [RUBRIC_ID, 'official_judging_rubric'],
    [JUDGE_ID, 'judge_context'],
    ...Object.entries(extra),
  ]);
}

/** A valid extraction; `overrides` replaces top-level sections. */
export function sampleExtraction(
  overrides: Partial<EventContextExtraction> = {},
): EventContextExtraction {
  const unclearDate = {
    statement: 'Not stated.',
    certainty: 'unclear' as const,
    sourceIds: [],
    value: null,
  };
  return {
    dates: {
      startsAt: {
        statement: 'Starts 2031-04-12 09:00 UTC.',
        certainty: 'explicit',
        sourceIds: [RULES_ID],
        value: '2031-04-12T09:00:00Z',
      },
      endsAt: {
        statement: 'Ends 2031-04-13 12:00 UTC.',
        certainty: 'explicit',
        sourceIds: [RULES_ID],
        value: '2031-04-13T12:00:00Z',
      },
      judgingStartsAt: unclearDate,
      submissionDeadline: unclearDate,
    },
    judgingFormat: { statement: 'In-person expo.', certainty: 'explicit', sourceIds: [RULES_ID] },
    rules: [
      {
        statement: 'Teams have at most four members.',
        certainty: 'explicit',
        sourceIds: [RULES_ID],
      },
    ],
    submissionRequirements: [],
    priorWorkPolicy: {
      statement: 'Pre-existing code is allowed.',
      certainty: 'explicit',
      sourceIds: [RULES_ID],
      stance: 'allowed',
    },
    organizerGuidance: [],
    tracks: [],
    rubrics: [
      {
        scope: 'overall',
        trackKey: null,
        name: 'Official rubric',
        scaleMin: 1,
        scaleMax: 5,
        sourceIds: [RUBRIC_ID],
        criteria: [
          {
            key: 'technical',
            name: 'Technical',
            description: 'Depth.',
            weight: 0.6,
            sourceIds: [RUBRIC_ID],
            anchors: [],
          },
          {
            key: 'design',
            name: 'Design',
            description: 'Polish.',
            weight: 0.4,
            sourceIds: [RUBRIC_ID],
            anchors: [],
          },
        ],
      },
    ],
    conflicts: [],
    ...overrides,
  };
}

/** A deterministic ID generator: valid v4-shaped UUIDs in sequence. */
export function sequentialIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
  };
}
