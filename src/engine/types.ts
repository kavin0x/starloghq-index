import type { CapabilityManifest, Category } from '../manifest/schema.js';

export interface SearchOptions {
  category?: Category;
  stack?: string;          // e.g., "next.js", "python"
  topK?: number;           // default 5
  projectContext?: string; // for vs_custom generation
  diversityLambda?: number; // 0-1, default 0.5 (MMR ON, Phase 6-validated). 0=max diversity, 1=pure relevance (opt out). Per D-07 + Phase 0 trust-reset.
  // Manifest ids from STARLOG_PRIVATE_CORPUS to float FIRST (org-sanctioned),
  // applied as a pure pre-slice partition that does NOT change scoring (FACTS-03).
  // Only RELEVANT private matches (score >= PRIVATE_FLOAT_MIN_SCORE) are floated.
  privateIds?: Set<string>;
}

export interface SiftrankResult {
  key: string;
  value: string;
  object: Record<string, unknown>;
  score: number;
  exposure: number;
  rank: number;
}

// Injected dependency types for testability + MCP swap (QENG-05)
export type SiftrankFn = (manifests: CapabilityManifest[], query: string) => Promise<SiftrankResult[]>;
export type LlmFn = (prompt: string, system?: string) => Promise<string>;
