/*
 * Test-only: prints "name outputHash" for every golden scenario. Run in separate processes by the
 * determinism test to prove the same inputs give the same bytes in a fresh process.
 */
import { scoreProject } from '../engine.js';
import { goldenScenarios } from './scenarios.js';

const lines = goldenScenarios().map((scenario) => {
  const result = scoreProject(scenario.context, scenario.body, scenario.options);
  return `${scenario.name} ${result.ok ? result.report.outputHash : 'REJECTED'}`;
});
process.stdout.write(`${lines.join('\n')}\n`);
