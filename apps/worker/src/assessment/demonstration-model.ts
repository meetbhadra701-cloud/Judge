import type { LlmResult, StructuredRequest } from '@judge-copilot/llm';

/*
 * The SCRIPTED DEMONSTRATION "model" (P6C). It exists so that the whole offline workflow -- capture, selection, extraction, scoring, report -- can be
 * shown on ANY captured project, not only the one synthetic project the recorded replay fixture covers. It is NOT a model and it does NOT read the
 * project: every answer is produced by the fixed rules below from the structure of the request, and none depends on what the text says.
 *
 *   - claims / evidence: the first usable line of each passage, quoted verbatim (so the real gates accept it and the real verifiers can check it);
 *   - relations, contradictions, unknowns: none (a demonstration does not cross-check anything);
 *   - every dimension: the SAME placeholder, 70 % of the scale, citing the first two project-derived records, with a rationale that says so;
 *   - the critic: never objects.
 *
 * The placeholder is deliberately uniform and says nothing about any project. The run is labelled a SCRIPTED DEMONSTRATION everywhere it is shown
 * (provider mode `scripted`), and the provider is refused outside development and test by the llm package and by the environment schemas.
 */

export interface ParsedRecord {
  readonly handle: string;
  readonly meta: Record<string, unknown>;
  readonly body: string | null;
}

const BEGIN = /^<<<ITEM (\S+) ([0-9a-f]{16})>>>$/;

/** Parses the records of a rendered request. A record ends only at the END line carrying ITS code, as the framing promises. */
export function parseRecords(request: StructuredRequest): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const block of request.user) {
    const lines = block.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const begin = BEGIN.exec(lines[index] ?? '');
      if (!begin) continue;
      const handle = begin[1] ?? '';
      const code = begin[2] ?? '';
      const end = `<<<END ITEM ${handle} ${code}>>>`;
      let stop = index + 1;
      while (stop < lines.length && lines[stop] !== end) stop += 1;
      const inner = lines.slice(index + 1, stop);
      const metaLine = inner[0] ?? '';
      const meta = JSON.parse(metaLine.replace(/^meta: /, '')) as Record<string, unknown>;
      const textAt = inner.indexOf('text:');
      records.push({
        handle,
        meta,
        body: textAt >= 0 ? inner.slice(textAt + 1).join('\n') : null,
      });
      index = stop;
    }
  }
  return records;
}

export const DEMONSTRATION_PLACEHOLDER_SHARE = 0.7;
const USAGE = { inputTokens: 1_000, outputTokens: 200 };
const PER_CALL_LIMIT = 8;

const ok = (json: unknown): LlmResult => ({
  ok: true,
  json,
  usage: USAGE,
  providerRequestId: null,
  servedModel: 'scripted-demonstration',
});

/** The first line that is long enough to be a statement and is not markup, structure or a marker, quoted exactly as shown. */
function firstUsableLine(body: string | null): string | null {
  for (const raw of (body ?? '').split('\n')) {
    const line = raw.trim();
    if (line.length < 40 || line.length > 220) continue;
    if (/^[#{}[\]<>|`~=_*-]/.test(line)) continue;
    if (!/[A-Za-z]{4}/.test(line)) continue;
    return line;
  }
  return null;
}

const isInterpretPassage = (record: ParsedRecord): boolean => 'class' in record.meta;
const dimensionOf = (records: readonly ParsedRecord[]): string => {
  const value = records.find((record) => record.handle === 'RUBRIC')?.meta['dimensionId'];
  return typeof value === 'string' ? value : '';
};

function extract(records: readonly ParsedRecord[], route: 'statement' | 'interpret') {
  const items: { ref: string; text: string; passage: string; quote: string }[] = [];
  for (const record of records) {
    if (!record.handle.startsWith('P-')) continue;
    if (isInterpretPassage(record) !== (route === 'interpret')) continue;
    const line = firstUsableLine(record.body);
    if (line === null) continue;
    items.push({
      ref: `${route === 'statement' ? 'c' : 'e'}${String(items.length)}`,
      text: line,
      passage: record.handle,
      quote: line,
    });
    if (items.length >= PER_CALL_LIMIT) break;
  }
  return items;
}

export function demonstrationStep(request: StructuredRequest): LlmResult {
  const records = parseRecords(request);
  switch (request.stage) {
    case 'claim_extraction':
      return ok({ claims: extract(records, 'statement') });
    case 'evidence_interpretation':
      return ok({ evidence: extract(records, 'interpret') });
    case 'fidelity_review':
      return ok({
        verdicts: records.map((record) => ({ item: record.handle, verdict: 'faithful' })),
      });
    case 'relation_matching':
      return ok({ relations: [] });
    case 'relation_verification':
      return ok({
        verdicts: records.map((record) => ({ pair: record.handle, verdict: 'supports' })),
      });
    case 'contradiction_detection':
      return ok({ contradictions: [] });
    case 'unknown_identification':
      return ok({ unknowns: [] });
    case 'dimension_assessment': {
      const dimensionId = dimensionOf(records);
      const rubric = records.find((record) => record.handle === 'RUBRIC');
      const scale = (rubric?.meta['scale'] ?? { min: 0, max: 10 }) as { min: number; max: number };
      const project = records.filter(
        (record) =>
          typeof record.meta['authorship'] === 'string' &&
          record.meta['authorship'] !== 'event_reference',
      );
      if (project.length === 0) {
        return ok({
          dimensionId,
          outcome: { kind: 'insufficient_evidence' },
          citations: [],
          rationale:
            'SCRIPTED DEMONSTRATION: no project-derived record was shown for this dimension.',
          limitations: [],
        });
      }
      return ok({
        dimensionId,
        outcome: {
          kind: 'scored',
          score: scale.min + DEMONSTRATION_PLACEHOLDER_SHARE * (scale.max - scale.min),
        },
        citations: project.slice(0, 2).map((record) => ({
          evidence: record.handle,
          directness: 'direct',
          specificity: 'exact',
          note: 'Cited as shown (scripted demonstration).',
        })),
        rationale:
          'SCRIPTED DEMONSTRATION: this value is a fixed placeholder (70 % of the scale) that was not produced by reading the project. It says nothing about its quality.',
        limitations: [],
      });
    }
    case 'critic': {
      return ok({ unit: dimensionOf(records), findings: [] });
    }
  }
}
