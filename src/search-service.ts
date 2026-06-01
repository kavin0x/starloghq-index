import { loadCorpus } from './engine/corpus.js';
import { search } from './engine/search.js';
import { createResilientSiftrankFn, createLlmFn } from './engine/siftrank.js';
import { CapabilityManifestSchema, type Category, type QueryResult } from './manifest/schema.js';

export interface SearchArgs {
  query: string;
  category?: string;
  stack?: string;
  top_k?: number;
  diversity_lambda?: number;
  context?: string;
}

/** Abort the hosted-API request if it hasn't responded in this many ms. */
const API_TIMEOUT_MS = 10_000;

/**
 * Convert a hosted-API JSON payload into validated QueryResult[].
 * Each entry is validated against the manifest schema; malformed entries are
 * skipped (with a stderr warning) rather than trusted blindly — otherwise a
 * shape mismatch would crash the formatter at render time. A non-array payload
 * yields an empty list.
 *
 * API CONTRACT: each element of the `https://api.starlog.dev/search` response
 * MUST conform to `CapabilityManifestSchema` (full `health`/`quality` objects
 * included), optionally plus a numeric `_score`. Entries that don't match are
 * dropped here — so if the hosted API's response shape ever diverges from the
 * stored-manifest schema, results silently disappear. Keep the two in sync.
 */
export function parseApiResults(payload: unknown): QueryResult[] {
  if (!Array.isArray(payload)) {
    console.error('[starlog] API returned a non-array payload; ignoring.');
    return [];
  }

  const results: QueryResult[] = [];
  for (const item of payload) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const score = typeof record._score === 'number' ? record._score : 0;
    const parsed = CapabilityManifestSchema.safeParse(record);
    if (!parsed.success) {
      const id = typeof record.id === 'string' ? record.id : '(unknown)';
      console.error(`[starlog] skipping malformed API manifest "${id}".`);
      continue;
    }
    results.push({
      manifest: parsed.data,
      relevance_score: score,
      vs_custom: '',
      context_fit: '',
      tradeoffs: [],
    });
  }
  return results;
}

/**
 * Execute a capability search, shared by both the MCP server and the CLI so
 * the two transports behave identically.
 *
 * Tier 1: when STARLOG_API_KEY is set, delegate to the hosted API. On any
 *         failure (network error or non-2xx) it logs to stderr and falls
 *         through to the local engine — never crashes the caller.
 * Tier 2: local corpus with resilient LLM ranking.
 */
export async function runSearch(args: SearchArgs): Promise<QueryResult[]> {
  const { query, category, stack, top_k, diversity_lambda, context } = args;

  const apiKey = process.env.STARLOG_API_KEY;
  if (apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const params = new URLSearchParams({ q: query });
      if (category) params.set('category', category);
      const response = await fetch(`https://api.starlog.dev/search?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = await response.json();
        const apiResults = parseApiResults(payload);
        // Distinguish "API legitimately found nothing" (trust it, return [])
        // from "API returned results but none survived validation" — the
        // latter is shape-drift, so fall through to the local corpus rather
        // than masquerade a bug as an empty result set.
        const droppedEverything = Array.isArray(payload) && payload.length > 0 && apiResults.length === 0;
        if (!droppedEverything) {
          return apiResults;
        }
        console.error(`[starlog] API returned ${payload.length} result(s) but none matched the manifest schema; using local corpus.`);
      } else {
        console.error(`[starlog] API error ${response.status} ${response.statusText}; using local corpus.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[starlog] API request failed (${msg}); using local corpus.`);
    } finally {
      clearTimeout(timer);
    }
  }

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
