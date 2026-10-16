import { isOfficialAuthority } from '@judge-copilot/context';
import type {
  EventContextDocument,
  EventContextDocumentInput,
  EventSourceAuthority,
  PriorWorkStance,
  SourceCertainty,
} from '@judge-copilot/schemas';

/*
 * P6D: the structured Event Context editor's model (no React here, so every rule is unit-testable).
 *
 * The editor is a FORM over the existing validated document model, never a second format. `documentFromModel` produces exactly the
 * `EventContextDocumentInput` the API's draft-save route already accepts, and the server stays the authority (`applyHumanEdit` +
 * `validateDocument`): it assigns every id, computes provenance (`origin`, `humanModified`) and refuses what it refuses. What this file adds:
 *
 *   - the organizer never sees a UUID or a snake_case key: existing items carry their ids through the form untouched (so source-derived
 *     provenance survives an edit), new items get none (the server creates them), and track/criterion keys are generated from names;
 *   - the three kinds of statement are told apart by a labelled choice, and an assumption is never promoted silently: "official" is only
 *     accepted when an OFFICIAL source is cited (see BASIS below);
 *   - problems are reported next to the field that caused them, in plain words, whether found here or returned by the API.
 */

// -- Basis: what kind of statement is this? --------------------------------------------------------------------------------------------

/**
 * `official`: stated in an official source the organizer cites (stored as certainty `explicit`; ONLY these can be reference evidence for an
 * assessment). `interpreted`: the organizer's reading of what the sources imply (`interpreted`). `unverified`: a note nobody has confirmed
 * (`unclear`). The mapping is one-to-one and reversible, so a stored document always shows the same label.
 */
export type Basis = 'official' | 'interpreted' | 'unverified';

export const BASIS_VALUES: readonly Basis[] = ['official', 'interpreted', 'unverified'];

export const BASIS_LABEL: Readonly<Record<Basis, string>> = {
  official: 'Official — stated in an official source I cite',
  interpreted: 'Organizer’s interpretation — my reading of the sources',
  unverified: 'Unverified note — not confirmed by any source',
};

export const BASIS_SHORT_LABEL: Readonly<Record<Basis, string>> = {
  official: 'Official',
  interpreted: 'Organizer’s interpretation',
  unverified: 'Unverified note',
};

const CERTAINTY_OF: Readonly<Record<Basis, SourceCertainty>> = {
  official: 'explicit',
  interpreted: 'interpreted',
  unverified: 'unclear',
};
const BASIS_OF: Readonly<Record<SourceCertainty, Basis>> = {
  explicit: 'official',
  interpreted: 'interpreted',
  unclear: 'unverified',
};

export interface SourceOption {
  readonly id: string;
  readonly title: string;
  readonly authority: EventSourceAuthority;
}
export const isOfficial = (source: SourceOption): boolean => isOfficialAuthority(source.authority);

// -- The form model --------------------------------------------------------------------------------------------------------------------

export interface FactRow {
  /** Present only for an item that already exists on the draft: it travels through the form so provenance is preserved. */
  readonly id?: string | undefined;
  readonly statement: string;
  readonly basis: Basis;
  readonly sourceIds: readonly string[];
}
export interface DateRow extends FactRow {
  /** `YYYY-MM-DDTHH:mm`, read as UTC; empty = not stated. */
  readonly value: string;
}
export interface RequirementRow extends FactRow {
  /** `uid` of the track the requirement is specific to; `''` = applies to every project. */
  readonly trackKey: string;
}
export interface PriorWorkRow extends FactRow {
  readonly stance: PriorWorkStance;
}
export interface TrackRow {
  /** Stable identity of the row inside the form (what requirements and track rubrics point at). Equals `key` for a track that already exists. */
  readonly uid: string;
  readonly key: string;
  readonly existing: boolean;
  readonly name: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
}
export interface AnchorRow {
  readonly score: string;
  readonly description: string;
}
export interface CriterionRow {
  readonly key: string;
  readonly existing: boolean;
  readonly name: string;
  readonly description: string;
  /** Percent as typed (`'40'`); `''` = the official rubric publishes no weight for this criterion. */
  readonly weightPct: string;
  readonly anchors: readonly AnchorRow[];
  /** Sources an existing criterion already cites (kept); a new criterion cites the rubric's own sources. */
  readonly sourceIds: readonly string[];
}
export interface RubricRow {
  readonly scope: 'overall' | 'track';
  /** `uid` of the track a track rubric belongs to; `''` for the overall rubric. */
  readonly trackKey: string;
  readonly name: string;
  readonly scaleMin: string;
  readonly scaleMax: string;
  readonly sourceIds: readonly string[];
  readonly criteria: readonly CriterionRow[];
}

export const DATE_FIELDS = ['startsAt', 'endsAt', 'judgingStartsAt', 'submissionDeadline'] as const;
export type DateField = (typeof DATE_FIELDS)[number];
export const DATE_LABEL: Readonly<Record<DateField, string>> = {
  startsAt: 'Event starts',
  endsAt: 'Event ends',
  judgingStartsAt: 'Judging starts',
  submissionDeadline: 'Submission deadline',
};

export interface EditorModel {
  readonly summary: string;
  readonly dates: Readonly<Record<DateField, DateRow>>;
  readonly judgingFormat: FactRow;
  readonly priorWork: PriorWorkRow;
  readonly rules: readonly FactRow[];
  readonly requirements: readonly RequirementRow[];
  readonly guidance: readonly FactRow[];
  readonly tracks: readonly TrackRow[];
  readonly rubrics: readonly RubricRow[];
  /** Conflicts between sources arise from extraction and are resolved with the authority rules; the form carries them through unchanged. */
  readonly conflicts: EventContextDocumentInput['conflicts'];
}

const NOT_STATED = 'Not stated.';
const blankFact = (): FactRow => ({ statement: '', basis: 'unverified', sourceIds: [] });

export function blankModel(): EditorModel {
  const date = (): DateRow => ({ ...blankFact(), value: '' });
  return {
    summary: '',
    dates: {
      startsAt: date(),
      endsAt: date(),
      judgingStartsAt: date(),
      submissionDeadline: date(),
    },
    judgingFormat: blankFact(),
    priorWork: { ...blankFact(), stance: 'unclear' },
    rules: [],
    requirements: [],
    guidance: [],
    tracks: [],
    rubrics: [],
    conflicts: [],
  };
}

export const blankFactRow = blankFact;
export const blankRequirement = (): RequirementRow => ({
  ...blankFact(),
  basis: 'official',
  trackKey: '',
});
export const blankCriterion = (): CriterionRow => ({
  key: '',
  existing: false,
  name: '',
  description: '',
  weightPct: '',
  anchors: [],
  sourceIds: [],
});
export const blankRubric = (scope: 'overall' | 'track', trackKey = ''): RubricRow => ({
  scope,
  trackKey,
  name: '',
  scaleMin: '',
  scaleMax: '',
  sourceIds: [],
  criteria: [blankCriterion()],
});
export const blankTrack = (uid: string): TrackRow => ({
  uid,
  key: '',
  existing: false,
  name: '',
  description: '',
  sourceIds: [],
});

// -- Stored document -> model ----------------------------------------------------------------------------------------------------------

const asFact = (fact: {
  id?: string | undefined;
  statement: string;
  certainty: SourceCertainty;
  sourceIds: readonly string[];
}): FactRow => ({
  id: fact.id,
  // an unclear fact that only says "not stated" is an empty slot, not content
  statement: fact.certainty === 'unclear' && fact.statement === NOT_STATED ? '' : fact.statement,
  basis: BASIS_OF[fact.certainty],
  sourceIds: [...fact.sourceIds],
});

/** `2026-05-01T09:00:00.000Z` -> `2026-05-01T09:00` (UTC). */
const toLocalValue = (iso: string | null): string => (iso ? iso.slice(0, 16) : '');

/** The editor's starting point: the draft as stored (`input` is the edit-request shape, ids included), or a blank model. */
export function modelFromInput(input: EventContextDocumentInput | null, summary = ''): EditorModel {
  if (input === null) return { ...blankModel(), summary };
  const date = (fact: EventContextDocumentInput['dates']['startsAt']): DateRow => ({
    ...asFact(fact),
    value: toLocalValue(fact.value),
  });
  return {
    summary,
    dates: {
      startsAt: date(input.dates.startsAt),
      endsAt: date(input.dates.endsAt),
      judgingStartsAt: date(input.dates.judgingStartsAt),
      submissionDeadline: date(input.dates.submissionDeadline),
    },
    judgingFormat: asFact(input.judgingFormat),
    priorWork: { ...asFact(input.priorWorkPolicy), stance: input.priorWorkPolicy.stance },
    rules: input.rules.map(asFact),
    requirements: input.submissionRequirements.map((requirement) => ({
      ...asFact(requirement),
      trackKey: requirement.trackKey ?? '',
    })),
    guidance: input.organizerGuidance.map(asFact),
    tracks: input.tracks.map((track) => ({
      uid: track.key,
      key: track.key,
      existing: true,
      name: track.name,
      description: track.description ?? '',
      sourceIds: [...track.sourceIds],
    })),
    rubrics: input.rubrics.map((rubric) => ({
      scope: rubric.scope,
      trackKey: rubric.trackKey ?? '',
      name: rubric.name,
      scaleMin: String(rubric.scaleMin),
      scaleMax: String(rubric.scaleMax),
      sourceIds: [...rubric.sourceIds],
      criteria: rubric.criteria.map((criterion) => ({
        key: criterion.key,
        existing: true,
        name: criterion.name,
        description: criterion.description,
        weightPct: criterion.weight === null ? '' : formatPercent(criterion.weight * 100),
        anchors: criterion.anchors.map((anchor) => ({
          score: String(anchor.score),
          description: anchor.description,
        })),
        sourceIds: [...criterion.sourceIds],
      })),
    })),
    conflicts: input.conflicts,
  };
}

/** The edit-request shape of a stored document (provenance fields dropped; ids and source ids kept). */
export function inputFromDocument(document: EventContextDocument): EventContextDocumentInput {
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

// -- Keys ------------------------------------------------------------------------------------------------------------------------------

/** A snake_case identifier from a display name: `Community Impact!` -> `community_impact`. Unique among `taken`; never empty. */
export function keyFromName(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base === '') base = 'item';
  if (!/^[a-z]/.test(base)) base = `c_${base}`;
  base = base.slice(0, 90);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Percent text without float noise: `40`, `33.3333`. */
export function formatPercent(value: number): string {
  return String(Number(value.toFixed(4)));
}

// -- Issues ----------------------------------------------------------------------------------------------------------------------------

/**
 * `field` is the model path of the control the problem belongs to (`rules.0.statement`, `rubrics.0.criteria.2.weightPct`), or `form` when it
 * belongs to no single control. `blocks`: `save` = the draft cannot even be written (unreadable input); `lock` = the draft can be saved but
 * the version cannot be locked until it is fixed.
 */
export interface EditorIssue {
  readonly field: string;
  readonly message: string;
  readonly blocks: 'save' | 'lock';
}

const issue = (field: string, message: string, blocks: 'save' | 'lock' = 'lock'): EditorIssue => ({
  field,
  message,
  blocks,
});

// -- Model -> document input -----------------------------------------------------------------------------------------------------------

const MAX_STATEMENT = 5_000;
const MAX_NAME = 200;
const MAX_LIST = 200;
const MAX_CRITERIA = 100;
const MAX_ANCHORS = 50;

const FIXED_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export interface BuildResult {
  readonly input: EventContextDocumentInput | null;
  readonly issues: readonly EditorIssue[];
}

/**
 * Builds the document the API accepts, and reports every problem it finds. `input` is null only when something cannot be represented at
 * all (a weight that is not a number, a date that is not a date, a name that is empty); problems that merely make the draft unlockable
 * (weights that do not total 100 %) still yield an input, so the organizer can save work in progress.
 */
export function documentFromModel(
  model: EditorModel,
  sources: readonly SourceOption[],
): BuildResult {
  const issues: EditorIssue[] = [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const known = (ids: readonly string[]) => ids.filter((id) => sourceById.has(id));
  const authorityOf = (id: string): EventSourceAuthority =>
    sourceById.get(id)?.authority ?? 'universal_fallback';
  const isOfficialId = (id: string): boolean => isOfficialAuthority(authorityOf(id));

  const fact = (row: FactRow, field: string, section: 'official-capable' | 'guidance') => {
    if (row.basis === 'official' && section === 'guidance') {
      issues.push(
        issue(
          `${field}.basis`,
          'Organizer guidance cannot be marked official: it is not an official source.',
          'save',
        ),
      );
    }
    if (row.statement.length > MAX_STATEMENT) {
      issues.push(
        issue(
          `${field}.statement`,
          `This is too long (the limit is ${String(MAX_STATEMENT)} characters).`,
          'save',
        ),
      );
    }
    const ids = known(row.sourceIds);
    if (row.basis === 'official' && !ids.some((id) => isOfficialId(id))) {
      issues.push(
        issue(
          `${field}.sources`,
          'Marked official, but no official source is selected. Select the official source this comes from, or change it to “Organizer’s interpretation”. Nothing is treated as official without a source.',
          'save',
        ),
      );
    }
    return {
      ...(row.id === undefined ? {} : { id: row.id }),
      statement: row.statement.trim(),
      certainty: CERTAINTY_OF[row.basis],
      sourceIds: ids,
    };
  };
  const listFact = (row: FactRow, field: string, section: 'official-capable' | 'guidance') => {
    if (row.statement.trim() === '') {
      issues.push(issue(`${field}.statement`, 'Write the statement, or remove this row.', 'save'));
    }
    return fact(row, field, section);
  };
  /** A fixed slot (judging format, prior-work policy): empty means "not stated", which is stored as an unclear fact. */
  const slot = (row: FactRow, field: string) => {
    if (row.statement.trim() === '') {
      return {
        ...(row.id === undefined ? {} : { id: row.id }),
        statement: NOT_STATED,
        certainty: 'unclear' as const,
        sourceIds: [] as string[],
      };
    }
    return fact(row, field, 'official-capable');
  };

  // dates
  const dateInput = (field: DateField) => {
    const row = model.dates[field];
    const path = `dates.${field}`;
    const typed = row.value.trim();
    if (typed === '') {
      // a note without a date is stored as an unclear fact: the system never invents a date
      return {
        ...(row.id === undefined ? {} : { id: row.id }),
        statement: row.statement.trim() === '' ? NOT_STATED : row.statement.trim(),
        certainty: 'unclear' as const,
        sourceIds: known(row.sourceIds),
        value: null,
      };
    }
    const match = FIXED_UTC.exec(typed);
    const parsed = match ? Date.parse(`${typed}:00.000Z`) : Number.NaN;
    if (!match || Number.isNaN(parsed)) {
      issues.push(issue(`${path}.value`, 'Enter a valid date and time.', 'save'));
      return null;
    }
    if (row.basis === 'unverified') {
      // never promoted silently: the organizer decides whether the date is official or an interpretation
      issues.push(
        issue(
          `${path}.basis`,
          'A date that is filled in must be marked official or an interpretation. To keep an unconfirmed date, write it in the note and leave the date empty.',
          'save',
        ),
      );
      return null;
    }
    const built = fact(
      {
        ...row,
        statement:
          row.statement.trim() === ''
            ? `${DATE_LABEL[field]} ${typed.replace('T', ' ')} UTC`
            : row.statement,
      },
      path,
      'official-capable',
    );
    return { ...built, value: `${typed}:00.000Z` };
  };
  const dates = {
    startsAt: dateInput('startsAt'),
    endsAt: dateInput('endsAt'),
    judgingStartsAt: dateInput('judgingStartsAt'),
    submissionDeadline: dateInput('submissionDeadline'),
  };
  if (
    dates.startsAt?.value &&
    dates.endsAt?.value &&
    Date.parse(dates.endsAt.value) < Date.parse(dates.startsAt.value)
  ) {
    issues.push(issue('dates.endsAt.value', 'The event cannot end before it starts.'));
  }

  // tracks (keys are generated once and then kept; rows are referenced by uid so a new track can be used before it has a key)
  const takenKeys = new Set(model.tracks.filter((t) => t.existing).map((t) => t.key));
  const keyByUid = new Map<string, string>();
  const tracks = model.tracks.map((track, index) => {
    const field = `tracks.${String(index)}`;
    if (track.name.trim() === '')
      issues.push(issue(`${field}.name`, 'Give the track a name, or remove it.', 'save'));
    if (track.name.length > MAX_NAME)
      issues.push(
        issue(
          `${field}.name`,
          `The name is too long (the limit is ${String(MAX_NAME)} characters).`,
          'save',
        ),
      );
    const ids = known(track.sourceIds);
    if (ids.length === 0) {
      issues.push(
        issue(
          `${field}.sources`,
          'Select the source that defines this track. A track is not invented.',
          'save',
        ),
      );
    }
    const key = track.existing ? track.key : keyFromName(track.name, takenKeys);
    takenKeys.add(key);
    keyByUid.set(track.uid, key);
    return {
      key,
      name: track.name.trim(),
      description: track.description.trim() === '' ? null : track.description.trim(),
      sourceIds: ids,
    };
  });
  const resolveTrack = (uid: string): string | null =>
    uid === '' ? null : (keyByUid.get(uid) ?? null);
  // rubrics
  const rubricIdentities = new Map<string, number>();
  const rubrics = model.rubrics.map((rubric, r) => {
    const field = `rubrics.${String(r)}`;
    if (rubric.name.trim() === '')
      issues.push(issue(`${field}.name`, 'Give the rubric a name.', 'save'));
    const identity = rubric.scope === 'overall' ? 'overall' : `track:${rubric.trackKey}`; // uid: stable even before the track has a key
    if (rubricIdentities.has(identity)) {
      issues.push(
        issue(
          `${field}.name`,
          rubric.scope === 'overall'
            ? 'An event has one overall rubric. Remove this one or merge its criteria into the other.'
            : 'This track already has a rubric. Remove one of them.',
        ),
      );
    }
    rubricIdentities.set(identity, r);
    if (rubric.scope === 'track') {
      if (rubric.trackKey === '')
        issues.push(issue(`${field}.trackKey`, 'Choose the track this rubric belongs to.'));
      else if (!keyByUid.has(rubric.trackKey))
        issues.push(
          issue(
            `${field}.trackKey`,
            'This rubric belonged to a track that has been removed. Choose another track for it, or remove the rubric. It was not changed for you, and nothing is saved until you decide.',
            'save',
          ),
        );
    }
    const rubricSources = known(rubric.sourceIds);
    const needed: ReadonlySet<EventSourceAuthority> =
      rubric.scope === 'overall'
        ? new Set<EventSourceAuthority>(['official_judging_rubric'])
        : new Set<EventSourceAuthority>(['official_judging_rubric', 'official_track_rules']);
    if (!rubricSources.some((id) => needed.has(authorityOf(id)))) {
      issues.push(
        issue(
          `${field}.sources`,
          rubric.scope === 'overall'
            ? 'Select the official judging rubric source these criteria come from. Official criteria and weights are never invented: add the rubric text as a source of authority “official_judging_rubric” first.'
            : 'Select the official source (judging rubric or track rules) this track rubric comes from.',
          'save',
        ),
      );
    }
    const min = parseNumber(rubric.scaleMin);
    const max = parseNumber(rubric.scaleMax);
    if (min === null)
      issues.push(
        issue(`${field}.scaleMin`, 'Enter the lowest score as a number, for example 1.', 'save'),
      );
    if (max === null)
      issues.push(
        issue(
          `${field}.scaleMax`,
          'Enter the highest score as a number, for example 5 or 10.',
          'save',
        ),
      );
    if (min !== null && max !== null && min >= max) {
      issues.push(issue(`${field}.scaleMax`, 'The highest score must be above the lowest score.'));
    }
    if (rubric.criteria.length === 0)
      issues.push(issue(`${field}.criteria`, 'A rubric needs at least one criterion.'));
    if (rubric.criteria.length > MAX_CRITERIA)
      issues.push(
        issue(
          `${field}.criteria`,
          `A rubric can have at most ${String(MAX_CRITERIA)} criteria.`,
          'save',
        ),
      );

    const criterionKeys = new Set(rubric.criteria.filter((c) => c.existing).map((c) => c.key));
    const weights = rubric.criteria.map((criterion) => criterion.weightPct.trim());
    const weighted = weights.filter((w) => w !== '').length;
    if (weighted > 0 && weighted < weights.length) {
      issues.push(
        issue(
          `${field}.criteria`,
          'Either give every criterion a weight or leave every weight empty. An official rubric is not half-weighted, and no weight is invented.',
        ),
      );
    }
    let total = 0;
    const criteria = rubric.criteria.map((criterion, c) => {
      const cField = `${field}.criteria.${String(c)}`;
      if (criterion.name.trim() === '')
        issues.push(issue(`${cField}.name`, 'Give the criterion a name, or remove it.', 'save'));
      const key = criterion.existing ? criterion.key : keyFromName(criterion.name, criterionKeys);
      criterionKeys.add(key);
      let weight: number | null = null;
      if (criterion.weightPct.trim() !== '') {
        const pct = parseNumber(criterion.weightPct);
        if (pct === null) {
          issues.push(
            issue(
              `${cField}.weightPct`,
              'Enter the weight as a number of percent, for example 40.',
              'save',
            ),
          );
        } else if (pct <= 0 || pct > 100) {
          issues.push(
            issue(`${cField}.weightPct`, 'A weight must be above 0 and at most 100 percent.'),
          );
        } else {
          weight = Number((pct / 100).toFixed(8));
          total += pct;
        }
      }
      const anchorScores = new Set<number>();
      if (criterion.anchors.length > MAX_ANCHORS)
        issues.push(
          issue(`${cField}.anchors`, `At most ${String(MAX_ANCHORS)} scoring-guide rows.`, 'save'),
        );
      const anchors = criterion.anchors.flatMap((anchor, a) => {
        const aField = `${cField}.anchors.${String(a)}`;
        const score = parseNumber(anchor.score);
        if (score === null) {
          issues.push(
            issue(
              `${aField}.score`,
              'Enter the score this description belongs to, as a number.',
              'save',
            ),
          );
          return [];
        }
        if (anchor.description.trim() === '') {
          issues.push(
            issue(
              `${aField}.description`,
              'Describe what this score looks like, or remove the row.',
              'save',
            ),
          );
          return [];
        }
        if (min !== null && max !== null && (score < min || score > max)) {
          issues.push(issue(`${aField}.score`, 'This score is outside the rubric’s scale.'));
        }
        if (anchorScores.has(score))
          issues.push(issue(`${aField}.score`, 'Two scoring-guide rows use the same score.'));
        anchorScores.add(score);
        return [{ score, description: anchor.description.trim() }];
      });
      return {
        key,
        name: criterion.name.trim(),
        description: criterion.description.trim(),
        weight,
        sourceIds: [...new Set([...known(criterion.sourceIds), ...rubricSources])],
        anchors,
      };
    });
    if (weighted === weights.length && weighted > 0 && Math.abs(total - 100) > 1e-4) {
      issues.push(
        issue(
          `${field}.criteria`,
          `The weights add up to ${formatPercent(total)} %. An official rubric’s weights must total exactly 100 %; fix them to match the official text (they are never adjusted for you).`,
        ),
      );
    }
    return {
      scope: rubric.scope,
      trackKey:
        rubric.scope === 'overall' ? null : (keyByUid.get(rubric.trackKey) ?? rubric.trackKey),
      name: rubric.name.trim(),
      scaleMin: min ?? 0,
      scaleMax: max ?? 0,
      sourceIds: rubricSources,
      criteria,
    };
  });

  // lists
  const rules = model.rules.map((row, i) =>
    listFact(row, `rules.${String(i)}`, 'official-capable'),
  );
  const requirements = model.requirements.map((row, i) => {
    const field = `requirements.${String(i)}`;
    const built = listFact(row, field, 'official-capable');
    const trackKey = resolveTrack(row.trackKey);
    if (row.trackKey !== '' && trackKey === null) {
      // M6 phase 0 (R8B P3-2): never widen silently. A requirement for a track that is gone is NOT turned into an event-wide requirement: nothing is
      // saved until the organizer chooses another track, applies it to every project on purpose, or removes it
      issues.push(
        issue(
          `${field}.trackKey`,
          'This requirement belonged to a track that has been removed. Choose another track for it, apply it to every project on purpose, or remove the requirement. It was not changed for you, and nothing is saved until you decide.',
          'save',
        ),
      );
    }
    return { ...built, trackKey };
  });
  const guidance = model.guidance.map((row, i) =>
    listFact(row, `guidance.${String(i)}`, 'guidance'),
  );
  for (const [name, list] of [
    ['rules', model.rules],
    ['requirements', model.requirements],
    ['guidance', model.guidance],
    ['tracks', model.tracks],
    ['rubrics', model.rubrics],
  ] as const) {
    if (list.length > MAX_LIST)
      issues.push(issue(name, `At most ${String(MAX_LIST)} entries.`, 'save'));
  }

  const priorStatement = model.priorWork.statement.trim();
  const priorWork =
    priorStatement === ''
      ? {
          ...(model.priorWork.id === undefined ? {} : { id: model.priorWork.id }),
          statement: NOT_STATED,
          certainty: 'unclear' as const,
          sourceIds: [] as string[],
          stance: 'unclear' as const,
        }
      : {
          ...fact(model.priorWork, 'priorWork', 'official-capable'),
          stance: model.priorWork.stance,
        };
  if (
    priorStatement !== '' &&
    model.priorWork.basis === 'unverified' &&
    model.priorWork.stance !== 'unclear'
  ) {
    issues.push(
      issue(
        'priorWork.stance',
        'A policy that is only an unverified note must have the stance “unclear”. Mark it official or an interpretation, or set the stance to unclear.',
      ),
    );
  }
  if (
    priorStatement !== '' &&
    model.priorWork.basis !== 'unverified' &&
    model.priorWork.stance === 'unclear'
  ) {
    issues.push(
      issue(
        'priorWork.stance',
        'Choose the stance of the policy (allowed, allowed with disclosure or not allowed), or mark the statement as an unverified note.',
      ),
    );
  }

  const blockers = issues.some((entry) => entry.blocks === 'save');
  if (
    blockers ||
    dates.startsAt === null ||
    dates.endsAt === null ||
    dates.judgingStartsAt === null ||
    dates.submissionDeadline === null
  ) {
    return { input: null, issues };
  }
  return {
    issues,
    input: {
      dates: {
        startsAt: dates.startsAt,
        endsAt: dates.endsAt,
        judgingStartsAt: dates.judgingStartsAt,
        submissionDeadline: dates.submissionDeadline,
      },
      judgingFormat: slot(model.judgingFormat, 'judgingFormat'),
      rules,
      submissionRequirements: requirements,
      priorWorkPolicy: priorWork,
      organizerGuidance: guidance,
      tracks,
      rubrics,
      conflicts: model.conflicts,
    },
  };
}

// -- Server issues -> fields -----------------------------------------------------------------------------------------------------------

const SECTION_NAME: Readonly<Record<string, string>> = {
  submissionRequirements: 'requirements',
  organizerGuidance: 'guidance',
  priorWorkPolicy: 'priorWork',
};
const LEAF_NAME: Readonly<Record<string, string>> = {
  weight: 'weightPct',
  sourceIds: 'sources',
  certainty: 'basis',
};

/**
 * Turns a path the API reported (`rubrics[0].criteria[1].weight`, or a schema path such as `document.rules.2.statement`) into the model path
 * of the control it belongs to. Indexes are the same on both sides because the form keeps the document's order.
 */
export function fieldOfServerPath(path: string): string {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((part) => part !== '' && part !== 'document');
  if (parts.length === 0) return 'form';
  const mapped = parts.map((part, index) =>
    index === 0 ? (SECTION_NAME[part] ?? part) : (LEAF_NAME[part] ?? part),
  );
  return mapped.join('.');
}

/** A short, plain label for where a field path points, for the error summary ("Rubric 1 · Criterion 2 · weight"). */
export function describeField(field: string): string {
  const parts = field.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    const next = parts[i + 1];
    const index = next !== undefined && /^\d+$/.test(next) ? Number(next) + 1 : null;
    const singular: Record<string, string> = {
      rules: 'Rule',
      requirements: 'Requirement',
      guidance: 'Guidance',
      tracks: 'Track',
      rubrics: 'Rubric',
      criteria: 'Criterion',
      anchors: 'Scoring-guide row',
    };
    if (index !== null && singular[part]) {
      out.push(`${singular[part]} ${String(index)}`);
      i += 1;
    } else if (part === 'dates') {
      out.push('Dates');
    } else if (part in DATE_LABEL) {
      out.push(DATE_LABEL[part as DateField]);
    } else if (part === 'weightPct') out.push('weight');
    else if (part === 'sources') out.push('sources');
    else if (part === 'scaleMin') out.push('lowest score');
    else if (part === 'scaleMax') out.push('highest score');
    else if (part === 'trackKey') out.push('track');
    else if (part === 'judgingFormat') out.push('Judging format');
    else if (part === 'priorWork') out.push('Prior-work policy');
    else if (part === 'form') out.push('Event Context');
    else out.push(part);
  }
  return out.join(' · ');
}

// -- Lock readiness, in the organizer's words -----------------------------------------------------------------------------------------------

/**
 * The reason a draft cannot be locked yet, as the API reports it (`code` + `message`), in plain words with the next step. Unknown codes keep the
 * API's own message: it is never replaced by a guess.
 */
export function explainLockIssue(issueFromApi: { code: string; message: string }): string {
  const { code, message } = issueFromApi;
  if (code === 'INVALID_RUBRIC_WEIGHTS') {
    const sum = /sum to ([0-9.eE+-]+), not 1/.exec(message);
    if (sum) {
      const percent = formatPercent(Number(sum[1]) * 100);
      return `The criterion weights add up to ${percent} %, but an official rubric’s weights must total exactly 100 %. Correct them in Edit Event Context to match the official text; they are never adjusted for you.`;
    }
    if (/every criterion has a weight or none/.test(message)) {
      return 'Either give every criterion a weight or leave every weight empty. An official rubric is not half-weighted, and no weight is invented.';
    }
  }
  if (code === 'UNOFFICIAL_EXPLICIT_STATEMENT') {
    return 'A statement is marked official but cites no official source (the official rules, rubric or track rules). Cite the official source it comes from in Edit Event Context, or mark it as your interpretation or an unverified note. Nothing is treated as official without a source.';
  }
  if (code === 'UNSOURCED_OFFICIAL_RUBRIC') {
    return 'A rubric is the event’s official judging standard, so it must cite the official source it was copied from (the official judging rubric, rules or track rules). Add that source on this page and select it for the rubric in Edit Event Context.';
  }
  if (code === 'CONTEXT_CONTENT_MISSING') {
    return 'Nothing has been entered yet. Use Edit Event Context to enter the event’s criteria, rules and tracks.';
  }
  return message;
}

/**
 * Track-scoped items (requirements and rubrics) whose track is no longer in the model: a track was removed, renamed away or never existed (M6 phase 0,
 * R8B P3-2). The editor warns about them as soon as it happens, and `documentFromModel` refuses to save while any exist.
 */
export function orphanedTrackReferences(
  model: Pick<EditorModel, 'tracks' | 'requirements' | 'rubrics'>,
): { readonly field: string; readonly what: string }[] {
  const uids = new Set(model.tracks.map((track) => track.uid));
  const out: { field: string; what: string }[] = [];
  model.requirements.forEach((row, i) => {
    if (row.trackKey !== '' && !uids.has(row.trackKey))
      out.push({
        field: `requirements.${String(i)}.trackKey`,
        what: `Requirement ${String(i + 1)}`,
      });
  });
  model.rubrics.forEach((rubric, i) => {
    if (rubric.scope === 'track' && rubric.trackKey !== '' && !uids.has(rubric.trackKey))
      out.push({
        field: `rubrics.${String(i)}.trackKey`,
        what: `Rubric “${rubric.name.trim() || String(i + 1)}”`,
      });
  });
  return out;
}
