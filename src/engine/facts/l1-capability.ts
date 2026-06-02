import { z } from 'zod/v4';

/**
 * L1 — Deterministic capability / effect-surface facts.
 *
 * WHAT IT ANSWERS: "what can this package's code DO?" (network, filesystem,
 * process exec, auth-path involvement, …) — derived from the artifact itself.
 *
 * INVARIANT — IMMUTABLE: the capability of a fixed set of bytes does not change
 * over time, so an L1 record carries NO freshness date. (Freshness is an L2
 * concern; mixing them is the layer-collapse we are deliberately avoiding.)
 *
 * LONG-TERM: content-addressed — keyed on `artifact_sha256`, with names/versions
 * as resolvers — and `provenance.derived_by === 'analyzer'` (a deterministic
 * byte→effect-surface pass). TODAY: hand-authored stubs (`derived_by: 'hand'`,
 * `artifact_sha256: null`). The schema is the same; only the provenance differs,
 * so the analyzer can backfill without a format change.
 */

export const EcosystemSchema = z.enum(['npm', 'pypi', 'system']);
export type Ecosystem = z.infer<typeof EcosystemSchema>;

export const L1ProvenanceSchema = z.object({
  derived_by: z.enum(['hand', 'analyzer']), // 'analyzer' = future deterministic L1 pass
  source: z.string(), // how we know the effect surface (observation / analyzer run id)
  verified: z.boolean(), // gate — only verified facts are served
});
export type L1Provenance = z.infer<typeof L1ProvenanceSchema>;

export const L1CapabilityFactSchema = z.object({
  package: z.string(), // resolver (name); long-term resolves to a digest
  ecosystem: EcosystemSchema.default('npm'),
  version_range: z.string().nullable().default(null), // which versions this fact applies to
  artifact_sha256: z.string().nullable().default(null), // FUTURE content-addressing key
  effect_surface: z.string(), // prose: what the code can do
  capabilities: z.array(z.string()).default([]), // structured tags (future: 'network','fs','exec',…)
  provenance: L1ProvenanceSchema,
  // NOTE: intentionally NO last_verified/fetched_at here. L1 is immutable.
});
export type L1CapabilityFact = z.infer<typeof L1CapabilityFactSchema>;
