import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { KnownCategorySchema } from './manifest/schema.js';
import type { QueryResult } from './manifest/schema.js';
import { runSearch } from './search-service.js';
import { getPackageVersion } from './paths.js';

// ── Result formatting ───────────────────────────────────────────────────────

function formatResults(query: string, results: QueryResult[]): string {
  const categories = KnownCategorySchema.options.join(', ');

  if (results.length === 0) {
    return `No strong match for "${query}" in the local index, which covers: ${categories}. ` +
      `This capability may be outside the indexed corpus -- do not present a forced match as a recommendation.`;
  }

  const lines: string[] = [];

  // A single isolated, modestly-scored hit usually means a stray keyword match
  // rather than a real capability fit; tell the agent so it doesn't relay a
  // lone off-topic result as a confident recommendation.
  if (results.length === 1 && results[0].relevance_score < 70) {
    lines.push(
      `_No strong match in the local index (covers: ${categories}). Closest by keyword -- treat as low confidence:_`,
      '',
    );
  }
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

// ── Server ──────────────────────────────────────────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer({ name: 'starlog', version: getPackageVersion() });

  server.tool(
    'starlog_search',
    'Search the Starlog capability manifest corpus. Returns ranked library recommendations for a given use case, with integration effort, best-for scenarios, skip-when conditions, hosted alternatives, and (when project context is supplied) DIY-vs-buy analysis. Use this when deciding which library or service to use for a specific capability.',
    {
      query: z.string().describe('What you need, e.g. "auth for Next.js SaaS" or "background job queue for Node.js"'),
      category: z.string().optional().describe(`Filter to a category. Known categories: ${KnownCategorySchema.options.join(', ')}. Any other string is accepted for dynamic categories (parity with the CLI).`),
      stack: z.string().optional().describe('Filter by stack affinity, e.g. "next.js", "python", "react"'),
      top_k: z.number().int().min(1).max(50).optional().describe('Max results to return, 1-50 (default 5)'),
      diversity_lambda: z.number().min(0).max(1).optional().describe('Diversity-relevance tradeoff (0=max diversity, 1=pure relevance). Omit for pure relevance ranking.'),
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

// Run-if-main guard: auto-start when executed directly (node dist/mcp.js, the
// command wired into settings.json), but stay importable for tests without
// opening stdio.
//
// Both sides are run through realpathSync before comparing. `import.meta.url`
// is already symlink-resolved by the loader, but `process.argv[1]` is the path
// exactly as the parent invoked it -- so on any install whose path crosses a
// symlink (macOS `/tmp -> /private/tmp`, some nvm/Homebrew layouts, an npx
// cache dir), a raw string compare is unequal and the server silently never
// starts. Canonicalizing both makes the guard fire regardless of symlinks.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await startMcpServer();
}
