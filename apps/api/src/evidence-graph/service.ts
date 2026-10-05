import type { EvidenceGraphStore } from '@judge-copilot/database';
import {
  claimView,
  evidenceView,
  neighborhood,
  paginate,
  summarizeGraph,
  currentClaims,
} from '@judge-copilot/evidence';
import type {
  ClaimDetail,
  ClaimsPage,
  ContradictionsPage,
  EvidenceDetail,
  EvidenceGraphSummary,
  EvidencePage,
  GraphNodeType,
  Neighborhood,
  PageQuery,
  UnknownsPage,
  EvidenceKind,
  EvidenceOrigin,
} from '@judge-copilot/schemas';
import { EvidenceGraphApiError } from './errors.js';

export interface EvidenceGraphServiceOptions {
  store: EvidenceGraphStore;
}

/**
 * Read-only inspection of a project's evidence graph. Every query loads only the requested
 * project's records, so an ID of another project is indistinguishable from a nonexistent one.
 * Results are plain structure in insertion order: no scores, ranking, confidence or coverage,
 * and nothing here writes, calls a model or triggers analysis.
 */
export class EvidenceGraphService {
  private readonly store: EvidenceGraphStore;

  constructor(options: EvidenceGraphServiceOptions) {
    this.store = options.store;
  }

  private async load(projectId: string) {
    const loaded = await this.store.loadGraph(projectId);
    if (!loaded) throw new EvidenceGraphApiError('PROJECT_NOT_FOUND', 'Project not found');
    return loaded;
  }

  async summary(projectId: string): Promise<EvidenceGraphSummary> {
    const { graph } = await this.load(projectId);
    return summarizeGraph(projectId, graph);
  }

  async listClaims(
    projectId: string,
    query: PageQuery & { current?: boolean },
  ): Promise<ClaimsPage> {
    const { graph } = await this.load(projectId);
    const source = query.current ? currentClaims(graph) : graph.ordered.claims;
    const { items, nextAfter } = paginate(source, query);
    return { items, page: { limit: query.limit, after: query.after, nextAfter } };
  }

  async getClaim(projectId: string, claimId: string): Promise<ClaimDetail> {
    const { graph } = await this.load(projectId);
    const view = claimView(graph, claimId);
    if (!view) throw new EvidenceGraphApiError('CLAIM_NOT_FOUND', 'Claim not found');
    return view;
  }

  async listEvidence(
    projectId: string,
    query: PageQuery & { kind?: EvidenceKind | undefined; origin?: EvidenceOrigin | undefined },
  ): Promise<EvidencePage> {
    const { graph } = await this.load(projectId);
    const source = graph.ordered.evidence.filter(
      (item) =>
        (query.kind === undefined || item.kind === query.kind) &&
        (query.origin === undefined || item.origin === query.origin),
    );
    const { items, nextAfter } = paginate(source, query);
    return { items, page: { limit: query.limit, after: query.after, nextAfter } };
  }

  async getEvidence(projectId: string, evidenceId: string): Promise<EvidenceDetail> {
    const { graph, known } = await this.load(projectId);
    const view = evidenceView(graph, evidenceId, known);
    if (!view) throw new EvidenceGraphApiError('EVIDENCE_NOT_FOUND', 'Evidence item not found');
    return view;
  }

  async listUnknowns(projectId: string, query: PageQuery): Promise<UnknownsPage> {
    const { graph } = await this.load(projectId);
    const { items, nextAfter } = paginate(graph.ordered.unknowns, query);
    return { items, page: { limit: query.limit, after: query.after, nextAfter } };
  }

  async listContradictions(projectId: string, query: PageQuery): Promise<ContradictionsPage> {
    const { graph } = await this.load(projectId);
    const { items, nextAfter } = paginate(graph.ordered.contradictions, query);
    return { items, page: { limit: query.limit, after: query.after, nextAfter } };
  }

  async neighbors(
    projectId: string,
    node: { type: GraphNodeType; id: string },
    depth: number,
  ): Promise<Neighborhood> {
    const { graph } = await this.load(projectId);
    const result = neighborhood(graph, node, { depth });
    if (!result) throw new EvidenceGraphApiError('NODE_NOT_FOUND', 'Graph node not found');
    return result;
  }
}
