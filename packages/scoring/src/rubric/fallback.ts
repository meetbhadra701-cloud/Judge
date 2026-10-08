import { FALLBACK_RUBRIC_VERSION, type EvidenceChannel } from '@judge-copilot/schemas';
import { deepFreeze } from '../freeze.js';
import type { NeedGroup } from './spec.js';

/*
 * `fallback-rubric/v1`: the universal fallback rubric (docs/SCORING.md §3-4) as engine data.
 *
 * Criterion and dimension WEIGHTS are the project's published fallback weights. The EVIDENCE-NEED
 * GROUPS are the engine's own PROVISIONAL, VERSIONED HEURISTICS: nobody published them, reasonable
 * reviewers will move channels between groups, and any change is a new engine version. Limitations
 * (also in docs/milestones/M4-design.md §7 and the package README):
 *
 *  1. Groups made only of `team_answer`/`judge_observation` cannot be satisfied before the
 *     interview milestone (M7): `qa_understanding` is capped at coverage 0 and
 *     `technical_ownership` at 1/2 until then. That is intended.
 *  2. A channel being present is not proof it is informative: a deployment observation is one HTTP
 *     response and a video item is oEmbed metadata. Coverage records that such material was CITED;
 *     directness, specificity and strength carry how much it shows.
 *  3. Event-context evidence is version-level provenance.
 *  4. Coverage is breadth over channels, not a count of items.
 *
 * The fallback applies only when the locked context has no official overall rubric; it is never
 * mixed with an official rubric.
 */

const C: EvidenceChannel = 'source_code';
const R: EvidenceChannel = 'repository';
const S: EvidenceChannel = 'submission';
const D: EvidenceChannel = 'deployment';
const V: EvidenceChannel = 'video';
const X: EvidenceChannel = 'event_context';
const A: EvidenceChannel = 'team_answer';
const O: EvidenceChannel = 'judge_observation';

export interface FallbackDimensionDefinition {
  readonly key: string;
  readonly name: string;
  /** Percent of the criterion. */
  readonly weightPercent: number;
  readonly needGroups: readonly NeedGroup[];
}

export interface FallbackCriterionDefinition {
  readonly key: string;
  readonly name: string;
  /** Percent of the rubric. */
  readonly weightPercent: number;
  readonly dimensions: readonly FallbackDimensionDefinition[];
}

const dim = (
  key: string,
  name: string,
  weightPercent: number,
  ...needGroups: NeedGroup[]
): FallbackDimensionDefinition => ({ key, name, weightPercent, needGroups });

export const FALLBACK_TRACK_CRITERION_KEY = 'track_prize_alignment';

export const FALLBACK_RUBRIC_DEFINITION: readonly FallbackCriterionDefinition[] = deepFreeze([
  {
    key: 'technical_execution',
    name: 'Technical Execution & Depth',
    weightPercent: 20,
    dimensions: [
      dim('implementation_depth', 'Implementation depth', 25, [C]),
      dim('architecture_integration', 'Architecture / integration', 20, [C], [R, S, A]),
      dim('technical_ownership', 'Technical ownership', 20, [R, C], [A, O]),
      dim('correctness_robustness', 'Correctness / robustness', 20, [C], [D, O, V]),
      dim('engineering_challenge', 'Engineering challenge', 15, [C, R], [S, V, A]),
    ],
  },
  {
    key: 'completion_functionality',
    name: 'Completion & Functionality',
    weightPercent: 20,
    dimensions: [
      dim('core_user_flow', 'Core user flow', 30, [D, V, O], [C]),
      dim('runtime_live_demonstration', 'Runtime / live demonstration', 25, [D, V, O]),
      dim('end_to_end_integration', 'End-to-end integration', 20, [D, O, V], [C]),
      dim('stated_vs_implemented_scope', 'Stated vs. implemented scope', 15, [S, V, A], [C, D, O]),
      dim('failure_edge_handling', 'Failure / edge handling', 10, [C], [D, O, V]),
    ],
  },
  {
    key: 'innovation_creativity',
    name: 'Innovation & Creativity',
    weightPercent: 15,
    dimensions: [
      dim('novelty_of_approach', 'Novelty of approach', 30, [S, V, A], [C, R]),
      dim('differentiation', 'Differentiation', 25, [S, V, A], [C, R, D]),
      dim('original_technical_contribution', 'Original technical contribution', 25, [C], [R, S]),
      dim('purposeful_technology_use', 'Purposeful technology use', 20, [C, R], [S, A]),
    ],
  },
  {
    key: 'impact_problem_fit',
    name: 'Impact & Problem Fit',
    weightPercent: 15,
    dimensions: [
      dim('problem_clarity', 'Problem clarity', 15, [S, V, A]),
      dim('target_user_specificity', 'Target-user specificity', 15, [S, V, A]),
      dim('importance_frequency', 'Importance / frequency', 15, [S, V, A]),
      dim('solution_problem_fit', 'Solution / problem fit', 30, [S, V, A], [C, D, O, V]),
      dim('plausibility_of_benefit', 'Plausibility of benefit', 15, [S, V, A], [D, O, V]),
      dim('awareness_of_constraints', 'Awareness of constraints', 10, [S, V, A]),
    ],
  },
  {
    key: 'design_user_experience',
    name: 'Design & User Experience',
    weightPercent: 10,
    dimensions: [
      dim('primary_task_clarity', 'Primary-task clarity', 25, [D, V, O], [S]),
      dim('usability_interaction_flow', 'Usability / interaction flow', 25, [D, V, O]),
      dim('visual_hierarchy_coherence', 'Visual hierarchy / coherence', 15, [D, V, O]),
      dim(
        'product_specific_intentionality',
        'Product-specific intentionality',
        15,
        [D, V, O],
        [S, A],
      ),
      dim('accessibility_responsiveness', 'Accessibility / responsiveness', 10, [D, O], [C]),
      dim('feedback_error_states', 'Feedback / error states', 10, [D, O, V], [C]),
    ],
  },
  {
    key: 'demo_communication',
    name: 'Demo & Communication',
    weightPercent: 10,
    dimensions: [
      dim('problem_solution_clarity', 'Problem → solution clarity', 20, [V], [S]),
      dim('actual_proof_demonstration', 'Actual proof / demonstration', 30, [V, O, D]),
      dim('technical_explanation', 'Technical explanation', 20, [V, A, S]),
      dim('qa_understanding', 'Q&A understanding', 20, [A, O]),
      dim('honesty_about_limitations', 'Honesty about limitations', 10, [S, V, A], [C, R]),
    ],
  },
  {
    key: FALLBACK_TRACK_CRITERION_KEY,
    name: 'Track / Prize Alignment',
    weightPercent: 10,
    dimensions: [
      dim(
        'official_eligibility_required_technology',
        'Official eligibility / required technology',
        20,
        [X],
        [C, R, D, S],
      ),
      dim('actual_implementation_evidence', 'Actual implementation evidence', 30, [C]),
      dim('centrality', 'Centrality', 25, [C], [S, V, A]),
      dim('creativity_track_fit', 'Creativity / track fit', 15, [S, V, A]),
      dim('demonstrated_use', 'Demonstrated use', 10, [D, V, O]),
    ],
  },
]);

export { FALLBACK_RUBRIC_VERSION };
