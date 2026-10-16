'use client';

/* eslint-disable @typescript-eslint/no-confusing-void-expression -- the form's many one-line handlers deliberately return the result of an update call */

import { useActionState, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { PriorWorkStance } from '@judge-copilot/schemas';
import {
  BASIS_LABEL,
  BASIS_VALUES,
  DATE_FIELDS,
  DATE_LABEL,
  blankCriterion,
  blankFactRow,
  blankRequirement,
  blankRubric,
  blankTrack,
  describeField,
  documentFromModel,
  fieldOfServerPath,
  formatPercent,
  isOfficial,
  type AnchorRow,
  type Basis,
  type CriterionRow,
  type EditorIssue,
  type EditorModel,
  type FactRow,
  type RubricRow,
  type SourceOption,
  type TrackRow,
} from '../../../../../../lib/context-editor';
import { saveStructuredContextAction, type StructuredSaveState } from './actions';

/*
 * The Event Context editor (P6D). A form over the existing document model: every control is a labelled input, every list has add/remove
 * buttons, and the organizer never sees an id, a key or JSON. What is typed here is converted by `lib/context-editor.ts` into the same
 * document the API already validates; this component only gathers input and shows problems next to the field that caused them.
 */

const STANCES: readonly { value: PriorWorkStance; label: string }[] = [
  { value: 'unclear', label: 'Not stated / unclear' },
  { value: 'allowed', label: 'Prior work is allowed' },
  { value: 'allowed_with_disclosure', label: 'Allowed if disclosed' },
  { value: 'not_allowed', label: 'Prior work is not allowed' },
];

const idOf = (field: string): string => `f-${field.replaceAll('.', '-')}`;

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? 'Saving…' : 'Save draft'}
    </button>
  );
}

export function ContextEditor({
  eventId,
  versionId,
  eventName,
  sources,
  initial,
  sourceTexts,
}: {
  eventId: string;
  versionId: string;
  eventName: string;
  sources: readonly SourceOption[];
  initial: EditorModel;
  sourceTexts: readonly { id: string; title: string; text: string }[];
}) {
  const [model, setModel] = useState<EditorModel>(initial);
  const [attempted, setAttempted] = useState(false);
  const [saved, formAction] = useActionState<StructuredSaveState, FormData>(
    saveStructuredContextAction,
    { attempt: 0, error: null, issues: [] },
  );
  const nextUid = useRef(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  /** Immutable update through a mutable draft: `edit((m) => { m.rules.push(...) })`. */
  const edit = (change: (draft: Mutable<EditorModel>) => void) =>
    setModel((current) => {
      const draft = structuredClone(current) as Mutable<EditorModel>;
      change(draft);
      return draft;
    });

  const built = useMemo(() => documentFromModel(model, sources), [model, sources]);
  const serverIssues: EditorIssue[] = saved.issues.map((entry) => ({
    field: fieldOfServerPath(entry.path),
    message: entry.message,
    blocks: 'save',
  }));
  const issues = [...(attempted ? built.issues : []), ...serverIssues];
  const byField = new Map<string, EditorIssue[]>();
  for (const entry of issues)
    byField.set(entry.field, [...(byField.get(entry.field) ?? []), entry]);
  const errorsOf = (field: string): ReactNode =>
    (byField.get(field) ?? []).map((entry, i) => (
      <p key={i} id={`${idOf(field)}-error`} role="alert" className="error field-error">
        {entry.message}
      </p>
    ));
  const invalid = (field: string) => (byField.has(field) ? true : undefined);
  const describedBy = (field: string) => (byField.has(field) ? `${idOf(field)}-error` : undefined);

  const trackOptions = model.tracks.map((track) => ({
    uid: track.uid,
    label: track.name.trim() === '' ? 'New track (not named yet)' : track.name,
  }));

  const hasOverall = model.rubrics.some((rubric) => rubric.scope === 'overall');

  return (
    <form
      action={formAction}
      className="editor"
      noValidate
      onSubmit={(event) => {
        setAttempted(true);
        if (built.input === null) {
          event.preventDefault();
          summaryRef.current?.focus();
        }
      }}
    >
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="document" value={built.input ? JSON.stringify(built.input) : ''} />

      <div ref={summaryRef} tabIndex={-1} aria-live="polite">
        {saved.error ? (
          <p role="alert" className="error">
            <strong>{saved.error}</strong>
          </p>
        ) : null}
        {issues.length > 0 ? (
          <div role="alert" className="error" data-testid="editor-issues">
            <strong>
              {issues.length === 1
                ? 'One thing needs attention'
                : `${String(issues.length)} things need attention`}
            </strong>
            <ul>
              {issues.map((entry, i) => (
                <li key={i}>
                  <a href={`#${idOf(entry.field)}`}>{describeField(entry.field)}</a>:{' '}
                  {entry.message}
                  {entry.blocks === 'lock'
                    ? ' (the draft can be saved, but not locked until this is fixed)'
                    : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* 1. Overview ---------------------------------------------------------------------------------------------------------------- */}
      <section aria-labelledby="h-overview">
        <h2 id="h-overview">1. Event and sources</h2>
        <p>
          <strong>Event:</strong> {eventName}
        </p>
        <p className="notice" role="note">
          <strong>How this form works.</strong> Everything an assessment can rely on must come from
          a source you added on the version page (rules, rubric, track rules, …). For each statement
          you say what kind it is: <strong>Official</strong> (stated in an official source you
          cite), <strong>Organizer’s interpretation</strong> (your reading) or{' '}
          <strong>Unverified note</strong>. Nothing is treated as official unless you cite an
          official source for it, and no criterion, weight or track is invented for you. Leave
          anything the sources do not settle empty.
        </p>
        <p>
          Sources on this version ({sources.length}):{' '}
          {sources.length === 0 ? (
            <strong>none yet — add the event’s official texts on the version page first.</strong>
          ) : (
            sources.map((source) => (
              <span key={source.id} className="tag">
                {source.title} · {source.authority}
              </span>
            ))
          )}
        </p>
        {sourceTexts.length > 0 ? (
          <details>
            <summary>Show the source texts (to copy from)</summary>
            {sourceTexts.map((text) => (
              <div key={text.id}>
                <strong>{text.title}</strong>
                <pre>{text.text}</pre>
              </div>
            ))}
          </details>
        ) : null}
      </section>

      {/* 2. Dates and judging ------------------------------------------------------------------------------------------------------- */}
      <section aria-labelledby="h-dates">
        <h2 id="h-dates">2. Dates and how judging works</h2>
        <p>
          <small>Leave a date empty if the sources do not state it. Times are UTC.</small>
        </p>
        {DATE_FIELDS.map((key) => {
          const row = model.dates[key];
          const path = `dates.${key}`;
          return (
            <fieldset key={key}>
              <legend>{DATE_LABEL[key]}</legend>
              <label>
                Date and time (UTC)
                <input
                  id={idOf(`${path}.value`)}
                  type="datetime-local"
                  value={row.value}
                  aria-invalid={invalid(`${path}.value`)}
                  aria-describedby={describedBy(`${path}.value`)}
                  onChange={(e) =>
                    edit((d) => {
                      d.dates[key].value = e.target.value;
                    })
                  }
                />
              </label>
              {errorsOf(`${path}.value`)}
              {row.value !== '' ? (
                <>
                  <BasisSelect
                    field={`${path}.basis`}
                    value={row.basis}
                    onChange={(basis) =>
                      edit((d) => {
                        d.dates[key].basis = basis;
                      })
                    }
                    invalid={invalid(`${path}.basis`)}
                    describedBy={describedBy(`${path}.basis`)}
                  />
                  {errorsOf(`${path}.basis`)}
                  <SourcePicker
                    field={`${path}.sources`}
                    sources={sources}
                    selected={row.sourceIds}
                    onChange={(ids) =>
                      edit((d) => {
                        d.dates[key].sourceIds = ids;
                      })
                    }
                  />
                  {errorsOf(`${path}.sources`)}
                </>
              ) : null}
            </fieldset>
          );
        })}
        <FactEditor
          title="How judging works"
          help="For example the number of rounds, whether judging is in person, or who judges. Optional."
          field="judgingFormat"
          row={model.judgingFormat}
          sources={sources}
          onChange={(change) =>
            edit((d) => {
              d.judgingFormat = change(d.judgingFormat);
            })
          }
          errorsOf={errorsOf}
          invalid={invalid}
          describedBy={describedBy}
        />
      </section>

      {/* 3. Judging criteria -------------------------------------------------------------------------------------------------------- */}
      <section aria-labelledby="h-rubrics">
        <h2 id="h-rubrics">3. Official judging criteria</h2>
        <p>
          <small>
            Enter the criteria exactly as the official rubric publishes them. Give weights in
            percent only if the rubric publishes weights (they must total 100 %); otherwise leave
            every weight empty and the report will show each criterion without an overall number.
            Scores are on the scale you enter, for example 1 to 5.
          </small>
        </p>
        {model.rubrics.map((rubric, r) => (
          <RubricEditor
            key={r}
            index={r}
            rubric={rubric}
            sources={sources}
            trackOptions={trackOptions}
            edit={edit}
            errorsOf={errorsOf}
            invalid={invalid}
            describedBy={describedBy}
          />
        ))}
        <div className="row-actions">
          <button
            type="button"
            disabled={hasOverall}
            onClick={() =>
              edit((d) => {
                d.rubrics.push(mut(blankRubric('overall')));
              })
            }
          >
            Add the overall judging rubric
          </button>{' '}
          <button
            type="button"
            disabled={model.tracks.length === 0}
            onClick={() =>
              edit((d) => {
                d.rubrics.push(mut(blankRubric('track')));
              })
            }
          >
            Add a track rubric
          </button>
          {model.tracks.length === 0 ? <small> (define a track in section 6 first)</small> : null}
        </div>
        {errorsOf('rubrics')}
        {!hasOverall && model.rubrics.length > 0 ? (
          <p className="notice" role="note">
            There is no overall rubric. An assessment is made against the event’s overall rubric
            only; track rubrics alone cannot be assessed in this version.
          </p>
        ) : null}
      </section>

      {/* 4. Rules ------------------------------------------------------------------------------------------------------------------- */}
      <section aria-labelledby="h-rules">
        <h2 id="h-rules">4. Event rules</h2>
        <p>
          <small>
            Rules that apply to every project. Only statements marked <em>Official</em> (with an
            official source) are used as reference for assessments.
          </small>
        </p>
        <FactList
          kind="rule"
          field="rules"
          rows={model.rules}
          sources={sources}
          onChange={(change) =>
            edit((d) => {
              d.rules = change(d.rules);
            })
          }
          errorsOf={errorsOf}
          invalid={invalid}
          describedBy={describedBy}
        />
      </section>

      {/* 5. Requirements ------------------------------------------------------------------------------------------------------------ */}
      <section aria-labelledby="h-reqs">
        <h2 id="h-reqs">5. Participation and submission requirements</h2>
        <p>
          <small>
            What a team must do or provide. A requirement can apply to every project or only to one
            track.
          </small>
        </p>
        {model.requirements.map((row, i) => (
          <div key={i} className="card" data-testid={`requirement-${String(i)}`}>
            <FactFields
              label={`Requirement ${String(i + 1)}`}
              field={`requirements.${String(i)}`}
              row={row}
              sources={sources}
              onChange={(change) =>
                edit((d) => {
                  d.requirements[i] = {
                    ...change(at(d.requirements, i)),
                    trackKey: at(d.requirements, i).trackKey,
                  };
                })
              }
              errorsOf={errorsOf}
              invalid={invalid}
              describedBy={describedBy}
            />
            <label>
              Applies to
              <select
                id={idOf(`requirements.${String(i)}.trackKey`)}
                value={row.trackKey}
                aria-invalid={invalid(`requirements.${String(i)}.trackKey`)}
                aria-describedby={describedBy(`requirements.${String(i)}.trackKey`)}
                onChange={(e) =>
                  edit((d) => {
                    at(d.requirements, i).trackKey = e.target.value;
                  })
                }
              >
                <option value="">Every project</option>
                {trackOptions.map((track) => (
                  <option key={track.uid} value={track.uid}>
                    Only the track: {track.label}
                  </option>
                ))}
              </select>
            </label>
            {errorsOf(`requirements.${String(i)}.trackKey`)}
            <button
              type="button"
              aria-label={`Remove requirement ${String(i + 1)}`}
              onClick={() =>
                edit((d) => {
                  d.requirements.splice(i, 1);
                })
              }
            >
              Remove requirement
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            edit((d) => {
              d.requirements.push(mut(blankRequirement()));
            })
          }
        >
          Add a requirement
        </button>
      </section>

      {/* 6. Prior work + tracks ----------------------------------------------------------------------------------------------------- */}
      <section aria-labelledby="h-prior">
        <h2 id="h-prior">6a. Prior-work policy</h2>
        <FactEditor
          title="Prior work"
          help="May teams reuse code or ideas they had before the event? Optional."
          field="priorWork"
          row={model.priorWork}
          sources={sources}
          onChange={(change) =>
            edit((d) => {
              d.priorWork = { ...change(d.priorWork), stance: d.priorWork.stance };
            })
          }
          errorsOf={errorsOf}
          invalid={invalid}
          describedBy={describedBy}
          extra={
            <>
              <label>
                Policy
                <select
                  id={idOf('priorWork.stance')}
                  value={model.priorWork.stance}
                  aria-invalid={invalid('priorWork.stance')}
                  aria-describedby={describedBy('priorWork.stance')}
                  onChange={(e) =>
                    edit((d) => {
                      d.priorWork.stance = e.target.value as PriorWorkStance;
                    })
                  }
                >
                  {STANCES.map((stance) => (
                    <option key={stance.value} value={stance.value}>
                      {stance.label}
                    </option>
                  ))}
                </select>
              </label>
              {errorsOf('priorWork.stance')}
            </>
          }
        />
      </section>

      <section aria-labelledby="h-tracks">
        <h2 id="h-tracks">6. Tracks and sponsor challenges</h2>
        <p>
          <small>
            A track is a category projects can enter, such as a theme or a sponsor’s challenge (a
            sponsor challenge is a track with its own requirements and, if published, its own
            rubric). Teams pick their tracks when they submit their project.
          </small>
        </p>
        {model.tracks.map((track, i) => (
          <TrackEditor
            key={track.uid}
            index={i}
            track={track}
            sources={sources}
            edit={edit}
            errorsOf={errorsOf}
            invalid={invalid}
            describedBy={describedBy}
          />
        ))}
        <button
          type="button"
          onClick={() => {
            nextUid.current += 1;
            const uid = `new-${String(nextUid.current)}`;
            edit((d) => {
              d.tracks.push(mut(blankTrack(uid)));
            });
          }}
        >
          Add a track
        </button>
      </section>

      {/* 7. Guidance ---------------------------------------------------------------------------------------------------------------- */}
      <section aria-labelledby="h-guidance">
        <h2 id="h-guidance">7. Organizer guidance (not official rules)</h2>
        <p>
          <small>
            Advice to judges that is not an official rule. It is shown to judges as guidance and is
            never treated as an official requirement.
          </small>
        </p>
        <FactList
          kind="guidance"
          field="guidance"
          rows={model.guidance}
          sources={sources}
          guidance
          onChange={(change) =>
            edit((d) => {
              d.guidance = change(d.guidance);
            })
          }
          errorsOf={errorsOf}
          invalid={invalid}
          describedBy={describedBy}
        />
      </section>

      {model.conflicts.length > 0 ? (
        <section aria-labelledby="h-conflicts">
          <h2 id="h-conflicts">Conflicts between sources</h2>
          <p className="notice" role="note">
            {model.conflicts.length} conflict(s) between sources were recorded on this draft. They
            are kept exactly as they are; their resolution follows the sources’ authority and is
            shown when you review the version.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="h-save">
        <h2 id="h-save">Save</h2>
        <label>
          What changed (optional)
          <input name="summary" defaultValue={initial.summary} maxLength={5000} />
        </label>
        <p>
          <small>
            Saving stores a draft. Next you review the result and lock the version; a locked version
            can no longer be edited (a new version is created for later changes).
          </small>
        </p>
        <SaveButton />
      </section>
    </form>
  );
}

/** The element at `index` of a list the form rendered it from: its absence is a programming error, never a user error. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no row ${String(index)}`);
  return item;
}

/** The model types are readonly for the pure functions; the editor mutates a private clone. */
const mut = <T,>(value: T): Mutable<T> => value as Mutable<T>;

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Mutable<U>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

// -- Pieces ----------------------------------------------------------------------------------------------------------------------------

function BasisSelect({
  field,
  value,
  onChange,
  invalid,
  describedBy,
  allowOfficial = true,
}: {
  field: string;
  value: Basis;
  onChange: (basis: Basis) => void;
  invalid: boolean | undefined;
  describedBy: string | undefined;
  allowOfficial?: boolean;
}) {
  return (
    <label>
      What kind of statement is this?
      <select
        id={idOf(field)}
        value={value}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value as Basis)}
      >
        {BASIS_VALUES.filter((basis) => allowOfficial || basis !== 'official').map((basis) => (
          <option key={basis} value={basis}>
            {BASIS_LABEL[basis]}
          </option>
        ))}
      </select>
    </label>
  );
}

function SourcePicker({
  field,
  sources,
  selected,
  onChange,
  legend = 'Sources it comes from',
}: {
  field: string;
  sources: readonly SourceOption[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  legend?: string;
}) {
  const chosen = new Set(selected);
  if (sources.length === 0) {
    return (
      <p id={idOf(field)}>
        <small>No sources yet: add them on the version page first.</small>
      </p>
    );
  }
  return (
    <fieldset id={idOf(field)} aria-label={legend}>
      <legend>{legend}</legend>
      {sources.map((source) => (
        <label key={source.id} className="inline">
          <input
            type="checkbox"
            checked={chosen.has(source.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, source.id]
                  : selected.filter((id) => id !== source.id),
              )
            }
          />{' '}
          {source.title} <small>({isOfficial(source) ? 'official' : source.authority})</small>
        </label>
      ))}
    </fieldset>
  );
}

interface Shared {
  errorsOf: (field: string) => ReactNode;
  invalid: (field: string) => boolean | undefined;
  describedBy: (field: string) => string | undefined;
}

type FactChange = (row: Mutable<FactRow>) => Mutable<FactRow>;

function FactFields({
  label,
  field,
  row,
  sources,
  onChange,
  errorsOf,
  invalid,
  describedBy,
  guidance = false,
}: Shared & {
  label: string;
  field: string;
  row: FactRow;
  sources: readonly SourceOption[];
  onChange: (change: FactChange) => void;
  guidance?: boolean;
}) {
  return (
    <>
      <label>
        {label}
        <textarea
          id={idOf(`${field}.statement`)}
          rows={3}
          maxLength={5000}
          value={row.statement}
          aria-invalid={invalid(`${field}.statement`)}
          aria-describedby={describedBy(`${field}.statement`)}
          onChange={(e) => onChange((r) => ({ ...r, statement: e.target.value }))}
        />
      </label>
      {errorsOf(`${field}.statement`)}
      <BasisSelect
        field={`${field}.basis`}
        value={row.basis}
        allowOfficial={!guidance}
        onChange={(basis) => onChange((r) => ({ ...r, basis }))}
        invalid={invalid(`${field}.basis`)}
        describedBy={describedBy(`${field}.basis`)}
      />
      {errorsOf(`${field}.basis`)}
      <SourcePicker
        field={`${field}.sources`}
        sources={sources}
        selected={row.sourceIds}
        onChange={(ids) => onChange((r) => ({ ...r, sourceIds: ids }))}
      />
      {errorsOf(`${field}.sources`)}
    </>
  );
}

function FactEditor({
  title,
  help,
  field,
  row,
  sources,
  onChange,
  extra,
  ...shared
}: Shared & {
  title: string;
  help: string;
  field: string;
  row: FactRow;
  sources: readonly SourceOption[];
  onChange: (change: FactChange) => void;
  extra?: ReactNode;
}) {
  return (
    <fieldset>
      <legend>{title}</legend>
      <p>
        <small>{help}</small>
      </p>
      <FactFields
        label="Statement"
        field={field}
        row={row}
        sources={sources}
        onChange={onChange}
        {...shared}
      />
      {extra}
    </fieldset>
  );
}

function FactList({
  kind,
  field,
  rows,
  sources,
  onChange,
  guidance = false,
  ...shared
}: Shared & {
  kind: 'rule' | 'guidance';
  field: string;
  rows: readonly FactRow[];
  sources: readonly SourceOption[];
  onChange: (change: (rows: Mutable<FactRow>[]) => Mutable<FactRow>[]) => void;
  guidance?: boolean;
}) {
  const noun = kind === 'rule' ? 'rule' : 'guidance';
  return (
    <>
      {rows.map((row, i) => (
        <div key={i} className="card" data-testid={`${field}-${String(i)}`}>
          <FactFields
            label={`${kind === 'rule' ? 'Rule' : 'Guidance'} ${String(i + 1)}`}
            field={`${field}.${String(i)}`}
            row={row}
            sources={sources}
            guidance={guidance}
            onChange={(change) => onChange((list) => list.map((r, j) => (j === i ? change(r) : r)))}
            {...shared}
          />
          <button
            type="button"
            aria-label={`Remove ${noun} ${String(i + 1)}`}
            onClick={() => onChange((list) => list.filter((_, j) => j !== i))}
          >
            Remove {noun}
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange((list) => [
            ...list,
            { ...blankFactRow(), basis: guidance ? 'interpreted' : 'official' } as Mutable<FactRow>,
          ])
        }
      >
        Add {kind === 'rule' ? 'a rule' : 'guidance'}
      </button>
    </>
  );
}

function TrackEditor({
  index,
  track,
  sources,
  edit,
  errorsOf,
  invalid,
  describedBy,
}: Shared & {
  index: number;
  track: TrackRow;
  sources: readonly SourceOption[];
  edit: (change: (draft: Mutable<EditorModel>) => void) => void;
}) {
  const field = `tracks.${String(index)}`;
  return (
    <div className="card" data-testid={`track-${String(index)}`}>
      <label>
        Track name
        <input
          id={idOf(`${field}.name`)}
          value={track.name}
          maxLength={200}
          aria-invalid={invalid(`${field}.name`)}
          aria-describedby={describedBy(`${field}.name`)}
          onChange={(e) =>
            edit((d) => {
              at(d.tracks, index).name = e.target.value;
            })
          }
        />
      </label>
      {errorsOf(`${field}.name`)}
      <label>
        What the track is about (optional)
        <textarea
          rows={2}
          value={track.description}
          maxLength={5000}
          onChange={(e) =>
            edit((d) => {
              at(d.tracks, index).description = e.target.value;
            })
          }
        />
      </label>
      <SourcePicker
        field={`${field}.sources`}
        sources={sources}
        selected={track.sourceIds}
        legend="Source that defines this track"
        onChange={(ids) =>
          edit((d) => {
            at(d.tracks, index).sourceIds = ids;
          })
        }
      />
      {errorsOf(`${field}.sources`)}
      <button
        type="button"
        aria-label={`Remove track ${String(index + 1)}`}
        onClick={() =>
          edit((d) => {
            d.tracks.splice(index, 1);
          })
        }
      >
        Remove track
      </button>
    </div>
  );
}

function RubricEditor({
  index,
  rubric,
  sources,
  trackOptions,
  edit,
  errorsOf,
  invalid,
  describedBy,
}: Shared & {
  index: number;
  rubric: RubricRow;
  sources: readonly SourceOption[];
  trackOptions: readonly { uid: string; label: string }[];
  edit: (change: (draft: Mutable<EditorModel>) => void) => void;
}) {
  const field = `rubrics.${String(index)}`;
  const weights = rubric.criteria
    .map((criterion) => criterion.weightPct.trim())
    .filter((w) => w !== '');
  const total = weights.reduce((sum, w) => sum + (Number.isFinite(Number(w)) ? Number(w) : 0), 0);
  return (
    <fieldset className="card" data-testid={`rubric-${String(index)}`}>
      <legend>{rubric.scope === 'overall' ? 'Overall judging rubric' : 'Track rubric'}</legend>
      {rubric.scope === 'track' ? (
        <>
          <label>
            Track
            <select
              id={idOf(`${field}.trackKey`)}
              value={rubric.trackKey}
              aria-invalid={invalid(`${field}.trackKey`)}
              aria-describedby={describedBy(`${field}.trackKey`)}
              onChange={(e) =>
                edit((d) => {
                  at(d.rubrics, index).trackKey = e.target.value;
                })
              }
            >
              <option value="">Choose a track…</option>
              {trackOptions.map((track) => (
                <option key={track.uid} value={track.uid}>
                  {track.label}
                </option>
              ))}
            </select>
          </label>
          {errorsOf(`${field}.trackKey`)}
        </>
      ) : null}
      <label>
        Rubric name
        <input
          id={idOf(`${field}.name`)}
          value={rubric.name}
          maxLength={200}
          placeholder="For example: Official judging criteria"
          aria-invalid={invalid(`${field}.name`)}
          aria-describedby={describedBy(`${field}.name`)}
          onChange={(e) =>
            edit((d) => {
              at(d.rubrics, index).name = e.target.value;
            })
          }
        />
      </label>
      {errorsOf(`${field}.name`)}
      <div className="pair">
        <label>
          Lowest score
          <input
            id={idOf(`${field}.scaleMin`)}
            inputMode="decimal"
            value={rubric.scaleMin}
            placeholder="1"
            aria-invalid={invalid(`${field}.scaleMin`)}
            aria-describedby={describedBy(`${field}.scaleMin`)}
            onChange={(e) =>
              edit((d) => {
                at(d.rubrics, index).scaleMin = e.target.value;
              })
            }
          />
        </label>
        <label>
          Highest score
          <input
            id={idOf(`${field}.scaleMax`)}
            inputMode="decimal"
            value={rubric.scaleMax}
            placeholder="5"
            aria-invalid={invalid(`${field}.scaleMax`)}
            aria-describedby={describedBy(`${field}.scaleMax`)}
            onChange={(e) =>
              edit((d) => {
                at(d.rubrics, index).scaleMax = e.target.value;
              })
            }
          />
        </label>
      </div>
      {errorsOf(`${field}.scaleMin`)}
      {errorsOf(`${field}.scaleMax`)}
      <SourcePicker
        field={`${field}.sources`}
        sources={sources}
        selected={rubric.sourceIds}
        legend="Official source these criteria come from"
        onChange={(ids) =>
          edit((d) => {
            at(d.rubrics, index).sourceIds = ids;
          })
        }
      />
      {errorsOf(`${field}.sources`)}
      <h3>Criteria</h3>
      {rubric.criteria.map((criterion, c) => (
        <CriterionEditor
          key={c}
          rubricIndex={index}
          index={c}
          criterion={criterion}
          edit={edit}
          errorsOf={errorsOf}
          invalid={invalid}
          describedBy={describedBy}
        />
      ))}
      {errorsOf(`${field}.criteria`)}
      <p data-testid={`weight-total-${String(index)}`}>
        {weights.length === 0
          ? 'Weights: none entered (the rubric is unweighted).'
          : `Weights entered: ${formatPercent(total)} % of 100 %${Math.abs(total - 100) > 1e-4 ? ' — they must total 100 % before the version can be locked.' : '.'}`}
      </p>
      <button
        type="button"
        onClick={() =>
          edit((d) => {
            at(d.rubrics, index).criteria.push(mut(blankCriterion()));
          })
        }
      >
        Add a criterion
      </button>{' '}
      <button
        type="button"
        aria-label={`Remove rubric ${String(index + 1)}`}
        onClick={() =>
          edit((d) => {
            d.rubrics.splice(index, 1);
          })
        }
      >
        Remove this rubric
      </button>
    </fieldset>
  );
}

function CriterionEditor({
  rubricIndex,
  index,
  criterion,
  edit,
  errorsOf,
  invalid,
  describedBy,
}: Shared & {
  rubricIndex: number;
  index: number;
  criterion: CriterionRow;
  edit: (change: (draft: Mutable<EditorModel>) => void) => void;
}) {
  const field = `rubrics.${String(rubricIndex)}.criteria.${String(index)}`;
  const set = (change: (c: Mutable<CriterionRow>) => void) =>
    edit((d) => change(at(at(d.rubrics, rubricIndex).criteria, index)));
  return (
    <div className="card" data-testid={`criterion-${String(rubricIndex)}-${String(index)}`}>
      <label>
        Criterion {index + 1} name
        <input
          id={idOf(`${field}.name`)}
          value={criterion.name}
          maxLength={200}
          aria-invalid={invalid(`${field}.name`)}
          aria-describedby={describedBy(`${field}.name`)}
          onChange={(e) =>
            set((c) => {
              c.name = e.target.value;
            })
          }
        />
      </label>
      {errorsOf(`${field}.name`)}
      <label>
        What it measures (optional)
        <textarea
          rows={2}
          value={criterion.description}
          maxLength={5000}
          onChange={(e) =>
            set((c) => {
              c.description = e.target.value;
            })
          }
        />
      </label>
      <label>
        Weight in percent (leave empty if the rubric publishes no weights)
        <input
          id={idOf(`${field}.weightPct`)}
          inputMode="decimal"
          value={criterion.weightPct}
          placeholder="e.g. 40"
          aria-invalid={invalid(`${field}.weightPct`)}
          aria-describedby={describedBy(`${field}.weightPct`)}
          onChange={(e) =>
            set((c) => {
              c.weightPct = e.target.value;
            })
          }
        />
      </label>
      {errorsOf(`${field}.weightPct`)}
      <details open={criterion.anchors.length > 0}>
        <summary>Scoring guide (optional): what each score looks like</summary>
        {criterion.anchors.map((anchor, a) => (
          <AnchorEditor
            key={a}
            field={`${field}.anchors.${String(a)}`}
            anchor={anchor}
            onChange={(next) =>
              set((c) => {
                c.anchors[a] = next;
              })
            }
            onRemove={() =>
              set((c) => {
                c.anchors.splice(a, 1);
              })
            }
            errorsOf={errorsOf}
            invalid={invalid}
            describedBy={describedBy}
          />
        ))}
        <button
          type="button"
          onClick={() =>
            set((c) => {
              c.anchors.push({ score: '', description: '' });
            })
          }
        >
          Add a scoring-guide row
        </button>
      </details>
      <button
        type="button"
        aria-label={`Remove criterion ${String(index + 1)}`}
        onClick={() =>
          edit((d) => {
            at(d.rubrics, rubricIndex).criteria.splice(index, 1);
          })
        }
      >
        Remove criterion
      </button>
    </div>
  );
}

function AnchorEditor({
  field,
  anchor,
  onChange,
  onRemove,
  errorsOf,
  invalid,
  describedBy,
}: Shared & {
  field: string;
  anchor: AnchorRow;
  onChange: (next: { score: string; description: string }) => void;
  onRemove: () => void;
}) {
  return (
    <div className="pair">
      <label>
        Score
        <input
          id={idOf(`${field}.score`)}
          inputMode="decimal"
          value={anchor.score}
          aria-invalid={invalid(`${field}.score`)}
          aria-describedby={describedBy(`${field}.score`)}
          onChange={(e) => onChange({ ...anchor, score: e.target.value })}
        />
      </label>
      <label>
        What this score means
        <input
          id={idOf(`${field}.description`)}
          value={anchor.description}
          aria-invalid={invalid(`${field}.description`)}
          aria-describedby={describedBy(`${field}.description`)}
          onChange={(e) => onChange({ ...anchor, description: e.target.value })}
        />
      </label>
      <button type="button" aria-label="Remove this scoring-guide row" onClick={onRemove}>
        Remove
      </button>
      {errorsOf(`${field}.score`)}
      {errorsOf(`${field}.description`)}
    </div>
  );
}
