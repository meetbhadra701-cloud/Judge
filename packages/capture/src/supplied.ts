import { jsonArtifact, textArtifact } from './artifacts.js';
import { normalizeText } from './hash.js';
import type { CaptureResult } from './ports.js';
import { validateCaptureResult } from './result.js';

/*
 * Organizer-supplied submission text (P6B-beta3). Fetching a Devpost page from this deployment is blocked by the environment's egress policy, so an
 * organizer may instead PASTE the submission text they can see. The result is stored as an ordinary immutable `devpost` snapshot, but it is labelled
 * for what it is:
 *
 *   - `metadata.provenance = 'organizer_supplied'` and `metadata.adapterVersion = 'organizer-supplied/v1'` (a fetched Devpost snapshot has neither);
 *   - a `submission.json` artifact that says, in words, that the text was typed or pasted by a person, was not fetched from Devpost and has not been
 *     compared with the Devpost page;
 *   - everything derived from it stays a TEAM CLAIM (the same routing as fetched submission text); nothing here can raise a verification level.
 *
 * It does not bypass any network restriction or authentication: nothing is fetched. The text is data, never an instruction, and is bounded.
 */

export const SUPPLIED_ADAPTER_VERSION = 'organizer-supplied/v1' as const;
export const SUPPLIED_PROVENANCE = 'organizer_supplied' as const;
export const SUPPLIED_TEXT_MAX_CODE_POINTS = 60_000;
export const SUPPLIED_TEXT_MIN_VISIBLE_CODE_POINTS = 20;

/** Unicode code points in a string (not UTF-16 units). */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export type SuppliedTextProblem = 'empty' | 'too_short' | 'too_long' | 'control_characters';

export type SuppliedTextCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problem: SuppliedTextProblem };

// C0 controls other than tab/newline, DEL, C1 controls, line/paragraph separators, bidi controls and the BOM: none belongs in pasted prose, and some
// can disguise text (bidi overrides) or break line-based quoting.
const FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
function hasForbiddenCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (FORBIDDEN_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

/** NFC, `\n` line endings, trailing space trimmed from every line and from the whole text; refuses control characters and out-of-bounds sizes. */
export function normalizeSuppliedText(input: string): SuppliedTextCheck {
  if (hasForbiddenCharacter(input.replace(/\r\n?/g, '\n')))
    return { ok: false, problem: 'control_characters' };
  const text = normalizeText(input)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/^\s+/u, '')
    .replace(/\s+$/u, '');
  const length = codePointLength(text);
  if (length === 0) return { ok: false, problem: 'empty' };
  if (length > SUPPLIED_TEXT_MAX_CODE_POINTS) return { ok: false, problem: 'too_long' };
  let visible = 0;
  for (const character of text) if (/\S/u.test(character)) visible += 1;
  if (visible < SUPPLIED_TEXT_MIN_VISIBLE_CODE_POINTS) {
    return { ok: false, problem: 'too_short' };
  }
  return { ok: true, text };
}

/** The capture result for supplied text: validated like any adapter's, so it can only be stored in the shapes a fetched snapshot may have. */
export function suppliedDevpostResult(text: string, declaredUrl: string): CaptureResult {
  const checked = normalizeSuppliedText(text);
  if (!checked.ok) throw new Error(`supplied text is not acceptable: ${checked.problem}`);
  const result: CaptureResult = {
    status: 'captured',
    revision: null,
    metadata: {
      adapterVersion: SUPPLIED_ADAPTER_VERSION,
      provenance: SUPPLIED_PROVENANCE,
      textCodePoints: codePointLength(checked.text),
    },
    artifacts: [
      jsonArtifact('submission.json', 'submission', {
        provenance: SUPPLIED_PROVENANCE,
        declaredUrl,
        statement:
          'This text was typed or pasted by an organizer. It was not fetched from Devpost and has not been compared with the Devpost page.',
      }),
      textArtifact('submission.txt', 'submission_text', 'text/plain', checked.text),
    ],
    partialReasons: [],
  };
  return validateCaptureResult('devpost', result);
}
