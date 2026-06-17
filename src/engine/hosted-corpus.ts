import { CapabilityManifestSchema, type CapabilityManifest } from '../manifest/schema.js';

/**
 * Hosted corpus fetch — the full (paid) corpus tier.
 *
 * The shipped package bundles only the small `corpus-free` tier. When the user
 * has a key (`STARLOG_API_KEY`), `runSearch` upgrades to the full hosted corpus
 * by asking the `/search` endpoint of the starlog-api worker (api.starlog.dev)
 * for the keyword-relevant manifests, then ranks them locally with the SAME
 * engine — so hosted only changes the *candidate set*, never the ranking.
 *
 * Consumption conventions mirror the facts client: Bearer STARLOG_API_KEY, a
 * short abort timeout, defensive parsing, and NEVER throws — any problem
 * (no key, network, non-200, malformed body) returns `null` so the caller
 * falls back to the local corpus. Existing keyless users are unaffected.
 *
 *   GET /search?q=&category=&top_k=  → { results: [{ rank, score, manifest }] }
 */
const DEFAULT_BASE_URL = 'https://api.starlog.dev';
const TIMEOUT_MS = 10_000;
// /search caps top_k at 50; ask for the max so the local re-rank has a full
// candidate set to pick the final top_k from.
const CANDIDATE_LIMIT = 50;

/**
 * Fetch keyword-relevant manifests from the hosted full corpus.
 * @returns the candidate manifests, or `null` to signal "use the local corpus".
 */
export async function fetchHostedCorpus(
  query: string,
  category?: string,
  opts: { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<CapabilityManifest[] | null> {
  const apiKey = opts.apiKey ?? process.env.STARLOG_API_KEY;
  if (!apiKey || apiKey.trim() === '') return null; // keyless → local tier
  if (!query || query.trim() === '') return null;

  const baseUrl = opts.baseUrl ?? process.env.STARLOG_API_URL ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ q: query, top_k: String(CANDIDATE_LIMIT) });
  if (category) params.set('category', category);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(`${baseUrl}/search?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[starlog] hosted /search → HTTP ${res.status}; using local corpus.`);
      return null;
    }
    const body: unknown = await res.json();
    const results =
      body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results)
        ? (body as { results: unknown[] }).results
        : [];
    const manifests: CapabilityManifest[] = [];
    for (const r of results) {
      const raw = r && typeof r === 'object' ? (r as { manifest?: unknown }).manifest : undefined;
      const parsed = CapabilityManifestSchema.safeParse(raw);
      if (parsed.success) manifests.push(parsed.data);
    }
    // Empty/garbage hosted body → fall back to local rather than return nothing.
    return manifests.length > 0 ? manifests : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[starlog] hosted /search failed (${msg}); using local corpus.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
