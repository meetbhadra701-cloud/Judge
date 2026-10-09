/* Code-assigned, request-scoped handles (design §4.1, N1). Never persisted IDs; the model may only echo handles it was shown. */

export const pad = (n: number, width: number): string => String(n).padStart(width, '0');
export const claimHandle = (n: number): string => `C-${pad(n, 3)}`;
export const evidenceHandle = (n: number): string => `E-${pad(n, 3)}`;
export const pairHandle = (n: number): string => `X-${pad(n, 3)}`;

/** The numeric part of a `C-`/`E-`/`X-` handle. */
export function handleNumber(handle: string): number {
  return Number.parseInt(handle.slice(2), 10);
}

/** A batch-local `ref` (M3 LocalRef) for a handle: lowercase, stable and unique per handle. */
export const refOf = (handle: string): string => handle.toLowerCase();
