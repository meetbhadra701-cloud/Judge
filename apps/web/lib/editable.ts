import type { EventContextDocument, EventContextDocumentInput } from '@judge-copilot/schemas';

/**
 * Converts a stored document into the edit-request shape: server-computed provenance fields
 * (origin, humanModified, computed resolutions) are dropped, IDs and source IDs are kept so the
 * server can preserve provenance.
 */
export function toEditableInput(document: EventContextDocument): EventContextDocumentInput {
  const fact = <T extends { origin: unknown; humanModified: unknown }>(item: T) => {
    const { origin: _origin, humanModified: _modified, ...rest } = item;
    return rest;
  };
  return {
    dates: {
      startsAt: fact(document.dates.startsAt),
      endsAt: fact(document.dates.endsAt),
      judgingStartsAt: fact(document.dates.judgingStartsAt),
      submissionDeadline: fact(document.dates.submissionDeadline),
    },
    judgingFormat: fact(document.judgingFormat),
    rules: document.rules.map(fact),
    submissionRequirements: document.submissionRequirements.map(fact),
    priorWorkPolicy: fact(document.priorWorkPolicy),
    organizerGuidance: document.organizerGuidance.map(fact),
    tracks: document.tracks.map(fact),
    rubrics: document.rubrics.map((rubric) => ({
      ...fact(rubric),
      criteria: rubric.criteria.map(fact),
    })),
    conflicts: document.conflicts.map((conflict) => ({
      id: conflict.id,
      topic: conflict.topic,
      description: conflict.description,
      positions: conflict.positions,
      humanResolution:
        conflict.resolution.status === 'resolved_by_human'
          ? {
              prevailingSourceIds: conflict.resolution.prevailingSourceIds,
              note: conflict.resolution.note ?? '',
            }
          : null,
    })),
  };
}
