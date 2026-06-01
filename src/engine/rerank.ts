import type { SiftrankResult } from './types.js';
import type { CapabilityManifest } from '../manifest/schema.js';

/**
 * Compute Jaccard similarity between two manifests using metadata fields:
 * category, alternative_ids, and stack_affinity (lowercased).
 *
 * @returns A number between 0 (no overlap) and 1 (identical feature sets).
 */
export function jaccardSimilarity(a: CapabilityManifest, b: CapabilityManifest): number {
  const setA = new Set([
    a.category,
    ...a.alternative_ids,
    ...a.stack_affinity.map(s => s.toLowerCase()),
  ]);
  const setB = new Set([
    b.category,
    ...b.alternative_ids,
    ...b.stack_affinity.map(s => s.toLowerCase()),
  ]);

  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Maximal Marginal Relevance (MMR) reranker.
 *
 * Greedy selection: picks items that balance relevance (siftrank score)
 * with diversity (low Jaccard similarity to already-selected items).
 *
 * @param results - SiftrankResult array (not mutated)
 * @param manifests - Map from manifest ID to CapabilityManifest
 * @param lambda - Tradeoff parameter: 0 = max diversity, 1 = pure relevance (default 0.5)
 * @param similarityFn - Similarity function (default: jaccardSimilarity)
 * @returns New array of SiftrankResult in MMR-reranked order
 */
export function mmrRerank(
  results: SiftrankResult[],
  manifests: Map<string, CapabilityManifest>,
  lambda: number = 0.5,
  similarityFn: (a: CapabilityManifest, b: CapabilityManifest) => number = jaccardSimilarity,
): SiftrankResult[] {
  if (results.length === 0) return [];
  if (results.length === 1) return [...results];

  // Normalize scores to 0-1 range
  const scores = results.map(r => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;

  const normalizedScores = new Map<string, number>();
  for (const r of results) {
    normalizedScores.set(r.key, range === 0 ? 1 : (r.score - minScore) / range);
  }

  // Track selected and remaining candidates
  const selected: SiftrankResult[] = [];
  const remaining = new Set(results.map((_, i) => i));

  // First pick: highest raw score (no diversity penalty)
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (const idx of remaining) {
    if (results[idx].score > bestScore) {
      bestScore = results[idx].score;
      bestIdx = idx;
    }
  }
  selected.push(results[bestIdx]);
  remaining.delete(bestIdx);

  // Subsequent picks: argmax of lambda * normalizedScore - (1 - lambda) * maxSimilarityToSelected
  while (remaining.size > 0) {
    let bestMMRIdx = -1;
    let bestMMRScore = -Infinity;

    for (const idx of remaining) {
      const candidate = results[idx];
      const relevance = normalizedScores.get(candidate.key) ?? 0;

      // Compute max similarity to any already-selected item
      let maxSim = 0;
      const candidateManifest = manifests.get(candidate.key);

      if (candidateManifest) {
        for (const sel of selected) {
          const selManifest = manifests.get(sel.key);
          if (selManifest) {
            const sim = similarityFn(candidateManifest, selManifest);
            if (sim > maxSim) maxSim = sim;
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestMMRIdx = idx;
      }
    }

    selected.push(results[bestMMRIdx]);
    remaining.delete(bestMMRIdx);
  }

  return selected;
}
