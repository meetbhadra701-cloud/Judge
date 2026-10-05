import type {
  EvidenceKind,
  EvidenceOrigin,
  ProjectSourceType,
  VerificationLevel,
} from '@judge-copilot/schemas';
import { EVIDENCE_GRAPH_LIMITS } from '@judge-copilot/schemas';
import {
  CONTENT_SOURCE_SNAPSHOT_STATUSES,
  FROZEN_EVENT_CONTEXT_STATUSES,
} from '@judge-copilot/domain';
import type { GraphIssueCode } from './issues.js';
import { resolveKnown, type GraphScope, type KnownEntities } from './known.js';
import {
  evidenceAnchorRequirement,
  isEvidenceVerificationAllowed,
  isOriginCreatableInM3,
} from './verification.js';

/*
 * Evidence provenance rules.
 *
 *   source-derived origins (devpost, github, deployment, video):
 *     project -> SourceSnapshot (same project, captured|partial, matching source type)
 *             -> optional artifact (belongs to THAT snapshot)
 *             -> optional span (code-point offsets, in bounds) -> excerpt (verbatim span text)
 *   event_context:
 *     project's event -> EventContextVersion (same event, locked or superseded). The reference is
 *     version-level: M1 facts are not individually addressable by stable ID, so per-item
 *     provenance would require redesigning M1 (documented limitation).
 *
 * A capture verifies that text existed, not that it is true: nothing here raises a verification
 * level because a source was captured.
 */

/** The snapshot source type each source-derived origin must come from. */
export const ORIGIN_SOURCE_TYPE: Readonly<Partial<Record<EvidenceOrigin, ProjectSourceType>>> = {
  devpost: 'devpost',
  github: 'github',
  deployment: 'deployment',
  video: 'video',
};

export type ProvenanceKind = 'source_snapshot' | 'event_context_version' | 'none';

export function provenanceKindFor(origin: EvidenceOrigin): ProvenanceKind {
  if (origin === 'event_context') return 'event_context_version';
  if (origin in ORIGIN_SOURCE_TYPE) return 'source_snapshot';
  return 'none';
}

/** The provenance fields as stored (nullable) or as planned. */
export interface ProvenanceFields {
  snapshotId: string | null;
  artifactId: string | null;
  span: { start: number; end: number } | null;
  excerpt: string | null;
  contextVersionId: string | null;
}

export interface ProvenanceIssue {
  code: GraphIssueCode;
  /** The provenance field concerned, e.g. `provenance.span`. */
  field: string;
  message: string;
}

// -- Code-point text helpers (the span unit) ---------------------------------------------------

/** Number of Unicode code points in `text`. */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** The text between two code-point offsets, half-open. `undefined` when out of bounds. */
export function sliceCodePoints(text: string, start: number, end: number): string | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return undefined;
  }
  const points = Array.from(text);
  if (end > points.length) return undefined;
  return points.slice(start, end).join('');
}

function isValidSpan(span: { start: number; end: number }): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end - span.start <= EVIDENCE_GRAPH_LIMITS.excerptMaxChars
  );
}

// -- Shape rules (no lookups) ----------------------------------------------------------------

/**
 * Structural rules that depend only on the evidence itself: origin support, which provenance
 * fields an origin needs or forbids, span shape, anchors a level needs, and the
 * origin/kind/level matrix.
 */
export function checkProvenanceShape(
  evidence: {
    origin: EvidenceOrigin;
    kind: EvidenceKind;
    verificationLevel: VerificationLevel;
  },
  provenance: ProvenanceFields,
): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  const add = (code: GraphIssueCode, field: string, message: string) =>
    issues.push({ code, field, message });

  if (!isOriginCreatableInM3(evidence.origin)) {
    add(
      'ORIGIN_NOT_SUPPORTED',
      'origin',
      `Evidence with origin "${evidence.origin}" needs interview records that do not exist yet`,
    );
  }
  if (!isEvidenceVerificationAllowed(evidence.origin, evidence.kind, evidence.verificationLevel)) {
    add(
      'INVALID_VERIFICATION',
      'verificationLevel',
      `A ${evidence.origin} ${evidence.kind} item cannot carry verification level ${evidence.verificationLevel}`,
    );
  }

  const kind = provenanceKindFor(evidence.origin);
  if (kind === 'source_snapshot') {
    if (provenance.snapshotId === null) {
      add(
        'MISSING_PROVENANCE',
        'provenance.snapshotId',
        'Source-derived evidence needs the exact snapshot it came from',
      );
    }
    if (provenance.contextVersionId !== null) {
      add(
        'UNEXPECTED_PROVENANCE',
        'provenance.contextVersionId',
        'Source-derived evidence cannot cite an event context version',
      );
    }
  } else if (kind === 'event_context_version') {
    if (provenance.contextVersionId === null) {
      add(
        'MISSING_PROVENANCE',
        'provenance.contextVersionId',
        'Event-context evidence needs the event context version it came from',
      );
    }
    if (provenance.snapshotId !== null || provenance.artifactId !== null) {
      add(
        'UNEXPECTED_PROVENANCE',
        'provenance.snapshotId',
        'Event-context evidence cannot cite a source snapshot or artifact',
      );
    }
  }

  if (provenance.artifactId !== null && provenance.snapshotId === null) {
    add('MISSING_PROVENANCE', 'provenance.snapshotId', 'An artifact reference needs its snapshot');
  }
  if (provenance.span !== null && provenance.artifactId === null) {
    add('MISSING_PROVENANCE', 'provenance.artifactId', 'A span needs the artifact it points into');
  }
  if (provenance.excerpt !== null && provenance.span === null) {
    add('UNEXPECTED_PROVENANCE', 'provenance.excerpt', 'An excerpt needs the span it quotes');
  }
  if (provenance.span !== null) {
    const { start, end } = provenance.span;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start)) {
      add('SPAN_INVALID', 'provenance.span', 'A span must satisfy 0 <= start < end');
    } else if (end - start > EVIDENCE_GRAPH_LIMITS.excerptMaxChars) {
      add(
        'SPAN_INVALID',
        'provenance.span',
        `A span covers at most ${String(EVIDENCE_GRAPH_LIMITS.excerptMaxChars)} code points`,
      );
    }
  }

  const anchor = evidenceAnchorRequirement(evidence.verificationLevel);
  if (anchor.artifact && provenance.artifactId === null) {
    add(
      'MISSING_ANCHOR',
      'provenance.artifactId',
      `Verification level ${evidence.verificationLevel} needs an artifact anchor`,
    );
  }
  if (anchor.span && provenance.span === null) {
    add(
      'MISSING_ANCHOR',
      'provenance.span',
      `Verification level ${evidence.verificationLevel} needs a span anchor`,
    );
  }
  return issues;
}

// -- Lookup rules ----------------------------------------------------------------------------

/**
 * Checks provenance references against the authoritative entities. `deriveExcerpt` is true at
 * creation (the planner fills in the verbatim span text) and false when validating stored rows,
 * where a stored excerpt is compared if the artifact text is readable.
 * Returns the verbatim span text when it could be read.
 */
export function checkProvenanceReferences(
  origin: EvidenceOrigin,
  provenance: ProvenanceFields,
  known: KnownEntities,
  scope: GraphScope,
): { issues: ProvenanceIssue[]; spanText: string | null } {
  const issues: ProvenanceIssue[] = [];
  const add = (code: GraphIssueCode, field: string, message: string) =>
    issues.push({ code, field, message });
  let spanText: string | null = null;

  let snapshotOk = false;
  if (provenance.snapshotId !== null) {
    const snapshot = resolveKnown(known, provenance.snapshotId, 'snapshot', scope);
    if (!snapshot.ok) {
      add(snapshot.code, 'provenance.snapshotId', snapshot.message);
    } else {
      snapshotOk = true;
      if (
        !(CONTENT_SOURCE_SNAPSHOT_STATUSES as readonly string[]).includes(snapshot.entity.status)
      ) {
        add(
          'SNAPSHOT_NOT_CONTENT_BEARING',
          'provenance.snapshotId',
          `A ${snapshot.entity.status} snapshot holds no captured content to cite`,
        );
      }
      const expectedType = ORIGIN_SOURCE_TYPE[origin];
      if (expectedType !== undefined && snapshot.entity.sourceType !== expectedType) {
        add(
          'SOURCE_TYPE_MISMATCH',
          'provenance.snapshotId',
          `Evidence with origin ${origin} must cite a ${expectedType} snapshot, not ${snapshot.entity.sourceType}`,
        );
      }
    }
  }

  if (provenance.artifactId !== null) {
    const artifact = resolveKnown(known, provenance.artifactId, 'artifact', scope);
    if (!artifact.ok) {
      add(artifact.code, 'provenance.artifactId', artifact.message);
    } else {
      if (provenance.snapshotId !== null && artifact.entity.snapshotId !== provenance.snapshotId) {
        add(
          'ARTIFACT_SNAPSHOT_MISMATCH',
          'provenance.artifactId',
          'The artifact belongs to a different snapshot than the one cited',
        );
      } else if (snapshotOk && provenance.span !== null && isValidSpan(provenance.span)) {
        const { start, end } = provenance.span;
        if (end > artifact.entity.codePointLength) {
          add(
            'SPAN_OUT_OF_BOUNDS',
            'provenance.span',
            `The span ends past the artifact's ${String(artifact.entity.codePointLength)} code points`,
          );
        } else if (artifact.entity.slice) {
          spanText = artifact.entity.slice(start, end) ?? null;
          if (spanText === null) {
            add(
              'SPAN_OUT_OF_BOUNDS',
              'provenance.span',
              'The span cannot be read from the artifact',
            );
          } else if (provenance.excerpt !== null && provenance.excerpt !== spanText) {
            add(
              'EXCERPT_MISMATCH',
              'provenance.excerpt',
              "The excerpt is not the span's exact text",
            );
          }
        }
      }
    }
  }

  if (provenance.contextVersionId !== null) {
    const version = resolveKnown(known, provenance.contextVersionId, 'context_version', scope);
    if (!version.ok) {
      add(version.code, 'provenance.contextVersionId', version.message);
    } else if (
      !(FROZEN_EVENT_CONTEXT_STATUSES as readonly string[]).includes(version.entity.status)
    ) {
      add(
        'CONTEXT_VERSION_NOT_FROZEN',
        'provenance.contextVersionId',
        `A ${version.entity.status} event context version is not frozen and cannot be cited`,
      );
    }
  }
  return { issues, spanText };
}
