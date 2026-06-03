import { loadCorpus } from './engine/corpus.js';
import { search } from './engine/search.js';
import { keywordSiftrank, createLlmFn } from './engine/siftrank.js';
import { type Category, type QueryResult } from './manifest/schema.js';

export interface SearchArgs {
  query: string;
  category?: string;
  stack?: string;
  top_k?: number;
  diversity_lambda?: number;
  context?: string;
}

/**
 * Execute a capability search, shared by both the MCP server and the CLI so
 * the two transports behave identically.
 *
 * Loads the local corpus and ranks with the offline keyword ranker — no key,
 * no network. Pass `context` to enrich the top results with a per-library
 * `vs custom` rationale.
 */
export async function runSearch(args: SearchArgs): Promise<QueryResult[]> {
  const { query, category, stack, top_k, diversity_lambda, context } = args;

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
    { siftrank: keywordSiftrank, llm: createLlmFn() },
  );
}
