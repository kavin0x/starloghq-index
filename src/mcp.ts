import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { loadCorpus } from './engine/corpus.js';
import { search } from './engine/search.js';
import { createResilientSiftrankFn, createLlmFn } from './engine/siftrank.js';
import { KnownCategorySchema } from './manifest/schema.js';
import type { Category, QueryResult } from './manifest/schema.js';

// ── Result formatting ───────────────────────────────────────────────────────

function formatResults(query: string, results: QueryResult[]): string {
  if (results.length === 0) {
    return `No manifests found for: "${query}"`;
  }

  const lines: string[] = [];
  for (const r of results) {
    const m = r.manifest;
    lines.push(`## ${m.name} (${m.id})`);
    lines.push(`**Solves:** ${m.solves}`);
    lines.push(`**Category:** ${m.category} | **Effort:** ${m.integration_effort} | **Ecosystem:** ${m.ecosystem}`);
    lines.push(`**Best for:** ${m.best_for.join('; ')}`);
    lines.push(`**Skip when:** ${m.skip_when.join('; ')}`);
    if (m.hosted_alternative) {
      lines.push(`**Hosted alternative:** ${m.hosted_alternative.name} -- ${m.hosted_alternative.pricing_summary}`);
    }
    if (r.vs_custom) {
      lines.push(`**vs. custom:** ${r.vs_custom}`);
    }
    if (r.tradeoffs && r.tradeoffs.length > 0) {
      lines.push(`**Tradeoffs:** ${r.tradeoffs.join('; ')}`);
    }
    lines.push(`**Stack affinity:** ${m.stack_affinity.join(', ')}`);
    lines.push(`**Health:** ${m.health.stars.toLocaleString()} stars, ${m.health.contributors} contributors, license: ${m.health.license}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Search execution (API delegation OR local engine) ─────────────────────

interface SearchArgs {
  query: string;
  category?: string;
  stack?: string;
  top_k?: number;
  diversity_lambda?: number;
  context?: string;
}

async function runSearch(args: SearchArgs): Promise<QueryResult[]> {
  const { query, category, stack, top_k, diversity_lambda, context } = args;

  // Tier 1: delegate to the hosted API when an API key is present (parity with
  // the `starlog search` CLI path). Falls back to the local engine on failure.
  const apiKey = process.env.STARLOG_API_KEY;
  if (apiKey) {
    try {
      const params = new URLSearchParams({ q: query });
      if (category) params.set('category', category);
      const response = await fetch(`https://api.starlog.dev/search?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) {
        const manifests = (await response.json()) as Array<Record<string, unknown>>;
        return manifests.map((m) => ({
          manifest: m as unknown as QueryResult['manifest'],
          relevance_score: (m._score as number) ?? 0,
          vs_custom: '',
          context_fit: '',
          tradeoffs: [],
        }));
      }
      console.error(`[starlog] API error ${response.status} ${response.statusText}; using local corpus.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[starlog] API request failed (${msg}); using local corpus.`);
    }
  }

  // Tier 2: local engine with resilient LLM ranking.
  const corpus = await loadCorpus(undefined, category as Category | undefined);
  return search(
    query,
    corpus,
    {
      category: category as Category | undefined,
      stack,
      topK: top_k ?? 5,
      projectContext: context,
      diversityLambda: diversity_lambda,
    },
    { siftrank: createResilientSiftrankFn(), llm: createLlmFn() },
  );
}

// ── Server ──────────────────────────────────────────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer({ name: 'starlog', version: '0.1.0' });

  server.tool(
    'starlog_search',
    'Search the Starlog capability manifest corpus. Returns ranked library recommendations for a given use case, with integration effort, best-for scenarios, skip-when conditions, hosted alternatives, and (when project context is supplied) DIY-vs-buy analysis. Use this when deciding which library or service to use for a specific capability.',
    {
      query: z.string().describe('What you need, e.g. "auth for Next.js SaaS" or "background job queue for Node.js"'),
      category: z.enum(KnownCategorySchema.options).optional().describe('Filter to a specific category (or pass any string for dynamic categories)'),
      stack: z.string().optional().describe('Filter by stack affinity, e.g. "next.js", "python", "react"'),
      top_k: z.number().optional().describe('Max results to return (default 5)'),
      diversity_lambda: z.number().optional().describe('Diversity-relevance tradeoff (0=max diversity, 1=pure relevance). Omit for pure relevance ranking.'),
      context: z.string().optional().describe('Project context to unlock DIY-vs-buy analysis, e.g. "B2B SaaS on Next.js + Postgres, small team, needs SSO soon"'),
    },
    async (args) => {
      const results = await runSearch(args);
      return { content: [{ type: 'text' as const, text: formatResults(args.query, results) }] };
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run-if-main guard: auto-start when executed directly (node dist/mcp.js or
// `starlog mcp`), but stay importable for tests without opening stdio.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  await startMcpServer();
}
