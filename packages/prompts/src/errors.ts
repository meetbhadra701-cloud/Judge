/*
 * Prompt errors carry PATHS and CODES only, never the offending value: prompt input is untrusted project text and may
 * hold secrets, so an error message must be safe to log.
 */

export interface PromptIssue {
  readonly path: string;
  readonly code: string;
}

export class PromptInputError extends Error {
  readonly issues: readonly PromptIssue[];

  constructor(issues: readonly PromptIssue[]) {
    super('Invalid prompt input');
    this.name = 'PromptInputError';
    this.issues = issues.slice(0, 50);
  }
}

/** A configured secret value was found in text that was about to become a prompt. The value is never reported. */
export class PromptSecretError extends Error {
  readonly path: string;

  constructor(path: string) {
    super('A configured secret value appears in prompt content');
    this.name = 'PromptSecretError';
    this.path = path;
  }
}

/** The fallback rubric's anchors are an unapproved owner-review draft; no prompt may use them (design N12). */
export class FallbackAnchorsNotApprovedError extends Error {
  constructor() {
    super('The fallback anchors are not approved for use');
    this.name = 'FallbackAnchorsNotApprovedError';
  }
}

export class PromptFramingError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Prompt framing failed: ${code}`);
    this.name = 'PromptFramingError';
    this.code = code;
  }
}
