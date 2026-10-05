import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { githubFixtureRoutes, type GithubFixtureRepository } from '@judge-copilot/github';
import type { FixtureResponse, FixtureWorld } from '@judge-copilot/safe-http';

/*
 * Loads synthetic network fixtures (development and tests only; the worker refuses fixture mode in
 * production). A directory of JSON files is merged into one world. Route bodies may reference
 * files (`bodyFile`), and GitHub repositories are described at a high level and expanded into the
 * exact REST responses by `githubFixtureRoutes`.
 */

type FixtureRouteInput = FixtureResponse & { readonly bodyFile?: string };

interface FixtureFile {
  readonly name: string;
  readonly hosts?: Record<string, string[] | string[][]>;
  readonly routes?: Record<string, FixtureRouteInput | FixtureRouteInput[]>;
  readonly githubRepositories?: GithubFixtureRepository[];
}

async function resolveRoute(directory: string, route: FixtureRouteInput): Promise<FixtureResponse> {
  if (!route.bodyFile) return route;
  const { bodyFile, ...rest } = route;
  const path = resolve(directory, bodyFile);
  if (!path.startsWith(resolve(directory)))
    throw new Error('fixture bodyFile escapes its directory');
  return { ...rest, body: await readFile(path, 'utf8') };
}

export async function loadFixtureWorld(
  directory: string,
): Promise<FixtureWorld & { names: string[] }> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const hosts: Record<string, string[] | string[][]> = {};
  const routes: Record<string, FixtureResponse | FixtureResponse[]> = {};
  const names: string[] = [];
  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(directory, file), 'utf8')) as FixtureFile;
    names.push(fixture.name);
    Object.assign(hosts, fixture.hosts ?? {});
    for (const [url, route] of Object.entries(fixture.routes ?? {})) {
      routes[url] = Array.isArray(route)
        ? await Promise.all(route.map((item) => resolveRoute(directory, item)))
        : await resolveRoute(directory, route);
    }
    for (const repository of fixture.githubRepositories ?? []) {
      Object.assign(routes, githubFixtureRoutes(repository));
    }
  }
  return { hosts, routes, names };
}
