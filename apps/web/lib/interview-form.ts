/*
 * The state of one Interview Mode form. It lives outside the server-action module on purpose: a 'use server' file may export only async functions, and this
 * constant is also read by the client components that render the forms.
 */

export interface InterviewFormState {
  /** Incremented per submission so the form re-renders its messages. */
  readonly attempt: number;
  /** True after a successful save (the form then starts empty). */
  readonly saved: boolean;
  readonly error: string | null;
  /** The request may or may not have been saved: pressing the button again is the safe recovery. */
  readonly outcomeUnknown: boolean;
  readonly values: {
    readonly text: string;
    readonly subject: string;
    readonly observed: string;
    readonly outcome: string;
    readonly teamAnswerId: string;
  };
}

export const EMPTY_INTERVIEW_FORM: InterviewFormState = {
  attempt: 0,
  saved: false,
  error: null,
  outcomeUnknown: false,
  values: { text: '', subject: '', observed: '', outcome: '', teamAnswerId: '' },
};
