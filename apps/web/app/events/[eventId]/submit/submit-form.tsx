'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { submitProjectAction, type SubmitState } from './actions';

const INITIAL: SubmitState = {
  attempt: 0,
  values: { github: '', devpost: '', name: '' },
  errors: {},
  formError: null,
  projectId: null,
};

/** Disabled while the submission is in flight: a double click cannot send it twice from this page. */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? 'Starting…' : 'Start analysis'}
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

export function SubmitForm({ eventId }: { eventId: string }) {
  const [state, action] = useActionState(submitProjectAction, INITIAL);
  return (
    <form action={action} className="stack" noValidate>
      <input type="hidden" name="eventId" value={eventId} />
      {state.formError ? (
        <p role="alert" className="error">
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
