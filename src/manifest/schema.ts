import { z } from 'zod/v4';

// Known categories -- original 7 target categories (SCHM-03)
export const KnownCategorySchema = z.enum([
  'authentication',
  'feature-flags',
  'caching',
  'realtime',
  'background-jobs',
  'email',
  'orm-database',
]);
export type KnownCategory = z.infer<typeof KnownCategorySchema>;

// Category -- accepts any string to support dynamic category expansion (D-04)
export const CategorySchema = z.string();
export type Category = string;

// Integration effort 5-level scale (D-03)
export const IntegrationEffortSchema = z.enum([
  'drop-in',
  'easy',
  'moderate',
  'significant',
  'major',
]);
export type IntegrationEffort = z.infer<typeof IntegrationEffortSchema>;

// Hosted alternative (structured object per PRD Section 5)
export const HostedAlternativeSchema = z.object({
  name: z.string(),
  manifest_id: z.string(),
  pricing_summary: z.string(),
});
export type HostedAlternative = z.infer<typeof HostedAlternativeSchema>;

// Health signals (from GitHub API, populated in Phase 2)
export const HealthSchema = z.object({
  stars: z.number(),
  weekly_downloads: z.number().optional(),
  last_commit: z.string(),       // ISO date string
  contributors: z.number(),
  license: z.string(),
  open_issues: z.number(),
});
export type Health = z.infer<typeof HealthSchema>;

// Quality heuristics
export const QualitySchema = z.object({
  has_tests: z.boolean(),
  has_docs: z.boolean(),
  has_types: z.boolean(),
  maintenance_status: z.enum(['active', 'maintained', 'slowing', 'archived']),
});
export type Quality = z.infer<typeof QualitySchema>;

// CapabilityManifest -- STORED fields only (SCHM-01, D-04)
export const CapabilityManifestSchema = z.object({
  // Identity
  id: z.string(),                          // e.g., "clerk", "nextauth"
  name: z.string(),                        // Human-readable: "Clerk"
  repo: z.string().nullable(),             // GitHub owner/repo (null for DIY patterns)
  ecosystem: z.enum(['npm', 'pypi', 'both']),

  // Capability
  category: CategorySchema,
  solves: z.string(),                      // 1-2 sentences (string, not array)

  // Fit
  stack_affinity: z.array(z.string()),     // Free-form strings per D-01
  integration_effort: IntegrationEffortSchema, // 5-level per D-03
  best_for: z.array(z.string()),           // 3-5 specific use cases
  skip_when: z.array(z.string()),          // 3-5 anti-patterns

  // Alternatives
  hosted_alternative: HostedAlternativeSchema.nullable(), // null if IS the hosted option or no hosted alternative exists
  alternative_ids: z.array(z.string()),    // Other manifest IDs in same category

  // Signals
  health: HealthSchema,
  quality: QualitySchema,

  // Provenance (D-07)
  auto_generated: z.boolean().optional(),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

// QueryResult -- COMPUTED fields (SCHM-02, D-04)
export const QueryResultSchema = z.object({
  manifest: CapabilityManifestSchema,
  relevance_score: z.number(),             // 0-100
  context_fit: z.string(),                 // Why this fits the project context
  vs_custom: z.string(),                   // Why use this instead of building custom
  tradeoffs: z.array(z.string()),          // Compared to other results
});
export type QueryResult = z.infer<typeof QueryResultSchema>;
