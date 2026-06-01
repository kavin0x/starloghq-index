import type { CapabilityManifest, Category } from '../manifest/schema.js';

export interface SearchOptions {
  category?: Category;
  stack?: string;          // e.g., "next.js", "python"
  topK?: number;           // default 5
  projectContext?: string; // for vs_custom generation
  diversityLambda?: number; // 0-1, default undefined (no MMR). 0=max diversity, 1=pure relevance. Per D-07.
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
