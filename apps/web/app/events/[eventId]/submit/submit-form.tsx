'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { submitProjectAction, type SubmitState } from './actions';

const INITIAL: SubmitState = {
  attempt: 0,
  values: { github: '', devpost: '', name: '' },
  errors: {},
  formError: null,
  projectId: null,
  outcomeUnknown: false,
};

/** Disabled while the submission is in flight: a double click cannot send it twice from this page. */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? 'Submitting…' : 'Submit and start capture'}
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

export function SubmitForm({
  eventId,
  submissionKey,
}: {
  eventId: string;
  /** The request identity of THIS form: stable across retries, new for every page load. */
  submissionKey: string;
}) {
  const [state, action] = useActionState(submitProjectAction, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const formError = useRef<HTMLParagraphElement>(null);
  // after a refused submission, put keyboard and screen-reader focus on the first thing to fix (a field, else the form-level message)
  useEffect(() => {
    if (state.attempt === 0) return;
    const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? formError.current)?.focus();
  }, [state.attempt]);
  return (
    <form ref={form} action={action} className="stack" noValidate>
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="submissionKey" value={submissionKey} />
      {state.formError ? (
        <p ref={formError} tabIndex={-1} role="alert" className="error">
          {state.formError}{' '}
          {state.projectId ? (
            <Link href={`/projects/${state.projectId}/capture`}>Open the project →</Link>
          ) : null}
        </p>
      ) : null}
      <label>
        GitHub repository URL
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
        Devpost project URL
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
        Project name{' '}
        <small>(optional — otherwise derived from the GitHub URL as owner/repository)</small>
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
