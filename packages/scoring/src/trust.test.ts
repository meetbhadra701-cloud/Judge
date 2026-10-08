import { isEvidenceVerificationAllowed } from '@judge-copilot/evidence';
import {
  EVIDENCE_KIND_VALUES,
  EVIDENCE_ORIGIN_VALUES,
  VERIFICATION_LEVEL_VALUES,
  type VerificationLevel,
} from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import type { FixtureGraph } from './testing/builders.js';
import { baseWorld, IDS, uid } from './testing/builders.js';
import { channelOf, isPrivilegedLevel, isUsableKind, resolveEffectiveTrust } from './trust.js';

const PRIVILEGED = ['machine_verified', 'judge_verified', 'live_verified'] as const;
let n = 0;
const eid = () => uid((n += 1), 'e3000001');

function trustOf(graph: FixtureGraph, id: string) {
  const { graph: g, known } = graph.build();
  const evidence = g.evidence.get(id);
  if (!evidence) throw new Error('missing');
  return resolveEffectiveTrust(evidence, known);
}

describe('effective trust: labels are never trust', () => {
  it('keeps unverified and an allowed team_claim', () => {
    const g = baseWorld();
    const unverified = eid();
    const team = eid();
    g.addEvidence({
      id: unverified,
      origin: 'devpost',
      kind: 'claim',
      label: 'unverified',
      snapshotId: IDS.devpost,
    });
    g.addEvidence({
      id: team,
      origin: 'devpost',
      kind: 'claim',
      label: 'team_claim',
      snapshotId: IDS.devpost,
    });
    expect(trustOf(g, unverified)).toEqual({ level: 'unverified', flag: null });
    expect(trustOf(g, team)).toEqual({ level: 'team_claim', flag: null });
  });

  it('demotes a team_claim label the origin and kind cannot carry', () => {
    const g = baseWorld();
    const id = eid();
    g.addEvidence({
      id,
      origin: 'github',
      kind: 'fact',
      label: 'team_claim',
      snapshotId: IDS.github,
    });
    expect(trustOf(g, id)).toEqual({ level: 'unverified', flag: 'unsupported_verification_label' });
  });

  it('accepts repo_corroborated only for a GitHub fact anchored in repository SOURCE CODE', () => {
    const g = baseWorld();
    const id = eid();
    g.addEvidence({
      id,
      origin: 'github',
      kind: 'fact',
      label: 'repo_corroborated',
      snapshotId: IDS.github,
      artifactId: IDS.code,
      span: [0, 10],
    });
    expect(trustOf(g, id)).toEqual({ level: 'repo_corroborated', flag: null });
  });

  it.each([
    ['a README', IDS.readme],
    ['repository metadata', IDS.meta],
  ])(
    'demotes repo_corroborated anchored in %s (team prose / unclassified)',
    (_name, artifactId) => {
      const g = baseWorld();
      const id = eid();
      g.addEvidence({
        id,
        origin: 'github',
        kind: 'fact',
        label: 'repo_corroborated',
        snapshotId: IDS.github,
        artifactId,
      });
      expect(trustOf(g, id)).toEqual({
        level: 'unverified',
        flag: 'unsupported_repo_corroboration',
      });
    },
  );

  it('demotes repo_corroborated under a documentation directory even with a source extension', () => {
    const g = baseWorld().artifact(uid(77, 'f2000009'), IDS.github, 'files/docs/example.ts');
    const id = eid();
    g.addEvidence({
      id,
      origin: 'github',
      kind: 'fact',
      label: 'repo_corroborated',
      snapshotId: IDS.github,
      artifactId: uid(77, 'f2000009'),
    });
    expect(trustOf(g, id).flag).toBe('unsupported_repo_corroboration');
  });

  it('demotes repo_corroborated when the structure does not support it', () => {
    const cases: [string, (g: FixtureGraph) => string][] = [
      [
        'no artifact',
        (g) => {
          const id = eid();
          g.addEvidence({
            id,
            origin: 'github',
            kind: 'fact',
            label: 'repo_corroborated',
            snapshotId: IDS.github,
          });
          return id;
        },
      ],
      [
        'not GitHub',
        (g) => {
          const id = eid();
          g.addEvidence({
            id,
            origin: 'devpost',
            kind: 'fact',
            label: 'repo_corroborated',
            snapshotId: IDS.devpost,
            artifactId: IDS.code,
          });
          return id;
        },
      ],
      [
        'a claim, not a fact',
        (g) => {
          const id = eid();
          g.addEvidence({
            id,
            origin: 'github',
            kind: 'claim',
            label: 'repo_corroborated',
            snapshotId: IDS.github,
            artifactId: IDS.code,
          });
          return id;
        },
      ],
      [
        'artifact of another snapshot',
        (g) => {
          g.snapshot(uid(5, 'f1000009'), 'github');
          const id = eid();
          g.addEvidence({
            id,
            origin: 'github',
            kind: 'fact',
            label: 'repo_corroborated',
            snapshotId: uid(5, 'f1000009'),
            artifactId: IDS.code,
          });
          return id;
        },
      ],
      [
        'failed snapshot',
        (g) => {
          g.snapshot(uid(6, 'f1000009'), 'github', 'failed').artifact(
            uid(6, 'f2000009'),
            uid(6, 'f1000009'),
            'files/a.ts',
          );
          const id = eid();
          g.addEvidence({
            id,
            origin: 'github',
            kind: 'fact',
            label: 'repo_corroborated',
            snapshotId: uid(6, 'f1000009'),
            artifactId: uid(6, 'f2000009'),
          });
          return id;
        },
      ],
      [
        'snapshot of another project',
        (g) => {
          g.snapshot(uid(7, 'f1000009'), 'github', 'captured', uid(9, 'a0000009')).artifact(
            uid(7, 'f2000009'),
            uid(7, 'f1000009'),
            'files/a.ts',
          );
          const id = eid();
          g.addEvidence({
            id,
            origin: 'github',
            kind: 'fact',
            label: 'repo_corroborated',
            snapshotId: uid(7, 'f1000009'),
            artifactId: uid(7, 'f2000009'),
          });
          return id;
        },
      ],
      [
        'unknown artifact',
        (g) => {
          const id = eid();
          g.addEvidence({
            id,
            origin: 'github',
            kind: 'fact',
            label: 'repo_corroborated',
            snapshotId: IDS.github,
            artifactId: uid(99, 'f2000009'),
          });
          return id;
        },
      ],
    ];
    for (const [name, make] of cases) {
      const g = baseWorld();
      const id = make(g);
      expect(trustOf(g, id), name).toEqual({
        level: 'unverified',
        flag: 'unsupported_repo_corroboration',
      });
    }
  });

  it.each(PRIVILEGED)('never trusts a stored %s label: unverified plus a flag', (label) => {
    const g = baseWorld();
    const code = eid();
    const deployment = eid();
    g.addEvidence({
      id: code,
      origin: 'github',
      kind: 'fact',
      label,
      snapshotId: IDS.github,
      artifactId: IDS.code,
      span: [0, 6],
    });
    g.addEvidence({
      id: deployment,
      origin: 'deployment',
      kind: 'fact',
      label,
      snapshotId: IDS.deployment,
      artifactId: IDS.response,
      span: [0, 2],
    });
    expect(trustOf(g, code)).toEqual({ level: 'unverified', flag: 'unattested_privileged_level' });
    expect(trustOf(g, deployment)).toEqual({
      level: 'unverified',
      flag: 'unattested_privileged_level',
    });
  });

  it('also distrusts a privileged label that would otherwise have qualified as repo_corroborated', () => {
    const g = baseWorld();
    const id = eid();
    g.addEvidence({
      id,
      origin: 'github',
      kind: 'fact',
      label: 'machine_verified',
      snapshotId: IDS.github,
      artifactId: IDS.code,
      span: [0, 6],
    });
    // The same row honestly labeled repo_corroborated would be trusted at that level.
    const honest = eid();
    g.addEvidence({
      id: honest,
      origin: 'github',
      kind: 'fact',
      label: 'repo_corroborated',
      snapshotId: IDS.github,
      artifactId: IDS.code,
      span: [0, 6],
    });
    expect(trustOf(g, id).level).toBe('unverified');
    expect(trustOf(g, honest).level).toBe('repo_corroborated');
  });

  it('demotes the contradicted label on evidence', () => {
    const g = baseWorld();
    const id = eid();
    g.addEvidence({
      id,
      origin: 'devpost',
      kind: 'claim',
      label: 'contradicted',
      snapshotId: IDS.devpost,
    });
    expect(trustOf(g, id)).toEqual({ level: 'unverified', flag: 'unsupported_verification_label' });
  });

  it('is exhaustive: no origin/kind/label combination ever resolves above what its label and structure allow', () => {
    let combinations = 0;
    for (const origin of EVIDENCE_ORIGIN_VALUES) {
      for (const kind of EVIDENCE_KIND_VALUES) {
        for (const label of VERIFICATION_LEVEL_VALUES) {
          const g = baseWorld();
          const id = eid();
          const snapshotId =
            origin === 'github'
              ? IDS.github
              : origin === 'deployment'
                ? IDS.deployment
                : origin === 'video'
                  ? IDS.video
                  : IDS.devpost;
          g.addEvidence({
            id,
            origin,
            kind,
            label,
            snapshotId: origin === 'event_context' ? null : snapshotId,
            artifactId: origin === 'github' ? IDS.code : null,
            contextVersionId: origin === 'event_context' ? IDS.context : null,
          });
          const { level, flag } = trustOf(g, id);
          combinations += 1;
          if (isPrivilegedLevel(label)) {
            expect(level).toBe('unverified');
            expect(flag).toBe('unattested_privileged_level');
          }
          // Effective trust is never above the label, and is a label-supported level or unverified.
          if (level === 'team_claim') {
            expect(label).toBe('team_claim');
            expect(isEvidenceVerificationAllowed(origin, kind, 'team_claim')).toBe(true);
          }
          if (level === 'repo_corroborated') {
            expect(label).toBe('repo_corroborated');
            expect(origin).toBe('github');
            expect(kind).toBe('fact');
          }
          expect(['unverified', 'team_claim', 'repo_corroborated']).toContain(level);
        }
      }
    }
    expect(combinations).toBe(7 * 5 * 7);
  });
});

describe('claim labels', () => {
  it('are not an input of effective trust at all', () => {
    // resolveEffectiveTrust takes an EVIDENCE record and the known source facts. There is no claim
    // parameter, so a claim label cannot influence it (also asserted end to end in engine tests).
    expect(resolveEffectiveTrust.length).toBe(2);
  });
});

describe('channels and usable kinds', () => {
  it('derives the channel from structure', () => {
    const g = baseWorld();
    const make = (spec: Parameters<FixtureGraph['addEvidence']>[0]) => {
      g.addEvidence(spec);
      return spec.id;
    };
    const ids = {
      code: make({ id: eid(), origin: 'github', snapshotId: IDS.github, artifactId: IDS.code }),
      readme: make({ id: eid(), origin: 'github', snapshotId: IDS.github, artifactId: IDS.readme }),
      bare: make({ id: eid(), origin: 'github', snapshotId: IDS.github }),
      devpost: make({ id: eid(), origin: 'devpost', snapshotId: IDS.devpost }),
      deployment: make({ id: eid(), origin: 'deployment', snapshotId: IDS.deployment }),
      video: make({ id: eid(), origin: 'video', snapshotId: IDS.video }),
      context: make({ id: eid(), origin: 'event_context', contextVersionId: IDS.context }),
    };
    const { graph, known } = g.build();
    const channel = (id: string) => {
      const evidence = graph.evidence.get(id);
      if (!evidence) throw new Error('missing');
      return channelOf(evidence, known);
    };
    expect(channel(ids.code)).toBe('source_code');
    expect(channel(ids.readme)).toBe('repository');
    expect(channel(ids.bare)).toBe('repository');
    expect(channel(ids.devpost)).toBe('submission');
    expect(channel(ids.deployment)).toBe('deployment');
    expect(channel(ids.video)).toBe('video');
    expect(channel(ids.context)).toBe('event_context');
  });

  it('only facts and claims can support anything', () => {
    expect(EVIDENCE_KIND_VALUES.filter(isUsableKind)).toEqual(['fact', 'claim']);
  });

  it('knows the privileged levels', () => {
    expect(
      VERIFICATION_LEVEL_VALUES.filter((level: VerificationLevel) => isPrivilegedLevel(level)),
    ).toEqual(['machine_verified', 'judge_verified', 'live_verified']);
  });
});
