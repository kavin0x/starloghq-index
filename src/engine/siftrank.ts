import type { SiftrankFn, LlmFn } from './types.js';

// Filler words that carry no ranking signal in a capability query. Kept small
// and dev-flavored: terms like "build", "app", or "using" match nearly every
// manifest, so counting them flattens the ranking into ties and lets
// off-category libraries surface on incidental hits.
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'for', 'to', 'of', 'in', 'on', 'with', 'and', 'or', 'my',
  'your', 'i', 'we', 'is', 'are', 'be', 'that', 'this', 'it', 'as', 'at', 'by',
  'app', 'apps', 'application', 'applications', 'using', 'use', 'build',
  'building', 'need', 'want', 'add', 'adding', 'set', 'setup', 'how', 'best',
  'good', 'some', 'something', 'library', 'libraries', 'package',
]);

// Canonicalize a token for comparison: lowercase and drop non-alphanumerics so
// "Next.js", "next-js", and "nextjs" all compare equal.
function canon(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Split a field into canonical tokens. Dots are kept through the split so
// "next.js" stays one token before canon collapses it to "nextjs".
function tokenizeField(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map(canon)
    .filter(Boolean);
}

// Strength of a single query term against one field's tokens: exact token hit
// is full weight; prefix overlaps (query "auth" vs token "authentication", or
// vice-versa) count partially. Length guards stop one- and two-letter stems
// from matching unrelated tokens.
function fieldMatch(tokens: string[], term: string): number {
  let best = 0;
  for (const tok of tokens) {
    if (tok === term) return 1;
    if (term.length >= 3 && tok.startsWith(term)) best = Math.max(best, 0.7);
    else if (tok.length >= 3 && term.startsWith(tok)) best = Math.max(best, 0.6);
  }
  return best;
}

// Saturating score curve: score = 100 * raw / (raw + SCORE_HALF). This is an
// ABSOLUTE map (no per-query max-normalization), so scores are comparable
// across queries and a lone weak match can never be presented as 100. A raw of
// SCORE_HALF scores 50; strong multi-field matches (raw ~20-27) saturate in the
// mid-to-high 70s; an incidental single-term match (raw ~4-9) stays in the 30s
// to high 50s -- honest "weak" territory rather than a confident-looking 100.
const SCORE_HALF = 7;

// Drop the long tail below this absolute score (~raw 3.8): results that barely
// brushed a single common token.
const RELEVANCE_FLOOR = 35;

// A hit in the library's name or category says far more about fitness than an
// incidental hit in its stack list, so fields are weighted, not pooled.
const FIELD_WEIGHTS: Array<['name' | 'category' | 'solves' | 'best_for' | 'stack', number]> = [
  ['name', 3],
  ['category', 2.5],
  ['solves', 2],
  ['best_for', 1.5],
  ['stack', 1],
];

/**
 * The keyword ranker -- the default and only ranking path. Exported for direct
 * unit testing and consumed by runSearch.
 *
 * Scoring, term by term: inverse-document-frequency (distinctive terms like
 * "auth" outweigh corpus-common ones) times a field-weighted sum of match
 * strength. Raw scores are normalized so the best match is 100.00 and the rest
 * fall off proportionally -- no flat ties, and off-category libraries that only
 * match filler terms sink to the bottom. A bounded health nudge separates
 * genuine ties without ever reordering across a real relevance gap.
 */
export const keywordSiftrank: SiftrankFn = async (manifests, query) => {
  const terms = [...new Set(tokenizeField(query))].filter(
    (t) => t.length >= 2 && !QUERY_STOPWORDS.has(t),
  );

  // Tokenize each manifest's fields once, indexed parallel to `manifests`.
  const fields = manifests.map((m) => ({
    name: tokenizeField(m.name),
    category: tokenizeField(m.category),
    solves: tokenizeField(m.solves),
    best_for: tokenizeField(m.best_for.join(' ')),
    stack: tokenizeField(m.stack_affinity.join(' ')),
  }));

  // Document frequency per term -> inverse-frequency weight. A term matching
  // few manifests is a strong signal; one matching many is weak.
  //
  // idf is computed against a floored corpus size: a category/stack filter can
  // shrink `manifests` to 2-3 entries, which would collapse idf toward 0 and
  // push every score below the relevance floor (an in-category search returning
  // nothing). The floor keeps scores calibrated to a full-corpus scale so
  // filtered searches still rank and clear the floor.
  const N = Math.max(manifests.length, 12);
  const idf = new Map<string, number>();
  for (const t of terms) {
    let df = 0;
    for (const f of fields) {
      if (FIELD_WEIGHTS.some(([k]) => fieldMatch(f[k], t) > 0)) df++;
    }
    idf.set(t, Math.log(1 + N / (1 + df)));
  }

  const scored = manifests.map((m, i) => {
    const f = fields[i];
    let raw = 0;
    // Track whether the match touched a capability field (name/category/solves/
    // best_for) and not just stack_affinity. A library that matches only on
    // stack ("next.js") is an off-topic coincidence -- e.g. an email SDK
    // surfacing for an auth query because both target Next.js.
    let onTopic = false;
    for (const t of terms) {
      let fieldSum = 0;
      for (const [k, w] of FIELD_WEIGHTS) {
        const strength = fieldMatch(f[k], t);
        if (strength > 0) {
          fieldSum += w * strength;
          if (k !== 'stack') onTopic = true;
        }
      }
      raw += (idf.get(t) ?? 0) * fieldSum;
    }
    if (raw > 0) {
      // Tiny tie-breaker (max ~0.07 for a 10M-download lib) so equally-relevant
      // libraries separate and the healthier one edges ahead.
      const popularity = m.health.weekly_downloads ?? m.health.stars ?? 0;
      raw += Math.log10(1 + popularity) * 0.01;
    }
    return { manifest: m, raw, onTopic };
  });

  let ranked = scored
    .map((s) => ({
      key: s.manifest.id,
      value: s.manifest.name,
      object: {} as Record<string, unknown>,
      score: s.raw > 0 ? Math.round((100 * s.raw) / (s.raw + SCORE_HALF) * 100) / 100 : 0,
      exposure: 1,
      rank: 0,
      onTopic: s.onTopic,
    }))
    .filter((r) => r.score >= RELEVANCE_FLOOR);

  // Prefer capability ("on-topic") matches; fall back to stack-only matches
  // only when nothing matched a capability field, so a pure stack query
  // ("next.js libraries") still returns something useful instead of nothing.
  const onTopicHits = ranked.filter((r) => r.onTopic);
  if (onTopicHits.length > 0) ranked = onTopicHits;

  return ranked
    // search() re-sorts by score, but ranking here keeps the rank field honest
    // and matches the real Go siftrank's contract (1-based, score-descending).
    .sort((a, b) => b.score - a.score)
    .map(({ onTopic: _onTopic, ...r }, i) => ({ ...r, rank: i + 1 }));
};

/**
 * Create an LlmFn that uses the Anthropic SDK via OpenRouter.
 * Uses anthropic/claude-haiku-4.5 for cost efficiency.
 */
export function createLlmFn(): LlmFn {
  let clientPromise: Promise<any> | null = null;

  function getClient() {
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((mod) => {
        const Anthropic = mod.default;
        return new Anthropic({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: 'https://openrouter.ai/api',
        });
      }).catch(() => {
        throw new Error('LLM enrichment requires @anthropic-ai/sdk. Run from source repo or install it separately.');
      });
    }
    return clientPromise;
  }

  return async (prompt: string, system?: string): Promise<string> => {
    const client = await getClient();
    const response = await client.messages.create({
      model: process.env.STARLOG_RANK_MODEL || 'anthropic/claude-haiku-4.5',
      max_tokens: 1024,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    if (block.type === 'text') {
      return block.text;
    }
    return '';
  };
}
