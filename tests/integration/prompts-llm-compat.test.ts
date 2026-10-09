/*
 * M5 P2: the prompts package and the llm package are siblings (neither may import the other), so their contract is tested
 * here. A rendered prompt must complete into a `StructuredRequest` without any extra text, and the request digest must commit
 * to every byte the model would see: the trusted system text, the framed data, the reference standard and the template.
 */
import { canonicalJson, sha256Hex } from '../../packages/context/src/index.js';
import {
  ASSESSMENT_STAGE_OUTPUT_SCHEMAS,
  ASSESSMENT_STAGE_VALUES,
} from '../../packages/schemas/src/index.js';
import { describe, expect, it } from 'vitest';
import {
  computeRequestDigest,
  jsonSchemaFor,
  ScriptedProvider,
  type StructuredRequest,
} from '../../packages/llm/src/index.js';
import {
  officialUnitFromLockedSnapshot,
  promptFor,
  renderPrompt,
  requestFields,
  type StageInputs,
} from '../../packages/prompts/src/index.js';
import {
  EVENT_ID,
  lockedSnapshot,
  VALID_INPUTS,
} from '../../packages/prompts/src/testing/fixtures.js';

/** Indexing with a guaranteed element (the repository forbids non-null assertions). */
function item<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`fixture has no item ${String(index)}`);
  return found;
}

type Stage = (typeof ASSESSMENT_STAGE_VALUES)[number];

function toRequest(stage: Stage, input: unknown): StructuredRequest {
  const rendered = renderPrompt(stage, input);
  return {
    ...requestFields(rendered),
    provider: 'test',
    model: 'claude-haiku-5-5',
    jsonSchema: jsonSchemaFor(ASSESSMENT_STAGE_OUTPUT_SCHEMAS[stage]),
    generation: { effort: 'low', maxOutputTokens: 2_000, timeoutMs: 120_000 },
  };
}

/** Independent re-statement of request-digest/v2, so the format itself is pinned from outside the llm package. */
function digestByHand(request: StructuredRequest): string {
  return sha256Hex(
    canonicalJson({
      v: 'request-digest/v2',
      stage: request.stage,
      promptId: request.promptId,
      promptVersion: request.promptVersion,
      promptTemplateHash: request.promptTemplateHash,
      schemaId: request.schemaId,
      schemaVersion: request.schemaVersion,
      provider: request.provider,
      model: request.model,
      system: request.system,
      user: [...request.user],
      jsonSchema: request.jsonSchema,
      generation: {
        effort: request.generation.effort ?? null,
        maxOutputTokens: request.generation.maxOutputTokens,
      },
    }),
  );
}

describe('prompts ↔ llm: the request is exactly what was rendered', () => {
  it.each(ASSESSMENT_STAGE_VALUES)('%s: completes into a valid StructuredRequest', (stage) => {
    const request = toRequest(stage, VALID_INPUTS[stage]);
    expect(request.stage).toBe(stage);
    expect(request.promptId).toBe(promptFor(stage).id);
    expect(request.promptVersion).toBe('v2');
    expect(request.promptTemplateHash).toBe(promptFor(stage).templateHash);
    expect(request.schemaId).toBe(promptFor(stage).schemaId);
    expect(request.system.length).toBeGreaterThan(0);
    expect(request.user.length).toBeGreaterThan(0);
    expect(computeRequestDigest(request)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(ASSESSMENT_STAGE_VALUES)(
    '%s: the digest commits to the exact rendered bytes',
    (stage) => {
      const request = toRequest(stage, VALID_INPUTS[stage]);
      expect(computeRequestDigest(request)).toBe(digestByHand(request));
    },
  );

  it.each(ASSESSMENT_STAGE_VALUES)(
    '%s: the output schema hash commits to the schema the provider is sent',
    (stage) => {
      const request = toRequest(stage, VALID_INPUTS[stage]);
      expect(sha256Hex(canonicalJson(request.jsonSchema))).toBe(promptFor(stage).outputSchemaHash);
    },
  );

  it.each(ASSESSMENT_STAGE_VALUES)(
    '%s: repeated identical inputs give an identical digest',
    (stage) => {
      const digests = new Set<string>();
      for (let index = 0; index < 4; index += 1) {
        digests.add(computeRequestDigest(toRequest(stage, structuredClone(VALID_INPUTS[stage]))));
      }
      expect(digests.size).toBe(1);
    },
  );

  it('gives each stage a different digest for otherwise comparable inputs', () => {
    const digests = ASSESSMENT_STAGE_VALUES.map((stage) =>
      computeRequestDigest(toRequest(stage, VALID_INPUTS[stage])),
    );
    expect(new Set(digests).size).toBe(ASSESSMENT_STAGE_VALUES.length);
  });
});

describe('prompts ↔ llm: changed model-visible text changes the digest', () => {
  const base = (stage: Stage) => computeRequestDigest(toRequest(stage, VALID_INPUTS[stage]));

  const changes: [string, Stage, (input: Record<string, unknown>) => void][] = [
    [
      'a source passage',
      'claim_extraction',
      (i) => (item((i as StageInputs['claim_extraction']).passages, 0).text += ' (edited)'),
    ],
    [
      'a source passage artifact label',
      'evidence_interpretation',
      (i) =>
        (item((i as StageInputs['evidence_interpretation']).passages, 0).artifact =
          'files/other.ts'),
    ],
    [
      'a quote under fidelity review',
      'fidelity_review',
      (i) => (item((i as StageInputs['fidelity_review']).items, 0).quote += '!'),
    ],
    [
      'a claim',
      'relation_matching',
      (i) => (item((i as StageInputs['relation_matching']).claims, 0).text += ' really'),
    ],
    [
      'an evidence record',
      'contradiction_detection',
      (i) => (item((i as StageInputs['contradiction_detection']).evidence, 0).text += ' really'),
    ],
    [
      'an evidence quote',
      'unknown_identification',
      (i) =>
        (item((i as StageInputs['unknown_identification']).evidence, 0).quote = 'db.insert(other)'),
    ],
    [
      'a pair',
      'relation_verification',
      (i) => (item((i as StageInputs['relation_verification']).pairs, 0).evidence += ' later'),
    ],
    [
      'a candidate text',
      'dimension_assessment',
      (i) => (item((i as StageInputs['dimension_assessment']).candidates, 0).text += ' twice'),
    ],
    [
      'a candidate label',
      'dimension_assessment',
      (i) => (item((i as StageInputs['dimension_assessment']).candidates, 0).label = 'unverified'),
    ],
    [
      'a handle',
      'dimension_assessment',
      (i) => (item((i as StageInputs['dimension_assessment']).candidates, 0).handle = 'E-010'),
    ],
    [
      'the criterion description',
      'dimension_assessment',
      (i) => {
        const standard = (i as StageInputs['dimension_assessment']).unit.standard;
        if (standard.basis === 'official') standard.criterionDescription += ' Also consider scale.';
      },
    ],
    [
      'an anchor description',
      'dimension_assessment',
      (i) => {
        const standard = (i as StageInputs['dimension_assessment']).unit.standard;
        if (standard.basis === 'official') item(standard.anchors, 1).description += ' (clarified)';
      },
    ],
    [
      'an anchor score',
      'critic',
      (i) => {
        const standard = (i as StageInputs['critic']).unit.standard;
        if (standard.basis === 'official') item(standard.anchors, 1).score = 4;
      },
    ],
    ['the scale', 'critic', (i) => ((i as StageInputs['critic']).unit.scale.max = 100)],
    [
      'the judgment rationale',
      'critic',
      (i) => ((i as StageInputs['critic']).judgment.rationale += ' It is excellent.'),
    ],
    ['a critic flag', 'critic', (i) => ((i as StageInputs['critic']).flags = [])],
    [
      'the order of records',
      'claim_extraction',
      (i) => (i as StageInputs['claim_extraction']).passages.reverse(),
    ],
  ];

  for (const [name, stage, mutate] of changes) {
    it(`${name} (${stage})`, () => {
      const input = structuredClone(VALID_INPUTS[stage]) as Record<string, unknown>;
      mutate(input);
      expect(computeRequestDigest(toRequest(stage, input)), name).not.toBe(base(stage));
    });
  }

  it('a change of one anchor in the locked snapshot changes the digest end to end', () => {
    const makeDigest = (anchorText: string) => {
      const snapshot = lockedSnapshot([
        {
          key: 'problem_fit',
          name: 'Problem fit',
          description: 'How well the project addresses a real, clearly stated problem.',
          anchors: [
            { score: 0, description: 'No coherent problem or an unrelated solution.' },
            { score: 10, description: anchorText },
          ],
        },
      ]);
      const { unit } = officialUnitFromLockedSnapshot(
        snapshot,
        {
          versionId: snapshot.versionId,
          lockedContentHash: snapshot.lockedContentHash,
          eventId: EVENT_ID,
        },
        'problem_fit',
      );
      return computeRequestDigest(
        toRequest('dimension_assessment', { ...VALID_INPUTS.dimension_assessment, unit }),
      );
    };
    expect(makeDigest('A precisely defined problem.')).toBe(
      makeDigest('A precisely defined problem.'),
    );
    expect(makeDigest('A precisely defined problem.')).not.toBe(
      makeDigest('A precisely defined problem and a working fix.'),
    );
  });

  it('changes with every identity field the request carries', () => {
    const request = toRequest('critic', VALID_INPUTS.critic);
    const original = computeRequestDigest(request);
    const variants: Partial<StructuredRequest>[] = [
      { promptId: 'critic-x' },
      { promptVersion: 'v3' },
      { promptTemplateHash: 'f'.repeat(64) },
      { schemaId: 'critic-x' },
      { schemaVersion: 'v3' },
      { system: `${request.system} ` },
      { user: [...request.user].reverse() },
      { user: request.user.slice(0, 1) },
      { jsonSchema: { ...request.jsonSchema, title: 'x' } },
      { model: 'claude-sonnet-5-5' },
    ];
    for (const variant of variants) {
      expect(
        computeRequestDigest({ ...request, ...variant }),
        JSON.stringify(Object.keys(variant)),
      ).not.toBe(original);
    }
    // timeout is the one deliberate exclusion
    expect(
      computeRequestDigest({ ...request, generation: { ...request.generation, timeoutMs: 5_000 } }),
    ).toBe(original);
  });

  it('is independent of object key order in the input', () => {
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([k, v]) => [k, reorder(v)]),
        );
      }
      return value;
    };
    for (const stage of ASSESSMENT_STAGE_VALUES) {
      expect(computeRequestDigest(toRequest(stage, reorder(VALID_INPUTS[stage])))).toBe(
        base(stage),
      );
    }
  });
});

describe('prompts ↔ llm: a rendered request runs through a provider unchanged', () => {
  it('delivers the exact rendered system and user text to the provider', async () => {
    const request = toRequest('claim_extraction', VALID_INPUTS.claim_extraction);
    const provider = new ScriptedProvider([
      {
        ok: true,
        json: { claims: [] },
        usage: { inputTokens: 100, outputTokens: 10 },
        providerRequestId: 'req-1',
        servedModel: 'claude-haiku-5-5',
      },
    ]);
    const result = await provider.generate(request, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(provider.requests[0]?.system).toBe(request.system);
    expect(provider.requests[0]?.user).toEqual(request.user);
  });
});
