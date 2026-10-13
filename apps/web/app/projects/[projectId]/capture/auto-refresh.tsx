'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-reads the page every few seconds while a capture is waiting, for at most ~5 minutes. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return undefined;
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      if (count > 100) clearInterval(timer);
      else router.refresh();
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  }, [active, router]);
  return null;
}
