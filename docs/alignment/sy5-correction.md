# Correction to carry into starlogdev sy5 (facts API backend)

> **Status:** Final from the **starlog-index** side — pending review by the sy5 owner
> (whoever wrote `starlogdev/.planning/quick/260601-sy5-…` / the `ADDENDUM-l1l2l3`).
> These are recommendations, not changes applied to starlogdev: the index side
> cannot see the sy5 repo, so every claim below about the *sy5 plan* (D-A, the §1
> envelope, the drift-guard) is stated as the index author understood it and must
> be validated against the actual plan before folding in. The claims about the
> *index side* — the package, its exports, the client seams — are verified against
> shipped code (`@starloghq/facts-schema` + `src/engine/facts/`).

The sy5 ADDENDUM already re-anchored the design to the layered model. This closes
the gap where the **executable steps** still point at the old flat schema, and
locks three open details. The contract is now a real package: **`@starloghq/facts-schema`**
(in starlog-index `packages/facts-schema`) — the L1/L2/L3 schemas + `evaluatePolicy`
+ the `FactView` type, zod-only, bundles into a Worker. (Note: `composeFact` — the
composition function — stays client-side in starlog-index; the package supplies the
schemas, `evaluatePolicy`, and the `FactView` type, not the composer.)

## 1. Schema sharing: IMPORT the package, don't vendor the flat schema (supersedes D-A + Phase 0 drift-guard)

- **D-A as written** vendors `FactRecordSchema` from `src/benchmark/facts/types.ts` — the **old flat** schema (now retired in starlog-index). **Do not vendor it.**
- **Instead:** `workers/starlog-api` adds `@starloghq/facts-schema` as a dependency and imports `L1CapabilityFactSchema`, `L2OverlaySchema`, `L3PolicySchema`, `evaluatePolicy`, `FactView` from it. zod comes with it (the package is zod-only — this removes the "zod bloats the Workers bundle" objection that motivated vendoring).
- **Phase 0's drift-guard test is no longer needed** (there's nothing to drift from — one artifact). Replace it with a `package.json` version pin + a build that fails on a missing/mismatched `@starloghq/facts-schema`.
- **RESEARCH source list:** replace `src/benchmark/facts/types.ts` (FactRecordSchema) and `src/engine/facts.ts` (loadFactMap/lookupFacts, the old collapsed API) with `@starloghq/facts-schema` and starlog-index `src/engine/facts/` (layered).

## 2. Lock the read envelope (supersedes the `{package, fact, tier, found}` shape in §1)

`GET /facts` returns the three independent inputs, NOT a collapsed record or a precomputed verdict:

```jsonc
{ "l1": L1CapabilityFact|null, "l2": L2Overlay|null, "l3": L3Policy|null, "found": boolean }
```

- `l2` = public ⊕ org-private (server resolves private-wins, per D-D).
- `l3` = the org **policy**, not a verdict — the **client runs `evaluatePolicy`** (composition + L3 stay client-side; matches the no-collapse invariant). Server-side verdict + CT audit log is a later governance phase, explicitly not P3.5.
- Client reads it with `parseFactsApiResponse` (reads `.l1/.l2/.l3`, defensive), falls back to local public on any error.

## 3. Layer the write path (supersedes a single `POST /facts FactRecord`)

- `POST /facts/l2` → org-private **L2 overlay** (`L2OverlaySchema`, `attestation.fetched_at` required), scoped `(org_id, package)`.
- `POST /facts/policy` → org **L3 policy** (`L3PolicySchema`).
- L1 writes are **admin/analyzer-only** (capability facts aren't org-authored).
- `starlog facts push` covers L2 (+ optionally policy). D1 schema: keep the `(org_id, …)` isolation spine; split the `facts` table into `org_l2_overlays(org_id,package,…)` and `org_l3_policies(org_id, rules…)`.

## 4. Produce-contract for the "core" (analyzer + ingester)

When built, both must EMIT the package schemas:
- **L1 analyzer** → `L1CapabilityFactSchema`, `provenance.derived_by:'analyzer'`, populated `artifact_sha256`.
- **L2 OSV/deps.dev ingester** → `L2OverlaySchema`, `attestation.source:'osv'|'deps.dev'|'scorecard'`, `refs`, `fetched_at`.

## Net

Phase spine unchanged. The only deltas: import the package (not vendor), serve `{l1,l2,l3,found}`, split writes by layer, keep `evaluatePolicy` client-side. Everything else in sy5 (KV public / D1 private, org identity, `org_id`-from-key isolation, rate limiting) stands.
