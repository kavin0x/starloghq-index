import type { CapabilityManifest, QueryResult } from '../manifest/schema.js';
import type { SearchOptions, SiftrankFn, LlmFn, SiftrankResult } from './types.js';
import { mmrRerank } from './rerank.js';

/**
 * Query engine pure function. Filters corpus, ranks via siftrank,
 * optionally generates vs_custom and tradeoffs via LLM.
 *
 * Architecture: Pure async function with injected deps (QENG-05).
 * No direct imports of Anthropic SDK or child_process.
 * Trivially replaceable with MCP transport using same corpus and logic.
 *
 * @param query - Natural language query (e.g., "auth for Next.js SaaS")
 * @param corpus - Full manifest corpus (never mutated)
 * @param options - Category, stack, topK, projectContext filters
 * @param deps - Injected dependencies for testability
 * @returns Ranked QueryResult array sorted by relevance_score descending
 */
export async function search(
  query: string,
  corpus: CapabilityManifest[],
  options: SearchOptions,
  deps: { siftrank: SiftrankFn; llm: LlmFn },
): Promise<QueryResult[]> {
  // Work on a copy to avoid mutating input
  let filtered = [...corpus];

  // Step 1: Filter by category (QENG-01)
  if (options.category) {
    filtered = filtered.filter((m) => m.category === options.category);
  }

  // Step 2: Filter by stack_affinity (QENG-01)
  if (options.stack) {
    const stackLower = options.stack.toLowerCase();
    filtered = filtered.filter((m) =>
      m.stack_affinity.some((s) => s.toLowerCase().includes(stackLower)),
    );
  }

  // Step 3: Early return if nothing matches
  if (filtered.length === 0) {
    return [];
  }

  // Step 4: Rank via siftrank (QENG-02)
  const siftrankResults = await deps.siftrank(filtered, query);

  // Step 5: Map siftrank results to QueryResult, limit to topK
  const topK = options.topK ?? 5;

  // Build a lookup map from manifest ID to manifest
  const manifestMap = new Map<string, CapabilityManifest>();
  for (const m of filtered) {
    manifestMap.set(m.id, m);
  }

  // Step 4.5: MMR diversity rerank (if enabled, per DIV-02)
  let ranked: SiftrankResult[];
  if (options.diversityLambda !== undefined && options.diversityLambda < 1.0) {
    ranked = mmrRerank(siftrankResults, manifestMap, options.diversityLambda);
  } else {
    ranked = [...siftrankResults].sort((a, b) => b.score - a.score);
  }
  const topResults = ranked.slice(0, topK);

  // Step 6: Generate vs_custom + tradeoffs via LLM (QENG-03, QENG-04)
  let analysisMap = new Map<string, { vs_custom: string; context_fit: string; tradeoffs: string[] }>();

  if (options.projectContext && topResults.length > 0) {
    // Build prompt for LLM
    const manifestSummaries = topResults.map((r) => {
      const manifest = manifestMap.get(r.key);
      if (!manifest) return '';
      return `- ${manifest.name} (${manifest.id}): ${manifest.solves}. Best for: ${manifest.best_for.join(', ')}. Skip when: ${manifest.skip_when.join(', ')}`;
    }).filter(Boolean).join('\n');

    const prompt = `Given the project context: "${options.projectContext}"

And these library options:
${manifestSummaries}

For each library, provide a JSON response with this structure:
{
  "analysis": [
    {
      "id": "<library-id>",
      "vs_custom": "<1-2 sentences why this library is better than building custom>",
      "context_fit": "<1-2 sentences why this fits the project context>",
      "tradeoffs": ["<tradeoff 1>", "<tradeoff 2>"]
    }
  ]
}

Respond with ONLY the JSON, no other text.`;

    const systemPrompt = 'You are a technical advisor analyzing library options for a software project. Respond only with valid JSON.';

    try {
      const llmResponse = await deps.llm(prompt, systemPrompt);
      const parsed = JSON.parse(llmResponse);

      if (parsed.analysis && Array.isArray(parsed.analysis)) {
        for (const item of parsed.analysis) {
          analysisMap.set(item.id, {
            vs_custom: item.vs_custom || '',
            context_fit: item.context_fit || '',
            tradeoffs: item.tradeoffs || [],
          });
        }
      }
    } catch {
      // If LLM fails, continue without analysis
    }
  }

  // Step 7: Build final QueryResult array
  const results: QueryResult[] = [];
  for (const siftrankResult of topResults) {
    const manifest = manifestMap.get(siftrankResult.key);
    if (!manifest) continue;

    const analysis = analysisMap.get(manifest.id);

    results.push({
      manifest,
      relevance_score: siftrankResult.score,
      vs_custom: analysis?.vs_custom ?? '',
      context_fit: analysis?.context_fit ?? '',
      tradeoffs: analysis?.tradeoffs ?? [],
    });
  }

  return results;
}
