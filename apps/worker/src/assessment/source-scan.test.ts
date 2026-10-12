import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Structural guarantees of the pipeline that a test of behavior alone would not pin: where a provider may be called, where a prompt may be
 * rendered, who owns the spending ledger, and that this layer opens no transaction of its own. The scan reads implementation files only
 * (comments are excluded; tests and test helpers are not part of the pipeline).
 */

const ROOT = join(import.meta.dirname, '..');
const WORKER_SRC = ROOT;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : files(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

const code = (file: string): string =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

const pipelineFiles = files(join(WORKER_SRC, 'assessment'));
const where = (pattern: RegExp, among = pipelineFiles): string[] =>
  among
    .filter((file) => pattern.test(code(file)))
    .map((file) => relative(WORKER_SRC, file))
    .sort();

describe('assessment pipeline structure', () => {
  it('has the expected modules (the scan is not vacuous)', () => {
    expect(pipelineFiles.map((f) => relative(WORKER_SRC, f)).sort()).toEqual([
      'assessment/assess.ts',
      'assessment/config.ts',
      'assessment/extract.ts',
      'assessment/ledger.ts',
      'assessment/loop.ts',
      'assessment/model-call.ts',
      'assessment/pipeline.ts',
      'assessment/preflight.ts',
      'assessment/runtime.ts',
      'assessment/session.ts',
      'assessment/sources.ts',
      'assessment/stop.ts',
      'assessment/write-extraction.ts',
    ]);
  });

  it('calls a provider in exactly one place, and renders a prompt in exactly one place', () => {
    expect(where(/\.generate\(/)).toEqual(['assessment/model-call.ts']);
    expect(where(/\brenderPrompt\(/)).toEqual(['assessment/model-call.ts']);
  });

  it('opens no transaction itself: every unit of work is one short transaction inside a P4 store', () => {
    expect(where(/\.transaction\(/)).toEqual([]);
    expect(where(/\bBEGIN\b|FOR UPDATE/)).toEqual([]);
  });

  it('owns the durable spending ledger in one place and builds the guard in one place', () => {
    expect(where(/new DatabaseRunBudget\(/)).toEqual(['assessment/pipeline.ts']);
    expect(where(/\bcreateGuardedProvider\(/)).toEqual(['assessment/pipeline.ts']);
  });

  it('never touches the scorer, the graph writer or the trusted-input constructor directly', () => {
    expect(where(/@judge-copilot\/scoring/)).toEqual([]);
    expect(where(/createTrustedScoringContext|scoreProject\(/)).toEqual([]);
    expect(where(/createGraph\b|createGraphInTransaction/)).toEqual([]);
    expect(where(/new AuthorizedAssessmentInputs/)).toEqual([]);
    // inputs come from the reader and nowhere else
    expect(where(/\.read\(runId\)|reader\.read\(/)).toEqual(['assessment/assess.ts']);
  });

  it('a worker ends a running run only with its lease token; the pending-expiry pass uses the lock-checked store operation', () => {
    // `finishRun` without a token may end a running run (an administrative P4 path); no worker code uses it that way
    expect(where(/\.finishRun\(/)).toEqual(['assessment/pipeline.ts']);
    const pipeline = code(join(WORKER_SRC, 'assessment/pipeline.ts'));
    expect(pipeline).toMatch(/const ending = \{[^}]*\bleaseToken\b/s);
    expect(where(/\.expirePendingRun\(/)).toEqual(['assessment/loop.ts']);
    expect(where(/\.expirePendingRun\(/, [join(WORKER_SRC, 'assessment/loop.ts')])).toHaveLength(1);
  });

  it('claims a run in exactly two places and never claims inside the pipeline body: the loop claims atomically (SKIP LOCKED), the pipeline runs under that lease', () => {
    expect(where(/\.claimNextRun\(/)).toEqual(['assessment/loop.ts']);
    // `claimRun(id)` remains only for callers that already know the run id (tests, tools): `runAssessment`
    expect(where(/\.claimRun\(/)).toEqual(['assessment/pipeline.ts']);
    const pipeline = code(join(WORKER_SRC, 'assessment/pipeline.ts'));
    const claimed = pipeline.slice(pipeline.indexOf('export async function runClaimedAssessment'));
    expect(claimed).not.toMatch(/\.claim(Next)?Run\(/);
    // the loop never lists-then-claims: no plain pending list feeds a claim
    const loop = code(join(WORKER_SRC, 'assessment/loop.ts'));
    expect(loop).not.toMatch(/pendingRunIds|\.claimRun\(/);
    expect(loop).not.toMatch(/await maintain\(\);\s*await fill\(\)/);
  });

  it('assigns no privileged verification level and mentions none in code', () => {
    expect(where(/repo_corroborated|machine_verified|judge_verified|live_verified/)).toEqual([]);
    expect(where(/verificationLevel/)).toEqual([]);
  });

  it('does not read the environment, the network, the shell or the filesystem (apart from the replay fixture in the runtime)', () => {
    expect(where(/process\.env|\bfetch\(|child_process|\beval\(|new Function/)).toEqual([]);
    expect(where(/node:fs|readFile/)).toEqual(['assessment/runtime.ts']);
    expect(where(/\bconsole\./)).toEqual([]);
  });

  it('uses no ambient time or randomness except through the injected clock and the composition root', () => {
    expect(where(/Math\.random\b/)).toEqual(['assessment/runtime.ts']);
    expect(where(/Date\.now\(/)).toEqual([]);
  });

  it('never references the unapproved fallback anchors', () => {
    expect(where(/fallback-anchors-draft|M5-fallback-anchors/)).toEqual([]);
  });
});
