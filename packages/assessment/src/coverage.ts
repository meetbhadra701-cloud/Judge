import type { Bucket, RoutedSourceType } from './routing.js';
import { repositoryComponent, repositoryRole } from './repository-roles.js';
import { PROSE_CATEGORY_VALUES, STUB_COMPONENT_BELOW, type ProseCategory } from './selection-v3.js';
import type { Range, SelectionPolicyId } from './windowing.js';

/*
 * The COVERAGE REPORT (P6B-beta3, remediated after R7D): an honest account of what of the captured material reached the model stages.
 *
 * Three things are kept apart, because they are not the same and none implies another:
 *   1. FILE REPRESENTATION   which original artifacts have a shown passage (or an identical, same-role twin that has).
 *   2. IMPLEMENTATION CONTENT  how many of the code points of the path-classified implementation files were inspected.
 *   3. RELEVANCE TO A CRITERION  whether what was inspected is what a rubric criterion needs. NOT ESTABLISHED by anything here: it is always
 *      `not_established`, and no verdict below claims the model understood the implementation.
 *
 * The INVENTORY is the original eligible artifacts, every one with its identity, role and status. Duplicate suppression only decides what is sent
 * to a model; it never shrinks the inventory or the denominators: a byte-identical copy still counts in full, and counts as inspected ONLY when
 * its twin has the same role and was shown ("represented"). Roles come from paths alone (`roleBasis: 'path_only'`): a name can place a file in a
 * role, and that is stated, not hidden. Nothing here is a statement about the quality of the project, and an unseen range is unknown, never negative.
 */

export type CoverageStatus = 'full' | 'partial' | 'unseen' | 'duplicate';

export type CoverageRole =
  | 'deployment'
  | 'manifest'
  | 'config'
  | 'implementation'
  | 'test'
  | 'generated'
  | 'statement'
  | 'metadata'
  | 'observation';

/** Exactly what of one artifact's text reached the model stages. Ranges are code-point offsets into the ORIGINAL text, half-open. */
export interface ArtifactCoverage {
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly artifactKey: string;
  readonly sourceType: RoutedSourceType;
  readonly bucket: Bucket;
  /** From the path alone: deployment, manifest, config, implementation, test, generated; statement/metadata/observation otherwise. */
  readonly role: CoverageRole;
  readonly component: string | null;
  /** For prose: its documentation category; null otherwise. */
  readonly category: ProseCategory | null;
  readonly status: CoverageStatus;
  /** Code points of passage text (the visible, eligible text) of this artifact. */
  readonly totalCodePoints: number;
  readonly shownCodePoints: number;
  /** How many leading passages were shown, and where the last one ends. The shown text is always exactly the first `passagesShown` passages. */
  readonly passagesShown: number;
  readonly shownEnd: number;
  readonly shownRanges: readonly Range[];
  /** The part never shown: UNKNOWN to every later stage, not evidence of anything. */
  readonly unshownRanges: readonly Range[];
  /** SHA-256 of the stored text, so a historical record can be checked against the immutable snapshot artifact it describes. */
  readonly textSha256: string;
  readonly duplicateOf: string | null;
  /** A duplicate whose SAME-ROLE twin was shown: its bytes were inspected through the twin. Always false for a non-duplicate. */
  readonly represented: boolean;
  readonly representedCodePoints: number;
}

export interface ComponentCoverage {
  readonly component: string;
  readonly implementationFiles: number;
  readonly implementationFilesShown: number;
  readonly implementationFilesRepresented: number;
  /** Original inventory, duplicates included. */
  readonly implementationCodePoints: number;
  readonly implementationCodePointsShown: number;
  readonly implementationCodePointsRepresented: number;
  /** Below STUB_COMPONENT_BELOW implementation code points. Reported, never counted as reassurance. */
  readonly stub: boolean;
}

export interface CategoryCoverage {
  readonly category: ProseCategory;
  readonly files: number;
  readonly filesShown: number;
  readonly filesRepresented: number;
  readonly codePoints: number;
  readonly codePointsShown: number;
}

export interface RoleInventory {
  readonly files: number;
  readonly filesShown: number;
  readonly codePoints: number;
  readonly codePointsShown: number;
}

export type CoverageVerdict = 'complete' | 'partial' | 'insufficient';

export const COVERAGE_CONCERN_VALUES = [
  'implementation_components_unseen',
  'implementation_partially_seen',
  'no_implementation_shown',
  'implementation_mostly_unseen',
  'dominant_component_unseen',
  'largest_components_unseen',
  'generated_volume_large',
  'duplicates_not_represented',
  'component_flood',
  'documentation_partially_seen',
  'documentation_category_unseen',
  'configuration_partially_seen',
  'tests_partially_seen',
] as const;
export type CoverageConcern = (typeof COVERAGE_CONCERN_VALUES)[number];

/**
 * The verdict rules, fixed here and documented in docs/ARCHITECTURE.md. They are heuristics over path-derived metadata. They are NOT proof that
 * an implementation was understood or that a criterion could be assessed, and they are not tuned to any one repository.
 *
 *   insufficient  implementation exists and (none of it was inspected, or fewer than `insufficientBelowInspectedShare` of its code points were, or
 *                 a DOMINANT component (>= `dominantComponentShare` of the implementation code points) has nothing inspected, or NONE of the
 *                 `largestComponentsChecked` largest components has anything inspected, or fewer than half of the MEANINGFUL components (not
 *                 stubs) have anything inspected)
 *   partial       anything eligible is neither shown in full nor represented by an identical same-role twin
 *   complete      otherwise
 */
export const COVERAGE_POLICY = Object.freeze({
  insufficientBelowComponentFraction: 0.5,
  insufficientBelowInspectedShare: 0.05,
  dominantComponentShare: 0.25,
  /** The K largest implementation components (by original code points); if none of them has anything inspected the verdict is insufficient. */
  largestComponentsChecked: 3,
  mostlyUnseenBelowShare: 0.5,
  generatedLargeShare: 0.5,
  /** More components than this cannot all receive a head from the default source budget (240,000 / 2,400): ordering then decides which are cut. */
  componentFloodAbove: 100,
  stubBelowCodePoints: STUB_COMPONENT_BELOW,
});

export interface CoverageMeasures {
  readonly fileRepresentation: {
    readonly eligibleFiles: number;
    readonly withShownPassage: number;
    readonly representedByTwin: number;
    readonly unseen: number;
  };
  readonly implementation: {
    readonly files: number;
    readonly filesShown: number;
    readonly filesRepresented: number;
    readonly filesUnseen: number;
    readonly codePoints: number;
    readonly codePointsShown: number;
    readonly codePointsRepresented: number;
    readonly codePointsUnseen: number;
    /** (shown + represented) / total; 1 when there is no implementation. */
    readonly inspectedShare: number;
  };
  readonly components: {
    readonly total: number;
    readonly meaningful: number;
    readonly stubs: number;
    readonly withShownFile: number;
    readonly meaningfulWithShownFile: number;
  };
  readonly roles: Readonly<Record<string, RoleInventory>>;
  readonly generatedShareOfSourceInventory: number;
  readonly documentation: readonly CategoryCoverage[];
}

export interface CoverageReport {
  readonly policy: SelectionPolicyId;
  /** The INVENTORY of original eligible artifacts (duplicates included), sorted by key. */
  readonly artifacts: readonly ArtifactCoverage[];
  /** Implementation components, with how much of each was inspected; sorted by code points descending, then name. */
  readonly components: readonly ComponentCoverage[];
  readonly measures: CoverageMeasures;
  readonly verdict: CoverageVerdict;
  /** Stable codes saying why the verdict is not `complete`; each is a fact about the SELECTION, never about the project. */
  readonly concerns: readonly CoverageConcern[];
  /** Whether what was inspected is what a rubric criterion needs. Never established by this report. */
  readonly relevance: 'not_established';
  /** Roles and components were derived from paths alone. */
  readonly roleBasis: 'path_only';
}

const compareCodePoints = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const unfinished = (status: CoverageStatus): boolean => status === 'partial' || status === 'unseen';

/** Roles and components of artifacts that a policy did not classify (selection v1), from paths alone. */
export function classifyForCoverage(
  sourceType: RoutedSourceType,
  key: string,
  bucket: Bucket,
): { role: CoverageRole; component: string | null } {
  if (sourceType === 'github' && key.startsWith('files/') && bucket === 'source') {
    const path = key.slice('files/'.length);
    return { role: repositoryRole(path), component: repositoryComponent(path) };
  }
  return {
    role: bucket === 'statement' ? 'statement' : bucket === 'metadata' ? 'metadata' : 'observation',
    component: null,
  };
}

export function buildCoverageReport(
  entries: readonly ArtifactCoverage[],
  policy: SelectionPolicyId,
): CoverageReport {
  const artifacts = [...entries].sort(
    (a, b) =>
      compareCodePoints(a.artifactKey, b.artifactKey) ||
      compareCodePoints(a.snapshotId, b.snapshotId) ||
      compareCodePoints(a.artifactId, b.artifactId),
  );
  const isImplementation = (a: ArtifactCoverage): boolean =>
    a.sourceType === 'github' && a.bucket === 'source' && a.role === 'implementation';
  const inspected = (a: ArtifactCoverage): number =>
    a.status === 'duplicate' ? a.representedCodePoints : a.shownCodePoints;

  // -- components (original inventory: duplicates are counted, and counted as inspected only when represented) --------------------------
  const byComponent = new Map<string, ComponentCoverage>();
  for (const a of artifacts.filter(isImplementation)) {
    const name = a.component ?? '(root)';
    const current = byComponent.get(name);
    const shownFile = a.shownCodePoints > 0 ? 1 : 0;
    const representedFile = a.status === 'duplicate' && a.represented ? 1 : 0;
    byComponent.set(name, {
      component: name,
      implementationFiles: (current?.implementationFiles ?? 0) + 1,
      implementationFilesShown: (current?.implementationFilesShown ?? 0) + shownFile,
      implementationFilesRepresented:
        (current?.implementationFilesRepresented ?? 0) + representedFile,
      implementationCodePoints: (current?.implementationCodePoints ?? 0) + a.totalCodePoints,
      implementationCodePointsShown:
        (current?.implementationCodePointsShown ?? 0) + a.shownCodePoints,
      implementationCodePointsRepresented:
        (current?.implementationCodePointsRepresented ?? 0) +
        (a.status === 'duplicate' ? a.representedCodePoints : 0),
      stub: false,
    });
  }
  const components: ComponentCoverage[] = [...byComponent.values()]
    .map((c) => ({ ...c, stub: c.implementationCodePoints < COVERAGE_POLICY.stubBelowCodePoints }))
    .sort(
      (a, b) =>
        b.implementationCodePoints - a.implementationCodePoints ||
        compareCodePoints(a.component, b.component),
    );

  // -- implementation content ------------------------------------------------------------------------------------------------------------
  const impl = artifacts.filter(isImplementation);
  const implCp = impl.reduce((n, a) => n + a.totalCodePoints, 0);
  const implShown = impl.reduce((n, a) => n + a.shownCodePoints, 0);
  const implRepresented = impl.reduce(
    (n, a) => n + (a.status === 'duplicate' ? a.representedCodePoints : 0),
    0,
  );
  const inspectedShare = implCp === 0 ? 1 : (implShown + implRepresented) / implCp;
  const implFilesShown = impl.filter((a) => a.shownCodePoints > 0).length;
  const implFilesRepresented = impl.filter((a) => a.status === 'duplicate' && a.represented).length;

  // -- roles, files, documentation -----------------------------------------------------------------------------------------------------
  const roles: Record<string, RoleInventory> = {};
  for (const a of artifacts) {
    const r = roles[a.role] ?? { files: 0, filesShown: 0, codePoints: 0, codePointsShown: 0 };
    roles[a.role] = {
      files: r.files + 1,
      filesShown: r.filesShown + (inspected(a) > 0 ? 1 : 0),
      codePoints: r.codePoints + a.totalCodePoints,
      codePointsShown: r.codePointsShown + inspected(a),
    };
  }
  const sourceInventory = artifacts.filter((a) => a.bucket === 'source');
  const sourceCp = sourceInventory.reduce((n, a) => n + a.totalCodePoints, 0);
  const generatedCp = sourceInventory
    .filter((a) => a.role === 'generated')
    .reduce((n, a) => n + a.totalCodePoints, 0);
  const documentation: CategoryCoverage[] = PROSE_CATEGORY_VALUES.flatMap((category) => {
    const files = artifacts.filter((a) => a.bucket === 'statement' && a.category === category);
    if (files.length === 0) return [];
    return [
      {
        category,
        files: files.length,
        filesShown: files.filter((a) => a.shownCodePoints > 0).length,
        filesRepresented: files.filter((a) => a.status === 'duplicate' && a.represented).length,
        codePoints: files.reduce((n, a) => n + a.totalCodePoints, 0),
        codePointsShown: files.reduce((n, a) => n + inspected(a), 0),
      },
    ];
  });
  const withShown = artifacts.filter((a) => a.shownCodePoints > 0).length;
  const representedByTwin = artifacts.filter(
    (a) => a.status === 'duplicate' && a.represented,
  ).length;
  const meaningful = components.filter((c) => !c.stub);
  const inspectedComponent = (c: ComponentCoverage): boolean =>
    c.implementationFilesShown > 0 || c.implementationFilesRepresented > 0;
  const meaningfulSeen = meaningful.filter(inspectedComponent).length;
  const measures: CoverageMeasures = {
    fileRepresentation: {
      eligibleFiles: artifacts.length,
      withShownPassage: withShown,
      representedByTwin,
      unseen: artifacts.length - withShown - representedByTwin,
    },
    implementation: {
      files: impl.length,
      filesShown: implFilesShown,
      filesRepresented: implFilesRepresented,
      filesUnseen: impl.length - implFilesShown - implFilesRepresented,
      codePoints: implCp,
      codePointsShown: implShown,
      codePointsRepresented: implRepresented,
      codePointsUnseen: implCp - implShown - implRepresented,
      inspectedShare,
    },
    components: {
      total: components.length,
      meaningful: meaningful.length,
      stubs: components.length - meaningful.length,
      withShownFile: components.filter(inspectedComponent).length,
      meaningfulWithShownFile: meaningfulSeen,
    },
    roles,
    generatedShareOfSourceInventory: sourceCp === 0 ? 0 : generatedCp / sourceCp,
    documentation,
  };

  // -- concerns and verdict ------------------------------------------------------------------------------------------------------------
  const concerns: CoverageConcern[] = [];
  let insufficient = false;
  if (impl.length > 0) {
    if (implShown + implRepresented === 0) {
      concerns.push('no_implementation_shown');
      insufficient = true;
    } else {
      if (inspectedShare < COVERAGE_POLICY.insufficientBelowInspectedShare) insufficient = true;
      if (inspectedShare < COVERAGE_POLICY.mostlyUnseenBelowShare)
        concerns.push('implementation_mostly_unseen');
      if (
        components.some(
          (c) => c.implementationFilesShown === 0 && c.implementationFilesRepresented === 0,
        )
      ) {
        concerns.push('implementation_components_unseen');
      }
      if (
        meaningful.length > 0 &&
        meaningfulSeen / meaningful.length < COVERAGE_POLICY.insufficientBelowComponentFraction
      ) {
        insufficient = true;
      }
      if (implShown + implRepresented < implCp) concerns.push('implementation_partially_seen');
    }
    const dominant = components.some(
      (c) =>
        c.implementationCodePoints >= COVERAGE_POLICY.dominantComponentShare * implCp &&
        c.implementationCodePointsShown + c.implementationCodePointsRepresented === 0,
    );
    if (dominant) {
      concerns.push('dominant_component_unseen');
      insufficient = true;
    }
    // `components` is sorted by original implementation code points, descending
    const largest = components.slice(0, COVERAGE_POLICY.largestComponentsChecked);
    if (largest.length > 0 && largest.every((c) => !inspectedComponent(c))) {
      concerns.push('largest_components_unseen');
      insufficient = true;
    }
    if (components.length > COVERAGE_POLICY.componentFloodAbove) concerns.push('component_flood');
  }
  if (measures.generatedShareOfSourceInventory >= COVERAGE_POLICY.generatedLargeShare)
    concerns.push('generated_volume_large');
  if (artifacts.some((a) => a.status === 'duplicate' && !a.represented))
    concerns.push('duplicates_not_represented');
  if (artifacts.some((a) => a.bucket === 'statement' && unfinished(a.status)))
    concerns.push('documentation_partially_seen');
  if (documentation.some((c) => c.files > 0 && c.filesShown + c.filesRepresented === 0))
    concerns.push('documentation_category_unseen');
  if (
    artifacts.some(
      (a) =>
        a.bucket === 'source' &&
        ['deployment', 'manifest', 'config'].includes(a.role) &&
        unfinished(a.status),
    )
  ) {
    concerns.push('configuration_partially_seen');
  }
  if (artifacts.some((a) => a.role === 'test' && unfinished(a.status)))
    concerns.push('tests_partially_seen');
  const anyUnfinished = artifacts.some(
    (a) => unfinished(a.status) || (a.status === 'duplicate' && !a.represented),
  );
  const verdict: CoverageVerdict = insufficient
    ? 'insufficient'
    : anyUnfinished
      ? 'partial'
      : 'complete';
  return {
    policy,
    artifacts,
    components,
    measures,
    verdict,
    concerns: COVERAGE_CONCERN_VALUES.filter((c) => concerns.includes(c)),
    relevance: 'not_established',
    roleBasis: 'path_only',
  };
}
