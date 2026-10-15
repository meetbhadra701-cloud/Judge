/*
 * ACCEPTANCE THRESHOLDS for evidence selection (P6B-beta3, R9-B1). FIXED BEFORE the new selection policy was written.
 *
 * Provenance of each number: it is derived from a requirement stated in the milestone brief and from the arithmetic of the budgets, NOT from
 * what any policy achieved. The baseline (v1) was measured first (coverage-experiments.test.ts, `v1 baseline`), then these were written down
 * and committed, then v2 was built against them. A threshold may only be changed in a commit that says why, never to make a result pass.
 *
 * The budgets (packages/assessment DEFAULT_BUDGETS): statement 120,000, source 240,000, metadata 30,000 code points; a passage holds at most
 * 1,200 code points.
 */

export const THRESHOLDS = {
  /**
   * Every component (a monorepo package or a top-level directory) that contains implementation code must have some of it SHOWN, whenever the
   * budget can afford one 2,400-code-point head per component at all (2 passages; 240,000 / 2,400 = 100 components). A fraction below 1 is allowed
   * only for the rounding of generated/duplicate-only components, hence 0.9, not 1. Brief: "handles monorepos and projects with many packages".
   */
  implementationComponentCoverageMin: 0.9,
  /** Above 100 components the head of each can no longer be afforded; the requirement degrades to half of them (documented, not hidden). */
  componentCoverageMinWhenOverCapacity: 0.5,
  componentHeadCapacity: 100,

  /**
   * No single file may consume more than a quarter of its bucket's budget while some other eligible (non-generated) file of the bucket has not been
   * shown at all. Brief: "avoid allowing one enormous documentation file to consume the entire budget."
   */
  maxArtifactShareWhileOthersUnshown: 0.25,

  /** The root README is "important README context": at least its first 6,000 code points (5 passages), or all of it if shorter. */
  rootReadmeMinCodePoints: 6_000,

  /**
   * Deployment and configuration files are small and decisive. Unless all of them together exceed 10% of the source budget, EVERY deployment file
   * has its head (first passage) shown. Brief: "includes configuration, deployment and tests where relevant".
   */
  deploymentMaxShareForGuarantee: 0.1,

  /**
   * Tests are evidence of testing, not of the product: at most 30% of the shown source code points while some implementation component is still
   * uncovered, and at least one test file is shown when tests exist and the source bucket has room.
   */
  testShareMaxWhileComponentsUncovered: 0.3,

  /**
   * Generated artifacts, snapshots and duplicates must not displace implementation: at most 10% of the shown source code points while some
   * implementation file has not been shown.
   */
  generatedShareMax: 0.1,

  /** A bucket must not waste its budget: when more is eligible than the budget, at least 98% of the budget is used. */
  budgetUtilizationMin: 0.98,

  /**
   * The reported coverage must be exactly what the oracle recomputes from the passages (no tolerance), and selection must not depend on file
   * content (hostile text moves nothing).
   */
  coverageMetadataTolerance: 0,

  /** The new policy must not be worse than the old one on any of the above, and must be strictly better on component coverage in the monorepo cases. */
  noRegression: true,
} as const;

/** Scenarios in which the component-coverage threshold is evaluated (the ones that contain several implementation components). */
export const COMPONENT_SCENARIOS = [
  'large-monorepo',
  'implementation-late-in-traversal',
  'many-tiny-files',
  'large-test-suites',
  'real-judge-404',
] as const;
