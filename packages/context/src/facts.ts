import type { ContextFact, EventContextContent } from '@judge-copilot/schemas';

export interface FactEntry {
  path: string;
  fact: ContextFact;
}

/** Every sourced fact in a document, with a stable display path. */
export function listFacts(content: EventContextContent): FactEntry[] {
  return [
    ...Object.entries(content.dates).map(([key, fact]) => ({ path: `dates.${key}`, fact })),
    { path: 'judgingFormat', fact: content.judgingFormat },
    { path: 'priorWorkPolicy', fact: content.priorWorkPolicy },
    ...content.rules.map((fact, i) => ({ path: `rules[${i}]`, fact })),
    ...content.submissionRequirements.map((fact, i) => ({
      path: `submissionRequirements[${i}]`,
      fact,
    })),
    ...content.organizerGuidance.map((fact, i) => ({ path: `organizerGuidance[${i}]`, fact })),
  ];
}
