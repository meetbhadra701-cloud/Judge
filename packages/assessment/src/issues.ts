/*
 * Typed domain issues. An issue carries a gate, a stable code and a PATH only (plus, where it helps, a code-assigned handle).
 * It never carries source text, model text, a quote, an excerpt or a secret: those can echo hostile project content or leak
 * into a repair prompt. Handles are safe because every handle that reaches a gate has already matched its closed pattern.
 */

/** `graph` is not a numbered gate: it is the closure / scoping check that sits after G1-G5 and before G6. */
export const GATE_VALUES = [
  'G1',
  'G2',
  'G2b',
  'G3',
  'G3b',
  'G4',
  'G5',
  'G6',
  'G7',
  'graph',
] as const;
export type GateId = (typeof GATE_VALUES)[number];

export interface DomainIssue {
  readonly gate: GateId;
  readonly code: string;
  readonly path: string;
  readonly handle?: string;
}

export function issue(gate: GateId, code: string, path: string, handle?: string): DomainIssue {
  return handle === undefined ? { gate, code, path } : { gate, code, path, handle };
}

/** A rejected ITEM (not a rejected call): dropped, counted, never repaired. */
export interface Rejection {
  readonly gate: GateId;
  readonly code: string;
  /** Index of the item in the model's output array. */
  readonly index: number;
  readonly handle?: string;
}

export function sortIssues<T extends DomainIssue>(issues: readonly T[]): T[] {
  const key = (value: DomainIssue) =>
    `${value.gate}\u0000${value.path}\u0000${value.code}\u0000${value.handle ?? ''}`;
  return [...issues].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
