import { z } from 'zod';
import { Uuid } from './primitives.js';

/*
 * M7: Interview Mode. The vocabularies, the strict request schemas and the HTTP contract of the two kinds of record a judge captures during an interview.
 * Layer 0: shape only. Nothing here scores, assesses or reasons about an answer.
 *
 *   TEAM ANSWER         "the judge recorded that the team said this". Testimony. It is NOT a verified fact, NOT evidence in the graph and NOT proof of anything.
 *   JUDGE OBSERVATION   "the authenticated judge reports observing this". A separate record of what was demonstrated or examined and what the judge directly
 *                       saw. It is the judge's own report: the system does not verify it and it is not (yet) trusted verification evidence.
 *
 * Both kinds are immutable once saved. A correction is a NEW record that names the one it supersedes; the original stays. M8 may consume these records; M7 does
 * not (no decomposition, no reassessment, no score change).
 */

export const INTERVIEW_LIMITS = {
  /** The team's answer, as typed. */
  answerMaxChars: 4_000,
  /** What was demonstrated or examined: a short label of the attempt. */
  subjectMaxChars: 500,
  /** What the judge directly observed. */
  observedMaxChars: 4_000,
} as const;

/**
 * What a live attempt amounted to, in the judge's own words. Every state DESCRIBES the attempt; none is a finding about the project and none is read as a
 * score. In particular `not_confirmed` and `unable_to_verify` are NOT evidence that the claim is false or that the project failed: an absence of confirmation is
 * not a negative finding (invariant 3).
 */
export const OBSERVATION_OUTCOME_VALUES = [
  'confirmed',
  'not_confirmed',
  'inconclusive',
  'unable_to_verify',
] as const;
export const ObservationOutcome = z.enum(OBSERVATION_OUTCOME_VALUES, {
  error: 'Choose what the attempt showed',
});
export type ObservationOutcome = z.infer<typeof ObservationOutcome>;

export const OBSERVATION_OUTCOME_LABELS: Readonly<Record<ObservationOutcome, string>> = {
  confirmed: 'The judge observed it',
  not_confirmed: 'The judge looked and did not observe it',
  inconclusive: 'Inconclusive',
  unable_to_verify: 'Could not be verified',
};

export const OBSERVATION_OUTCOME_MEANINGS: Readonly<Record<ObservationOutcome, string>> = {
  confirmed:
    'The judge reports directly observing what the team described. This is the judge’s own report, not a system check.',
  not_confirmed:
    'The judge looked for it during the interview and did not observe it. This is not evidence that it does not exist and not a finding against the project.',
  inconclusive:
    'What the judge saw neither supports nor contradicts the statement. Nothing follows from it.',
  unable_to_verify:
    'The attempt could not be carried out or checked (for example no time, no access or a technical problem). Nothing is inferred from this about the project.',
};

/** Who recorded a record, as a person can read it. `subject` is the identity provider’s stable subject; no credential is ever stored or shown. */
export interface InterviewActorView {
  readonly id: string;
  readonly subject: string;
}

/**
 * Which role the recording credential held when it was accepted. `judge` is the only role the human-verification path of a later milestone may rely on:
 * an organizer may record an interview as well, and the record then says so.
 */
export const RECORDER_ROLE_VALUES = ['judge', 'organizer'] as const;
export const RecorderRole = z.enum(RECORDER_ROLE_VALUES);
export type RecorderRole = z.infer<typeof RecorderRole>;

// -- Text ------------------------------------------------------------------------------------------------------------------------------

/*
 * Free text typed by a judge. It is stored as typed (line breaks as `\n`, trimmed at both ends), bounded in code points, and rendered by React as text, never as markup.
 * Refused: nothing at all, a lone surrogate (not valid UTF-8, the database would refuse it), a control character other than a tab or a line break (which includes
 * NUL), and the bidirectional-override characters that can make text read differently from how it is stored. The text is DATA: nothing reads it as an instruction.
 */
// The control and bidi ranges are the point of this pattern.
/* eslint-disable no-control-regex */
/** A lone surrogate: with the `u` flag a valid pair is one code point, so `\p{Cs}` matches only an unpaired one. */
const LONE_SURROGATE = /\p{Cs}/u;
const FORBIDDEN_TEXT = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]',
  'u',
);
/* eslint-enable no-control-regex */

/** The same rule as a PostgreSQL regex source, so the database enforces it too (ARE: escapes inside brackets are supported). */
export const INTERVIEW_FORBIDDEN_TEXT_SQL =
  '[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u202a-\\u202e\\u2066-\\u2069]';

function boundedText(max: number, what: string) {
  return (
    z
      .string()
      // a browser submits a textarea's line breaks as CRLF: one line-break convention is stored, so the same text is the same text everywhere (and a retry hashes the same)
      .transform((value) => value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim())
      .pipe(
        z
          .string()
          .min(1, `${what} must not be empty`)
          .refine(
            (value) => (value.match(/[\s\S]/gu) ?? []).length <= max,
            `${what} must be at most ${String(max)} characters`,
          )
          .refine((value) => !LONE_SURROGATE.test(value), `${what} must be valid text`)
          .refine(
            (value) => !FORBIDDEN_TEXT.test(value),
            `${what} contains characters that are not allowed`,
          ),
      )
  );
}

export const AnswerText = boundedText(INTERVIEW_LIMITS.answerMaxChars, 'The answer');
export const ObservationSubject = boundedText(
  INTERVIEW_LIMITS.subjectMaxChars,
  'What was demonstrated or examined',
);
export const ObservationText = boundedText(INTERVIEW_LIMITS.observedMaxChars, 'What was observed');

// -- Requests ----------------------------------------------------------------------------------------------------------------------------

/**
 * POST .../team-answers. The question comes from the PATH (and is checked against its set, its assessment and its project); the actor comes from the
 * credential. Strict: a `recordedBy`, a project, an assessment, a timestamp or any other key is an error, never ignored.
 */
export const RecordTeamAnswerRequest = z.strictObject({
  text: AnswerText,
  /** The record this one CORRECTS. It must be the newest record of its chain for the same question; the original is kept. */
  supersedesAnswerId: Uuid.optional(),
});
export type RecordTeamAnswerRequest = z.infer<typeof RecordTeamAnswerRequest>;

/**
 * POST .../judge-observations. `questionSetId` and `questionId` come together or not at all (an observation may stand alone, for the assessment); a linked team
 * answer needs its question.
 */
export const RecordJudgeObservationRequest = z
  .strictObject({
    subject: ObservationSubject,
    observed: ObservationText,
    outcome: ObservationOutcome,
    questionSetId: Uuid.optional(),
    questionId: Uuid.optional(),
    teamAnswerId: Uuid.optional(),
    supersedesObservationId: Uuid.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.questionSetId === undefined) !== (value.questionId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['questionId'],
        message: 'A question is named together with its question set, or not at all',
      });
    }
    if (value.teamAnswerId !== undefined && value.questionId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['teamAnswerId'],
        message: 'A linked team answer needs the question it answers',
      });
    }
  });
export type RecordJudgeObservationRequest = z.infer<typeof RecordJudgeObservationRequest>;

export const RecordTeamAnswerParams = z.strictObject({
  projectId: Uuid,
  setId: Uuid,
  questionId: Uuid,
});
export const RecordJudgeObservationParams = z.strictObject({
  projectId: Uuid,
  assessmentId: Uuid,
});
export const InterviewParams = z.strictObject({ projectId: Uuid, assessmentId: Uuid });

// -- The HTTP contract ------------------------------------------------------------------------------------------------------------------

export const INTERVIEW_TESTIMONY_NOTICE =
  'A team answer is what the judge recorded the team as saying. It is testimony, not a verified fact, and it changes no score.' as const;
export const INTERVIEW_OBSERVATION_NOTICE =
  'A judge observation is the judge’s own report of what they saw. It is recorded separately from the team’s answer, it is not checked by the system, and it changes no score.' as const;
export const INTERVIEW_IMMUTABLE_NOTICE =
  'Saved records are never edited or deleted. A correction is a new record that names the one it replaces; the original stays.' as const;

export interface TeamAnswerView {
  readonly id: string;
  readonly projectId: string;
  readonly assessmentId: string;
  readonly questionSetId: string;
  readonly questionId: string;
  readonly text: string;
  /** Server clock. */
  readonly recordedAt: string;
  readonly recordedBy: InterviewActorView;
  readonly recordedAsRole: RecorderRole;
  /** The record this one corrects, or null for an original. */
  readonly supersedesAnswerId: string | null;
  /** The record that corrects this one, or null when this is the newest of its chain. */
  readonly supersededByAnswerId: string | null;
  /** True when no later record corrects this one. */
  readonly isCurrent: boolean;
}

export interface JudgeObservationView {
  readonly id: string;
  readonly projectId: string;
  readonly assessmentId: string;
  readonly questionSetId: string | null;
  readonly questionId: string | null;
  readonly teamAnswerId: string | null;
  /** What was demonstrated or examined. */
  readonly subject: string;
  /** What the judge directly observed. */
  readonly observed: string;
  readonly outcome: ObservationOutcome;
  readonly recordedAt: string;
  readonly recordedBy: InterviewActorView;
  readonly recordedAsRole: RecorderRole;
  readonly supersedesObservationId: string | null;
  readonly supersededByObservationId: string | null;
  readonly isCurrent: boolean;
}

export interface InterviewRecordsResponse {
  readonly projectId: string;
  readonly assessmentId: string;
  /** Whether the assessment still verifies. When false NO record is returned (fail closed, as for the assessment and its question sets). */
  readonly assessmentVerified: boolean;
  /** A voided project keeps its interview history readable and accepts nothing new. */
  readonly voided: boolean;
  /** Oldest first, so the interview reads in the order it happened. */
  readonly teamAnswers: readonly TeamAnswerView[];
  readonly judgeObservations: readonly JudgeObservationView[];
  readonly notices: {
    readonly testimony: typeof INTERVIEW_TESTIMONY_NOTICE;
    readonly observation: typeof INTERVIEW_OBSERVATION_NOTICE;
    readonly immutable: typeof INTERVIEW_IMMUTABLE_NOTICE;
    readonly scores: 'interview_records_never_change_scores';
  };
}

export type RecordTeamAnswerResponse = {
  readonly result: 'created' | 'replayed';
  readonly teamAnswer: TeamAnswerView;
};
export type RecordJudgeObservationResponse = {
  readonly result: 'created' | 'replayed';
  readonly judgeObservation: JudgeObservationView;
};
