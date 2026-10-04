import type { HttpFetcher, ProjectSourceAdapter } from '@judge-copilot/capture';
import { createDeploymentAdapter } from '@judge-copilot/deployment';
import { createDevpostAdapter } from '@judge-copilot/devpost';
import { createGithubAdapter, type GithubCaptureLimits } from '@judge-copilot/github';
import type { ProjectSourceType } from '@judge-copilot/schemas';
import { createVideoAdapter } from '@judge-copilot/video';
import type { AdapterRegistry } from './capture/runner.js';

export interface AdapterOptions {
  /** The SSRF-safe client every adapter must use. */
  readonly http: HttpFetcher;
  readonly githubToken?: string | null;
  readonly githubLimits?: Partial<GithubCaptureLimits>;
  readonly deploymentTimeoutMs?: number;
}

/** One adapter per declared source type, all sharing the same policy-enforcing HTTP client. */
export function createAdapterRegistry(options: AdapterOptions): AdapterRegistry {
  const adapters: ProjectSourceAdapter[] = [
    createGithubAdapter({
      http: options.http,
      token: options.githubToken ?? null,
      ...(options.githubLimits ? { limits: options.githubLimits } : {}),
    }),
    createDevpostAdapter({ http: options.http }),
    createDeploymentAdapter({
      http: options.http,
      ...(options.deploymentTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.deploymentTimeoutMs }),
    }),
    createVideoAdapter({ http: options.http }),
  ];
  return new Map<ProjectSourceType, ProjectSourceAdapter>(
    adapters.map((adapter) => [adapter.sourceType, adapter]),
  );
}
