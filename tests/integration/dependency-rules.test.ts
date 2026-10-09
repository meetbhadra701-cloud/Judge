/*
 * Enforces the package dependency rules documented in docs/ARCHITECTURE.md
 * ("Package dependency rules"). If this test fails, fix the dependency — do not loosen the
 * rules without updating the architecture document and justifying the change.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCOPE = '@judge-copilot/';

/**
 * Layer of every package, including packages planned for later milestones.
 *   0 foundation       — shared, schemas
 *   1 domain           — domain
 *   2 deterministic core (pure, no I/O, no AI) — audit, context, capture, evidence, scoring, uncertainty, questions
 *   3 adapters (I/O and AI) — database, auth, safe-http, github, devpost, deployment, video, browser, llm, prompts
 *   4 apps             — api, worker, web
 * A package may depend only on packages in a strictly lower layer, except that layer-2
 * packages may depend on each other (acyclically).
 */
const LAYERS: Record<string, number> = {
  shared: 0,
  schemas: 0,
  domain: 1,
  audit: 2,
  context: 2,
  capture: 2,
  evidence: 2,
  scoring: 2,
  uncertainty: 2,
  questions: 2,
  assessment: 2,
  database: 3,
  auth: 3,
  'safe-http': 3,
  deployment: 3,
  video: 3,
  llm: 3,
  prompts: 3,
  github: 3,
  devpost: 3,
  browser: 3,
  api: 4,
  worker: 4,
  web: 4,
};
const SAME_LAYER_ALLOWED = new Set([2]);

interface WorkspacePackage {
  shortName: string;
  dir: string;
  isApp: boolean;
  declared: string[];
}

function readWorkspace(): WorkspacePackage[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(ROOT, group))
      .map((name) => join(ROOT, group, name))
      .filter((dir) => statSync(dir).isDirectory() && safeExists(join(dir, 'package.json')))
      .map((dir) => {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        expect(
          manifest.name.startsWith(SCOPE),
          `${manifest.name} must use the ${SCOPE} scope`,
        ).toBe(true);
        const declared = Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.peerDependencies,
        })
          .filter((dep) => dep.startsWith(SCOPE))
          .map((dep) => dep.slice(SCOPE.length));
        return {
          shortName: manifest.name.slice(SCOPE.length),
          dir,
          isApp: group === 'apps',
          declared,
        };
      }),
  );
}

function safeExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.next'].includes(entry.name) ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? '');
}

const workspace = readWorkspace();
const byName = new Map(workspace.map((pkg) => [pkg.shortName, pkg]));

describe('package dependency rules', () => {
  it('every workspace package has an assigned layer', () => {
    for (const pkg of workspace) {
      expect(
        LAYERS[pkg.shortName],
        `assign ${pkg.shortName} a layer in this test and in docs/ARCHITECTURE.md`,
      ).toBeDefined();
      expect(LAYERS[pkg.shortName] === 4, `${pkg.shortName}: only apps/* may be layer 4`).toBe(
        pkg.isApp,
      );
    }
  });

  it('packages never depend on apps, and dependencies only point downward', () => {
    for (const pkg of workspace) {
      const ownLayer = LAYERS[pkg.shortName] ?? Number.NaN;
      for (const dep of pkg.declared) {
        expect(byName.get(dep)?.isApp, `${pkg.shortName} must not depend on app ${dep}`).not.toBe(
          true,
        );
        const depLayer = LAYERS[dep] ?? Number.NaN;
        const allowed =
          depLayer < ownLayer || (depLayer === ownLayer && SAME_LAYER_ALLOWED.has(ownLayer));
        expect(allowed, `${pkg.shortName} (layer ${ownLayer}) -> ${dep} (layer ${depLayer})`).toBe(
          true,
        );
      }
    }
  });

  it('the scoring engine can never reach a model, prompt or adapter package, even transitively', () => {
    const seen = new Set<string>();
    const visit = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const dep of byName.get(name)?.declared ?? []) visit(dep);
    };
    visit('scoring');
    seen.delete('scoring');
    expect([...seen].sort()).toEqual(['context', 'domain', 'evidence', 'schemas']);
    for (const forbidden of ['llm', 'prompts', 'database', 'browser', 'api', 'worker', 'web']) {
      expect(seen.has(forbidden), `scoring must not reach ${forbidden}`).toBe(false);
    }
  });

  it('the workspace dependency graph is acyclic', () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, path: string[]): void => {
      if (done.has(name)) return;
      expect(visiting.has(name), `dependency cycle: ${[...path, name].join(' -> ')}`).toBe(false);
      visiting.add(name);
      for (const dep of byName.get(name)?.declared ?? []) visit(dep, [...path, name]);
      visiting.delete(name);
      done.add(name);
    };
    for (const pkg of workspace) visit(pkg.shortName, []);
  });

  it('source imports match declared dependencies and never reach into another package', () => {
    for (const pkg of workspace) {
      for (const file of sourceFiles(pkg.dir)) {
        const where = relative(ROOT, file);
        for (const specifier of importsOf(file)) {
          if (specifier.startsWith(SCOPE)) {
            const target = specifier.slice(SCOPE.length).split('/')[0] ?? '';
            expect(target, `${where}: deep import ${specifier}`).toBe(
              specifier.slice(SCOPE.length),
            );
            expect(target === pkg.shortName, `${where}: self-import ${specifier}`).toBe(false);
            expect(pkg.declared, `${where} imports undeclared ${specifier}`).toContain(target);
          } else if (specifier.startsWith('.')) {
            const resolved = resolve(file, '..', specifier);
            expect(
              resolved.startsWith(pkg.dir + '/'),
              `${where}: relative import ${specifier} escapes its package`,
            ).toBe(true);
          }
        }
      }
    }
  });
});
