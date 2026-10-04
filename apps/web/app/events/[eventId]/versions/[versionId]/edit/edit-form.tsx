'use client';

import { useActionState } from 'react';
import { saveDraftAction, type SaveDraftState } from '../../../../../actions';

export function EditDraftForm({
  eventId,
  versionId,
  initialJson,
  initialSummary,
}: {
  eventId: string;
  versionId: string;
  initialJson: string;
  initialSummary: string;
}) {
  const [state, action, pending] = useActionState<SaveDraftState, FormData>(saveDraftAction, {
    attempt: 0,
    json: null,
    error: null,
    issues: [],
  });

  return (
    <form action={action} className="stack" style={{ maxWidth: 'none' }} key={state.attempt}>
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="versionId" value={versionId} />
      {state.error ? (
        <div role="alert" className="error">
          <strong>{state.error}</strong>
          {state.issues.length > 0 ? (
            <ul>
              {state.issues.map((issue, i) => (
                <li key={i}>
                  {issue.code ? <code>{issue.code}</code> : null} {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <label>
        Summary <textarea name="summary" defaultValue={initialSummary} maxLength={5000} rows={2} />
      </label>
      <label>
        Structured context (JSON)
        <textarea
          name="document"
          className="code"
          defaultValue={state.json ?? initialJson}
          spellCheck={false}
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save draft'}
      </button>
    </form>
  );
}
