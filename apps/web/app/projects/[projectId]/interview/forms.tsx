'use client';

import type { TeamAnswerView } from '@judge-copilot/schemas';
import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import {
  answerChoiceLabel,
  OBSERVATION_OUTCOME_LABELS,
  OBSERVATION_OUTCOME_MEANINGS,
  OBSERVATION_OUTCOME_VALUES,
} from '../../../../lib/interview-view';
import { EMPTY_INTERVIEW_FORM, type InterviewFormState } from '../../../../lib/interview-form';
import { recordJudgeObservationAction, recordTeamAnswerAction } from './actions';

/*
 * The two forms of Interview Mode. Each is a small client component over a server action. The REQUEST KEY is rendered by the server for this page load and is
 * part of the form: pressing Save twice, or pressing it again after an answer that never arrived, is the same request and is saved once. A refused or failed
 * save keeps everything the judge typed. After a successful save the form starts empty and the server renders a new request key for the next record.
 */

const ANSWER_MAX = 4000;
const SUBJECT_MAX = 500;
const OBSERVED_MAX = 4000;

function SaveButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? busy : idle}
    </button>
  );
}

function Feedback({ state, testId }: { state: InterviewFormState; testId: string }) {
  return (
    <>
      {state.error ? (
        <p role="alert" className="error" data-testid={`${testId}-error`}>
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p role="status" className="notice" data-testid={`${testId}-saved`}>
          Saved. It appears in the list above exactly as recorded.
        </p>
      ) : null}
    </>
  );
}

export function TeamAnswerForm(props: {
  readonly projectId: string;
  readonly setId: string;
  readonly questionId: string;
  readonly requestKey: string;
  readonly testId: string;
  /** Set when this form records a CORRECTION of an earlier record. */
  readonly supersedesAnswerId?: string;
  readonly label?: string;
  readonly buttonLabel?: string;
}) {
  const [state, action] = useActionState(recordTeamAnswerAction, EMPTY_INTERVIEW_FORM);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (state.error) area.current?.focus();
  }, [state.attempt, state.error]);
  return (
    <form action={action} className="stack interview-form" data-testid={props.testId} noValidate>
      <input type="hidden" name="projectId" value={props.projectId} />
      <input type="hidden" name="setId" value={props.setId} />
      <input type="hidden" name="questionId" value={props.questionId} />
      <input type="hidden" name="requestKey" value={props.requestKey} />
      {props.supersedesAnswerId ? (
        <input type="hidden" name="supersedesAnswerId" value={props.supersedesAnswerId} />
      ) : null}
      <label>
        {props.label ?? 'What the team answered'}
        <textarea
          ref={area}
          name="text"
          rows={4}
          maxLength={ANSWER_MAX}
          defaultValue={state.values.text}
          key={`t-${String(state.attempt)}`}
          aria-invalid={state.error ? true : undefined}
          data-testid={`${props.testId}-text`}
        />
      </label>
      <p>
        <small>
          Type what the team said, as closely as you can. It is recorded as testimony, not as a
          verified fact.
        </small>
      </p>
      <Feedback state={state} testId={props.testId} />
      <SaveButton idle={props.buttonLabel ?? 'Save team answer'} busy="Saving…" />
    </form>
  );
}

export function JudgeObservationForm(props: {
  readonly projectId: string;
  readonly assessmentId: string;
  readonly requestKey: string;
  readonly testId: string;
  /** The question this observation is about; both or neither. */
  readonly setId?: string;
  readonly questionId?: string;
  /** The team answers of that question the judge may link (the current ones). */
  readonly answers?: readonly TeamAnswerView[];
  readonly supersedesObservationId?: string;
  readonly buttonLabel?: string;
}) {
  const [state, action] = useActionState(recordJudgeObservationAction, EMPTY_INTERVIEW_FORM);
  const subject = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.error) subject.current?.focus();
  }, [state.attempt, state.error]);
  const answers = props.answers ?? [];
  return (
    <form action={action} className="stack interview-form" data-testid={props.testId} noValidate>
      <input type="hidden" name="projectId" value={props.projectId} />
      <input type="hidden" name="assessmentId" value={props.assessmentId} />
      <input type="hidden" name="requestKey" value={props.requestKey} />
      {props.setId && props.questionId ? (
        <>
          <input type="hidden" name="setId" value={props.setId} />
          <input type="hidden" name="questionId" value={props.questionId} />
        </>
      ) : null}
      {props.supersedesObservationId ? (
        <input type="hidden" name="supersedesObservationId" value={props.supersedesObservationId} />
      ) : null}
      <label>
        What was demonstrated or examined
        <input
          ref={subject}
          name="subject"
          autoComplete="off"
          maxLength={SUBJECT_MAX}
          defaultValue={state.values.subject}
          key={`s-${String(state.attempt)}`}
          data-testid={`${props.testId}-subject`}
        />
      </label>
      <label>
        What you directly observed
        <textarea
          name="observed"
          rows={3}
          maxLength={OBSERVED_MAX}
          defaultValue={state.values.observed}
          key={`o-${String(state.attempt)}`}
          data-testid={`${props.testId}-observed`}
        />
      </label>
      <fieldset key={`r-${String(state.attempt)}`}>
        <legend>What the attempt showed</legend>
        {OBSERVATION_OUTCOME_VALUES.map((outcome) => (
          <label key={outcome} className="inline outcome-choice">
            <input
              type="radio"
              name="outcome"
              value={outcome}
              defaultChecked={state.values.outcome === outcome}
              data-testid={`${props.testId}-outcome-${outcome}`}
            />{' '}
            <strong>{OBSERVATION_OUTCOME_LABELS[outcome]}</strong>
            <br />
            <small>{OBSERVATION_OUTCOME_MEANINGS[outcome]}</small>
          </label>
        ))}
      </fieldset>
      {answers.length > 0 ? (
        <label>
          The team answer this is about <small>(optional)</small>
          <select
            name="teamAnswerId"
            defaultValue={state.values.teamAnswerId}
            key={`a-${String(state.attempt)}`}
            data-testid={`${props.testId}-answer`}
          >
            <option value="">None in particular</option>
            {answers.map((answer) => (
              <option key={answer.id} value={answer.id}>
                {answerChoiceLabel(answer)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p>
        <small>
          This is your own report of what you saw. It is recorded separately from the team’s answer,
          the system does not check it, and it changes no score.
        </small>
      </p>
      <Feedback state={state} testId={props.testId} />
      <SaveButton idle={props.buttonLabel ?? 'Save observation'} busy="Saving…" />
    </form>
  );
}
