# Starlog Facts Contract (L1/L2/L3)

> **Canonical source of truth:** the `@starloghq/facts-schema` package
> (`packages/facts-schema/src/index.ts`). Every other repo — the `starlog-api`
> worker, the future L1 analyzer, the OSV/deps.dev L2 ingester — **imports this
> package**; it is never re-typed, vendored, or hand-synced. If a shape changes,
> it changes here, once, and bumps this package's version.

This document is the explainer. The package is the enforcer.

## The model — three independent layers, composed at query time

| Layer | Question | Mutability | Producer | Schema |
|---|---|---|---|---|
| **L1 capability** | what can the code *do*? | **immutable** (no freshness field) | the deterministic analyzer (future); hand-stubs today | `L1CapabilityFactSchema` |
| **L2 overlay** | what is *known*? (CVE/license/maint) | **mutable** (`attestation.fetched_at`) | OSV/deps.dev/Scorecard ingester (future); hand-stubs today | `L2OverlaySchema` |
| **L3 policy** | is it *allowed here*? | mutable, org-owned | the org (CLI/API) | `L3PolicySchema` → `L3Verdict` |

**No-collapse invariant:** layers never merge into each other's records. They meet
only in `composeFact()` → `FactView`, by reference.

## Where it runs (the boundary)

- **Composition + L3 evaluation run CLIENT-SIDE.** `composeFact` + `evaluatePolicy`
  (both from the package) run in the MCP client. The server/worker provides the
  three independent *inputs*; it does **not** pre-collapse them or evaluate policy.
  (Server-side verdict + a CT audit log is a later governance phase, not now.)
- **L1 is read-only to clients/orgs.** Capability facts are author-controlled
  (analyzer/admin). Orgs supply L2 overlays and L3 policy, never L1.

## The API envelope (what the worker serves)

`GET /facts?package=&ecosystem=` → the three inputs for the caller's org:

```jsonc
{
  "l1": L1CapabilityFact | null,   // public capability fact
  "l2": L2Overlay | null,          // public ⊕ org-private overlay (private wins, resolved server-side)
  "l3": L3Policy | null,           // the org's policy (client runs evaluatePolicy) — NOT a precomputed verdict
  "found": boolean
}
```

- No key → `l1` + public `l2` + `l3: null`.
- Org key → adds the org's private `l2` overlay (server resolves private-wins) and the org `l3` policy.
- The client reads this with a defensive `parseFactsApiResponse` that reads
  `.l1 / .l2 / .l3` and never assumes a bare record. On any non-OK/network error
  it falls back to the **local** public corpus (offline-first).

Writes (org-scoped, `org_id` from the validated key, never the body):
- `POST /facts/l2` — upsert an org-private **L2 overlay** (`L2OverlaySchema`; `attestation.fetched_at` required).
- `POST /facts/policy` — set the org **L3 policy** (`L3PolicySchema`).
- L1 writes are **admin/analyzer-only** (not org-facing).

## The produce-contract (analyzer + ingester — the "core" half)

Producers must EMIT the schemas, or the client can't read them:

- **L1 analyzer** emits `L1CapabilityFactSchema` with `provenance.derived_by: 'analyzer'`
  and a populated `artifact_sha256` (content-addressed). No freshness field.
- **L2 ingester** emits `L2OverlaySchema` with `attestation.source: 'osv' | 'deps.dev' | 'scorecard'`,
  `refs: [<advisory ids / content hashes>]`, and `fetched_at: <ISO date>`.

## Client seams (what starlog-index already exposes for the backend to plug into)

| Backend input | Client seam (exists today) | Status |
|---|---|---|
| public L1 | `composeFact` `l1Lookup` dep | local stand-in shipped |
| public L2 | base `L2Source` (`l2-source.ts`) | local stand-in shipped |
| org-private L2 | `overlaySource(base, priv)` + the API-first `resolveFactView` | **built** — `FactsApiClient.getFacts` (`api-client.ts`); API L2 wins, local is the offline fallback |
| org L3 policy | `ComposeDeps.policy` (from API envelope `.l3`) | **built** — `resolveFactView` runs `evaluatePolicy` on the API-supplied policy |

**Client consumption — BUILT** (`src/engine/facts/api-client.ts` + `service.resolveFactView`):
- `createFactsApiClient()` — Bearer `STARLOG_API_KEY`, base `STARLOG_API_URL` (default `api.starlog.dev`), 10s abort; `null` when no key (→ local-only).
- `getFacts(pkg)` → `GET /facts`, read with `parseFactsApiResponse` (defensive `.l1/.l2/.l3`); `null` on any non-OK/network error.
- `resolveFactView(pkg, { local, api })` — **API-first, per-layer API-wins, full local fallback**; `evaluatePolicy` runs client-side. Used by the MCP tool + `starlog facts lookup`.
- `starlog facts push [file]` — `pushL2` (`POST /facts/l2`, batch `{overlays}`) + `pushPolicy` (`POST /facts/policy`); file shape `{ l2: L2Overlay[], policy?: L3Policy }`.

**Still backend-side (not the client's to build):** the `GET/POST /facts*` endpoints, org identity + `org_id`-from-key isolation, KV/D1 storage — see `docs/alignment/sy5-correction-DRAFT.md`.

## Versioning rule

`@starloghq/facts-schema` is the contract. A breaking schema change bumps its
**major**; additive fields bump **minor**. The worker pins a version; its CI
imports the package (no vendored copy), so a mismatch fails the worker build —
not production.
