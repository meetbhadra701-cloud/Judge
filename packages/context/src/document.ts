import { randomUUID } from 'node:crypto';
import type {
  ConflictInput as ConflictInputSchema,
  ContextConflict,
  ContextFact,
  EventContextDocument,
  EventContextDocumentInput,
  EventContextExtraction,
  FactOrigin,
  RubricAnchorDefinition,
  RubricDefinition,
  TrackDefinition,
} from '@judge-copilot/schemas';
import type { z } from 'zod';
import { resolveConflict } from './conflicts.js';
import { issue, throwIfIssues, type TypedIssue } from './errors.js';
import { canonicalJson } from './hash.js';
import { collectSourceIds } from './references.js';
import { validateDocument, type VersionSources } from './validation.js';

type ConflictInput = z.infer<typeof ConflictInputSchema>;

export interface DocumentContext {
  /** Sources of the context version being written. */
  sources: VersionSources;
  newId?: () => string;
}

/** What a human edit changed, for the audit trail. Labels are IDs/keys, never content. */
export interface DocumentChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

interface Provenance {
  sourceIds: string[];
  origin: FactOrigin;
  humanModified: boolean;
}

const SOURCE_DERIVED: Omit<Provenance, 'sourceIds'> = {
  origin: 'source_derived',
  humanModified: false,
};

/**
 * Turns a schema-valid extraction into a reviewed draft document. Code assigns every ID
 * (invariant 20) and resolves conflicts by authority; every item is `source_derived`.
 * Throws EventContextError when the extraction references unknown sources or is structurally invalid.
 */
export function documentFromExtraction(
  extraction: EventContextExtraction,
  context: DocumentContext,
): EventContextDocument {
  assertKnownSources(extraction, context.sources);
  const newId = context.newId ?? randomUUID;
  const issues: TypedIssue[] = [];

  const fact = <
    T extends { statement: string; certainty: ContextFact['certainty']; sourceIds: string[] },
  >(
    input: T,
  ) => {
    const { id: _ignored, ...rest } = input as T & { id?: string };
    return { ...rest, id: newId(), sourceIds: unique(input.sourceIds), ...SOURCE_DERIVED };
  };
  const date = (input: EventContextExtraction['dates']['startsAt']) => ({
    ...fact(input),
    value: normalizeIso(input.value),
  });

  const document: EventContextDocument = {
    dates: {
      startsAt: date(extraction.dates.startsAt),
      endsAt: date(extraction.dates.endsAt),
      judgingStartsAt: date(extraction.dates.judgingStartsAt),
      submissionDeadline: date(extraction.dates.submissionDeadline),
    },
    judgingFormat: fact(extraction.judgingFormat),
    rules: extraction.rules.map(fact),
    submissionRequirements: extraction.submissionRequirements.map(fact),
    priorWorkPolicy: fact(extraction.priorWorkPolicy),
    organizerGuidance: extraction.organizerGuidance.map(fact),
    tracks: extraction.tracks.map((track) => ({
      ...track,
      sourceIds: unique(track.sourceIds),
      ...SOURCE_DERIVED,
    })),
    rubrics: extraction.rubrics.map((rubric) => ({
      ...rubric,
      sourceIds: unique(rubric.sourceIds),
      ...SOURCE_DERIVED,
      criteria: rubric.criteria.map((criterion) => ({
        ...criterion,
        sourceIds: unique(criterion.sourceIds),
        anchors: sortAnchors(criterion.anchors),
        ...SOURCE_DERIVED,
      })),
    })),
    conflicts: extraction.conflicts.map((conflict, i) => {
      const resolution = resolve(conflict, context.sources, `conflicts[${i}]`, issues);
      return {
        id: newId(),
        topic: conflict.topic,
        description: conflict.description,
        positions: conflict.positions,
        resolution,
        ...SOURCE_DERIVED,
      };
    }),
  };

  throwIfIssues([...issues, ...validateDocument(document, context.sources)]);
  return document;
}

/**
 * Applies a human's full replacement of a draft document while preserving provenance:
 *
 * - IDs and origins are server-controlled; new items are `human`, existing items keep their origin.
 * - A source-derived item may be reworded (it becomes `humanModified`) but may never lose a
 *   source it cited (`PROVENANCE_REMOVED`).
 * - Source-derived conflicts cannot be removed or lose positions; they stay visible.
 * - Removing a list fact or track is allowed and recorded in `changes`; the original extraction
 *   remains stored separately.
 */
export function applyHumanEdit(
  previous: EventContextDocument | null,
  input: EventContextDocumentInput,
  context: DocumentContext,
): { document: EventContextDocument; changes: DocumentChanges } {
  assertKnownSources(input, context.sources);
  const editor = new Editor(context.newId ?? randomUUID);

  const dates = input.dates;
  const prevDates = previous?.dates;
  const document: EventContextDocument = {
    dates: {
      startsAt: editor.singleton(
        { ...dates.startsAt, value: normalizeIso(dates.startsAt.value) },
        prevDates?.startsAt,
        'dates.startsAt',
      ),
      endsAt: editor.singleton(
        { ...dates.endsAt, value: normalizeIso(dates.endsAt.value) },
        prevDates?.endsAt,
        'dates.endsAt',
      ),
      judgingStartsAt: editor.singleton(
        { ...dates.judgingStartsAt, value: normalizeIso(dates.judgingStartsAt.value) },
        prevDates?.judgingStartsAt,
        'dates.judgingStartsAt',
      ),
      submissionDeadline: editor.singleton(
        { ...dates.submissionDeadline, value: normalizeIso(dates.submissionDeadline.value) },
        prevDates?.submissionDeadline,
        'dates.submissionDeadline',
      ),
    },
    judgingFormat: editor.singleton(input.judgingFormat, previous?.judgingFormat, 'judgingFormat'),
    priorWorkPolicy: editor.singleton(
      input.priorWorkPolicy,
      previous?.priorWorkPolicy,
      'priorWorkPolicy',
    ),
    rules: editor.list(input.rules, previous?.rules ?? [], 'rules'),
    submissionRequirements: editor.list(
      input.submissionRequirements,
      previous?.submissionRequirements ?? [],
      'submissionRequirements',
    ),
    organizerGuidance: editor.list(
      input.organizerGuidance,
      previous?.organizerGuidance ?? [],
      'organizerGuidance',
    ),
    tracks: editor.tracks(input.tracks, previous?.tracks ?? []),
    rubrics: editor.rubrics(input.rubrics, previous?.rubrics ?? []),
    conflicts: editor.conflicts(input.conflicts, previous?.conflicts ?? [], context.sources),
  };

  throwIfIssues([...editor.issues, ...validateDocument(document, context.sources)]);
  return { document, changes: editor.changes };
}

class Editor {
  readonly issues: TypedIssue[] = [];
  readonly changes: DocumentChanges = { added: [], modified: [], removed: [] };

  constructor(private readonly newId: () => string) {}

  /** Fixed-slot facts (dates, judging format, prior-work policy): identity is the slot. */
  singleton<T extends { id?: string | undefined; sourceIds: string[] }>(
    input: T,
    prev: (ContextFact & Record<string, unknown>) | undefined,
    path: string,
  ): Omit<T, 'id'> & { id: string } & Provenance {
    if (prev && input.id !== undefined && input.id !== prev.id) {
      this.issues.push(
        issue('UNKNOWN_FACT_ID', path, `Fact id ${input.id} does not belong to ${path}`),
      );
    }
    return this.fact(input, prev, path, path);
  }

  /** List facts: identity is the server-assigned fact id. */
  list<T extends { id?: string | undefined; sourceIds: string[] }>(
    inputs: readonly T[],
    previous: readonly ContextFact[],
    section: string,
  ): (Omit<T, 'id'> & { id: string } & Provenance)[] {
    const prevById = new Map(previous.map((fact) => [fact.id, fact]));
    const kept = new Set<string>();
    const result = inputs.map((input, i) => {
      const path = `${section}[${i}]`;
      let prev: ContextFact | undefined;
      if (input.id !== undefined) {
        prev = prevById.get(input.id);
        if (!prev) {
          this.issues.push(
            issue(
              'UNKNOWN_FACT_ID',
              path,
              `Unknown fact id ${input.id}; omit the id to add a new fact`,
            ),
          );
        } else if (kept.has(input.id)) {
          this.issues.push(
            issue('DUPLICATE_FACT_ID', path, `Fact id ${input.id} appears more than once`),
          );
        }
        kept.add(input.id);
      }
      return this.fact(input, prev, path, `${section}:${prev?.id ?? 'new'}`);
    });
    for (const fact of previous) {
      if (!kept.has(fact.id)) {
        this.changes.removed.push(`${section}:${fact.id}`);
      }
    }
    return result;
  }

  tracks(
    inputs: EventContextDocumentInput['tracks'],
    previous: readonly TrackDefinition[],
  ): TrackDefinition[] {
    const prevByKey = new Map(previous.map((track) => [track.key, track]));
    const result = inputs.map((input, i) => ({
      ...input,
      ...this.provenance(prevByKey.get(input.key), input, `tracks[${i}]`, `tracks:${input.key}`),
    }));
    const keys = new Set(inputs.map((track) => track.key));
    for (const track of previous) {
      if (!keys.has(track.key)) this.changes.removed.push(`tracks:${track.key}`);
    }
    return result;
  }

  rubrics(
    inputs: EventContextDocumentInput['rubrics'],
    previous: readonly RubricDefinition[],
  ): RubricDefinition[] {
    const identity = (rubric: { scope: string; trackKey: string | null }) =>
      rubric.scope === 'overall' ? 'overall' : `track:${rubric.trackKey ?? ''}`;
    const prevByIdentity = new Map(previous.map((rubric) => [identity(rubric), rubric]));
    const result = inputs.map((input, i) => {
      const prev = prevByIdentity.get(identity(input));
      const label = `rubrics:${identity(input)}`;
      const { criteria, ...fields } = input;
      const prevCriteria = new Map(
        (prev?.criteria ?? []).map((criterion) => [criterion.key, criterion]),
      );
      return {
        ...fields,
        ...this.provenance(prev, fields, `rubrics[${i}]`, label),
        criteria: criteria.map((criterion, j) => {
          const normalized = { ...criterion, anchors: sortAnchors(criterion.anchors) };
          return {
            ...normalized,
            ...this.provenance(
              prevCriteria.get(criterion.key),
              normalized,
              `rubrics[${i}].criteria[${j}]`,
              `${label}/criteria:${criterion.key}`,
            ),
          };
        }),
      };
    });
    const identities = new Set(inputs.map(identity));
    for (const rubric of previous) {
      if (!identities.has(identity(rubric)))
        this.changes.removed.push(`rubrics:${identity(rubric)}`);
    }
    return result;
  }

  conflicts(
    inputs: readonly ConflictInput[],
    previous: readonly ContextConflict[],
    sources: VersionSources,
  ): ContextConflict[] {
    const prevById = new Map(previous.map((conflict) => [conflict.id, conflict]));
    const kept = new Set<string>();
    const result = inputs.map((input, i): ContextConflict => {
      const path = `conflicts[${i}]`;
      const prev = input.id !== undefined ? prevById.get(input.id) : undefined;
      if (input.id !== undefined) {
        if (!prev)
          this.issues.push(issue('UNKNOWN_FACT_ID', path, `Unknown conflict id ${input.id}`));
        kept.add(input.id);
      }
      const resolution = resolve(input, sources, path, this.issues);
      if (prev?.origin === 'source_derived') {
        const positionSources = new Set(input.positions.map((position) => position.sourceId));
        if (prev.positions.some((position) => !positionSources.has(position.sourceId))) {
          this.issues.push(
            issue(
              'PROVENANCE_REMOVED',
              `${path}.positions`,
              'Positions of a source-derived conflict cannot be removed',
            ),
          );
        }
      }
      const content = {
        topic: input.topic,
        description: input.description,
        positions: input.positions,
        resolution,
      };
      const changed =
        prev !== undefined &&
        canonicalJson(content) !== canonicalJson(omit(prev, ['id', 'origin', 'humanModified']));
      this.record(prev, changed, `conflicts:${prev?.id ?? 'new'}`);
      return {
        id: prev?.id ?? this.newId(),
        ...content,
        origin: prev?.origin ?? 'human',
        humanModified: (prev?.humanModified ?? false) || changed,
      };
    });
    for (const conflict of previous) {
      if (kept.has(conflict.id)) continue;
      if (conflict.origin === 'source_derived') {
        this.issues.push(
          issue(
            'PROVENANCE_REMOVED',
            'conflicts',
            `Source-derived conflict ${conflict.id} cannot be removed; it stays visible even when resolved`,
          ),
        );
      } else {
        this.changes.removed.push(`conflicts:${conflict.id}`);
      }
    }
    return result;
  }

  private fact<T extends { id?: string | undefined; sourceIds: string[] }>(
    input: T,
    prev: (ContextFact & Record<string, unknown>) | undefined,
    path: string,
    label: string,
  ): Omit<T, 'id'> & { id: string } & Provenance {
    const { id: _ignored, ...fields } = input;
    return {
      ...fields,
      id: prev?.id ?? this.newId(),
      ...this.provenance(prev, fields, path, label),
    };
  }

  /** Server-computed provenance: keeps origin, forbids dropping cited sources, flags human changes. */
  private provenance(
    prev: (Provenance & Record<string, unknown>) | undefined,
    fields: { sourceIds: string[] } & Record<string, unknown>,
    path: string,
    label: string,
  ): Provenance {
    const sourceIds = unique(fields.sourceIds);
    if (!prev) {
      this.record(undefined, false, label);
      return { sourceIds, origin: 'human', humanModified: false };
    }
    if (prev.origin === 'source_derived') {
      const missing = prev.sourceIds.filter((id) => !sourceIds.includes(id));
      if (missing.length > 0) {
        this.issues.push(
          issue(
            'PROVENANCE_REMOVED',
            `${path}.sourceIds`,
            'A source-derived item cannot drop the sources it cites',
          ),
        );
      }
    }
    const changed = comparable({ ...fields, sourceIds }) !== comparable(prev);
    this.record(prev, changed, label);
    return { sourceIds, origin: prev.origin, humanModified: prev.humanModified || changed };
  }

  private record(prev: unknown, changed: boolean, label: string): void {
    if (prev === undefined) this.changes.added.push(label);
    else if (changed) this.changes.modified.push(label);
  }
}

/** Canonical comparison of an item's human-editable content (ignores provenance bookkeeping). */
function comparable(item: Record<string, unknown>): string {
  const { origin: _o, humanModified: _h, id: _i, criteria: _c, sourceIds, ...rest } = item;
  return canonicalJson({ ...rest, sourceIds: [...(sourceIds as string[])].sort() });
}

function resolve(
  conflict: {
    positions: ContextConflict['positions'];
    humanResolution?: ConflictInput['humanResolution'];
  },
  sources: VersionSources,
  path: string,
  issues: TypedIssue[],
): ContextConflict['resolution'] {
  const result = resolveConflict(
    conflict.positions,
    (id) => sources.get(id) ?? 'universal_fallback',
    conflict.humanResolution ?? null,
  );
  if (result.ok) {
    return result.resolution;
  }
  issues.push(
    issue(
      conflict.humanResolution ? 'INVALID_CONFLICT_RESOLUTION' : 'INVALID_CONFLICT',
      path,
      result.message,
    ),
  );
  return { status: 'unresolved', prevailingSourceIds: [], note: null };
}

function assertKnownSources(value: unknown, sources: VersionSources): void {
  const unknown = [...collectSourceIds(value)].filter((id) => !sources.has(id));
  throwIfIssues(
    unknown.map((id) =>
      issue(
        'UNKNOWN_SOURCE_REFERENCE',
        'document',
        `Source ${id} is not part of this context version`,
      ),
    ),
  );
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sortAnchors(anchors: readonly RubricAnchorDefinition[]): RubricAnchorDefinition[] {
  return [...anchors].sort((a, b) => a.score - b.score);
}

function normalizeIso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function omit<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !(keys as readonly PropertyKey[]).includes(key)),
  ) as Omit<T, K>;
}
