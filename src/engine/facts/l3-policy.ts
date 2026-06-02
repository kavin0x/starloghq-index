import { z } from 'zod/v4';
import type { L1CapabilityFact } from './l1-capability.js';
import type { L2Overlay } from './l2-overlay.js';

/**
 * L3 — Suitability / policy / governance.
 *
 * WHAT IT ANSWERS: "is this package ALLOWED here?" — an org-specific verdict,
 * evaluated against L1 capability + L2 overlay facts. "Capability never changes;
 * suitability does": L3 is mutable and org-owned, and it must NEVER be baked
 * into an L1 or L2 record — it is computed at query time from them.
 *
 * GROUNDWORK ONLY this release: the schema + a pure evaluator. No rules ship in
 * the public package (a default/empty policy yields verdict 'none'). The full
 * L3 product (identity, signing, tamper-evident CT audit log, org tenancy) is a
 * later phase; this is the seam it grows into.
 */

export const L3DecisionSchema = z.enum(['deny', 'flag', 'allow']);
export type L3Decision = z.infer<typeof L3DecisionSchema>;

export const L3RuleSchema = z.object({
  id: z.string(),
  decision: L3DecisionSchema,
  // Match against composed facts. All present fields must match (AND).
  match: z.object({
    package: z.string().optional(),
    license_risk: z.enum(['none', 'copyleft-weak', 'copyleft-strong', 'unknown']).optional(),
    maintenance: z.enum(['active', 'maintenance-only', 'deprecated', 'abandoned', 'compromised']).optional(),
    has_known_vulns: z.boolean().optional(),
    capability: z.string().optional(), // an L1 capability tag that must be present
  }),
  rationale: z.string(),
});
export type L3Rule = z.infer<typeof L3RuleSchema>;

export const L3PolicySchema = z.object({
  org: z.string(),
  rules: z.array(L3RuleSchema).default([]),
});
export type L3Policy = z.infer<typeof L3PolicySchema>;

export interface L3Verdict {
  decision: L3Decision | 'none'; // 'none' = no policy / no rule fired
  rule_id?: string;
  rationale?: string;
}

/**
 * Evaluate a policy against composed L1+L2 facts. Pure, no I/O. First matching
 * rule wins; with no policy or no match, returns { decision: 'none' }.
 */
export function evaluatePolicy(
  policy: L3Policy | null | undefined,
  facts: { l1: L1CapabilityFact | null; l2: L2Overlay | null },
): L3Verdict {
  if (!policy || policy.rules.length === 0) return { decision: 'none' };
  for (const rule of policy.rules) {
    if (ruleMatches(rule, facts)) {
      return { decision: rule.decision, rule_id: rule.id, rationale: rule.rationale };
    }
  }
  return { decision: 'none' };
}

function ruleMatches(
  rule: L3Rule,
  { l1, l2 }: { l1: L1CapabilityFact | null; l2: L2Overlay | null },
): boolean {
  const m = rule.match;
  if (m.package !== undefined && m.package !== (l1?.package ?? l2?.package)) return false;
  if (m.license_risk !== undefined && m.license_risk !== l2?.license_risk) return false;
  if (m.maintenance !== undefined && m.maintenance !== l2?.maintenance) return false;
  if (m.has_known_vulns !== undefined && m.has_known_vulns !== ((l2?.known_vulns.length ?? 0) > 0)) return false;
  if (m.capability !== undefined && !(l1?.capabilities ?? []).includes(m.capability)) return false;
  // A rule with an empty match object matches everything — disallow as a footgun.
  const hasAnyCriterion = Object.values(m).some((v) => v !== undefined);
  return hasAnyCriterion;
}
