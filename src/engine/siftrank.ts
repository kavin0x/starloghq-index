import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CapabilityManifest } from '../manifest/schema.js';
import type { SiftrankFn, SiftrankResult, LlmFn } from './types.js';

const execFileAsync = promisify(execFile);

// Resolve siftrank binary -- check GOPATH/bin first, then fall back to PATH
function getSiftrankPath(): string {
  const gopath = process.env.GOPATH || join(process.env.HOME || '', 'go');
  return join(gopath, 'bin', 'siftrank');
}

/**
 * siftrank's `key` field is a generated short hash, NOT our manifest id -- the
 * original manifest is preserved in `object`. search() maps results back to the
 * corpus by `key` against manifest ids, so without this re-keying every
 * semantic result fails to map and the search returns empty. Re-point `key` to
 * `object.id` so the rest of the pipeline matches. Exported for unit testing.
 */
export function rekeyByObjectId(results: SiftrankResult[]): SiftrankResult[] {
  return results.map((r) => {
    // siftrank preserves the original input object so we can map back to it.
    // The current binary names that field `document`; older docs call it
    // `object`. Check both, then re-point `key` to the manifest id.
    const rec = r as unknown as { document?: { id?: unknown }; object?: { id?: unknown } };
    const id = rec.document?.id ?? rec.object?.id;
    return typeof id === 'string' ? { ...r, key: id } : r;
  });
}

/**
 * Create a SiftrankFn that spawns the siftrank Go binary.
 *
 * Maps OPENROUTER_API_KEY to OPENAI_API_KEY and uses --base-url
 * to route through OpenRouter. Uses anthropic/claude-haiku-4.5 for
 * cost efficiency.
 */
export function createSiftrankFn(): SiftrankFn {
  return async (manifests: CapabilityManifest[], query: string): Promise<SiftrankResult[]> => {
    if (manifests.length === 0) return [];

    const tmpFile = join(tmpdir(), `siftrank-${randomUUID()}.json`);

    try {
      // Write manifests to temp file
      await writeFile(tmpFile, JSON.stringify(manifests), 'utf-8');

      const args = [
        '--file', tmpFile,
        '--json',
        '--prompt', query,
        '--model', process.env.STARLOG_RANK_MODEL || 'anthropic/claude-haiku-4.5',
        '--base-url', 'https://openrouter.ai/api/v1',
        '--batch-size', '10',
        '--template', '{{ .name }}: {{ .solves }} | Best for: {{ range .best_for }}{{ . }}, {{ end }}',
      ];

      const env = {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENROUTER_API_KEY,
      };

      const { stdout } = await execFileAsync(getSiftrankPath(), args, {
        env,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      const parsed: SiftrankResult[] = JSON.parse(stdout);
      // Order by siftrank's authoritative `rank` (1 = best). siftrank's own
      // `score` is "lower = better" (mean position), the opposite of this
      // pipeline's convention, so it must NOT be used for ordering downstream.
      return rekeyByObjectId(parsed).sort((a, b) => a.rank - b.rank);
    } finally {
      // Clean up temp file
      await unlink(tmpFile).catch(() => {});
    }
  };
}

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
 * Keyword fallback ranker -- used when the siftrank binary / OPENROUTER_API_KEY
 * is unavailable. Exported for direct unit testing.
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
  const N = manifests.length;
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

// Emit the fallback notice at most once per process. stderr only -- stdout
// carries the CLI's search output and the MCP stdio protocol.
let warnedFallback = false;

function warnFallback(message: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  console.error(message);
}

/**
 * The ranker the CLI and MCP server both use. Retrieve-then-rerank:
 *
 *   1. The validated keyword ranker RETRIEVES the relevant set -- it applies the
 *      relevance floor + on-topic filter, so it decides *which* manifests are
 *      relevant and returns nothing for out-of-corpus queries.
 *   2. siftrank, when configured (binary + key), only REORDERS that set. It
 *      never widens it, so the off-topic tail can't appear and the out-of-domain
 *      protection carries into semantic mode for free.
 *
 * If siftrank is absent (the default) or errors, the keyword order stands. This
 * keeps semantic ranking strictly additive: it can refine the order but never
 * makes results worse than the keyword baseline. (Semantic reranking quality is
 * not yet independently validated -- treated as experimental.)
 */
export function createResilientSiftrankFn(): SiftrankFn {
  const real = createSiftrankFn();
  return async (manifests, query) => {
    const eligible = await keywordSiftrank(manifests, query);
    if (eligible.length === 0) return []; // out-of-corpus: nothing to rank

    const eligibleIds = new Set(eligible.map((r) => r.key));
    const subset = manifests.filter((m) => eligibleIds.has(m.id));

    try {
      const ranked = await real(subset, query);
      const ordered = ranked.filter((r) => eligibleIds.has(r.key));
      if (ordered.length === 0) {
        warnFallback('[starlog] siftrank returned no usable ranking; using keyword order. Run `starlog doctor`.');
        return eligible;
      }
      // Present siftrank's order with the keyword relevance magnitudes assigned
      // highest-first, so the score column stays monotonic instead of exposing
      // siftrank's inverted internal score.
      const scoresDesc = eligible.map((r) => r.score).sort((a, b) => b - a);
      const fallbackScore = scoresDesc[scoresDesc.length - 1] ?? 0;
      return ordered.map((r, i) => ({ ...r, score: scoresDesc[i] ?? fallbackScore, rank: i + 1 }));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (/ENOENT/.test(raw)) {
        // No siftrank binary -- the ordinary default. Keyword ranking is the
        // first-class mode; point to `doctor` for the (experimental) upgrade.
        warnFallback(
          '[starlog] Using keyword ranking (offline default). ' +
          'For experimental semantic ranking, run: starlog doctor',
        );
      } else {
        // Binary present but errored. Don't leak the command/temp path -- just
        // the exit code and a pointer to `doctor`.
        const e = err as { code?: number | string };
        const exit = typeof e.code === 'number' ? ` (exit ${e.code})` : '';
        warnFallback(
          `[starlog] siftrank failed${exit}; using keyword ranking instead. ` +
          'Run `starlog doctor` to check your ranking setup.',
        );
      }
      return eligible;
    }
  };
}

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
