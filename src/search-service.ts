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
 *
 * API CONTRACT (`https://api.starlog.dev/search`): an envelope
 *   { query, category, total_manifests, results_count,
 *     results: [ { rank, score, manifest: <CapabilityManifest> } ] }
 * ordered by `rank` (1 = best). A bare array of manifest objects (optionally
 * with `_score`) is also accepted for forward/backward compatibility.
 *
 * Each manifest is validated against `CapabilityManifestSchema`; malformed
 * entries are skipped (with a stderr warning) rather than trusted blindly.
 * The API's own `score` is flat for top hits, so the displayed relevance is
 * derived from rank position (higher = better) to stay monotonic.
 */
export function parseApiResults(payload: unknown): QueryResult[] {
  const rawItems: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { results?: unknown[] }).results)
      ? (payload as { results: unknown[] }).results
      : [];

  // Normalize to { manifest record, rank }, preferring the envelope's nested
  // `manifest` and `rank`; for a bare array, the item IS the manifest.
  const entries = rawItems
    .map((item, i) => {
      if (item === null || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const record = obj.manifest && typeof obj.manifest === 'object'
        ? (obj.manifest as Record<string, unknown>)
        : obj;
      const rank = typeof obj.rank === 'number' ? obj.rank : i + 1;
      return { record, rank };
    })
    .filter((e): e is { record: Record<string, unknown>; rank: number } => e !== null)
    .sort((a, b) => a.rank - b.rank);

  const n = entries.length;
  const results: QueryResult[] = [];
  entries.forEach((e, i) => {
    const parsed = CapabilityManifestSchema.safeParse(e.record);
    if (!parsed.success) {
      const id = typeof e.record.id === 'string' ? e.record.id : '(unknown)';
      console.error(`[starlog] skipping malformed API manifest "${id}".`);
      return;
    }
    results.push({
      manifest: parsed.data,
      relevance_score: n > 0 ? Math.round((100 * (n - i)) / n * 100) / 100 : 0,
      vs_custom: '',
      context_fit: '',
      tradeoffs: [],
    });
  });
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
        // Return the hosted results when there are any; otherwise fall through
        // to the local corpus rather than surfacing an empty result set for an
        // in-corpus query (an unrecognized shape or a backend hiccup must never
        // black-hole the search — the local keyword ranker is the safety net).
        if (apiResults.length > 0) {
          return apiResults;
        }
        console.error('[starlog] API returned no usable results; using local corpus.');
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
