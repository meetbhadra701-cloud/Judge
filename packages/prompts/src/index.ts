/*
 * @judge-copilot/prompts — versioned, frozen prompts and the pure prompt renderer (M5, phase P2).
 *
 * Layer 3 (adapter). No provider, no network, no filesystem and no environment access: rendering is a pure function of its
 * input. Trusted instructions live only in the `system` text; every project-controlled character lives only inside
 * deterministically marked records of the user blocks. Records are named by code-assigned HANDLES, never by persisted UUIDs.
 * The fallback-rubric anchors are an unapproved draft and are refused (FALLBACK_ANCHORS_APPROVED is false).
 */
export {
  FallbackAnchorsNotApprovedError,
  PromptFramingError,
  PromptInputError,
  PromptSecretError,
} from './errors.js';
export type { PromptIssue } from './errors.js';
export { deriveBoundary, deriveItemMarkers } from './frame.js';
export type { BlockKind, HashFn } from './frame.js';
export {
  Candidate,
  CRITIC_FLAG_VALUES,
  PROMPT_INPUT_LIMITS,
  STAGE_INPUT_SCHEMAS,
  UnitView,
} from './inputs.js';
export type { StageInputs } from './inputs.js';
export { FALLBACK_ANCHORS_APPROVED, renderPrompt, requestFields } from './render.js';
export type { ClosedSet, RenderedPrompt, RenderOptions } from './render.js';
export { officialUnitFromLockedSnapshot } from './rubric-view.js';
export type { OfficialUnit, OfficialUnitBinding } from './rubric-view.js';
export { FRAMING_VERSION } from './system.js';
export { PROMPT_REGISTRY, PROMPT_VERSION, PROMPTS, promptFor } from './templates.js';
export type { StagePrompt } from './templates.js';
