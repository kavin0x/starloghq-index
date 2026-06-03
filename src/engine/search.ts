import type { CapabilityManifest, QueryResult } from '../manifest/schema.js';
import type { SearchOptions, SiftrankFn, LlmFn, SiftrankResult } from './types.js';
import { mmrRerank } from './rerank.js';

/**
 * Minimum relevance score for an org-private (STARLOG_PRIVATE_CORPUS) result to
 * be floated FIRST. Tied to the EXISTING low-confidence bar used at cli.ts:123
 * and mcp.ts:27 — search only hard-filters category/stack, so an off-topic
 * private manifest (e.g. an org auth package on a "caching" query) is still in
 * `filtered`; this guard keeps it from hijacking position #1. Only RELEVANT
 * private matches surface first.
 */
const PRIVATE_FLOAT_MIN_SCORE = 70;

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
  // Exact (case-insensitive) match, not substring: a `react` filter must not
  // pull in `react-native`/`react-router`. Mirrors jaccardSimilarity's
  // set-membership semantics (L8).
  if (options.stack) {
    const stackLower = options.stack.toLowerCase();
    filtered = filtered.filter((m) =>
      m.stack_affinity.some((s) => s.toLowerCase() === stackLower),
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

  // Step 4.5: MMR diversity rerank — ON by default (Phase 0 trust-reset, per DIV-02).
  // Default lambda = 0.5 (Phase 6-validated diversity/relevance balance). All callers
  // (CLI, MCP, hosted search-service) flow through here, so the default applies
  // everywhere. Pass diversityLambda >= 1.0 to opt out and get pure score-descending
  // order (no diversity rerank).
  const lambda = options.diversityLambda ?? 0.5;
  let ranked: SiftrankResult[];
  if (lambda < 1.0) {
    ranked = mmrRerank(siftrankResults, manifestMap, lambda);
  } else {
    ranked = [...siftrankResults].sort((a, b) => b.score - a.score);
  }

  // FACTS-03 private-first overlay: float org-sanctioned (STARLOG_PRIVATE_CORPUS)
  // results that are RELEVANT (score >= PRIVATE_FLOAT_MIN_SCORE) ahead of the
  // rest, BEFORE the topK slice — a pure stable partition. Scoring and MMR are
  // untouched (this is NOT a ranking engine). With no privateIds it is a no-op.
  const isFloatedPrivate = (r: SiftrankResult): boolean =>
    options.privateIds?.has(r.key) === true && r.score >= PRIVATE_FLOAT_MIN_SCORE;
  if (options.privateIds && options.privateIds.size > 0) {
    ranked = [...ranked.filter(isFloatedPrivate), ...ranked.filter((r) => !isFloatedPrivate(r))];
  }

  const topResults = ranked.slice(0, topK);

  // MMR reorders by *marginal* relevance, which would print the score column out
  // of order (e.g. a diverse pick scoring 44 sitting above a 60). Treat diversity
  // as a selection step: keep the diverse top-k MMR chose, but present them
  // highest-score-first so the displayed scores are always monotonic. (For
  // lambda>=1 the set is already score-descending, so this is a no-op there.)
  //
  // FACTS-03: a plain `b.score - a.score` would undo the private-first partition,
  // so key on [floated-private first, then score desc]. This keeps RELEVANT
  // org-sanctioned picks visible at top WITHOUT altering relevance scores and
  // WITHOUT surfacing off-topic private packages. When nothing floats (no
  // privateIds, or none relevant) this collapses to pure score-desc — byte
  // identical to the prior behavior.
  topResults.sort(
    (a, b) =>
      (isFloatedPrivate(b) ? 1 : 0) - (isFloatedPrivate(a) ? 1 : 0) || b.score - a.score,
  );

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
