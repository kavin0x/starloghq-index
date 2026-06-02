import { z } from 'zod/v4';
import { EcosystemSchema } from './l1-capability.js';

/**
 * L2 — Reputation / vulnerability / license / health overlay.
 *
 * WHAT IT ANSWERS: "what is currently KNOWN about this package?" — CVEs/incidents,
 * SPDX license + risk, maintenance status.
 *
 * INVARIANT — MUTABLE: this changes over time (a CVE drops; a project is
 * deprecated). So freshness lives HERE, in `attestation.fetched_at` — and ONLY
 * here. An L1 record must never carry a freshness date; an L2 record must always
 * carry one.
 *
 * LONG-TERM: CONSUMED, not authored — pulled from OSV / deps.dev / Scorecard /
 * sigstore as signed, hash-pinned overlays (`attestation.source: 'osv'|…`, with
 * `refs` carrying advisory ids / content hashes). TODAY: a hand-authored
 * stand-in (`attestation.source: 'hand'`). See l2-source.ts for the seam that
 * will swap the hand source for the real pull WITHOUT touching this schema.
 */

export const VulnSchema = z.object({
  id: z.string(), // CVE / GHSA id, or "INCIDENT:<slug>"
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  affected: z.string(),
  summary: z.string(),
});
export type Vuln = z.infer<typeof VulnSchema>;

export const L2AttestationSchema = z.object({
  source: z.enum(['hand', 'osv', 'deps.dev', 'scorecard']), // today always 'hand'
  refs: z.array(z.string()).default([]), // FUTURE: advisory ids / hash-pinned overlay digests
  fetched_at: z.iso.date({ error: 'fetched_at must be a valid ISO date (YYYY-MM-DD)' }), // the freshness gate
});
export type L2Attestation = z.infer<typeof L2AttestationSchema>;

export const L2OverlaySchema = z.object({
  package: z.string(),
  ecosystem: EcosystemSchema.default('npm'),
  known_vulns: z.array(VulnSchema).default([]),
  license: z.string(),
  license_risk: z.enum(['none', 'copyleft-weak', 'copyleft-strong', 'unknown']),
  maintenance: z.enum(['active', 'maintenance-only', 'deprecated', 'abandoned', 'compromised']),
  transitive_risk: z.string().nullable().default(null),
  attestation: L2AttestationSchema,
});
export type L2Overlay = z.infer<typeof L2OverlaySchema>;
