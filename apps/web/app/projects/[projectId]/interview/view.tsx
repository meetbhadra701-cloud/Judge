import type {
  InterviewRecordsResponse,
  JudgeObservationView,
  QuestionSetView,
  SelectedQuestionView,
  TeamAnswerView,
  UncertaintyOpportunityView,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  EXPECTED_INFORMATION_LABELS,
  KIND_LABELS,
  MODE_HINTS,
  MODE_LABELS,
  REFERENCE_TYPE_LABELS,
  SEVERITY_LABELS,
  weightText,
} from '../../../../lib/questions-view';
import {
  OBSERVATION_OUTCOME_LABELS,
  OBSERVATION_OUTCOME_MEANINGS,
  recordedLine,
  threadsOf,
  type InterviewState,
  type QuestionThread,
} from '../../../../lib/interview-view';
import { JudgeObservationForm, TeamAnswerForm } from './forms';

/*
 * Interview Mode: the page a judge uses DURING the interview. It shows each suggested question with everything it relates to (the uncertainty, the rubric
 * criteria and the evidence, all in view: nothing sits in a collapsed list), then the team's recorded answers to it and the judge's own observations of it, and
 * a form for each. A team answer is labelled testimony; an observation is labelled the judge's own report. Saved records are never edited: a correction is a new
 * record that names the one it replaces. Everything typed (by the team or the judge) is rendered as plain text by React, never as markup, and nothing on this page
 * reads, evaluates or scores it. This page changes no score and calls no model.
 */

export interface InterviewViewProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly state: InterviewState;
  /** A fresh request key for each form of this render (the identity of "this save"). */
  readonly keys: (name: string) => string;
}

function Header(props: { projectId: string; projectName: string; children?: ReactNode }) {
  return (
    <>
      <p>
        <Link href={`/projects/${encodeURIComponent(props.projectId)}/assessment`}>
          ← Preliminary report
        </Link>
      </p>
      <h1>Interview Mode</h1>
      <p>
        <strong>{props.projectName}</strong>
      </p>
      {props.children}
    </>
  );
}

export function InterviewPageView(props: InterviewViewProps): ReactNode {
  const { state } = props;
  if (state.kind !== 'ready') {
    return (
      <main data-testid="interview-page" data-state={state.kind}>
        <Header projectId={props.projectId} projectName={props.projectName} />
        {state.kind === 'unavailable' ? (
          <p role="alert" className="error" data-testid="interview-unavailable">
            {state.message}
          </p>
        ) : null}
        {state.kind === 'no_assessment' ? (
          <p role="status" data-testid="interview-no-assessment">
            This project has no assessment yet. Interview Mode works from a verified preliminary
            report: request one first.
          </p>
        ) : null}
        {state.kind === 'unverified' ? (
          <p role="alert" className="error" data-testid="interview-unverified">
            This assessment does not pass its integrity checks, so no question or interview record
            is shown or accepted for it.
          </p>
        ) : null}
      </main>
    );
  }
  const { set, records, readOnlyReason } = state;
  const canRecord = readOnlyReason === null;
  const grouped = threadsOf(set, records);
  const opportunities = new Map((set?.opportunities ?? []).map((o) => [o.id, o] as const));
  return (
    <main
      data-testid="interview-page"
      data-state="ready"
      data-can-record={canRecord ? 'yes' : 'no'}
    >
      <Header projectId={props.projectId} projectName={props.projectName}>
        <p>
          <small>
            Assessment version {state.assessmentVersionNumber}
            {set ? ` · question set saved ${set.createdAt.slice(0, 10)}` : ''}
          </small>
        </p>
      </Header>
      <div className="notice" role="note" data-testid="interview-notices">
        <p>
          <strong>How records work.</strong> {records.notices.testimony}
        </p>
        <p>{records.notices.observation}</p>
        <p>{records.notices.immutable}</p>
        <p>No answer or observation is evaluated here, and none changes any score.</p>
      </div>
      {readOnlyReason ? (
        <p role="note" className="notice" data-testid="interview-read-only">
          {readOnlyReason}
        </p>
      ) : null}
      {set === null ? (
        <p role="status" data-testid="interview-no-set">
          No suggested questions have been generated for this assessment, so there is nothing to ask
          from the list. You can still record what you observe about the project below.{' '}
          <Link href={`/projects/${encodeURIComponent(props.projectId)}/assessment`}>
            Generate the questions on the report page →
          </Link>
        </p>
      ) : (
        <SetBanner set={set} />
      )}
      {grouped.threads.length === 0 && set !== null ? (
        <p role="status" data-testid="interview-no-questions">
          This set selected no question. Nothing was added to fill it.
        </p>
      ) : null}
      <ol className="questions interview-questions" data-testid="interview-questions">
        {grouped.threads.map((thread) => (
          <QuestionBlock
            key={thread.question.id}
            thread={thread}
            projectId={props.projectId}
            assessmentId={state.assessmentId}
            setId={set?.id ?? ''}
            opportunities={opportunities}
            canRecord={canRecord}
            keys={props.keys}
          />
        ))}
      </ol>
      <section aria-labelledby="standalone-heading" data-testid="interview-standalone">
        <h2 id="standalone-heading">Observations about the project as a whole</h2>
        <p>
          <small>
            Not tied to one question: something you looked at or tried during the visit.
          </small>
        </p>
        <ObservationList observations={grouped.standalone} testId="standalone-observations" />
        {canRecord ? (
          <JudgeObservationForm
            projectId={props.projectId}
            assessmentId={state.assessmentId}
            requestKey={props.keys('observation-standalone')}
            testId="observation-form-standalone"
          />
        ) : null}
      </section>
      {grouped.elsewhere.answers.length + grouped.elsewhere.observations.length > 0 ? (
        <section aria-labelledby="elsewhere-heading" data-testid="interview-elsewhere">
          <h2 id="elsewhere-heading">Recorded under another question set of this assessment</h2>
          <p>
            <small>
              Kept visible here so nothing recorded is hidden by the choice of question set.
            </small>
          </p>
          <AnswerList answers={grouped.elsewhere.answers} testId="elsewhere-answers" />
          <ObservationList
            observations={grouped.elsewhere.observations}
            testId="elsewhere-observations"
          />
        </section>
      ) : null}
    </main>
  );
}

function SetBanner({ set }: { set: QuestionSetView }) {
  return (
    <>
      {set.generation.demonstration ? (
        <p role="alert" className="error" data-testid="interview-demonstration-banner">
          <strong>OFFLINE DEMONSTRATION — NOT AI-GENERATED.</strong> These suggested questions were
          produced by fixed rules, not phrased by a model. You may ask different questions, or none.
        </p>
      ) : (
        <p className="notice" role="note">
          {set.notices.advisory}
        </p>
      )}
      <p data-testid="interview-count">
        <strong>
          {set.questions.length === 5
            ? 'Five suggested questions.'
            : `${String(set.questions.length)} suggested question${set.questions.length === 1 ? '' : 's'} (fewer than five).`}
        </strong>
      </p>
      {set.questions.length < 5 && set.shortfall ? (
        <p className="notice" role="note" data-testid="interview-shortfall">
          <strong>Why fewer than five.</strong> {set.shortfall.explanation} Nothing was added to
          fill the list.
        </p>
      ) : null}
    </>
  );
}

function QuestionBlock(props: {
  thread: QuestionThread;
  projectId: string;
  assessmentId: string;
  setId: string;
  opportunities: ReadonlyMap<string, UncertaintyOpportunityView>;
  canRecord: boolean;
  keys: (name: string) => string;
}): ReactNode {
  const { question, answers, observations } = props.thread;
  const rank = String(question.rank);
  const currentAnswers = answers.filter((a) => a.isCurrent);
  return (
    <li
      data-testid={`interview-question-${rank}`}
      data-question-id={question.id}
      data-mode={question.mode}
    >
      <h2>
        <span className="badge">Question {question.rank}</span>{' '}
        <span className="tag" title={MODE_HINTS[question.mode]}>
          {MODE_LABELS[question.mode]}
        </span>
      </h2>
      <p data-testid={`interview-question-${rank}-text`}>
        <strong>{question.text}</strong>
      </p>
      <Evidence question={question} rank={rank} opportunities={props.opportunities} />
      <h3>What the team said</h3>
      <p>
        <small>Testimony recorded by the judge. Not a verified fact.</small>
      </p>
      <AnswerList answers={answers} testId={`question-${rank}-answers`} />
      {props.canRecord ? (
        <>
          <TeamAnswerForm
            projectId={props.projectId}
            setId={props.setId}
            questionId={question.id}
            requestKey={props.keys(`answer-${question.id}`)}
            testId={`answer-form-${rank}`}
          />
          {currentAnswers.map((answer) => (
            <details key={answer.id} data-testid={`correct-answer-${answer.id}`}>
              <summary>
                Record a correction of the answer saved {answer.recordedAt.slice(11, 16)} UTC
              </summary>
              <TeamAnswerForm
                projectId={props.projectId}
                setId={props.setId}
                questionId={question.id}
                requestKey={props.keys(`correct-${answer.id}`)}
                testId={`correct-answer-form-${answer.id}`}
                supersedesAnswerId={answer.id}
                label="The corrected answer"
                buttonLabel="Save correction"
              />
            </details>
          ))}
        </>
      ) : null}
      <h3>What the judge observed</h3>
      <p>
        <small>
          The judge’s own report of a live demonstration or check. Separate from the answer.
        </small>
      </p>
      <ObservationList observations={observations} testId={`question-${rank}-observations`} />
      {props.canRecord ? (
        <JudgeObservationForm
          projectId={props.projectId}
          assessmentId={props.assessmentId}
          requestKey={props.keys(`observation-${question.id}`)}
          testId={`observation-form-${rank}`}
          setId={props.setId}
          questionId={question.id}
          answers={currentAnswers}
        />
      ) : null}
    </li>
  );
}

/** The uncertainty, the rubric criteria and the evidence a question relates to, ALL in view. */
function Evidence(props: {
  question: SelectedQuestionView;
  rank: string;
  opportunities: ReadonlyMap<string, UncertaintyOpportunityView>;
}): ReactNode {
  const { question, rank } = props;
  const addressed = question.opportunityIds.flatMap((id) => {
    const found = props.opportunities.get(id);
    return found ? [found] : [];
  });
  return (
    <div className="interview-evidence" data-testid={`interview-question-${rank}-evidence`}>
      <p>
        <strong>Why it matters.</strong>{' '}
        <span data-testid={`interview-question-${rank}-reason`}>{question.reason}</span>
      </p>
      {addressed.length > 0 ? (
        <>
          <p>
            <strong>The uncertainty it addresses:</strong>
          </p>
          <ul data-testid={`interview-question-${rank}-uncertainty`}>
            {addressed.map((o) => (
              <li key={o.id}>
                <span className="tag">{KIND_LABELS[o.kind]}</span>{' '}
                <small>({SEVERITY_LABELS[o.severity]})</small> {o.observation}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {question.dimensions.length > 0 ? (
        <p data-testid={`interview-question-${rank}-dimensions`}>
          <strong>Rubric criteria:</strong>{' '}
          {question.dimensions
            .map((d) => {
              const weight = weightText(d.weightShare);
              return weight === null ? d.name : `${d.name} (${weight})`;
            })
            .join('; ')}
        </p>
      ) : null}
      {question.references.length > 0 ? (
        <>
          <p>
            <strong>Evidence and records it relates to:</strong>
          </p>
          <ul data-testid={`interview-question-${rank}-links`}>
            {question.references.map((reference) => (
              <li key={`${reference.type}:${reference.id}`}>
                <span className="tag">{REFERENCE_TYPE_LABELS[reference.type]}</span>{' '}
                {reference.label}
                {reference.verificationLevel ? (
                  <small> · recorded as {reference.verificationLevel.replaceAll('_', ' ')}</small>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p>
        <small>
          What would settle it:{' '}
          {question.expectedInformation.map((info) => EXPECTED_INFORMATION_LABELS[info]).join(', ')}
        </small>
      </p>
    </div>
  );
}

function AnswerList({
  answers,
  testId,
}: {
  answers: readonly TeamAnswerView[];
  testId: string;
}): ReactNode {
  if (answers.length === 0) {
    return (
      <p data-testid={`${testId}-empty`}>
        <small>No answer recorded yet. An unanswered question is not a failed question.</small>
      </p>
    );
  }
  return (
    <ul className="records" data-testid={testId}>
      {answers.map((answer) => (
        <li
          key={answer.id}
          data-testid="team-answer"
          data-record-id={answer.id}
          data-current={answer.isCurrent ? 'yes' : 'no'}
        >
          <span className="tag tag-muted">Team answer</span>
          {answer.supersedesAnswerId ? <span className="tag tag-human">Correction</span> : null}
          {!answer.isCurrent ? (
            <span className="tag tag-warn">Superseded by a later correction</span>
          ) : null}
          <blockquote className="typed" data-testid="team-answer-text">
            {answer.text}
          </blockquote>
          <small data-testid="team-answer-meta">{recordedLine(answer)}</small>
        </li>
      ))}
    </ul>
  );
}

function ObservationList({
  observations,
  testId,
}: {
  observations: readonly JudgeObservationView[];
  testId: string;
}): ReactNode {
  if (observations.length === 0) {
    return (
      <p data-testid={`${testId}-empty`}>
        <small>No observation recorded yet.</small>
      </p>
    );
  }
  return (
    <ul className="records" data-testid={testId}>
      {observations.map((o) => (
        <li
          key={o.id}
          data-testid="judge-observation"
          data-record-id={o.id}
          data-outcome={o.outcome}
          data-current={o.isCurrent ? 'yes' : 'no'}
        >
          <span className="tag tag-ok">Judge observation</span>
          <span
            className="tag"
            title={OBSERVATION_OUTCOME_MEANINGS[o.outcome]}
            data-testid="observation-outcome"
          >
            {OBSERVATION_OUTCOME_LABELS[o.outcome]}
          </span>
          {o.supersedesObservationId ? <span className="tag tag-human">Correction</span> : null}
          {!o.isCurrent ? (
            <span className="tag tag-warn">Superseded by a later correction</span>
          ) : null}
          <p>
            <strong>Examined:</strong>{' '}
            <span className="typed" data-testid="observation-subject">
              {o.subject}
            </span>
          </p>
          <blockquote className="typed" data-testid="observation-observed">
            {o.observed}
          </blockquote>
          <small>
            {OBSERVATION_OUTCOME_MEANINGS[o.outcome]} · {recordedLine(o)}
            {o.teamAnswerId ? ' · about a recorded team answer' : ''}
          </small>
        </li>
      ))}
    </ul>
  );
}

export type { InterviewRecordsResponse };
