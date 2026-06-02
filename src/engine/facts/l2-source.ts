import { L2OverlaySchema, type L2Overlay } from '@starloghq/facts-schema';
import type { Ecosystem } from '@starloghq/facts-schema';

/**
 * L2 source seam — the "consume, don't build" boundary.
 *
 * The whole point of L2 is that the data comes from upstream attestors (OSV,
 * deps.dev, Scorecard, sigstore) — NOT from us. This interface is where that
 * swap happens. Today we ship ONE implementation: a hand-authored stand-in
 * served from the bundled corpus. Tomorrow an `OsvL2Source` (sketched below,
 * deliberately NOT implemented — there is no generator/index yet) fetches and
 * hash-pins the real overlays. Consumers (compose.ts) depend on this interface,
 * never on a concrete source, so the swap touches nothing downstream.
 */
export interface L2Source {
  /** Return the overlay for a package, or null if this source has none. */
  lookup(pkg: string, ecosystem?: Ecosystem): L2Overlay | null;
}

/** Build a hand-authored L2 source from an in-memory map (the bundled stand-in). */
export function handAuthoredL2Source(overlays: Record<string, L2Overlay>): L2Source {
  return {
    lookup(pkg) {
      return overlays[pkg] ?? null;
    },
  };
}

/**
 * Merge a private overlay over a base overlay for the SAME package.
 *
 * Org rulings win on the scalar fields (license/maintenance calls are the org's
 * to make), but `known_vulns` is UNIONED by id with the BASE winning on a
 * collision: an upstream advisory's existence and severity are immutable here —
 * a private overlay may only ADD net-new ids (e.g. `INCIDENT:<slug>`), never
 * drop or downgrade an upstream one. (Whole-record private-wins used to silently
 * suppress a real CVE.) Refining/overriding an upstream claim is a separate,
 * additive concern — the curated-claim type (VEX status + `severity_for_us` +
 * justification) — and lands with that schema, not by mutating `VulnSchema` here.
 */
function mergeOverlay(base: L2Overlay, priv: L2Overlay): L2Overlay {
  const baseIds = new Set(base.known_vulns.map((v) => v.id));
  return {
    ...priv, // org rulings win on scalar fields
    known_vulns: [
      ...base.known_vulns, // upstream existence + severity is immutable...
      ...priv.known_vulns.filter((v) => !baseIds.has(v.id)), // ...private may only add net-new ids
    ],
  };
}

/**
 * Layer a private overlay source over a base source. The org's own L2 rulings
 * (internal advisories, license calls) shadow the public ones per-field, but the
 * union semantics in {@link mergeOverlay} guarantee a private overlay can never
 * suppress an upstream vuln. Entry validation/skip lives in the loader that
 * builds the private map.
 */
export function overlaySource(base: L2Source, priv: L2Source | null): L2Source {
  if (!priv) return base;
  return {
    lookup(pkg, ecosystem) {
      const p = priv.lookup(pkg, ecosystem);
      const b = base.lookup(pkg, ecosystem);
      if (!p) return b;
      if (!b) return p;
      return mergeOverlay(b, p);
    },
  };
}

// ── FUTURE (groundwork only — NOT wired this release) ───────────────────────
// No live generator/index exists yet, so this is intentionally a stub sketch:
//
//   export function osvL2Source(opts: { cacheDir: string; ttlDays: number }): L2Source {
//     // 1. resolve pkg+version -> OSV/deps.dev query
//     // 2. fetch advisories + license + maintenance; hash-pin the response
//     // 3. validate each into L2OverlaySchema with attestation.source='osv',
//     //    refs=[<advisory ids>, <content hash>], fetched_at=<today>
//     // 4. cache to disk (TTL); degrade to last-cached / null on network failure
//     // returns an L2Source. Local-first stays intact: no network unless enabled.
//   }
//
// When built, it slots in via overlaySource(handAuthoredL2Source(...), osvL2Source(...))
// or replaces the hand source outright — no schema or compose change required.

/** Re-validate an untrusted overlay (e.g. from a private file) before serving. */
export function parseOverlay(raw: unknown): L2Overlay | null {
  const r = L2OverlaySchema.safeParse(raw);
  return r.success ? r.data : null;
}
