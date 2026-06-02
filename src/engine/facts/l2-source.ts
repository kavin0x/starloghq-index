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
 * Merge a private overlay source over a base source (private wins). The org's
 * own L2 rulings (internal advisories, license calls) shadow the public ones.
 * Entry validation/skip lives in the loader that builds the private map.
 */
export function overlaySource(base: L2Source, priv: L2Source | null): L2Source {
  if (!priv) return base;
  return {
    lookup(pkg, ecosystem) {
      return priv.lookup(pkg, ecosystem) ?? base.lookup(pkg, ecosystem);
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
