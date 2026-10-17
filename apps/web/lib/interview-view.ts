import {
  OBSERVATION_OUTCOME_LABELS,
  OBSERVATION_OUTCOME_MEANINGS,
  OBSERVATION_OUTCOME_VALUES,
  type InterviewRecordsResponse,
  type JudgeObservationView,
  type ObservationOutcome,
  type QuestionSetView,
  type SelectedQuestionView,
  type TeamAnswerView,
} from '@judge-copilot/schemas';

/*
 * What the Interview Mode page shows, decided in one place from the API's verified read models. Nothing here computes a number, evaluates an answer, ranks
 * anything or changes a score: it only groups the stored records under the question they belong to.
 */

export { OBSERVATION_OUTCOME_LABELS, OBSERVATION_OUTCOME_MEANINGS, OBSERVATION_OUTCOME_VALUES };

export const ROLE_LABELS = { judge: 'judge', organizer: 'organizer' } as const;

export type InterviewState =
  /** The API could not be reached or answered. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /** The project has no assessment yet. */
  | { readonly kind: 'no_assessment' }
  /** The assessment does not verify: no question, no record and no form is shown. */
  | { readonly kind: 'unverified' }
  | {
      readonly kind: 'ready';
      readonly assessmentVersionNumber: number;
      /** The stored question set being interviewed from, or null when the assessment has none. */
      readonly set: QuestionSetView | null;
      readonly records: InterviewRecordsResponse;
      /** Null when records can be added; otherwise why this page is read-only history. */
      readonly readOnlyReason: string | null;
      readonly assessmentId: string;
    };

export const READ_ONLY_REASONS = {
  voided:
    'This project was voided by an organizer, so no new interview record can be added. Its interview history stays readable below.',
  historicalAssessment:
    'This is an earlier assessment of the project. It is shown as history: new interview records are added to the newest assessment.',
  historicalSet:
    'This is an earlier question set of the assessment. It is shown as history: new interview records are added to the newest question set.',
} as const;

export function readOnlyReasonOf(input: {
  readonly voided: boolean;
  readonly isNewestAssessment: boolean;
  readonly isNewestSet: boolean;
}): string | null {
  if (input.voided) return READ_ONLY_REASONS.voided;
  if (!input.isNewestAssessment) return READ_ONLY_REASONS.historicalAssessment;
  if (!input.isNewestSet) return READ_ONLY_REASONS.historicalSet;
  return null;
}

export interface QuestionThread {
  readonly question: SelectedQuestionView;
  /** Oldest first: the original, then every correction. */
  readonly answers: readonly TeamAnswerView[];
  readonly observations: readonly JudgeObservationView[];
}

export interface InterviewThreads {
  readonly threads: readonly QuestionThread[];
  /** Observations about the assessment as a whole (no question). */
  readonly standalone: readonly JudgeObservationView[];
  /** Records saved under another question set of the same assessment: kept visible, never hidden by the choice of set. */
  readonly elsewhere: {
    readonly answers: readonly TeamAnswerView[];
    readonly observations: readonly JudgeObservationView[];
  };
}

/** Groups the stored records under the questions of ONE set; everything else stays visible as "elsewhere" or "standalone". */
export function threadsOf(
  set: QuestionSetView | null,
  records: Pick<InterviewRecordsResponse, 'teamAnswers' | 'judgeObservations'>,
): InterviewThreads {
  const questionIds = new Set((set?.questions ?? []).map((q) => q.id));
  const here = (setId: string | null): boolean => set !== null && setId === set.id;
  return {
    threads: (set?.questions ?? []).map((question) => ({
      question,
      answers: records.teamAnswers.filter(
        (a) => a.questionId === question.id && here(a.questionSetId),
      ),
      observations: records.judgeObservations.filter(
        (o) => o.questionId === question.id && here(o.questionSetId),
      ),
    })),
    standalone: records.judgeObservations.filter((o) => o.questionId === null),
    elsewhere: {
      answers: records.teamAnswers.filter(
        (a) => !questionIds.has(a.questionId) || !here(a.questionSetId),
      ),
      observations: records.judgeObservations.filter(
        (o) => o.questionId !== null && (!questionIds.has(o.questionId) || !here(o.questionSetId)),
      ),
    },
  };
}

/** "Saved 3 Jan 2026, 14:05 UTC by judge-1 (judge)". UTC, so the same record reads the same everywhere. */
export function recordedLine(
  record: Pick<
    TeamAnswerView | JudgeObservationView,
    'recordedAt' | 'recordedBy' | 'recordedAsRole'
  >,
): string {
  const when = new Date(record.recordedAt);
  const text = Number.isNaN(when.getTime())
    ? record.recordedAt
    : `${when.toISOString().slice(0, 10)} ${when.toISOString().slice(11, 16)} UTC`;
  return `Saved ${text} by ${record.recordedBy.subject} (${ROLE_LABELS[record.recordedAsRole]})`;
}

export function isObservationOutcome(value: string): value is ObservationOutcome {
  return (OBSERVATION_OUTCOME_VALUES as readonly string[]).includes(value);
}

/** A short label of a team answer for a chooser: its first line, cut. */
export function answerChoiceLabel(answer: TeamAnswerView): string {
  const flat = answer.text.replace(/\s+/g, ' ').trim();
  const cut = flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
  return `${answer.recordedAt.slice(11, 16)} UTC — ${cut}`;
}
