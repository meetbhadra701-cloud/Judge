import {
  buildEvidenceGraph,
  type EvidenceGraph,
  type KnownEntities,
} from '@judge-copilot/evidence';
import {
  ArtifactProvenanceFacts,
  ClaimRecord,
  ContextVersionProvenanceFacts,
  ContradictionRecord,
  EvidenceRecord,
  RelationRecord,
  SnapshotProvenanceFacts,
  UnknownRecord,
  type ScoringIssue,
} from '@judge-copilot/schemas';
import { deepFreeze } from './freeze.js';

/*
 * A private, validated, immutable SNAPSHOT of the evidence graph and its source facts.
 *
 * Why. The graph and known-entity maps a caller passes in are mutable and caller-owned. If the
 * context kept references to them, anything holding the originals could change an artifact's key
 * (turning a README into "source code" and raising a strength from 0.15 to 0.60), inject evidence
 * after the integrity check, or rewrite relations, contradictions, provenance, labels or
 * supersession, all after validation and fingerprinting. `Object.freeze` on the outer context does
 * nothing for the contents of a Map.
 *
 * What. Every record the engine consumes is schema-parsed into a NEW object (Zod builds fresh
 * objects and arrays, drops unknown keys, and rejects malformed values), deeply frozen, and the
 * evidence graph's indexes are rebuilt from those copies, so the ordered arrays and every index are
 * consistent by construction. Validation, fingerprinting and scoring all use this snapshot and
 * nothing else; the originals are never read again. The caller's index Maps are only compared with
 * their ordered arrays, and any disagreement is rejected rather than guessed at.
 *
 * The snapshot object is never handed out: it lives in a module-private WeakMap (context.ts).
 */

export type SnapshotResult =
  | { readonly ok: true; readonly graph: EvidenceGraph; readonly known: KnownEntities }
  | { readonly ok: false; readonly issues: readonly ScoringIssue[] };

const MAX_ISSUES = 50;

/** What every schema in `@judge-copilot/schemas` offers; avoids a direct dependency on the validator. */
interface Parser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

interface Collector {
  readonly issues: ScoringIssue[];
  fail(path: string, message: string): void;
}

function parseList<T>(schema: Parser<T>, raw: unknown, label: string, collector: Collector): T[] {
  if (!Array.isArray(raw)) {
    collector.fail(`graph.${label}`, 'Expected a list of records');
    return [];
  }
  const out: T[] = [];
  raw.forEach((entry: unknown, index) => {
    const parsed = schema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
    else {
      const first = parsed.error.issues[0];
      collector.fail(
        [`graph.${label}`, String(index), ...(first?.path ?? []).map(String)].join('.'),
        first?.message ?? 'Invalid record',
      );
    }
  });
  return out;
}

/**
 * Copies a map of source facts through its schema. `slice` and any other function-valued field of a
 * fact is not data and is dropped; each copy is frozen and must be filed under its own ID.
 */
function copyFacts<T extends { id: string }>(
  label: string,
  schema: Parser<T>,
  source: unknown,
  collector: Collector,
): Map<string, T> {
  const out = new Map<string, T>();
  if (!(source instanceof Map)) {
    collector.fail(`known.${label}`, 'Expected a map of source facts');
    return out;
  }
  for (const [key, value] of source as Map<string, unknown>) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      collector.fail(`known.${label}.${key}`, parsed.error.issues[0]?.message ?? 'Invalid fact');
    } else if (parsed.data.id !== key) {
      collector.fail(`known.${label}.${key}`, 'A source fact is filed under another ID');
    } else {
      out.set(key, deepFreeze(parsed.data));
    }
  }
  return out;
}

/** The caller's index must hold exactly the ordered records (same IDs), or the graph is inconsistent. */
function indexAgrees(index: unknown, ordered: readonly { id: string }[]): boolean {
  if (!(index instanceof Map) || index.size !== ordered.length) return false;
  return ordered.every((record) => index.has(record.id));
}

export function snapshotGraph(graph: EvidenceGraph, known: KnownEntities): SnapshotResult {
  const issues: ScoringIssue[] = [];
  const collector: Collector = {
    issues,
    fail(path, message) {
      if (issues.length < MAX_ISSUES)
        issues.push({ code: 'GRAPH_INTEGRITY_FAILED', path, message });
    },
  };

  const ordered = graph.ordered as typeof graph.ordered | undefined;
  if (!ordered) {
    collector.fail('graph', 'The graph has no ordered records');
    return { ok: false, issues };
  }
  const claims = parseList(ClaimRecord, ordered.claims, 'claims', collector);
  const evidence = parseList(EvidenceRecord, ordered.evidence, 'evidence', collector);
  const relations = parseList(RelationRecord, ordered.relations, 'relations', collector);
  const unknowns = parseList(UnknownRecord, ordered.unknowns, 'unknowns', collector);
  const contradictions = parseList(
    ContradictionRecord,
    ordered.contradictions,
    'contradictions',
    collector,
  );

  for (const [label, list, index] of [
    ['claims', claims, graph.claims],
    ['evidence', evidence, graph.evidence],
    ['relations', relations, graph.relations],
    ['unknowns', unknowns, graph.unknowns],
    ['contradictions', contradictions, graph.contradictions],
  ] as const) {
    if (new Set(list.map((record) => record.id)).size !== list.length) {
      collector.fail(`graph.${label}`, 'Two records share an ID');
    } else if (!indexAgrees(index, list)) {
      collector.fail(`graph.${label}`, 'The graph index does not match its ordered records');
    }
  }

  const snapshots = copyFacts('snapshots', SnapshotProvenanceFacts, known.snapshots, collector);
  const artifacts = copyFacts('artifacts', ArtifactProvenanceFacts, known.artifacts, collector);
  const contextVersions = copyFacts(
    'contextVersions',
    ContextVersionProvenanceFacts,
    known.contextVersions,
    collector,
  );

  if (issues.length > 0) return { ok: false, issues };

  const frozen = deepFreeze({ claims, evidence, relations, unknowns, contradictions });
  return {
    ok: true,
    graph: buildEvidenceGraph(frozen),
    known: {
      claims: new Map(),
      evidence: new Map(),
      snapshots,
      artifacts,
      contextVersions,
    },
  };
}
