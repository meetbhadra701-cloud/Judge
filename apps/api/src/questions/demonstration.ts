import type { LlmResult, StructuredRequest } from '@judge-copilot/llm';

/*
 * The SCRIPTED QUESTION DEMONSTRATION "model" (M6). It exists so the whole question workflow -- uncertainty analysis, candidate validation, ranking,
 * selection, persistence, display -- can be shown offline, on any verified assessment. It is NOT a model and it is NOT an AI: every candidate is produced by
 * the fixed templates below from the STRUCTURE of the request (the kind of each uncertainty, the rubric criterion names and track names the request lists),
 * and none depends on what a team wrote. Every set it produces is labelled an offline demonstration everywhere it is shown (provider mode `scripted`), and
 * the provider is refused outside development and test by the llm package and by the environment schemas.
 *
 * It returns a candidate for the first uncertainty of each (kind, criteria) signature only, so it never floods the ranking with copies of one question.
 */

interface Record_ {
  readonly handle: string;
  readonly meta: Record<string, unknown>;
  readonly body: string | null;
}

const ITEM_OPEN = /^<<<ITEM (\S+) ([0-9a-f]{16})>>>$/;

function parseRecords(request: StructuredRequest): Record_[] {
  const records: Record_[] = [];
  for (const block of request.user) {
    const lines = block.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const begin = ITEM_OPEN.exec(lines[index] ?? '');
      if (!begin) continue;
      const handle = begin[1] ?? '';
      const end = `<<<END ITEM ${handle} ${begin[2] ?? ''}>>>`;
      let stop = index + 1;
      while (stop < lines.length && lines[stop] !== end) stop += 1;
      const inner = lines.slice(index + 1, stop);
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse((inner[0] ?? '').replace(/^meta: /, '')) as Record<string, unknown>;
      } catch {
        meta = {};
      }
      const textAt = inner.indexOf('text:');
      records.push({ handle, meta, body: textAt >= 0 ? inner.slice(textAt + 1).join('\n') : null });
      index = stop;
    }
  }
  return records;
}

type Mode = 'ask' | 'clarify' | 'show_me' | 'demonstrate' | 'verify';
type Info =
  'explanation' | 'code_walkthrough' | 'live_demonstration' | 'link_or_document' | 'measurement';

interface Template {
  readonly mode: Mode;
  readonly info: readonly Info[];
  readonly effort: 'brief' | 'moderate' | 'extended';
  readonly distinguishes: 'weak' | 'moderate' | 'strong';
  readonly text: (subject: string) => string;
  readonly reason: (subject: string) => string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const quote = (name: string): string => `“${name.replace(/[“”"]/g, '').slice(0, 80)}”`;

const TEMPLATES: Readonly<Record<string, Template>> = {
  dimension_not_assessed: {
    mode: 'show_me',
    info: ['live_demonstration', 'code_walkthrough'],
    effort: 'moderate',
    distinguishes: 'strong',
    text: (s) => `Could you show us, on the project itself, what it does in relation to ${s}?`,
    reason: (s) =>
      `No score could be given for ${s}, so seeing it directly is the quickest way to place it on the rubric.`,
  },
  dimension_rests_on_claims: {
    mode: 'demonstrate',
    info: ['live_demonstration', 'code_walkthrough'],
    effort: 'moderate',
    distinguishes: 'strong',
    text: (s) =>
      `Could you demonstrate, on the project itself, what your materials describe for ${s}?`,
    reason: (s) =>
      `The score for ${s} rests only on what the team's materials say, so a live look would corroborate or correct it.`,
  },
  claim_unverified: {
    mode: 'verify',
    info: ['live_demonstration', 'link_or_document'],
    effort: 'moderate',
    distinguishes: 'strong',
    text: (s) =>
      `Could you show us how one of the statements in your materials about ${s} can be checked on the project itself?`,
    reason: (s) =>
      `A statement about ${s} is so far a claim by the team; a check on the project would show whether it holds.`,
  },
  contradiction_recorded: {
    mode: 'clarify',
    info: ['explanation', 'link_or_document'],
    effort: 'brief',
    distinguishes: 'strong',
    text: (s) =>
      `Two parts of your materials seem to describe ${s} differently; could you explain how they fit together?`,
    reason: (s) =>
      `Two recorded passages about ${s} do not obviously agree, and an explanation would settle which reading applies.`,
  },
  unknown_recorded: {
    mode: 'clarify',
    info: ['explanation', 'link_or_document'],
    effort: 'brief',
    distinguishes: 'moderate',
    text: (s) => `Could you tell us more about the open point the assessment recorded for ${s}?`,
    reason: (s) =>
      `The assessment could not establish a point about ${s}, and the team can say more directly.`,
  },
  source_missing: {
    mode: 'show_me',
    info: ['link_or_document', 'code_walkthrough'],
    effort: 'brief',
    distinguishes: 'strong',
    text: () =>
      'Could you show us where the project material that could not be captured can be found?',
    reason: () =>
      'Part of the expected material was not available to the assessment, so nothing from it has been examined yet.',
  },
  coverage_partial: {
    mode: 'show_me',
    info: ['code_walkthrough', 'live_demonstration'],
    effort: 'moderate',
    distinguishes: 'strong',
    text: () =>
      'Could you walk us through the parts of the code that carry the core of the project?',
    reason: () =>
      'Part of the implementation was not shown to the assessment, so a walk-through would cover what it could not see.',
  },
  requirement_unaddressed: {
    mode: 'ask',
    info: ['explanation', 'live_demonstration'],
    effort: 'moderate',
    distinguishes: 'moderate',
    text: (s) => `Could you show us how the project meets the requirements listed for ${s}?`,
    reason: (s) =>
      `Nothing the assessment examined shows whether the project meets the requirements listed for ${s}.`,
  },
  track_rubric_not_assessed: {
    mode: 'ask',
    info: ['explanation', 'live_demonstration'],
    effort: 'moderate',
    distinguishes: 'moderate',
    text: (s) => `Could you tell us how the project addresses the criteria published for ${s}?`,
    reason: (s) =>
      `The criteria published for ${s} were not scored by the assessment, so the interview is the place to cover them.`,
  },
  thin_evidence: {
    mode: 'demonstrate',
    info: ['live_demonstration', 'measurement'],
    effort: 'moderate',
    distinguishes: 'moderate',
    text: (s) => `Could you show us a concrete example from the project that illustrates ${s}?`,
    reason: (s) =>
      `The score for ${s} rests on a small amount of evidence, and an example would show which way it should move.`,
  },
};

export const DEMONSTRATION_MODEL = 'scripted-demonstration';

export function questionDemonstrationStep(request: StructuredRequest): LlmResult {
  const records = parseRecords(request);
  const dimensionName = new Map<string, string>();
  const referenceType = new Map<string, string>();
  const referenceLabel = new Map<string, string>();
  for (const record of records) {
    if (record.handle.startsWith('D-')) {
      dimensionName.set(record.handle, text(record.meta['name']));
    } else if (/^[CXEKRTV]-/.test(record.handle)) {
      referenceType.set(record.handle, text(record.meta['type']));
      referenceLabel.set(record.handle, record.body ?? '');
    }
  }
  const seen = new Set<string>();
  const candidates: unknown[] = [];
  for (const record of records) {
    if (!record.handle.startsWith('O-')) continue;
    const kind = text(record.meta['kind']);
    const template = TEMPLATES[kind];
    if (!template) continue;
    const dimensions = (record.meta['dimensions'] as string[] | undefined) ?? [];
    const references = (record.meta['references'] as string[] | undefined) ?? [];
    const trackHandle = references.find((handle) => referenceType.get(handle) === 'track');
    const names = dimensions.map((handle) => dimensionName.get(handle) ?? '').filter(Boolean);
    const subject =
      kind === 'requirement_unaddressed' || kind === 'track_rubric_not_assessed'
        ? trackHandle !== undefined
          ? `the ${quote(referenceLabel.get(trackHandle) ?? 'declared')} track`
          : 'the event’s general rules'
        : names.length === 1
          ? quote(names[0] ?? '')
          : names.length > 1
            ? `${quote(names[0] ?? '')} and related criteria`
            : 'this project';
    const signature = `${kind}|${subject}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    candidates.push({
      mode: template.mode,
      text: template.text(subject),
      reason: template.reason(subject),
      expectedInformation: [...template.info],
      opportunities: [record.handle],
      dimensions: dimensions.slice(0, 6),
      references: references.filter((handle) => handle !== trackHandle).slice(0, 3),
      distinguishes: template.distinguishes,
      effort: template.effort,
    });
  }
  return {
    ok: true,
    json: { candidates: candidates.slice(0, 40) },
    // local code: it consumes no provider tokens and costs nothing, so it reports none
    usage: { inputTokens: 0, outputTokens: 0 },
    providerRequestId: null,
    servedModel: DEMONSTRATION_MODEL,
  };
}
