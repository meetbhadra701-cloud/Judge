import type { QuestionSetView, SelectedQuestionView } from '@judge-copilot/schemas';
import type { ReactNode } from 'react';
import {
  countLine,
  EXPECTED_INFORMATION_LABELS,
  KIND_LABELS,
  MODE_HINTS,
  MODE_LABELS,
  REFERENCE_TYPE_LABELS,
  SEVERITY_LABELS,
  weightText,
  type QuestionsPanelState,
} from '../../../../lib/questions-view';

/*
 * The "Five Questions" section of a VERIFIED preliminary report. It shows the stored question set exactly as the API returns it: the order, the wording, the
 * reason, the uncertainty each question addresses and the records it draws on. It has no answer field, changes no score, and ranks nothing itself. A set
 * produced by an offline demonstration is labelled as one and is never described as AI-generated. Project-supplied text (a claim, a recorded gap) is rendered as
 * text by React, never as markup.
 */

export interface QuestionsSectionProps {
  readonly projectId: string;
  readonly assessmentId: string;
  readonly state: QuestionsPanelState;
  readonly generateAction: (formData: FormData) => void | Promise<void>;
}

export function QuestionsSection(props: QuestionsSectionProps): ReactNode {
  const { state } = props;
  if (state.kind === 'hidden') return null;
  return (
    <section
      aria-labelledby="questions-heading"
      data-testid="five-questions"
      data-state={state.kind}
    >
      <h2 id="questions-heading">Five Questions</h2>
      <p className="notice" role="note">
        Suggested prompts for your interview, built from what this report could not establish. They
        are not findings, they are not a script, and no question or answer changes any score. You
        may ask different questions, or none.
      </p>
      {state.kind === 'unavailable' ? (
        <p role="status" data-testid="questions-unavailable">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'withheld' ? (
        <p role="alert" className="error" data-testid="questions-withheld">
          The questions saved for this version are withheld because the assessment they were built
          from no longer passes its integrity checks. Nothing derived from it is shown.
        </p>
      ) : null}
      {state.kind === 'not_generated' ? (
        <NotGenerated
          projectId={props.projectId}
          assessmentId={props.assessmentId}
          canGenerate={state.canGenerate}
          notice={state.notice}
          action={props.generateAction}
        />
      ) : null}
      {state.kind === 'set' ? <SetView set={state.set} /> : null}
    </section>
  );
}

function NotGenerated({
  projectId,
  assessmentId,
  canGenerate,
  notice,
  action,
}: {
  projectId: string;
  assessmentId: string;
  canGenerate: boolean;
  notice: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <div data-testid="questions-not-generated">
      <p>No questions have been generated for this version yet.</p>
      <p className="notice" role="note" data-testid="questions-launch-notice">
        {notice}
      </p>
      {canGenerate ? (
        <form action={action}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="assessmentId" value={assessmentId} />
          <button type="submit" data-testid="generate-questions">
            Generate suggested questions
          </button>
        </form>
      ) : (
        <p data-testid="questions-cannot-generate">
          Questions cannot be generated here right now. You can still prepare your own from the
          unknowns and missing information above.
        </p>
      )}
    </div>
  );
}

function SetView({ set }: { set: QuestionSetView }) {
  const byId = new Map(set.opportunities.map((o) => [o.id, o] as const));
  return (
    <>
      {set.generation.demonstration ? (
        <p role="alert" className="error" data-testid="questions-demonstration-banner">
          <strong>OFFLINE DEMONSTRATION — NOT AI-GENERATED.</strong> {set.notices.advisory}
        </p>
      ) : (
        <p className="notice" role="note" data-testid="questions-ai-notice">
          {set.notices.advisory}
        </p>
      )}
      <p data-testid="questions-count">
        <strong>{countLine(set)}</strong>
      </p>
      {set.questions.length < 5 && set.shortfall ? (
        <div
          className="notice"
          role="note"
          data-testid="questions-shortfall"
          data-code={set.shortfall.code}
        >
          <p>
            <strong>Why fewer than five.</strong> {set.shortfall.explanation}
          </p>
          {set.shortfall.policyNote ? (
            <p data-testid="questions-policy-note">
              <small>{set.shortfall.policyNote}</small>
            </p>
          ) : null}
          <p>
            Nothing was added to fill the list. To prepare your own questions, start from the
            uncertainties below that no question above covers.
          </p>
        </div>
      ) : null}
      <ol className="questions" data-testid="questions-list">
        {set.questions.map((question) => (
          <QuestionCard key={question.id} question={question} opportunities={byId} />
        ))}
      </ol>
      <Uncertainties set={set} />
      <details data-testid="questions-method">
        <summary>How these were chosen</summary>
        <p>
          The uncertainties above were found by fixed rules from this report’s records: every
          expected source, criterion, claim and requirement was checked, and only gaps that could
          change what you understand about the project were kept. Wording was proposed for each, and
          every proposal was checked against the records before it could appear here. The order
          weighs how much of the rubric an uncertainty touches, how large it is, how well an answer
          would settle it, how easy it is to see for yourself, and how much interview time it takes,
          and it avoids two questions that would tell you the same thing. The ordering number is a
          ranking aid only: it is <strong>not a probability</strong> and not a score.
        </p>
        <p>
          <small>
            Engine {set.policyVersion} · prompt {set.generation.promptId}/
            {set.generation.promptVersion} · {set.counts.opportunities} uncertaint
            {set.counts.opportunities === 1 ? 'y' : 'ies'} · {set.counts.candidates} candidate
            {set.counts.candidates === 1 ? '' : 's'} checked · {set.counts.rejected} refused ·
            generated for assessment version {set.assessmentVersionNumber}
          </small>
        </p>
        {set.rejections.length > 0 ? (
          <p>
            <small data-testid="questions-rejections">
              Refused candidates are not shown. By reason:{' '}
              {set.rejections
                .map((r) => `${r.code.replaceAll('_', ' ')} ×${String(r.count)}`)
                .join(', ')}
              .
            </small>
          </p>
        ) : null}
      </details>
    </>
  );
}

function QuestionCard({
  question,
  opportunities,
}: {
  question: SelectedQuestionView;
  opportunities: ReadonlyMap<string, QuestionSetView['opportunities'][number]>;
}) {
  const addressed = question.opportunityIds.flatMap((id) => {
    const found = opportunities.get(id);
    return found ? [found] : [];
  });
  return (
    <li
      data-testid={`question-${String(question.rank)}`}
      data-rank={question.rank}
      data-mode={question.mode}
    >
      <h3>
        <span className="badge">Question {question.rank}</span>{' '}
        <span className="tag" title={MODE_HINTS[question.mode]}>
          {MODE_LABELS[question.mode]}
        </span>
      </h3>
      <p data-testid={`question-${String(question.rank)}-text`}>
        <strong>{question.text}</strong>
      </p>
      <dl>
        <dt>Why it matters</dt>
        <dd data-testid={`question-${String(question.rank)}-reason`}>{question.reason}</dd>
        <dt>Uncertainty it addresses</dt>
        <dd>
          <ul>
            {addressed.map((o) => (
              <li key={o.id} data-testid={`question-${String(question.rank)}-uncertainty`}>
                <span className="tag">{KIND_LABELS[o.kind]}</span>{' '}
                <small>({SEVERITY_LABELS[o.severity]})</small> {o.observation}
              </li>
            ))}
          </ul>
        </dd>
        {question.dimensions.length > 0 ? (
          <>
            <dt>Rubric criteria</dt>
            <dd data-testid={`question-${String(question.rank)}-dimensions`}>
              {question.dimensions
                .map((d) => {
                  const weight = weightText(d.weightShare);
                  return weight === null ? d.name : `${d.name} (${weight})`;
                })
                .join('; ')}
            </dd>
          </>
        ) : null}
        {question.references.length > 0 ? (
          <>
            <dt>Linked evidence and unknowns</dt>
            <dd>
              <ul data-testid={`question-${String(question.rank)}-links`}>
                {question.references.map((reference) => (
                  <li key={`${reference.type}:${reference.id}`}>
                    <span className="tag">{REFERENCE_TYPE_LABELS[reference.type]}</span>{' '}
                    {reference.label}
                    {reference.verificationLevel ? (
                      <small>
                        {' '}
                        · recorded as {reference.verificationLevel.replaceAll('_', ' ')}
                      </small>
                    ) : null}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        <dt>What would settle it</dt>
        <dd>
          {question.expectedInformation.map((info) => EXPECTED_INFORMATION_LABELS[info]).join(', ')}
        </dd>
      </dl>
    </li>
  );
}

function Uncertainties({ set }: { set: QuestionSetView }) {
  if (set.opportunities.length === 0) {
    return (
      <p data-testid="questions-no-uncertainty">
        The analysis found nothing that could materially change what you understand about this
        project.
      </p>
    );
  }
  return (
    <details open={set.questions.length < 5} data-testid="questions-uncertainties">
      <summary>
        All {set.opportunities.length} open uncertaint{set.opportunities.length === 1 ? 'y' : 'ies'}{' '}
        found (for your own questions)
      </summary>
      <p>
        <small>
          Each is a gap in what was submitted or examined, not a finding against the project.
        </small>
      </p>
      <ol>
        {set.opportunities.map((o) => {
          const asked = set.questions
            .filter((q) => q.opportunityIds.includes(o.id))
            .map((q) => q.rank);
          return (
            <li key={o.id} data-testid="uncertainty" data-covered={asked.length > 0 ? 'yes' : 'no'}>
              <span className="tag">{KIND_LABELS[o.kind]}</span> {o.observation}{' '}
              <small>
                {asked.length > 0
                  ? `Asked in question ${asked.join(', ')}.`
                  : 'No question above covers this: available for your own follow-up.'}
              </small>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
