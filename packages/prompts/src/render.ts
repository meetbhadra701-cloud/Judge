import { canonicalJson } from '@judge-copilot/context';
import type { AssessmentStage } from '@judge-copilot/schemas';
import {
  FallbackAnchorsNotApprovedError,
  PromptInputError,
  PromptSecretError,
  type PromptIssue,
} from './errors.js';
import {
  blockBegin,
  blockEnd,
  deriveBoundary,
  deriveItemMarkers,
  markerClause,
  type BlockKind,
  type FramedItem,
  type HashFn,
} from './frame.js';
import { STAGE_INPUT_SCHEMAS, type StageInputs, type UnitView } from './inputs.js';
import { promptFor } from './templates.js';

/**
 * The fallback anchors are an unapproved draft that still awaits owner review. This constant is
 * the single switch, and it is `false`: a `fallback` standard is refused for every stage until the owner approves the exact
 * text AND a later version of this package enables it. It is not configurable at runtime.
 */
export const FALLBACK_ANCHORS_APPROVED = false as boolean;

export interface RenderOptions {
  /** Server-side secret VALUES (provider key, tokens, connection strings). Any occurrence in prompt content aborts the render. */
  readonly secrets?: readonly string[];
  /** Test seam for collision handling. Production code never sets it. */
  readonly hash?: HashFn;
}

/** The closed sets the prompt exposes. Only HANDLE fields contribute; text that merely looks like a handle never does. */
export interface ClosedSet {
  readonly passages: readonly string[];
  readonly claims: readonly string[];
  readonly evidence: readonly string[];
  readonly pairs: readonly string[];
  /** Claim or evidence handles reviewed by the fidelity stage. */
  readonly items: readonly string[];
  /** The one unit a dimension or critic prompt is about. */
  readonly unit: string | null;
}

export interface RenderedPrompt {
  readonly stage: AssessmentStage;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly promptTemplateHash: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly outputSchemaHash: string;
  /** Trusted instructions plus the marker clause for THIS request. Contains no project data. */
  readonly system: string;
  /** Delimited untrusted data (and, for scoring units, the reference standard), one string per block, in order. */
  readonly user: readonly string[];
  readonly boundary: string;
  readonly closedSet: ClosedSet;
  /** The standard's origin, for the audit ledger (not model-visible). */
  readonly standardBasis: UnitView['standard']['basis'] | null;
}

/**
 * Exactly the request fields this renderer determines. A caller completes a `StructuredRequest` by adding the provider,
 * model, JSON schema and generation settings; nothing else may be added to `system` or `user`, because the request digest
 * commits to those strings byte for byte.
 */
export function requestFields(rendered: RenderedPrompt) {
  return {
    stage: rendered.stage,
    promptId: rendered.promptId,
    promptVersion: rendered.promptVersion,
    promptTemplateHash: rendered.promptTemplateHash,
    schemaId: rendered.schemaId,
    schemaVersion: rendered.schemaVersion,
    system: rendered.system,
    user: rendered.user,
  } as const;
}

interface Layout {
  readonly standard: readonly FramedItem[];
  readonly data: readonly FramedItem[];
  readonly closedSet: ClosedSet;
  readonly unit: UnitView | null;
}

const EMPTY: ClosedSet = {
  passages: [],
  claims: [],
  evidence: [],
  pairs: [],
  items: [],
  unit: null,
};

function standardItem(unit: UnitView): FramedItem {
  const { standard } = unit;
  const meta: Record<string, unknown> = {
    dimensionId: unit.dimensionId,
    name: unit.name,
    scale: { min: unit.scale.min, max: unit.scale.max },
    basis: standard.basis,
    notices: [...unit.notices],
  };
  if (standard.basis === 'official') {
    meta['criterionDescription'] = standard.criterionDescription;
    meta['anchors'] = standard.anchors.map(({ score, description }) => ({ score, description }));
  } else if (standard.basis === 'official_no_anchors') {
    meta['criterionDescription'] = standard.criterionDescription;
    meta['anchors'] = 'none_published';
  }
  return { handle: 'RUBRIC', meta };
}

function claimsAndEvidence(input: StageInputs['relation_matching']): Layout {
  const data: FramedItem[] = [
    ...input.claims.map((claim) => ({
      handle: claim.handle,
      meta: { kind: 'claim', text: claim.text },
    })),
    ...input.evidence.map((item) => ({
      handle: item.handle,
      meta: { kind: 'evidence', quote: item.quote, text: item.text },
    })),
  ];
  return {
    standard: [],
    data,
    unit: null,
    closedSet: {
      ...EMPTY,
      claims: input.claims.map((c) => c.handle),
      evidence: input.evidence.map((e) => e.handle),
    },
  };
}

function candidateItem(candidate: {
  handle: string;
  channel: string;
  label: string;
  authorship: string;
  text: string;
  excerpt: string | null;
}): FramedItem {
  return {
    handle: candidate.handle,
    meta: {
      authorship: candidate.authorship,
      channel: candidate.channel,
      excerpt: candidate.excerpt,
      label: candidate.label,
      text: candidate.text,
    },
  };
}

const LAYOUTS: { [S in AssessmentStage]: (input: never) => Layout } = {
  claim_extraction: (input: StageInputs['claim_extraction']): Layout => ({
    standard: [],
    data: input.passages.map((p) => ({
      handle: p.handle,
      meta: { artifact: p.artifact, source: p.sourceType },
      body: p.text,
    })),
    unit: null,
    closedSet: { ...EMPTY, passages: input.passages.map((p) => p.handle) },
  }),
  evidence_interpretation: (input: StageInputs['evidence_interpretation']): Layout => ({
    standard: [],
    data: input.passages.map((p) => ({
      handle: p.handle,
      meta: { artifact: p.artifact, class: p.artifactClass, source: p.sourceType },
      body: p.text,
    })),
    unit: null,
    closedSet: { ...EMPTY, passages: input.passages.map((p) => p.handle) },
  }),
  fidelity_review: (input: StageInputs['fidelity_review']): Layout => ({
    standard: [],
    data: input.items.map((i) => ({
      handle: i.handle,
      meta: { assertion: i.assertion, quote: i.quote },
    })),
    unit: null,
    closedSet: { ...EMPTY, items: input.items.map((i) => i.handle) },
  }),
  relation_matching: claimsAndEvidence,
  contradiction_detection: claimsAndEvidence,
  unknown_identification: claimsAndEvidence,
  relation_verification: (input: StageInputs['relation_verification']): Layout => ({
    standard: [],
    data: input.pairs.map((p) => ({
      handle: p.handle,
      meta: { claim: p.claim, evidence: p.evidence, evidenceQuote: p.evidenceQuote },
    })),
    unit: null,
    closedSet: { ...EMPTY, pairs: input.pairs.map((p) => p.handle) },
  }),
  dimension_assessment: (input: StageInputs['dimension_assessment']): Layout => ({
    standard: [standardItem(input.unit)],
    data: input.candidates.map(candidateItem),
    unit: input.unit,
    closedSet: {
      ...EMPTY,
      evidence: input.candidates.map((c) => c.handle),
      unit: input.unit.dimensionId,
    },
  }),
  critic: (input: StageInputs['critic']): Layout => ({
    standard: [standardItem(input.unit), { handle: 'FLAGS', meta: { flags: [...input.flags] } }],
    data: [
      { handle: 'JUDGMENT', meta: { judgment: input.judgment } },
      ...input.cited.map(candidateItem),
      ...input.others.map((o) => ({ handle: o.handle, meta: { oneLine: o.oneLine } })),
      { handle: 'CONTRADICTIONS', meta: { recorded: input.contradictions } },
    ],
    unit: input.unit,
    closedSet: {
      ...EMPTY,
      evidence: [...input.cited.map((c) => c.handle), ...input.others.map((o) => o.handle)],
      unit: input.unit.dimensionId,
    },
  }),
};

function walkStrings(
  value: unknown,
  path: string,
  visit: (text: string, path: string) => void,
): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value))
    value.forEach((entry, index) => {
      walkStrings(entry, `${path}[${String(index)}]`, visit);
    });
  else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) walkStrings(entry, `${path}.${key}`, visit);
  }
}

const MIN_SECRET_CHARS = 8;

function checkSecrets(secrets: readonly string[] | undefined): readonly string[] {
  const list = secrets ?? [];
  list.forEach((secret, index) => {
    if (secret.length < MIN_SECRET_CHARS) {
      throw new PromptInputError([
        { path: `options.secrets[${String(index)}]`, code: 'secret_too_short' },
      ]);
    }
  });
  return list;
}

function itemText(markers: { begin: string; end: string }, item: FramedItem): string {
  const lines = [markers.begin, `meta: ${canonicalJson(item.meta)}`];
  if (item.body !== undefined) lines.push('text:', item.body);
  lines.push(markers.end);
  return lines.join('\n');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Pure and deterministic: the same input always yields the same bytes. The input is validated against a strict allow-list
 * schema (unsupported fields are rejected), a configured secret in any field aborts the render, and the output keeps the
 * structural trust boundary: trusted text only in `system`, every project-controlled character only inside marked records.
 */
export function renderPrompt(
  stage: AssessmentStage,
  input: unknown,
  options: RenderOptions = {},
): RenderedPrompt {
  const prompt = promptFor(stage);
  const parsed = STAGE_INPUT_SCHEMAS[stage].safeParse(input);
  if (!parsed.success) {
    const issues: PromptIssue[] = parsed.error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
    }));
    throw new PromptInputError(issues);
  }
  const value: unknown = parsed.data;
  const unitCandidate = (value as { unit?: UnitView }).unit;
  if (unitCandidate?.standard.basis === 'fallback' && !FALLBACK_ANCHORS_APPROVED) {
    throw new FallbackAnchorsNotApprovedError();
  }

  const secrets = checkSecrets(options.secrets);
  const scan = (text: string, path: string) => {
    for (const secret of secrets) if (text.includes(secret)) throw new PromptSecretError(path);
  };
  walkStrings(value, 'input', scan);

  const layout = (LAYOUTS[stage] as (input: unknown) => Layout)(value);
  const blocks: { kind: BlockKind; items: readonly FramedItem[] }[] = [];
  if (prompt.blocks.includes('standard')) blocks.push({ kind: 'standard', items: layout.standard });
  blocks.push({ kind: 'data', items: layout.data });

  // Everything project-influenced, as one canonical text: the preimage the boundary and every marker are checked against.
  const dataText = canonicalJson(blocks.map((block) => block.items));
  const seed = canonicalJson({
    systemBase: prompt.systemBase,
    promptId: prompt.id,
    promptVersion: prompt.version,
  });
  const boundary = deriveBoundary(seed, dataText, options.hash);

  const user = blocks.map((block) => {
    const rendered = block.items.map((item) => {
      const content = `${canonicalJson(item.meta)}\u0000${item.body ?? ''}`;
      return itemText(
        deriveItemMarkers(boundary, item.handle, content, dataText, options.hash),
        item,
      );
    });
    return [blockBegin(block.kind, boundary), ...rendered, blockEnd(block.kind, boundary)].join(
      '\n',
    );
  });
  const system = `${prompt.systemBase}\n\n${markerClause(
    boundary,
    blocks.map((block) => block.kind),
  )}`;

  // Last line of defense: no configured secret may be anywhere in what will be sent.
  scan(system, 'system');
  user.forEach((block, index) => {
    scan(block, `user[${String(index)}]`);
  });

  return deepFreeze({
    stage,
    promptId: prompt.id,
    promptVersion: prompt.version,
    promptTemplateHash: prompt.templateHash,
    schemaId: prompt.schemaId,
    schemaVersion: prompt.schemaVersion,
    outputSchemaHash: prompt.outputSchemaHash,
    system,
    user,
    boundary,
    closedSet: layout.closedSet,
    standardBasis: layout.unit?.standard.basis ?? null,
  });
}
