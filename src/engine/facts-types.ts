import { z } from 'zod/v4';

/**
 * Schema for `starlog_facts` records — authoritative, non-recallable package
 * facts (CVEs/incidents, SPDX license + risk, maintenance status, effect
 * surface) that change an agent's install/avoid/pick decision.
 *
 * Ported from the validated facts experiment in the starlogdev R&D repo
 * (design: docs/plans/2026-06-01-agent-facts-decision-proof-design.md there).
 * Accuracy is the #1 risk, so every record carries a `source` and a `verified`
 * gate — only `verified: true` records are served.
 */

export const VulnSchema = z.object({
  id: z.string(), // CVE / GHSA id, or "INCIDENT:<slug>" when no formal CVE
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  affected: z.string(), // affected version range, human-readable
  summary: z.string(),
});
export type Vuln = z.infer<typeof VulnSchema>;

export const FactRecordSchema = z.object({
  package: z.string(), // npm (or ecosystem) package name
  ecosystem: z.enum(['npm', 'pypi', 'system']).default('npm'),
  effect_surface: z.string(), // what the code can DO (the non-recallable bit)
  known_vulns: z.array(VulnSchema),
  license: z.string(), // SPDX-ish
  license_risk: z.enum(['none', 'copyleft-weak', 'copyleft-strong', 'unknown']),
  maintenance: z.enum(['active', 'maintenance-only', 'deprecated', 'abandoned', 'compromised']),
  transitive_risk: z.string().nullable(),
  // Provenance — every fact carries a source and is gated on `verified` before
  // it may be served (public corpus or org-private overlay).
  source: z.string(),
  verified: z.boolean(),
  // Recency — the date (YYYY-MM-DD) this record was last confirmed accurate.
  // Required: a static facts corpus goes WRONG when stale (a "clean" record
  // becomes false the day a CVE drops), so every served fact must declare when
  // it was last verified. Surfaced as an "as of <date>" line in the output, and
  // enforced on org-private records too (a record missing/malforming this is
  // skipped by the overlay loader).
  //
  // z.iso.date() validates the YYYY-MM-DD shape AND calendar validity — a
  // shape-only regex would let an impossible date (e.g. 2026-13-99) through and
  // serve a garbage "as of" line, defeating the freshness gate.
  last_verified: z.iso.date({ error: 'last_verified must be a valid ISO date (YYYY-MM-DD)' }),
});
export type FactRecord = z.infer<typeof FactRecordSchema>;
