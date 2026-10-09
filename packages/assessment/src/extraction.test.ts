import { describe, expect, it } from 'vitest';
import {
  indexPassages,
  pendingReviews,
  resolveFidelity,
  type AdmittedClaim,
  type AdmittedEvidence,
} from './extraction.js';
import {
  validateClaimExtraction,
  validateEvidenceInterpretation,
  validateFidelityReview,
} from './stage.js';
import { artifact, hydroTrackArtifacts } from './testing/world.js';
import { buildPassages, type Passage } from './windowing.js';

const world = (artifacts = hydroTrackArtifacts()) => {
  const { passages } = buildPassages(artifacts);
  return { passages, index: indexPassages(passages) };
};
const passageOf = (passages: readonly Passage[], key: string): Passage => {
  const found = passages.find((p) => p.artifactKey === key);
  if (!found) throw new Error(`no passage for ${key}`);
  return found;
};

const DEVPOST_QUOTE =
  'HydroTrack sends a reminder every two hours and stores each intake entry in SQLite.';

function claimsOutput(
  passage: string,
  items: { ref?: string; text: string; quote: string; passage?: string }[],
) {
  return {
    claims: items.map((item, i) => ({
      ref: item.ref ?? `c${String(i + 1)}`,
      text: item.text,
      passage: item.passage ?? passage,
      quote: item.quote,
    })),
  };
}

function accept<T>(
  result: { ok: boolean; phase: string } & Partial<{ accepted: readonly T[] }>,
): readonly T[] {
  if (!result.ok || result.accepted === undefined)
    throw new Error(`not accepted: ${JSON.stringify(result)}`);
  return result.accepted;
}

describe('G1: claim admission', () => {
  it('admits a verbatim claim with code-assigned handle, derived span and exact_text grounding', () => {
    const { passages, index } = world();
    const devpost = passageOf(passages, 'submission.txt');
    const result = validateClaimExtraction(
      claimsOutput(devpost.handle, [{ text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE }]),
      index,
    );
    const [claim] = accept<AdmittedClaim>(result);
    expect(claim?.handle).toBe('C-001');
    expect(claim?.grounding).toBe('exact_text');
    expect(claim?.sourceType).toBe('devpost');
    expect(claim?.located.excerpt).toBe(DEVPOST_QUOTE);
    expect(claim?.located.start).toBeGreaterThan(0);
  });

  it('marks a paraphrase pending review, and keeps the quote as the source of record', () => {
    const { passages, index } = world();
    const devpost = passageOf(passages, 'submission.txt');
    const result = validateClaimExtraction(
      claimsOutput(devpost.handle, [
        { text: 'The app reminds users every two hours.', quote: DEVPOST_QUOTE },
      ]),
      index,
    );
    const [claim] = accept<AdmittedClaim>(result);
    expect(claim?.grounding).toBe('pending_review');
    expect(claim?.text).toBe('The app reminds users every two hours.');
    expect(claim?.located.excerpt).toBe(DEVPOST_QUOTE);
  });

  it('treats whitespace-only differences as the same words (exact_text after NFC + whitespace normalization)', () => {
    const { passages, index } = world([
      artifact({
        sourceType: 'devpost',
        key: 'submission.txt',
        kind: 'submission_text',
        text: 'It works\noffline and keeps all data on the device.\n',
      }),
    ]);
    const handle = passages[0]?.handle ?? '';
    const [claim] = accept<AdmittedClaim>(
      validateClaimExtraction(
        claimsOutput(handle, [
          {
            text: 'It works offline and keeps all data on the device.',
            quote: 'It works\noffline and keeps all data on the device.',
          },
        ]),
        index,
      ),
    );
    expect(claim?.grounding).toBe('exact_text');
  });

  it('rejects an unshown passage handle, a malformed one (shape), and a passage of the wrong route', () => {
    const { passages, index } = world();
    const code = passageOf(passages, 'files/src/intake.ts');
    const devpost = passageOf(passages, 'submission.txt');
    const unshown = validateClaimExtraction(
      claimsOutput('P-9999', [{ text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE }]),
      index,
    );
    expect(unshown.ok && unshown.rejected.map((r) => r.code)).toEqual(['unknown_passage']);
    const malformed = validateClaimExtraction(
      claimsOutput('passage-1', [{ text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE }]),
      index,
    );
    expect(malformed.ok).toBe(false);
    expect(!malformed.ok && malformed.phase).toBe('shape');
    const wrongRoute = validateClaimExtraction(
      claimsOutput(code.handle, [
        {
          text: 'It rejects non-positive amounts.',
          quote: "if (amount <= 0) throw new RangeError('amount must be positive');",
        },
      ]),
      index,
    );
    expect(wrongRoute.ok && wrongRoute.rejected.map((r) => r.code)).toEqual([
      'passage_not_statement',
    ]);
    expect(devpost.route).toBe('statement');
  });

  it('rejects a quote taken from a DIFFERENT passage than the one named', () => {
    const { passages, index } = world();
    const readme = passageOf(passages, 'files/README.md');
    const result = validateClaimExtraction(
      claimsOutput(readme.handle, [{ text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE }]),
      index,
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual(['quote_not_found']);
  });

  it('rejects fabricated provenance, ids, origins and levels at the schema gate (strict objects)', () => {
    const { passages, index } = world();
    const devpost = passageOf(passages, 'submission.txt');
    const base = { ref: 'c1', text: DEVPOST_QUOTE, passage: devpost.handle, quote: DEVPOST_QUOTE };
    for (const extra of [
      { snapshotId: devpost.snapshotId },
      { artifactId: devpost.artifactId },
      { span: { start: 0, end: 10 } },
      { excerpt: DEVPOST_QUOTE },
      { origin: 'github' },
      { verificationLevel: 'repo_corroborated' },
      { kind: 'fact' },
      { id: 'c1d4b9a0-0000-4000-8000-000000000001' },
    ]) {
      const result = validateClaimExtraction({ claims: [{ ...base, ...extra }] }, index);
      expect(result.ok, JSON.stringify(extra)).toBe(false);
      expect(!result.ok && result.phase).toBe('shape');
    }
  });

  it('rejects a non-unique quote and a quote that is not in the text, without echoing either', () => {
    const { passages, index } = world([
      artifact({
        sourceType: 'devpost',
        key: 'submission.txt',
        kind: 'submission_text',
        text: 'We built a tracker. We built a tracker. It is great.\n',
      }),
    ]);
    const handle = passages[0]?.handle ?? '';
    const result = validateClaimExtraction(
      claimsOutput(handle, [
        { text: 'We built a tracker.', quote: 'We built a tracker.' },
        { text: 'It was built by a team of ten.', quote: 'It was built by a team of ten.' },
      ]),
      index,
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual([
      'quote_ambiguous',
      'quote_not_found',
    ]);
    expect(JSON.stringify(result)).not.toContain('team of ten');
  });

  it('drops a duplicated ref and collapses a duplicate claim, recording both', () => {
    const { passages, index } = world();
    const devpost = passageOf(passages, 'submission.txt');
    const result = validateClaimExtraction(
      claimsOutput(devpost.handle, [
        { ref: 'c1', text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE },
        { ref: 'c1', text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE },
        { ref: 'c2', text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE },
      ]),
      index,
    );
    expect(result.ok && result.accepted).toHaveLength(1);
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual([
      'duplicate_ref',
      'duplicate_claim',
    ]);
  });

  it('continues numbering across calls and enforces the per-run cap', () => {
    const { passages, index } = world();
    const devpost = passageOf(passages, 'submission.txt');
    const first = accept<AdmittedClaim>(
      validateClaimExtraction(
        claimsOutput(devpost.handle, [{ text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE }]),
        index,
      ),
    );
    const second = validateClaimExtraction(
      claimsOutput(devpost.handle, [
        {
          text: 'It works offline and never sends your data to a server.',
          quote: 'It works offline and never sends your data to a server.',
        },
      ]),
      index,
      { existing: first },
    );
    expect(accept<AdmittedClaim>(second)[0]?.handle).toBe('C-002');
    const capped = validateClaimExtraction(
      claimsOutput(devpost.handle, [
        {
          text: 'It works offline and never sends your data to a server.',
          quote: 'It works offline and never sends your data to a server.',
        },
      ]),
      index,
      { existing: first, maxClaims: 1 },
    );
    expect(capped.ok && capped.rejected.map((r) => r.code)).toEqual(['over_cap']);
  });

  it('a located quote proves provenance only: it never makes a false claim true or raises a label', () => {
    // The text exists in the captured page; whether it is TRUE is not established, and the claim stays a team claim.
    const { passages, index } = world();
    const devpost = passageOf(passages, 'submission.txt');
    const quote = 'It works offline and never sends your data to a server.';
    const [claim] = accept<AdmittedClaim>(
      validateClaimExtraction(claimsOutput(devpost.handle, [{ text: quote, quote }]), index),
    );
    expect(claim).toBeDefined();
    expect(Object.keys(claim ?? {}).sort()).toEqual([
      'grounding',
      'handle',
      'located',
      'modelRef',
      'sourceType',
      'text',
    ]);
    expect(claim).not.toHaveProperty('verificationLevel');
  });

  it('never puts quote text in a rejection', () => {
    const { passages, index } = world();
    const devpost = passageOf(passages, 'submission.txt');
    const secretish = 'A sentence that is certainly not present anywhere.';
    const result = validateClaimExtraction(
      claimsOutput(devpost.handle, [{ text: secretish, quote: secretish }]),
      index,
    );
    expect(JSON.stringify(result)).not.toContain('certainly not present');
  });
});

describe('G2: interpreted evidence admission', () => {
  const CODE_QUOTE = "if (amount <= 0) throw new RangeError('amount must be positive');";

  it('admits a fact from a repository passage with origin derived from the artifact, never from the model', () => {
    const { passages, index } = world();
    const code = passageOf(passages, 'files/src/intake.ts');
    const result = validateEvidenceInterpretation(
      {
        evidence: [
          {
            ref: 'e1',
            text: 'addIntake throws a RangeError for non-positive amounts.',
            passage: code.handle,
            quote: CODE_QUOTE,
          },
        ],
      },
      index,
    );
    const [item] = accept<AdmittedEvidence>(result);
    expect(item?.handle).toBe('E-001');
    expect(item?.sourceType).toBe('github');
    expect(item?.artifactClass).toBe('source_code');
    expect(item?.grounding).toBe('pending_review');
    expect(item?.located.excerpt).toBe(CODE_QUOTE);
  });

  it('classifies a deployment observation by artifact, and rejects statement passages', () => {
    const { passages, index } = world();
    const response = passageOf(passages, 'response.json');
    const ok = validateEvidenceInterpretation(
      {
        evidence: [
          {
            ref: 'e1',
            text: 'The deployment answered with HTTP status 200.',
            passage: response.handle,
            quote: '"status": 200',
          },
        ],
      },
      index,
    );
    expect(accept<AdmittedEvidence>(ok)[0]?.sourceType).toBe('deployment');
    expect(accept<AdmittedEvidence>(ok)[0]?.artifactClass).toBe('deployment_observation');
    const devpost = passageOf(passages, 'submission.txt');
    const wrong = validateEvidenceInterpretation(
      {
        evidence: [
          {
            ref: 'e1',
            text: 'HydroTrack sends reminders.',
            passage: devpost.handle,
            quote: DEVPOST_QUOTE,
          },
        ],
      },
      index,
    );
    expect(wrong.ok && wrong.rejected.map((r) => r.code)).toEqual(['passage_not_repository']);
  });

  it('refuses a model-supplied kind, origin, level or provenance (strict schema)', () => {
    const { passages, index } = world();
    const code = passageOf(passages, 'files/src/intake.ts');
    for (const extra of [
      { kind: 'absence' },
      { origin: 'event_context' },
      { verificationLevel: 'machine_verified' },
      { span: { start: 0, end: 9 } },
    ]) {
      const result = validateEvidenceInterpretation(
        {
          evidence: [
            { ref: 'e1', text: 'x fact', passage: code.handle, quote: CODE_QUOTE, ...extra },
          ],
        },
        index,
      );
      expect(result.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it('treats a verbatim description as exact_text (no review needed)', () => {
    const { passages, index } = world();
    const code = passageOf(passages, 'files/src/intake.ts');
    const [item] = accept<AdmittedEvidence>(
      validateEvidenceInterpretation(
        { evidence: [{ ref: 'e1', text: CODE_QUOTE, passage: code.handle, quote: CODE_QUOTE }] },
        index,
      ),
    );
    expect(item?.grounding).toBe('exact_text');
  });
});

describe('G2b: fidelity of paraphrases', () => {
  function admitted() {
    const { passages, index } = world();
    const devpost = passageOf(passages, 'submission.txt');
    const code = passageOf(passages, 'files/src/intake.ts');
    const claims = accept<AdmittedClaim>(
      validateClaimExtraction(
        claimsOutput(devpost.handle, [
          { ref: 'c1', text: DEVPOST_QUOTE, quote: DEVPOST_QUOTE },
          {
            ref: 'c2',
            text: 'The app works without a network connection.',
            quote: 'It works offline and never sends your data to a server.',
          },
        ]),
        index,
      ),
    );
    const evidence = accept<AdmittedEvidence>(
      validateEvidenceInterpretation(
        {
          evidence: [
            {
              ref: 'e1',
              text: 'addIntake rejects non-positive amounts.',
              passage: code.handle,
              quote: "if (amount <= 0) throw new RangeError('amount must be positive');",
            },
          ],
        },
        index,
      ),
    );
    return { claims, evidence };
  }

  it('asks for review of paraphrases ONLY: a verbatim claim needs no call', () => {
    const { claims, evidence } = admitted();
    expect(pendingReviews(claims, evidence).map((p) => p.handle)).toEqual(['C-002', 'E-001']);
  });

  it('admits a paraphrase only with exactly one faithful verdict, and the statement stays verbatim', () => {
    const { claims, evidence } = admitted();
    const result = resolveFidelity(claims, evidence, [
      { item: 'C-002', verdict: 'faithful' },
      { item: 'E-001', verdict: 'faithful' },
    ]);
    expect(result.claims.map((c) => [c.handle, c.text, c.grounding])).toEqual([
      ['C-001', DEVPOST_QUOTE, 'exact_text'],
      ['C-002', 'The app works without a network connection.', 'paraphrase_reviewed_faithful'],
    ]);
    // the verbatim words are still the located excerpt
    expect(result.claims[1]?.located.excerpt).toBe(
      'It works offline and never sends your data to a server.',
    );
    expect(result.dispositions.map((d) => d.disposition)).toEqual([
      'paraphrase_reviewed_faithful',
      'paraphrase_reviewed_faithful',
    ]);
    expect(result.issues).toEqual([]);
  });

  it.each(['overstated', 'unfaithful', 'cannot_tell'] as const)(
    '%s: downgrades to the verbatim words and records it',
    (verdict) => {
      const { claims, evidence } = admitted();
      const result = resolveFidelity(claims, evidence, [
        { item: 'C-002', verdict },
        { item: 'E-001', verdict },
      ]);
      const downgraded = result.claims.find((c) => c.handle === 'C-002');
      expect(downgraded?.text).toBe('It works offline and never sends your data to a server.');
      expect(downgraded?.grounding).toBe('exact_text');
      expect(result.evidence[0]?.text).toBe(
        "if (amount <= 0) throw new RangeError('amount must be positive');",
      );
      expect(result.dispositions.map((d) => d.disposition)).toEqual([
        'paraphrase_replaced_by_verbatim',
        'evidence_text_replaced_by_verbatim',
      ]);
    },
  );

  it('drops a claim whose verbatim words cannot stand as a claim (over 1,000 characters)', () => {
    const long = 'The system processes every request with great care and precision. '
      .repeat(17)
      .trim();
    const { passages, index } = world([
      artifact({
        sourceType: 'devpost',
        key: 'submission.txt',
        kind: 'submission_text',
        text: `${long}\n`,
      }),
    ]);
    const claims = accept<AdmittedClaim>(
      validateClaimExtraction(
        claimsOutput(passages[0]?.handle ?? '', [{ text: 'The system is careful.', quote: long }]),
        index,
      ),
    );
    const result = resolveFidelity(claims, [], [{ item: 'C-001', verdict: 'unfaithful' }]);
    expect(result.claims).toEqual([]);
    expect(result.dispositions).toEqual([
      { handle: 'C-001', disposition: 'claim_dropped_unfaithful' },
    ]);
  });

  it('admits NOTHING unreviewed when the review is unavailable (empty answer)', () => {
    const { claims, evidence } = admitted();
    const result = resolveFidelity(claims, evidence, []);
    expect(result.claims.every((c) => c.grounding === 'exact_text')).toBe(true);
    expect(result.evidence.every((e) => e.grounding === 'exact_text')).toBe(true);
    expect(result.claims.map((c) => c.text)).not.toContain(
      'The app works without a network connection.',
    );
    expect(result.issues.map((i) => i.code)).toEqual(['missing_verdict', 'missing_verdict']);
  });

  it('rejects verdicts for unknown or non-reviewed items and duplicates, without admitting', () => {
    const { claims, evidence } = admitted();
    const result = resolveFidelity(claims, evidence, [
      { item: 'C-001', verdict: 'faithful' }, // verbatim: never reviewed
      { item: 'C-099', verdict: 'faithful' },
      { item: 'C-002', verdict: 'faithful' },
      { item: 'C-002', verdict: 'faithful' },
      { item: 'E-001', verdict: 'faithful' },
    ]);
    expect(result.issues.map((i) => [i.code, i.handle])).toEqual([
      ['unknown_item', 'C-001'],
      ['unknown_item', 'C-099'],
      ['duplicate_verdict', 'C-002'],
    ]);
    expect(result.claims.find((c) => c.handle === 'C-002')?.text).toBe(
      'It works offline and never sends your data to a server.',
    );
    expect(result.evidence[0]?.grounding).toBe('paraphrase_reviewed_faithful');
  });

  it('runs behind the strict schema: an unknown verdict word is a shape failure', () => {
    const { claims, evidence } = admitted();
    const result = validateFidelityReview(
      { verdicts: [{ item: 'C-002', verdict: 'verified' }] },
      claims,
      evidence,
    );
    expect(result.ok).toBe(false);
  });
});
