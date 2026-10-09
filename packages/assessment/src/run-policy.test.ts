import { describe, expect, it } from 'vitest';
import type { FinalUnit, UnitDisposition } from './judgment.js';
import { evaluateRun, technicalThreshold } from './run-policy.js';

const unit = (
  i: number,
  disposition: UnitDisposition,
  cause?: 'schema' | 'domain' | 'refusal',
): FinalUnit =>
  cause
    ? { dimensionId: `u.${String(i)}`, disposition, judgment: null, cause }
    : { dimensionId: `u.${String(i)}`, disposition, judgment: null };
const units = (
  total: number,
  technical: number,
  rest: UnitDisposition = 'scored',
  cause: 'schema' | 'domain' = 'domain',
): FinalUnit[] =>
  Array.from({ length: total }, (_, i) =>
    i < technical ? unit(i, 'assessor_output_invalid', cause) : unit(i, rest),
  );

describe('aggregate technical-failure rule (design §9.3, C6)', () => {
  it('computes T = max(2, ceil(0.25 U))', () => {
    expect([1, 2, 5, 8, 9, 36].map(technicalThreshold)).toEqual([2, 2, 2, 2, 3, 9]);
  });

  it('U = 1: one technical failure FAILS the run (rule 2); a valid insufficiency does not', () => {
    expect(evaluateRun(units(1, 1)).failRun).toBe(true);
    expect(evaluateRun(units(1, 1)).allTechnical).toBe(true);
    expect(evaluateRun(units(1, 1)).overThreshold).toBe(false); // rule 1 alone could never fail U = 1
    expect(evaluateRun([unit(0, 'assessor_reported_insufficient')]).failRun).toBe(false);
    expect(evaluateRun([unit(0, 'no_candidate_evidence')]).failRun).toBe(false);
    expect(evaluateRun([unit(0, 'marked_insufficient_by_critic')]).failRun).toBe(false);
  });

  it('U = 2: one technical failure passes, two fail', () => {
    expect(evaluateRun(units(2, 1)).failRun).toBe(false);
    expect(evaluateRun(units(2, 2)).failRun).toBe(true);
  });

  it('U = 5: one technical failure passes, two fail (T = 2)', () => {
    expect(evaluateRun(units(5, 1)).failRun).toBe(false);
    expect(evaluateRun(units(5, 2)).failRun).toBe(true);
    expect(evaluateRun(units(5, 2)).threshold).toBe(2);
  });

  it('U = 36: eight pass, nine fail (T = 9)', () => {
    expect(evaluateRun(units(36, 8)).failRun).toBe(false);
    expect(evaluateRun(units(36, 9)).failRun).toBe(true);
    expect(evaluateRun(units(36, 9)).threshold).toBe(9);
  });

  it('for every U, all-technical fails and all-valid-insufficient never does', () => {
    for (const total of [1, 2, 3, 4, 5, 8, 9, 20, 36]) {
      expect(evaluateRun(units(total, total)).failRun, `all technical, U=${String(total)}`).toBe(
        true,
      );
      expect(
        evaluateRun(units(total, 0, 'assessor_reported_insufficient')).failRun,
        `all valid, U=${String(total)}`,
      ).toBe(false);
      expect(
        evaluateRun(units(total, 0, 'marked_insufficient_by_critic')).failRun,
        `all substantive, U=${String(total)}`,
      ).toBe(false);
    }
  });

  it('counts technical dispositions only: assessor, critic-unavailable and refusal; never valid or substantive ones', () => {
    const mixed = [
      unit(0, 'assessor_output_invalid', 'schema'),
      unit(1, 'critic_unavailable'),
      unit(2, 'provider_refused', 'refusal'),
      unit(3, 'assessor_reported_insufficient'),
      unit(4, 'no_satisfiable_need'),
      unit(5, 'event_reference_only'),
      unit(6, 'marked_insufficient_by_critic'),
      unit(7, 'scored'),
    ];
    const evaluation = evaluateRun(mixed);
    expect(evaluation.counts).toEqual({
      scored: 1,
      valid_insufficiency: 3,
      substantive: 1,
      technical: 3,
    });
  });

  it('chooses the failure category by the majority of technical failures: schema only when most were schema failures', () => {
    expect(evaluateRun(units(5, 3, 'scored', 'schema')).failureCategory).toBe(
      'schema_validation_failed',
    );
    expect(evaluateRun(units(5, 3, 'scored', 'domain')).failureCategory).toBe(
      'domain_validation_failed',
    );
    const tie = [
      unit(0, 'assessor_output_invalid', 'schema'),
      unit(1, 'assessor_output_invalid', 'domain'),
      unit(2, 'scored'),
      unit(3, 'scored'),
    ];
    expect(evaluateRun(tie).failureCategory).toBe('domain_validation_failed'); // "otherwise domain"
    expect(evaluateRun(units(5, 1)).failureCategory).toBeNull();
  });

  it('records mostly_unassessable only when MORE than half the units end insufficient for substantive reasons', () => {
    expect(
      evaluateRun([
        unit(0, 'marked_insufficient_by_critic'),
        unit(1, 'marked_insufficient_by_critic'),
        unit(2, 'scored'),
        unit(3, 'scored'),
      ]).mostlyUnassessable,
    ).toBe(false); // exactly half
    expect(
      evaluateRun([
        unit(0, 'marked_insufficient_by_critic'),
        unit(1, 'marked_insufficient_by_critic'),
        unit(2, 'marked_insufficient_by_critic'),
        unit(3, 'scored'),
      ]).mostlyUnassessable,
    ).toBe(true);
    // valid insufficiency is not "substantive"; it is reported separately
    const valid = evaluateRun(units(4, 0, 'no_candidate_evidence'));
    expect(valid.mostlyUnassessable).toBe(false);
    expect(valid.insufficientTotal).toBe(4);
  });

  it('substantive critic rejections never fail a run, even when every unit is rejected', () => {
    const all = evaluateRun(units(5, 0, 'marked_insufficient_by_critic'));
    expect(all.failRun).toBe(false);
    expect(all.technical).toBe(0);
    expect(all.mostlyUnassessable).toBe(true);
  });

  it('a unit counts once, by its final disposition', () => {
    // a unit that was partly technical (a failed first try) and ended valid is simply valid
    expect(evaluateRun(units(2, 0, 'assessor_reported_insufficient')).technical).toBe(0);
  });

  it('refuses an empty run', () => {
    expect(() => evaluateRun([])).toThrow();
  });
});
