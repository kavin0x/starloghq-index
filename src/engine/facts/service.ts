import { readFileSync } from 'node:fs';
import { L1CapabilityFactSchema, type L1CapabilityFact } from './l1-capability.js';
import { type L2Overlay } from './l2-overlay.js';
import { handAuthoredL2Source, overlaySource, parseOverlay, type L2Source } from './l2-source.js';
import { L3PolicySchema, type L3Policy } from './l3-policy.js';
import { composeFact, type ComposeDeps, type FactView } from './compose.js';
import { L1_BY_PACKAGE } from './l1-data.js';
import { L2_BY_PACKAGE, L2_OVERLAYS_LIST } from './l2-data.js';

/**
 * Facts service — wires the three INDEPENDENT layers together for serving.
 * Each private input loads on its own (private L1, private L2, L3 policy); the
 * layers never merge into each other, they only compose at query time.
 */

export interface ServiceDeps extends ComposeDeps {
  /** Ordered, de-duplicated package keys the name resolver scans (corpus first). */
  resolverKeys: string[];
}

// ── Name resolution (the matcher; identical semantics to the prior lookupFacts) ──
export function resolvePackage(query: string, keys: string[]): string | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  for (const key of keys) {
    const p = key.toLowerCase().trim();
    if (!p) continue; // an empty key would match every query
    if (q === p || q.includes(p) || p.includes(q)) return key;
  }
  return null;
}

// ── Private input loaders (each layer, each resilient, never throws) ──────────

/**
 * Load org-private facts from STARLOG_PRIVATE_FACTS. The file is a JSON object
 * with independent `l1` and `l2` arrays: `{ "l1": [...L1...], "l2": [...L2...] }`.
 * Each entry is schema-validated; L1 must be verified. Bad file / bad entries
 * degrade to empty maps (warn to stderr), never throw.
 */
export function loadPrivateFacts(path?: string): { l1: Record<string, L1CapabilityFact>; l2: Record<string, L2Overlay> } {
  const empty = { l1: {}, l2: {} };
  if (!path) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[starlog] private facts file unreadable (${path}): ${msg}; using public facts only.`);
    return empty;
  }
  const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? (parsed as Record<string, unknown>) : {};
  const l1: Record<string, L1CapabilityFact> = {};
  for (const entry of Array.isArray(obj.l1) ? obj.l1 : []) {
    const r = L1CapabilityFactSchema.safeParse(entry);
    if (r.success && r.data.provenance.verified) l1[r.data.package] = r.data;
  }
  const l2: Record<string, L2Overlay> = {};
  for (const entry of Array.isArray(obj.l2) ? obj.l2 : []) {
    const o = parseOverlay(entry);
    if (o) l2[o.package] = o;
  }
  return { l1, l2 };
}

/**
 * Load an L3 policy from STARLOG_POLICY (a JSON L3Policy). Bad/absent → null
 * (no policy → every verdict is 'none'). Never throws.
 */
export function loadPolicy(path?: string): L3Policy | null {
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[starlog] policy file unreadable (${path}): ${msg}; no org policy applied.`);
    return null;
  }
  const r = L3PolicySchema.safeParse(parsed);
  if (!r.success) {
    console.error(`[starlog] policy file invalid (${path}); no org policy applied.`);
    return null;
  }
  return r.data;
}

function uniqueOrder(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) for (const k of list) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

/**
 * Build serve-time deps from env. Public L1 + public L2 (hand source), overlaid
 * with private L1/L2 (private wins per layer, independently), plus an optional
 * L3 policy. Reads files ONCE — call this at server start (or once per CLI run).
 */
export function buildComposeDeps(env: NodeJS.ProcessEnv = process.env): ServiceDeps {
  const priv = loadPrivateFacts(env.STARLOG_PRIVATE_FACTS);
  const mergedL1: Record<string, L1CapabilityFact> = { ...L1_BY_PACKAGE, ...priv.l1 };
  const l2Base: L2Source = handAuthoredL2Source(L2_BY_PACKAGE);
  const l2Priv: L2Source | null = Object.keys(priv.l2).length ? handAuthoredL2Source(priv.l2) : null;
  const l2Source = overlaySource(l2Base, l2Priv);
  const policy = loadPolicy(env.STARLOG_POLICY);
  // Corpus (L1) order first — preserves first-match-wins precedence the eval
  // baseline encodes — then any L2-only / private-only keys.
  const resolverKeys = uniqueOrder(Object.keys(mergedL1), L2_OVERLAYS_LIST.map((o) => o.package), Object.keys(priv.l2));
  return { l1Lookup: (p) => mergedL1[p] ?? null, l2Source, policy, resolverKeys };
}

/** Resolve a free-text query to a composed FactView, or null on a miss. */
export function lookupFactView(query: string, deps: ServiceDeps): FactView | null {
  const pkg = resolvePackage(query, deps.resolverKeys);
  if (!pkg) return null;
  return composeFact(pkg, deps);
}
