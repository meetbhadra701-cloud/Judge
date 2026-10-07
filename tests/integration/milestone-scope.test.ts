/*
 * Guards the M3 scope (docs/V1_CONTRACT.md). M3 adds the evidence graph on top of M2's projects
 * and immutable source snapshots: Claim, EvidenceItem, EvidenceRelation, Unknown and
 * Contradiction (persistence, graph queries, verification levels, ID-integrity validation), the
 * `packages/evidence` domain package and read-only inspection routes. Everything from M4 on must
 * stay unimplemented: no scoring engine, no assessments, no uncertainty or question engine, no
 * interview mode, no model providers, prompts or embeddings. The guard inspects implementation
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
  'scoring', // M4
  'uncertainty', // M6
  'questions', // M6
  'browser', // headless/sandboxed browser inspection (deferred; M2 uses plain HTTP observation)
  'llm', // model provider abstraction (first used no earlier than M5)
  'prompts',
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

describe('M3 milestone scope', () => {
  it('keeps M4+ packages as README-only placeholders', () => {
    for (const name of NOT_YET_IMPLEMENTED) {
      const dir = join(ROOT, 'packages', name);
      expect(statSync(dir).isDirectory(), `${name} placeholder exists`).toBe(true);
      expect(existsSync(join(dir, 'package.json')), `${name} must not be implemented yet`).toBe(
        false,
      );
      expect(readdirSync(dir)).toEqual(['README.md']);
    }
  });

  it('implements the M2 ingestion packages and the M3 evidence package as workspace packages', () => {
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

  it('creates no scoring, assessment, question or interview tables in any migration, and only the five graph tables in M3', () => {
    const migrations = join(ROOT, 'packages/database/drizzle');
    const graphTables: string[] = [];
    for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql'))) {
      const created = [
        ...readFileSync(join(migrations, file), 'utf8').matchAll(/CREATE TABLE "([a-z_]+)"/g),
      ].map((match) => match[1] ?? '');
      for (const table of created) {
        expect(LATER_TABLE_PATTERN.test(table), `${file}: ${table}`).toBe(false);
        if (/claim|evidence|contradiction|unknown/.test(table)) graphTables.push(table);
      }
    }
    expect(graphTables.sort()).toEqual(M3_TABLES);
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
    // Identifiers only (comments may describe future work). These belong to M4-M9.
    const laterConcepts =
      /\b(AssessmentVersion|CriterionAssessment|DimensionAssessment|JudgeQuestion|TeamAnswer|JudgeFinalScore|ScoreChange|EvidenceGraphVersion|ExtractionVersion|AnalysisVersion|scoring-engine|computeOverallScore|aggregateScores|informationGain|selectTopQuestions|LlmClient|ModelProvider|PromptTemplate|createEmbedding)\b/;
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
