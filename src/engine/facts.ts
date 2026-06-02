/**
 * Public facts API — the LAYERED model.
 *
 * Three independent layers, composed at query time, never collapsed:
 *   L1 (immutable capability)  ./facts/l1-capability + l1-data
 *   L2 (mutable overlay)       ./facts/l2-overlay + l2-source + l2-data
 *   L3 (org policy)            ./facts/l3-policy
 *   composition                ./facts/compose + service + format
 *
 * Private inputs are independent: STARLOG_PRIVATE_FACTS feeds private L1+L2,
 * STARLOG_POLICY feeds L3 — wired in service.buildComposeDeps().
 */

export * from './facts/l1-capability.js';
export * from './facts/l2-overlay.js';
export * from './facts/l2-source.js';
export * from './facts/l3-policy.js';
export * from './facts/compose.js';
export * from './facts/service.js';
export { formatFactView } from './facts/format.js';
export { L1_FACTS, L1_BY_PACKAGE } from './facts/l1-data.js';
export { L2_OVERLAYS_LIST, L2_BY_PACKAGE } from './facts/l2-data.js';

import { buildComposeDeps, lookupFactView } from './facts/service.js';
import type { FactView } from './facts/compose.js';

/**
 * Convenience resolver used by the CLI's per-call path and the eval harness:
 * resolve a free-text query to a composed FactView (or null), using deps derived
 * from the current environment. For the MCP server (and any hot path) build deps
 * ONCE via buildComposeDeps() and call lookupFactView() to avoid re-reading env
 * files per call.
 */
export function lookupFacts(query: string): FactView | null {
  return lookupFactView(query, buildComposeDeps());
}
