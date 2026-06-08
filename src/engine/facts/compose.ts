import type { Ecosystem, L1CapabilityFact, L2Overlay, FactView } from '@starloghq/facts-schema';
import type { L2Source } from './l2-source.js';
import { evaluatePolicy, type L3Policy } from '@starloghq/facts-schema';

export type { FactView } from '@starloghq/facts-schema'; // re-export for app consumers

/**
 * Composition — the ONLY place the three layers meet, and they meet at query
 * time, by reference, not by merge. L1, L2, and L3 are sourced independently;
 * composeFact joins them into a read-only view for serving. Nothing here writes
 * back into a layer, so the layers stay independent (the no-collapse invariant).
 *
 *   L1 (immutable capability)  ─┐
 *   L2 (mutable overlay)       ─┼─►  composeFact()  ─►  FactView { l1, l2, l3 }
 *   L3 (org policy)            ─┘
 */

export interface ComposeDeps {
  /** Resolve a package name to its L1 capability fact (independent L1 lookup). */
  l1Lookup: (pkg: string) => L1CapabilityFact | null;
  /** The L2 source (hand-authored today, OSV-backed later). */
  l2Source: L2Source;
  /** Optional org policy; absent → every verdict is 'none'. */
  policy?: L3Policy | null;
}

/**
 * Compose the three layers for one package. Returns a view when L1 or L2 has
 * something, OR when the org has a STANDING package-targeted verdict on the name
 * (a policy-only ban) — so a `facts policy <pkg> deny` reaches the agent instead
 * of silently no-opping (#21). Returns null only when there are no facts AND no
 * standing verdict — a genuine "no facts on file". This still honors the
 * no-collapse invariant: layers are joined by reference, never merged, and policy
 * never invents L1/L2 facts (the returned l1/l2 stay null in the policy-only case).
 */
export function composeFact(pkg: string, deps: ComposeDeps): FactView | null {
  const l1 = deps.l1Lookup(pkg);
  const l2 = deps.l2Source.lookup(pkg, l1?.ecosystem);
  const l3 = evaluatePolicy(deps.policy, { l1, l2 });
  if (l1 || l2) {
    const ecosystem: Ecosystem = l1?.ecosystem ?? l2?.ecosystem ?? 'npm';
    return { package: l1?.package ?? l2?.package ?? pkg, ecosystem, l1, l2, l3 };
  }

  // No L1/L2 facts. evaluatePolicy() above returned 'none' because rule matching
  // derives the package name from l1/l2 — both null here, so a package-keyed rule
  // can't fire. But a standing verdict that targets this name BY PACKAGE ALONE is
  // a deliberate org ruling (a ban with no accompanying record) and must still
  // surface. Rules keyed on l2 fields (license_risk, maintenance, vulns) need an
  // overlay to judge, so only a package-only rule can fire on a no-facts package.
  const standing = deps.policy?.rules.find(
    (r) => r.match.package === pkg && Object.keys(r.match).length === 1,
  );
  if (standing) {
    return {
      package: pkg,
      ecosystem: 'npm', // no L1/L2 to source an ecosystem from; default like above
      l1: null,
      l2: null,
      l3: { decision: standing.decision, rule_id: standing.id, rationale: standing.rationale },
    };
  }

  return null;
}
