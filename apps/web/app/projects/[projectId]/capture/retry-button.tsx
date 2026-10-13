'use client';

import { useFormStatus } from 'react-dom';

/** Disabled while the retry request is in flight, so a double click cannot send it twice. */
export function RetryButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? 'Requesting…' : label}
    </button>
  );
}
