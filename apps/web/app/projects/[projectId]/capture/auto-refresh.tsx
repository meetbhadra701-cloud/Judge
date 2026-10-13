'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export const CHECK_EVERY_MS = 3000;
export const CHECK_FOR_MS = 5 * 60 * 1000;
/** After this many failed probes in a row the checker stops and says so. */
const MAX_PROBE_FAILURES = 5;

type Watching = 'watching' | 'expired' | 'unreachable';

/**
 * Checks for capture progress while a capture is waiting, and says honestly what it is doing. It polls a small read-only probe
 * (`./status`, plain JSON) and asks Next.js to re-render the page ONLY when the probe's fingerprint changed, so it never interleaves a
 * router refresh with the user's own navigation (back/forward, links). It stops after five minutes of wall-clock time, or after repeated
 * probe failures, and then tells the reader to reload: what it claims always matches what it does.
 */
export function AutoRefresh({
  projectId,
  fingerprint,
  active,
}: {
  projectId: string;
  fingerprint: string;
  active: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<Watching>('watching');
  useEffect(() => {
    if (!active) return undefined;
    setState('watching');
    const deadline = Date.now() + CHECK_FOR_MS;
    let failures = 0;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      if (Date.now() > deadline) {
        stopped = true;
        clearInterval(timer);
        setState('expired');
        return;
      }
      fetch(`/projects/${encodeURIComponent(projectId)}/capture/status`, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error('probe failed');
          return (await response.json()) as { fingerprint?: unknown };
        })
        .then((probe) => {
          failures = 0;
          if (
            !stopped &&
            typeof probe.fingerprint === 'string' &&
            probe.fingerprint !== fingerprint
          ) {
            stopped = true;
            clearInterval(timer);
            router.refresh();
          }
        })
        .catch(() => {
          failures += 1;
          if (failures >= MAX_PROBE_FAILURES && !stopped) {
            stopped = true;
            clearInterval(timer);
            setState('unreachable');
          }
        });
    }, CHECK_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, fingerprint, projectId, router]);
  if (!active) return null;
  return (
    <p role="status" data-testid="auto-refresh" data-state={state} className="muted">
      {state === 'watching'
        ? 'This page checks for progress every 3 seconds, for up to 5 minutes.'
        : state === 'expired'
          ? 'Automatic checking stopped after 5 minutes. Reload the page to check again.'
          : 'Automatic checking stopped because progress could not be read. Reload the page to check again.'}
    </p>
  );
}
