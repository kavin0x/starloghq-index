/**
 * Transport-agnostic facts engine for `starlog_facts`.
 *
 * Returns a `FactRecord | null` (NOT a serialized string — formatting is the
 * transport's job). The MCP server (src/mcp.ts) and the CLI both consume facts
 * from here. Ported from the validated facts capability in the starlogdev R&D
 * repo; the public corpus + schema live in co-located ./facts-data and
 * ./facts-types so nothing here depends on the benchmark harness.
 */

export {
  FactRecordSchema,
  VulnSchema,
  type FactRecord,
  type Vuln,
} from './facts-types.js';

export { FACT_STUBS, VERIFIED_FACTS } from './facts-data.js';

import { readFileSync } from 'node:fs';
import { VERIFIED_FACTS } from './facts-data.js';
import { FactRecordSchema, type FactRecord } from './facts-types.js';

/**
 * Fuzzy-match a query against a fact map and return the matching record, or
 * null on a miss. Lowercase + trim; match on exact OR query.includes(pkg) OR
 * pkg.includes(query).
 *
 * @param query   the package name (or a phrase containing it) to look up
 * @param factMap defaults to VERIFIED_FACTS (verified:true records only)
 */
export function lookupFacts(
  query: string,
  factMap: Record<string, FactRecord> = VERIFIED_FACTS,
): FactRecord | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  for (const [pkg, rec] of Object.entries(factMap)) {
    const p = pkg.toLowerCase();
    if (q === p || q.includes(p) || p.includes(q)) return rec;
  }
  return null;
}

/**
 * Build the fact map served by `starlog_facts`, optionally overlaying an
 * ORG-PRIVATE facts file on top of the public corpus.
 *
 * Resilience contract (two levels):
 *   - FILE-LEVEL: a missing / unreadable / invalid-JSON private file is a soft
 *     failure — warn to stderr and return the FULL public map (never throw).
 *   - ENTRY-LEVEL: an entry that fails `FactRecordSchema` OR is `verified:false`
 *     is skipped; the remaining valid+verified entries still load.
 *
 * Merge semantics: `{ ...public, ...private }` — on key (package) collision the
 * PRIVATE entry WINS. With `privatePath` falsy the function is the identity on
 * the public corpus (unset env → byte-identical public-only behavior).
 *
 * Synchronous on purpose: `createServer()` loads this once at server start and
 * must stay synchronous (it is called directly in the in-memory MCP test).
 *
 * @param privatePath absolute path to a JSON array of FactRecord objects, or
 *                    undefined to serve the public corpus only.
 */
export function loadFactMap(privatePath?: string): Record<string, FactRecord> {
  if (!privatePath) return VERIFIED_FACTS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(privatePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[starlog] private facts file unreadable (${privatePath}): ${msg}; using public facts only.`,
    );
    return VERIFIED_FACTS;
  }

  const entries = Array.isArray(parsed) ? parsed : [];
  const privateMap: Record<string, FactRecord> = {};
  for (const entry of entries) {
    const result = FactRecordSchema.safeParse(entry);
    if (!result.success || result.data.verified !== true) continue;
    privateMap[result.data.package] = result.data;
  }

  return { ...VERIFIED_FACTS, ...privateMap };
}
