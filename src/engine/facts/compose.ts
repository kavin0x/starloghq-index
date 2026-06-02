import type { Ecosystem, L1CapabilityFact } from './l1-capability.js';
import type { L2Overlay } from './l2-overlay.js';
import type { L2Source } from './l2-source.js';
import { evaluatePolicy, type L3Policy, type L3Verdict } from './l3-policy.js';

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

export interface FactView {
  package: string;
  ecosystem: Ecosystem;
  l1: L1CapabilityFact | null; // capability facts (or null if none on file)
  l2: L2Overlay | null; // reputation/vuln overlay (or null)
  l3: L3Verdict; // org suitability verdict ({ decision: 'none' } by default)
}

export interface ComposeDeps {
  /** Resolve a package name to its L1 capability fact (independent L1 lookup). */
  l1Lookup: (pkg: string) => L1CapabilityFact | null;
  /** The L2 source (hand-authored today, OSV-backed later). */
  l2Source: L2Source;
  /** Optional org policy; absent → every verdict is 'none'. */
  policy?: L3Policy | null;
}

/**
 * Compose the three layers for one package. Returns null only when NEITHER L1
 * nor L2 has anything — i.e. a genuine "no facts on file". An L3 verdict is
 * always computed (default 'none'); policy never invents facts, it only judges
 * the ones L1/L2 provide.
 */
export function composeFact(pkg: string, deps: ComposeDeps): FactView | null {
  const l1 = deps.l1Lookup(pkg);
  const l2 = deps.l2Source.lookup(pkg, l1?.ecosystem);
  if (!l1 && !l2) return null;
  const ecosystem: Ecosystem = l1?.ecosystem ?? l2?.ecosystem ?? 'npm';
  const l3 = evaluatePolicy(deps.policy, { l1, l2 });
  return { package: l1?.package ?? l2?.package ?? pkg, ecosystem, l1, l2, l3 };
}
