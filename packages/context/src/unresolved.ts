import type { EventContextDocument, UnresolvedItem } from '@judge-copilot/schemas';
import { listFacts } from './facts.js';

/**
 * Items a reviewer should look at: facts whose certainty is `unclear` and conflicts that source
 * authority could not resolve. Both may legitimately remain in a locked context.
 */
export function listUnresolved(document: EventContextDocument): UnresolvedItem[] {
  return [
    ...listFacts(document)
      .filter(({ fact }) => fact.certainty === 'unclear')
      .map(({ path, fact }) => ({
        kind: 'unclear_fact' as const,
        path,
        id: fact.id,
        statement: fact.statement,
      })),
    ...document.conflicts
      .map((conflict, i) => ({ conflict, path: `conflicts[${i}]` }))
      .filter(({ conflict }) => conflict.resolution.status === 'unresolved')
      .map(({ conflict, path }) => ({
        kind: 'unresolved_conflict' as const,
        path,
        id: conflict.id,
        statement: conflict.description,
      })),
  ];
}
