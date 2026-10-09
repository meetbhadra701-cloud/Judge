/* Test-only: drives the pure pipeline from fixed, hand-written "model outputs". Nothing here is a real model answer. */
import {
  buildPassages,
  buildStatementItems,
  indexPassages,
  resolveFidelity,
  validateClaimExtraction,
  validateEvidenceInterpretation,
  type AdmittedClaim,
  type AdmittedEvidence,
  type CommentaryWorld,
  type Passage,
  type RelationEvidence,
  type RelationWorld,
  type SourceArtifact,
  type StatementItem,
} from '../index.js';
import { hydroTrackArtifacts } from './world.js';

export const DEVPOST_REMINDER =
  'HydroTrack sends a reminder every two hours and stores each intake entry in SQLite.';
export const DEVPOST_OFFLINE = 'It works offline and never sends your data to a server.';
export const CODE_THROW = "if (amount <= 0) throw new RangeError('amount must be positive');";
export const CODE_INSERT = 'db.insert({ amount, at: Date.now() });';

export function passageFor(passages: readonly Passage[], key: string): Passage {
  const found = passages.find((p) => p.artifactKey === key);
  if (!found) throw new Error(`no passage for ${key}`);
  return found;
}

export interface Extracted {
  readonly artifacts: readonly SourceArtifact[];
  readonly passages: readonly Passage[];
  readonly claims: readonly AdmittedClaim[];
  readonly evidence: readonly AdmittedEvidence[];
  readonly statements: readonly StatementItem[];
  readonly relationWorld: RelationWorld;
  readonly commentaryWorld: CommentaryWorld;
}

function accepted<T>(result: { ok: boolean } & Partial<{ accepted: readonly T[] }>): readonly T[] {
  if (!result.ok || result.accepted === undefined)
    throw new Error(`fixture rejected: ${JSON.stringify(result)}`);
  return result.accepted;
}

/** The happy path: two verbatim claims, two interpreted facts (one verbatim, one reviewed paraphrase). */
export function extract(artifacts: readonly SourceArtifact[] = hydroTrackArtifacts()): Extracted {
  const { passages } = buildPassages(artifacts);
  const index = indexPassages(passages);
  const devpost = passageFor(passages, 'submission.txt');
  const code = passages.find((p) => p.artifactKey === 'files/src/intake.ts');
  const claims = accepted(
    validateClaimExtraction(
      {
        claims: [
          { ref: 'c1', text: DEVPOST_REMINDER, passage: devpost.handle, quote: DEVPOST_REMINDER },
          { ref: 'c2', text: DEVPOST_OFFLINE, passage: devpost.handle, quote: DEVPOST_OFFLINE },
        ],
      },
      index,
    ),
  );
  // A project without a repository passage (for example a Devpost-only submission) has no interpreted evidence.
  const interpreted = code
    ? accepted(
        validateEvidenceInterpretation(
          {
            evidence: [
              {
                ref: 'e1',
                text: 'addIntake rejects non-positive amounts.',
                passage: code.handle,
                quote: CODE_THROW,
              },
              { ref: 'e2', text: CODE_INSERT, passage: code.handle, quote: CODE_INSERT },
            ],
          },
          index,
        ),
      )
    : [];
  const resolved = resolveFidelity(claims, interpreted, [{ item: 'E-001', verdict: 'faithful' }]);
  const statements = buildStatementItems(resolved.claims, resolved.evidence).items;
  const relationWorld: RelationWorld = {
    claims: new Map(resolved.claims.map((c) => [c.handle, { handle: c.handle, text: c.text }])),
    evidence: new Map<string, RelationEvidence>([
      ...statements.map(
        (s) =>
          [
            s.handle,
            {
              handle: s.handle,
              kind: 'claim' as const,
              text: s.text,
              excerpt: s.located.excerpt,
              statementOf: s.claimHandles,
            },
          ] as const,
      ),
      ...resolved.evidence.map(
        (e) =>
          [
            e.handle,
            {
              handle: e.handle,
              kind: 'fact' as const,
              text: e.text,
              excerpt: e.located.excerpt,
              statementOf: [] as string[],
            },
          ] as const,
      ),
    ]),
  };
  const commentaryWorld: CommentaryWorld = {
    claims: new Set(relationWorld.claims.keys()),
    evidence: new Set(relationWorld.evidence.keys()),
    statementOf: new Map(statements.map((s) => [s.handle, s.claimHandles])),
  };
  return {
    artifacts,
    passages,
    claims: resolved.claims,
    evidence: resolved.evidence,
    statements,
    relationWorld,
    commentaryWorld,
  };
}
