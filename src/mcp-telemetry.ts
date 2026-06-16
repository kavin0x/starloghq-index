import type { FactView } from './engine/facts/compose.js';
import type { QueryResult } from './manifest/schema.js';
import { scrubText } from './telemetry.js';

/**
 * Property builders for the MCP-surface telemetry events (`mcp_facts`,
 * `mcp_search`) — the place we decide WHAT leaves the machine for an agent tool
 * call. Pure + unit-tested so the privacy rules are verifiable in isolation:
 *  - a package name is captured UNLESS it was resolved from the org's private
 *    STARLOG_PRIVATE_FACTS overlay (then redacted to `private: true`). Public and
 *    not-yet-indexed names DO flow — that long tail is the "what to index next"
 *    signal the whole feature exists for;
 *  - every free-text field (query, context) passes through {@link scrubText}.
 * The thin handlers in mcp.ts just `track(event, <builder output>)`.
 */

export function mcpFactsEventProps(
  args: { package: string; context?: string },
  view: FactView | null,
  opts: { usedApi: boolean; privatePackages: ReadonlySet<string> },
): Record<string, unknown> {
  const resolvedPkg = view?.package ?? args.package;
  const isPrivate = opts.privatePackages.has(resolvedPkg);
  const l2 = view?.l2 ?? null;
  return {
    package: isPrivate ? null : resolvedPkg,
    private: isPrivate,
    hit: view !== null,
    ecosystem: view?.ecosystem ?? null,
    source: l2?.attestation.source ?? null,
    has_vulns: (l2?.known_vulns.length ?? 0) > 0,
    license_risk: l2?.license_risk ?? null,
    maintenance: l2?.maintenance ?? null,
    policy_decision: view?.l3?.decision ?? null,
    used_api: opts.usedApi,
    context: args.context ? scrubText(args.context) : null,
  };
}

export function mcpSearchEventProps(
  args: { query: string; category?: string; stack?: string; top_k?: number; context?: string },
  results: QueryResult[],
): Record<string, unknown> {
  return {
    query: scrubText(args.query),
    category: args.category ?? null,
    stack: args.stack ?? null,
    top_k: args.top_k ?? null,
    result_count: results.length,
    top_score: results[0]?.relevance_score ?? null,
    context: args.context ? scrubText(args.context) : null,
  };
}
