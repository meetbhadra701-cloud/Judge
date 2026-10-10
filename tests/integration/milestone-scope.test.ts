/*
 * Guards the M5 scope while M5 is built phase by phase (docs/V1_CONTRACT.md, docs/milestones/M5-design.md).
 * M3 added the evidence graph; M4 the pure scoring engine. M5 PHASE P1 added only the shared assessment
 * vocabularies/schemas and the provider-neutral `packages/llm` interface (digest, timeout, retry, local
 * spending guard, replay and scripted providers); PHASE P2 adds only the pure `packages/prompts` renderer
 * (frozen templates, framing of untrusted data); PHASE P3 adds only the pure `packages/assessment` trust boundary
 * (windowing, quote location, gates G1-G7, graph planning, critic policy, report verification) and one additive scoring
 * export (the report-hash verifier); PHASE P4 adds only the database persistence of assessments (migrations 0010-0011, the
 * trusted input reader, the extraction, run, ledger and assessment stores): NO vendor SDK or endpoint, NO pipeline
 * orchestration, NO route, worker job or UI. Everything from M6 on, and the later M5 phases,
 * must stay unimplemented. Each M5 phase updates this guard together with its own work. The guard inspects implementation
 * surfaces (code, manifests, migrations, routes), not the binding documentation, which discusses
 * those concepts by design. If a later milestone legitimately adds one of these, update this
 * test in that milestone together with its milestone report.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** Packages that must remain README-only placeholders until their milestone. */
const NOT_YET_IMPLEMENTED = [
  'uncertainty', // M6
  'questions', // M6
  'browser', // headless/sandboxed browser inspection (deferred; M2 uses plain HTTP observation)
];

/** Packages M2 and M3 implement. */
const IMPLEMENTED_PACKAGES = [
  'capture',
  'safe-http',
  'github',
  'devpost',
  'deployment',
  'video',
  'auth', // M2
  'evidence', // M3
  'scoring', // M4
  'llm', // M5 P1: provider-neutral interface only; no vendor adapter yet
  'prompts', // M5 P2: pure renderer and frozen templates only; no provider, no pipeline
  'assessment', // M5 P3: pure gates, planning and policy only; no provider, no database, no pipeline
];

const MODEL_SDKS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  'cohere-ai',
  '@mistralai/mistralai',
  'ollama',
  'groq-sdk',
  'replicate',
  'langchain',
  '@langchain/core',
  'ai',
  'llamaindex',
  '@huggingface/inference',
];

const PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'integrate.api.nvidia.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'api-inference.huggingface.co',
  'localhost:11434',
];

/** Tables that belong to later milestones (M3's claim/evidence/unknown/contradiction tables are allowed). */
const LATER_TABLE_PATTERN =
  /(assessment|score|question|answer|interview|embedding|ranking|winner|criterion|dimension|rubric_assessment)/;

/** The only tables M5 phase P4 adds (migration 0010). Nothing else matching the later-milestone pattern may exist. */
const M5_P4_TABLES = [
  'assessment_dimension_judgments',
  'assessment_judgment_citations',
  'assessment_requests',
  'assessment_run_budget',
  'assessment_run_calls',
  'assessment_run_extractions',
  'assessment_run_input_snapshots',
  'assessment_run_inputs',
  'assessment_run_outcomes',
  'graph_extraction_items',
  'graph_extractions',
  'pre_interview_assessments',
];

/** The only tables M3 may add. */
const M3_TABLES = ['claims', 'contradictions', 'evidence_items', 'evidence_relations', 'unknowns'];

function workspaceManifests(): {
  dir: string;
  manifest: Record<string, Record<string, string> | undefined>;
}[] {
  const dirs = [
    ROOT,
    ...['apps', 'packages'].flatMap((group) =>
      readdirSync(join(ROOT, group)).map((name) => join(ROOT, group, name)),
    ),
  ];
  return dirs
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({
      dir,
      manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >,
    }));
}

function sourceFiles(dir: string, { includeTests = false } = {}): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.next'].includes(entry.name)
        ? []
        : sourceFiles(path, { includeTests });
    }
    if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) return [];
    return includeTests || !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

const applicationSource = ['apps', 'packages'].flatMap((group) => sourceFiles(join(ROOT, group)));

describe('M5 milestone scope (phase P4)', () => {
  it('keeps the later packages as README-only placeholders', () => {
    for (const name of NOT_YET_IMPLEMENTED) {
      const dir = join(ROOT, 'packages', name);
      expect(statSync(dir).isDirectory(), `${name} placeholder exists`).toBe(true);
      expect(existsSync(join(dir, 'package.json')), `${name} must not be implemented yet`).toBe(
        false,
      );
      expect(readdirSync(dir)).toEqual(['README.md']);
    }
  });

  it('implements the M2 ingestion packages, the M3 evidence package and the M4 scoring package as workspace packages', () => {
    for (const name of IMPLEMENTED_PACKAGES) {
      expect(existsSync(join(ROOT, 'packages', name, 'package.json')), name).toBe(true);
    }
  });

  it('depends on no model or provider SDK', () => {
    for (const { dir, manifest } of workspaceManifests()) {
      const deps = Object.keys({ ...manifest['dependencies'], ...manifest['devDependencies'] });
      expect(
        deps.filter((dep) => MODEL_SDKS.includes(dep)),
        dir,
      ).toEqual([]);
    }
  });

  it('contains no model-provider endpoints in application source', () => {
    const offenders = applicationSource.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return PROVIDER_HOSTS.some((host) => text.includes(host));
    });
    expect(offenders).toEqual([]);
  });

  it('creates no question, answer, interview or final-score tables in any migration; M3 adds the five graph tables and M5 P4 the twelve assessment tables', () => {
    const migrations = join(ROOT, 'packages/database/drizzle');
    const graphTables: string[] = [];
    const laterTables: string[] = [];
    for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql'))) {
      const created = [
        ...readFileSync(join(migrations, file), 'utf8').matchAll(/CREATE TABLE "([a-z_]+)"/g),
      ].map((match) => match[1] ?? '');
      for (const table of created) {
        if (M5_P4_TABLES.includes(table)) {
          laterTables.push(table);
          continue;
        }
        expect(LATER_TABLE_PATTERN.test(table), `${file}: ${table}`).toBe(false);
        if (/claim|evidence|contradiction|unknown/.test(table)) graphTables.push(table);
      }
    }
    expect(graphTables.sort()).toEqual(M3_TABLES);
    // P4 adds exactly the assessment-persistence tables, and no question, answer, interview, final-score or delta table
    expect(laterTables.sort()).toEqual(M5_P4_TABLES);
  });

  it('defines no score, weight, confidence, coverage, rank or accusation column on a graph table', () => {
    const schema = readFileSync(
      join(ROOT, 'packages/database/src/schema/evidence-graph.ts'),
      'utf8',
    );
    const columns = [...schema.matchAll(/^\s+\w+: \w+\('([a-z_]+)'/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(columns.length).toBeGreaterThan(40);
    expect(
      columns.filter((column) =>
        /score|weight|confidence|coverage|rank|strength|penalty|cheat|fraud|accus|grade|rating/.test(
          column,
        ),
      ),
    ).toEqual([]);
  });

  it('exports no scoring, ranking, confidence or assessment API from the evidence package', () => {
    const exported = sourceFiles(join(ROOT, 'packages/evidence/src')).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /^export (?:async )?(?:function|const|class|interface|type) (\w+)/gm,
        ),
      ].map((match) => match[1] ?? ''),
    );
    expect(exported.length).toBeGreaterThan(30);
    expect(
      exported.filter((name) =>
        /score|weight|confidence|coverage|rank|strength|assess|criterion|dimension|question|interview|winner|penalt|cheat|fraud/i.test(
          name,
        ),
      ),
    ).toEqual([]);
  });

  it('has no later-milestone concepts in implementation code', () => {
    // Identifiers only (comments may describe future work). These belong to M6-M9 (and the
    // still-unimplemented M5 phases: the persisted assessment version arrives with P4).
    const laterConcepts =
      /\b(AssessmentVersion|CriterionAssessment|JudgeQuestion|TeamAnswer|JudgeFinalScore|ScoreChange|EvidenceGraphVersion|ExtractionVersion|AnalysisVersion|informationGain|selectTopQuestions|PromptTemplate|createEmbedding)\b/;
    const offenders = applicationSource.filter((file) => {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n');
      return laterConcepts.test(code);
    });
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('keeps packages/evidence pure: no I/O, process, network, database or environment access', () => {
    const forbidden = [
      /from ['"](node:)?(fs|fs\/promises|net|tls|http|https|dgram|child_process|vm|os|worker_threads|dns)['"]/,
      /from ['"](drizzle-orm|postgres|fastify|next|react)(\/[^'"]*)?['"]/,
      /process\.env/,
      /\bfetch\(/,
      /\bDate\.now\(|new Date\(\)/,
      /Math\.random\(/,
    ];
    for (const file of sourceFiles(join(ROOT, 'packages/evidence/src'))) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/)/.test(line))
        .join('\n');
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${relative(ROOT, file)} ${pattern.source}`).toBe(false);
      }
      const builtins = [...code.matchAll(/from ['"](node:[a-z/_]+)['"]/g)].map((m) => m[1]);
      expect(
        builtins.filter((name) => name !== 'node:crypto'),
        relative(ROOT, file),
      ).toEqual([]);
    }
  });

  it('adds exactly the two M5 P4 migrations (0010 schema, 0011 integrity) and no other', () => {
    const migrations = readdirSync(join(ROOT, 'packages/database/drizzle'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(migrations).toEqual([
      '0000_m0_foundation.sql',
      '0001_audit_events_append_only.sql',
      '0002_m1_event_context.sql',
      '0003_m1_event_context_immutability.sql',
      '0004_m2_source_ingestion.sql',
      '0005_m2_source_ingestion_immutability.sql',
      '0006_m2_partial_reason_html_structure_limit.sql',
      '0007_m3_evidence_graph.sql',
      '0008_m3_evidence_graph_integrity.sql',
      '0009_m3_supersession_guard_hardening.sql',
      '0010_m5_assessment_schema.sql',
      '0011_m5_assessment_integrity.sql',
    ]);
  });

  it('keeps the scoring engine out of every app and every adapter: only the pure assessment package uses it (the database package only in its test helpers)', () => {
    const importers = applicationSource.filter(
      (file) =>
        !file.startsWith(join(ROOT, 'packages/scoring')) &&
        !file.startsWith(join(ROOT, 'packages/assessment')) &&
        !file.startsWith(join(ROOT, 'packages/database/src/testing')) &&
        /@judge-copilot\/scoring/.test(readFileSync(file, 'utf8')),
    );
    expect(importers.map((file) => relative(ROOT, file))).toEqual([]);
    for (const { dir, manifest } of workspaceManifests()) {
      if (dir === join(ROOT, 'packages/scoring') || dir === join(ROOT, 'packages/assessment'))
        continue;
      if (dir === join(ROOT, 'packages/database')) {
        // a development-only dependency: production code never scores
        expect(Object.keys(manifest['dependencies'] ?? {}).includes('@judge-copilot/scoring')).toBe(
          false,
        );
        continue;
      }
      const deps = Object.keys({ ...manifest['dependencies'], ...manifest['devDependencies'] });
      expect(deps.includes('@judge-copilot/scoring'), dir).toBe(false);
    }
  });

  it('keeps packages/scoring pure: no I/O, process, network, database, environment, clock or randomness', () => {
    const forbidden = [
      /from ['"](node:)?(fs|fs\/promises|net|tls|http|https|dgram|child_process|vm|os|worker_threads|dns)['"]/,
      /from ['"](drizzle-orm|postgres|fastify|next|react)(\/[^'"]*)?['"]/,
      /process\.env/,
      /\bfetch\(/,
      /\bDate\.now\(|new Date\(\)/,
      /Math\.random\(/,
    ];
    const files = sourceFiles(join(ROOT, 'packages/scoring/src')).filter(
      (file) => !file.includes(join('src', 'testing')),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/)/.test(line))
        .join('\n');
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${relative(ROOT, file)} ${pattern.source}`).toBe(false);
      }
      const builtins = [...text.matchAll(/from ['"](node:[a-z/_]+)['"]/g)].map((m) => m[1]);
      expect(builtins, relative(ROOT, file)).toEqual([]);
    }
  });

  it('keeps packages/llm provider-neutral: no vendor SDK, no dependency beyond context, schemas and zod', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/llm/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@judge-copilot/context',
      '@judge-copilot/schemas',
      'zod',
    ]);
    expect(manifest.devDependencies ?? {}).toEqual({});
  });

  it('has no importer of @judge-copilot/llm yet: no pipeline, route, worker job or UI uses a provider in P1', () => {
    const importers = applicationSource.filter(
      (file) =>
        !file.startsWith(join(ROOT, 'packages/llm')) &&
        /@judge-copilot\/llm/.test(readFileSync(file, 'utf8')),
    );
    expect(importers.map((file) => relative(ROOT, file))).toEqual([]);
    for (const { dir, manifest } of workspaceManifests()) {
      if (dir === join(ROOT, 'packages/llm')) continue;
      const deps = Object.keys({ ...manifest['dependencies'], ...manifest['devDependencies'] });
      expect(deps.includes('@judge-copilot/llm'), dir).toBe(false);
    }
  });

  it('keeps packages/prompts a pure library: only context, schemas and zod, no model SDK or provider package', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packages/prompts/package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@judge-copilot/context',
      '@judge-copilot/schemas',
      'zod',
    ]);
    expect(manifest.devDependencies ?? {}).toEqual({});
  });

  it('has no importer of @judge-copilot/prompts yet: no pipeline, route, worker job or UI renders a prompt in P2', () => {
    const importers = applicationSource.filter(
      (file) =>
        !file.startsWith(join(ROOT, 'packages/prompts')) &&
        /@judge-copilot\/prompts/.test(readFileSync(file, 'utf8')),
    );
    expect(importers.map((file) => relative(ROOT, file))).toEqual([]);
    for (const { dir, manifest } of workspaceManifests()) {
      if (dir === join(ROOT, 'packages/prompts')) continue;
      const deps = Object.keys({ ...manifest['dependencies'], ...manifest['devDependencies'] });
      expect(deps.includes('@judge-copilot/prompts'), dir).toBe(false);
    }
  });

  it('keeps the unapproved fallback anchors out of every implementation file', () => {
    const offenders = applicationSource.filter((file) =>
      /M5-fallback-anchors-draft|fallback-anchors-draft/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('keeps packages/assessment pure: only context, evidence, schemas and scoring, no model, prompt, database or worker', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packages/assessment/package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@judge-copilot/context',
      '@judge-copilot/evidence',
      '@judge-copilot/schemas',
      '@judge-copilot/scoring',
    ]);
    expect(manifest.devDependencies ?? {}).toEqual({});
  });

  it('limits the importers of @judge-copilot/assessment to the database persistence layer: no pipeline, route, worker job or UI yet', () => {
    const importers = applicationSource.filter(
      (file) =>
        !file.startsWith(join(ROOT, 'packages/assessment')) &&
        !file.startsWith(join(ROOT, 'packages/database')) &&
        /@judge-copilot\/assessment/.test(readFileSync(file, 'utf8')),
    );
    expect(importers.map((file) => relative(ROOT, file))).toEqual([]);
    for (const { dir, manifest } of workspaceManifests()) {
      if (dir === join(ROOT, 'packages/assessment') || dir === join(ROOT, 'packages/database'))
        continue;
      const deps = Object.keys({ ...manifest['dependencies'], ...manifest['devDependencies'] });
      expect(deps.includes('@judge-copilot/assessment'), dir).toBe(false);
    }
  });

  it('changes scoring only by the approved additive report-hash export (design §8.9, D15)', () => {
    const index = readFileSync(join(ROOT, 'packages/scoring/src/index.ts'), 'utf8');
    expect(index).toContain(
      "export { reportOutputHash, verifyScoreReportHash } from './report-hash.js';",
    );
    const hashFile = readFileSync(join(ROOT, 'packages/scoring/src/report-hash.ts'), 'utf8');
    // the verifier reproduces the engine's existing rule through the engine's own hash helper; it defines no new rule
    expect(hashFile).toContain("import { hashOf } from './canonical.js';");
    expect(hashFile).toContain('return hashOf(body);');
    // the engine still computes the hash itself, over the body, exactly as before
    const engine = readFileSync(join(ROOT, 'packages/scoring/src/engine.ts'), 'utf8');
    expect(engine).toContain('const outputHash = hashOf(body);');
    expect(engine).not.toContain('report-hash');
  });

  it('adds no assessment route, job type or pipeline in P4 (persistence only)', () => {
    const migrations = join(ROOT, 'packages/database/drizzle');
    const sql = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(migrations, name), 'utf8'))
      .join('\n');
    // only the twelve tables of migration 0010: nothing about questions, answers, interviews, final scores or deltas
    const createdAssessmentTables = [
      ...sql.matchAll(
        /CREATE TABLE "([a-z_]*(?:assessment|pre_interview|graph_extraction|budget)[a-z_]*)"/gi,
      ),
    ].map((match) => match[1] ?? '');
    expect(createdAssessmentTables.sort()).toEqual(M5_P4_TABLES);
    expect(
      /CREATE TABLE "[a-z_]*(post_interview|final_score|question|answer|delta)[a-z_]*"/i.test(sql),
    ).toBe(false);
    expect(existsSync(join(ROOT, 'packages/prompts/package.json'))).toBe(true);
    const workerAndApi = [
      ...sourceFiles(join(ROOT, 'apps/api/src')),
      ...sourceFiles(join(ROOT, 'apps/worker/src')),
    ];
    for (const file of workerAndApi) {
      expect(
        /pre_interview_assessment|assessment_run/i.test(readFileSync(file, 'utf8')),
        relative(ROOT, file),
      ).toBe(false);
    }
  });

  it('exposes no score, analysis, assessment, question, ranking or winner HTTP routes', () => {
    const routeFiles = sourceFiles(join(ROOT, 'apps/api/src')).filter((file) =>
      file.endsWith('routes.ts'),
    );
    for (const file of routeFiles) {
      const paths = [...readFileSync(file, 'utf8').matchAll(/['`](\/[^'`]*)['`]/g)].map(
        (match) => match[1] ?? '',
      );
      for (const path of paths) {
        expect(
          /score|analy[sz]|assess|question|rank|winner|interview|answer|extract|embed|verdict|grade/i.test(
            path,
          ),
          `${relative(ROOT, file)}: ${path}`,
        ).toBe(false);
      }
    }
  });

  it('registers only GET handlers for the evidence graph (writes are refused, never served)', () => {
    const routes = readFileSync(join(ROOT, 'apps/api/src/evidence-graph/routes.ts'), 'utf8');
    const verbs = [...routes.matchAll(/app\.(get|post|put|patch|delete|all)\(/g)].map((m) => m[1]);
    expect(new Set(verbs)).toEqual(new Set(['get']));
    expect(routes).toContain("method: ['POST', 'PUT', 'PATCH', 'DELETE']");
    expect(routes).toContain('GRAPH_READ_ONLY');
  });
});

describe('M3 security architecture', () => {
  it('has no code path that executes, installs or imports project content', () => {
    // ESLint already forbids child_process/vm; this is an independent, broader source check.
    const forbidden = [
      /from ['"](node:)?child_process['"]/,
      /from ['"](node:)?vm['"]/,
      /from ['"](node:)?worker_threads['"]/,
      /from ['"](node:)?wasi['"]/,
      /\beval\s*\(/,
      /new Function\s*\(/,
      /\bimport\(\s*[^'"\s)]/, // dynamic import of a computed specifier
      /\brequire\(\s*[^'"\s)]/,
      /npm (install|ci)|pip install|docker build|git clone|make\b.*-C/,
    ];
    const offenders = applicationSource
      .filter((file) => !file.includes(join('apps', 'web')) || !file.endsWith('next-env.d.ts'))
      .flatMap((file) => {
        const text = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/)/.test(line))
          .join('\n');
        return forbidden
          .filter((pattern) => pattern.test(text))
          .map((pattern) => `${relative(ROOT, file)} ${pattern.source}`);
      });
    expect(offenders).toEqual([]);
  });

  it('renders no project text as HTML or Markdown anywhere in the web UI', () => {
    const offenders = sourceFiles(join(ROOT, 'apps/web')).filter((file) =>
      /dangerouslySetInnerHTML|\.innerHTML\b|from ['"](marked|markdown-it|remark[^'"]*|react-markdown)['"]/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('keeps capture adapters off the filesystem and away from raw sockets and global fetch', () => {
    const adapterDirs = ['capture', 'github', 'devpost', 'deployment', 'video'].map((name) =>
      join(ROOT, 'packages', name, 'src'),
    );
    for (const file of adapterDirs.flatMap((dir) => sourceFiles(dir))) {
      const text = readFileSync(file, 'utf8');
      expect(
        /from ['"](node:)?(fs|fs\/promises|net|tls|http|https|dgram)['"]/.test(text),
        relative(ROOT, file),
      ).toBe(false);
      expect(/\bfetch\(/.test(text), relative(ROOT, file)).toBe(false);
    }
  });

  it('routes all capture network access through the SSRF-safe client', () => {
    // Only safe-http opens connections; the worker composes adapters with it. (Type-only
    // imports, such as the API server's request types, open nothing.)
    const networkModules = applicationSource.filter((file) =>
      /^import (?!type\b)[^;]*from ['"](node:)?(http|https|net|tls|undici)['"]/m.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(networkModules.map((file) => relative(ROOT, file)).sort()).toEqual([
      'packages/safe-http/src/client.ts',
      'packages/safe-http/src/ip-policy.ts',
      'packages/safe-http/src/transport.ts',
      'packages/safe-http/src/url-policy.ts',
    ]);
  });
});
