import type { EventContextDocumentInput } from '@judge-copilot/schemas';

const NOT_STATED = 'Not yet established from the official sources.';

/**
 * A starting point for authoring an Event Context by hand when no extractor is configured.
 * Every fact starts `unclear` — nothing is guessed.
 */
export function blankDocumentInput(): EventContextDocumentInput {
  const unclearDate = {
    statement: NOT_STATED,
    certainty: 'unclear' as const,
    sourceIds: [],
    value: null,
  };
  return {
    dates: {
      startsAt: unclearDate,
      endsAt: unclearDate,
      judgingStartsAt: unclearDate,
      submissionDeadline: unclearDate,
    },
    judgingFormat: { statement: NOT_STATED, certainty: 'unclear', sourceIds: [] },
    rules: [],
    submissionRequirements: [],
    priorWorkPolicy: {
      statement: NOT_STATED,
      certainty: 'unclear',
      sourceIds: [],
      stance: 'unclear',
    },
    organizerGuidance: [],
    tracks: [],
    rubrics: [],
    conflicts: [],
  };
}
