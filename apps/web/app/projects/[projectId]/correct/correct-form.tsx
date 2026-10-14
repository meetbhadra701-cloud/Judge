'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { correctProjectAction, type CorrectState } from './actions';

const INITIAL: CorrectState = {
  attempt: 0,
  values: { reason: '', replace: true, github: '', devpost: '', name: '' },
  errors: {},
  formError: null,
  projectId: null,
  outcomeUnknown: false,
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? 'Applying…' : 'Void this project'}
    </button>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="error">
      {message}
    </p>
  );
}

export function CorrectForm({
  projectId,
  correctionKey,
}: {
  projectId: string;
  /** The request identity of THIS form: stable across retries, new for every page load. */
  correctionKey: string;
}) {
  const [state, action] = useActionState(correctProjectAction, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const formError = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.attempt === 0) return;
    const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? formError.current)?.focus();
  }, [state.attempt]);
  return (
    <form ref={form} action={action} className="stack" noValidate>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="correctionKey" value={correctionKey} />
      {state.formError ? (
        <p ref={formError} tabIndex={-1} role="alert" className="error">
          {state.formError}{' '}
          {state.projectId ? (
            <Link href={`/projects/${state.projectId}`}>Open the project →</Link>
          ) : null}
        </p>
      ) : null}
      <label>
        Why is this project being voided?
        <input
          name="reason"
          autoComplete="off"
          defaultValue={state.values.reason}
          key={`r-${String(state.attempt)}`}
          aria-invalid={state.errors.reason ? true : undefined}
          aria-describedby={state.errors.reason ? 'reason-error' : undefined}
          maxLength={1000}
        />
      </label>
      <FieldError id="reason-error" message={state.errors.reason} />
      <label>
        <input
          type="checkbox"
          name="replace"
          value="yes"
          defaultChecked={state.values.replace}
          key={`c-${String(state.attempt)}`}
        />{' '}
        Submit the corrected links as a replacement project
      </label>
      <label>
        Corrected GitHub repository URL
        <input
          name="github"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://github.com/owner/repository"
          defaultValue={state.values.github}
          key={`g-${String(state.attempt)}`}
          aria-invalid={state.errors.github ? true : undefined}
          aria-describedby={state.errors.github ? 'github-error' : undefined}
          maxLength={2048}
        />
      </label>
      <FieldError id="github-error" message={state.errors.github} />
      <label>
        Corrected Devpost project URL
        <input
          name="devpost"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://devpost.com/software/project-name"
          defaultValue={state.values.devpost}
          key={`d-${String(state.attempt)}`}
          aria-invalid={state.errors.devpost ? true : undefined}
          aria-describedby={state.errors.devpost ? 'devpost-error' : undefined}
          maxLength={2048}
        />
      </label>
      <FieldError id="devpost-error" message={state.errors.devpost} />
      <label>
        Project name <small>(optional — otherwise derived from the GitHub URL)</small>
        <input
          name="name"
          autoComplete="off"
          defaultValue={state.values.name}
          key={`n-${String(state.attempt)}`}
          aria-invalid={state.errors.name ? true : undefined}
          aria-describedby={state.errors.name ? 'name-error' : undefined}
          maxLength={200}
        />
      </label>
      <FieldError id="name-error" message={state.errors.name} />
      <SubmitButton />
    </form>
  );
}
