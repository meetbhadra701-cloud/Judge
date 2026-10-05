/*
 * @judge-copilot/evidence — the evidence graph's pure domain rules (M3).
 *
 * Claim, EvidenceItem, EvidenceRelation, Unknown and Contradiction: verification-level rules,
 * provenance rules, the ID-integrity planner, graph-integrity validation and deterministic graph
 * queries. Layer 2: no I/O, no database, no model calls, no scoring (that is M4).
 */
export * from './graph.js';
export * from './ids.js';
export * from './integrity.js';
export * from './issues.js';
export * from './known.js';
export * from './plan.js';
export * from './provenance.js';
export * from './queries.js';
export * from './verification.js';
