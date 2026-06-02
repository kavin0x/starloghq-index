# @starloghq/facts-schema

The **canonical L1/L2/L3 facts contract** for [Starlog](https://github.com/starloghq/index) —
the single source of truth imported by both the `starloghq` client and the
`starlog-api` worker, so the shape can't drift by construction. Zod schemas +
pure policy semantics only; zero dependencies except `zod` (so it bundles
cleanly into a Cloudflare Worker).

```ts
import {
  L1CapabilityFactSchema,  // immutable capability / effect-surface facts
  L2OverlaySchema,         // mutable reputation/vuln/license overlay (attestation.fetched_at)
  L3PolicySchema,          // org suitability/governance policy
  evaluatePolicy,          // pure policy evaluation (runs client-side)
  type FactView,           // the composed GET /facts envelope shape
} from '@starloghq/facts-schema';
```

## The three layers (never collapsed)

| Layer | Question | Mutability | Schema |
|---|---|---|---|
| **L1** | what can the code *do*? | immutable (no freshness field) | `L1CapabilityFactSchema` |
| **L2** | what is *known*? (CVE/license/maint) | mutable (`attestation.fetched_at`) | `L2OverlaySchema` |
| **L3** | is it *allowed here*? | org-owned, computed at query time | `L3PolicySchema` → `evaluatePolicy` |

Layers are sourced independently and meet only at query time (`FactView`). See
[`docs/FACTS-CONTRACT.md`](https://github.com/starloghq/index/blob/main/docs/FACTS-CONTRACT.md)
for the full contract (API envelope, produce-contract, versioning rule).

## Versioning

Breaking schema change → **major**; additive field → **minor**. Consumers pin a
version and import this package (no vendoring), so a mismatch fails their build,
not production.

Source-available under BUSL-1.1.
