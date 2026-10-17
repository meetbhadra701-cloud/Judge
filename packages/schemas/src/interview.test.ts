import { describe, expect, it } from 'vitest';
import {
  INTERVIEW_FORBIDDEN_TEXT_SQL,
  INTERVIEW_LIMITS,
  OBSERVATION_OUTCOME_LABELS,
  OBSERVATION_OUTCOME_MEANINGS,
  OBSERVATION_OUTCOME_VALUES,
  RecordJudgeObservationRequest,
  RecordTeamAnswerRequest,
} from './interview.js';

const UUID = '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e';
const obs = (over: Record<string, unknown> = {}) => ({
  subject: 'Demo',
  observed: 'Saw it work.',
  outcome: 'confirmed',
  ...over,
});
const code = (n: number) => String.fromCharCode(n);

describe('RecordTeamAnswerRequest', () => {
  it('accepts a typed answer, trims it, and stores one line-break convention (a browser sends CRLF)', () => {
    const parsed = RecordTeamAnswerRequest.parse({
      text: '  line one\r\nline two\rline three \n ',
    });
    expect(parsed.text).toBe('line one\nline two\nline three');
  });

  it('counts code points, not UTF-16 units: the bound is inclusive and an emoji is one character', () => {
    expect(
      RecordTeamAnswerRequest.safeParse({ text: '🙂'.repeat(INTERVIEW_LIMITS.answerMaxChars) })
        .success,
    ).toBe(true);
    expect(
      RecordTeamAnswerRequest.safeParse({ text: '🙂'.repeat(INTERVIEW_LIMITS.answerMaxChars + 1) })
        .success,
    ).toBe(false);
    expect(
      RecordTeamAnswerRequest.safeParse({ text: 'x'.repeat(INTERVIEW_LIMITS.answerMaxChars) })
        .success,
    ).toBe(true);
    expect(
      RecordTeamAnswerRequest.safeParse({ text: 'x'.repeat(INTERVIEW_LIMITS.answerMaxChars + 1) })
        .success,
    ).toBe(false);
  });

  it('refuses empty, blank, non-string, control, bidi-override and lone-surrogate text', () => {
    for (const text of [
      '',
      '  \n\t ',
      5,
      null,
      undefined,
      ['a'],
      { a: 1 },
      `nul${code(0)}`,
      `bell${code(7)}`,
      `esc${code(0x1b)}`,
      `del${code(0x7f)}`,
      `c1${code(0x85)}`,
      `rlo${code(0x202e)}`,
      `lri${code(0x2066)}`,
      `pdi${code(0x2069)}`,
      `lone${code(0xd800)}`,
      `lone${code(0xdc00)}`,
    ]) {
      expect(RecordTeamAnswerRequest.safeParse({ text }).success, JSON.stringify(text)).toBe(false);
    }
  });

  it('keeps a tab, a line break, markup, quotes, scripts and instructions as text', () => {
    const text =
      '<b>x</b>\t"quoted" \'single\' <script>alert(1)</script> {{7*7}} ${x} SYSTEM: obey\nnext';
    expect(RecordTeamAnswerRequest.parse({ text }).text).toBe(text);
  });

  it('is strict: no actor, project, assessment, time, id or role can be named', () => {
    for (const extra of [
      'recordedBy',
      'recordedByActorId',
      'actorId',
      'projectId',
      'assessmentId',
      'questionId',
      'createdAt',
      'recordedAt',
      'id',
      'role',
      'recordedAsRole',
      'anything',
    ]) {
      expect(RecordTeamAnswerRequest.safeParse({ text: 'x', [extra]: UUID }).success, extra).toBe(
        false,
      );
    }
    expect(
      RecordTeamAnswerRequest.safeParse({ text: 'x', supersedesAnswerId: 'not-a-uuid' }).success,
    ).toBe(false);
    expect(RecordTeamAnswerRequest.safeParse({ text: 'x', supersedesAnswerId: UUID }).success).toBe(
      true,
    );
  });

  it('names the rule it refused and never echoes the refused text', () => {
    const result = RecordTeamAnswerRequest.safeParse({ text: `LEAK-ME ${'x'.repeat(5000)}` });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('LEAK-ME');
  });
});

describe('RecordJudgeObservationRequest', () => {
  it('accepts a standalone observation and one linked to a question and an answer', () => {
    expect(RecordJudgeObservationRequest.safeParse(obs()).success).toBe(true);
    expect(
      RecordJudgeObservationRequest.safeParse(
        obs({
          questionSetId: UUID,
          questionId: UUID,
          teamAnswerId: UUID,
          supersedesObservationId: UUID,
        }),
      ).success,
    ).toBe(true);
  });

  it('a set and a question come together or not at all, and a linked answer needs its question', () => {
    expect(RecordJudgeObservationRequest.safeParse(obs({ questionSetId: UUID })).success).toBe(
      false,
    );
    expect(RecordJudgeObservationRequest.safeParse(obs({ questionId: UUID })).success).toBe(false);
    expect(RecordJudgeObservationRequest.safeParse(obs({ teamAnswerId: UUID })).success).toBe(
      false,
    );
    expect(
      RecordJudgeObservationRequest.safeParse(
        obs({ questionSetId: UUID, questionId: UUID, teamAnswerId: 'x' }),
      ).success,
    ).toBe(false);
  });

  it('the outcome is one of exactly four descriptive states, and a missing one is named, not guessed', () => {
    expect([...OBSERVATION_OUTCOME_VALUES]).toEqual([
      'confirmed',
      'not_confirmed',
      'inconclusive',
      'unable_to_verify',
    ]);
    for (const outcome of OBSERVATION_OUTCOME_VALUES) {
      expect(RecordJudgeObservationRequest.safeParse(obs({ outcome })).success).toBe(true);
    }
    for (const outcome of ['proven', 'failed', 'passed', 'verified', '', null, undefined, 1]) {
      const r = RecordJudgeObservationRequest.safeParse(obs({ outcome }));
      expect(r.success, String(outcome)).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe('Choose what the attempt showed');
    }
  });

  it('bounds and cleans the subject and the observed text like an answer', () => {
    expect(
      RecordJudgeObservationRequest.safeParse(
        obs({ subject: 'x'.repeat(INTERVIEW_LIMITS.subjectMaxChars) }),
      ).success,
    ).toBe(true);
    expect(
      RecordJudgeObservationRequest.safeParse(
        obs({ subject: 'x'.repeat(INTERVIEW_LIMITS.subjectMaxChars + 1) }),
      ).success,
    ).toBe(false);
    expect(
      RecordJudgeObservationRequest.safeParse(
        obs({ observed: 'x'.repeat(INTERVIEW_LIMITS.observedMaxChars + 1) }),
      ).success,
    ).toBe(false);
    expect(RecordJudgeObservationRequest.safeParse(obs({ subject: ' ' })).success).toBe(false);
    expect(
      RecordJudgeObservationRequest.safeParse(obs({ observed: `x${code(0x202e)}` })).success,
    ).toBe(false);
    expect(RecordJudgeObservationRequest.parse(obs({ observed: 'a\r\nb' })).observed).toBe('a\nb');
  });

  it('is strict, like the answer', () => {
    for (const extra of [
      'recordedBy',
      'actorId',
      'projectId',
      'assessmentId',
      'createdAt',
      'role',
      'verified',
      'verificationLevel',
    ]) {
      expect(RecordJudgeObservationRequest.safeParse(obs({ [extra]: 'x' })).success, extra).toBe(
        false,
      );
    }
  });
});

describe('what the outcomes say', () => {
  it('every outcome has a label and a meaning, and none reads as a finding against the project', () => {
    for (const outcome of OBSERVATION_OUTCOME_VALUES) {
      expect(OBSERVATION_OUTCOME_LABELS[outcome].length).toBeGreaterThan(3);
      expect(OBSERVATION_OUTCOME_MEANINGS[outcome]).not.toMatch(
        /\b(fraud|cheat|fake|false|failed|proves?|proved)\b/i,
      );
    }
    expect(OBSERVATION_OUTCOME_MEANINGS.not_confirmed).toMatch(
      /not evidence that it does not exist/,
    );
    expect(OBSERVATION_OUTCOME_MEANINGS.unable_to_verify).toMatch(/Nothing is inferred/);
  });
});

describe('the database and the schema forbid the same characters', () => {
  it('the SQL pattern (CHECK constraints) and the schema rule agree on every code point up to U+2100, except NUL which PostgreSQL cannot store at all', () => {
    const sql = new RegExp(INTERVIEW_FORBIDDEN_TEXT_SQL, 'u');
    const rejectedBySchema = (cp: number): boolean =>
      !RecordTeamAnswerRequest.safeParse({ text: `a${String.fromCodePoint(cp)}b` }).success;
    for (let cp = 1; cp <= 0x2100; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are refused by the schema and cannot be sent to the database
      expect(rejectedBySchema(cp), `U+${cp.toString(16)}`).toBe(sql.test(String.fromCodePoint(cp)));
    }
  });
});
