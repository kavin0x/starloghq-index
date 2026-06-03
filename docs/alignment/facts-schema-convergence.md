# Proposal: converge `@starloghq/facts-schema` to the Master Plan record shapes

> **Status:** Proposal from the **starlog-index** side — **no package code changed**.
> For ratification by the backend / index-builder owner before any schema edit.
> The Master Plan (`starlog-startup`: `index-builder.html` §4.4, §6.1; `maintenance.html`
> §1.1) makes the **index-builder the producer authority** for L1/L2 record shapes. Our
> `@starloghq/facts-schema` is the **shared contract** both sides import — so it must
> converge to those authoritative shapes, or we re-introduce the drift the package exists
> to kill. Claims here about the Master Plan are quoted from those docs; claims about the
> package are verified against `packages/facts-schema/src/index.ts`.

## Why now

Our own contract rule (`docs/FACTS-CONTRACT.md`): *"if a shape changes, it changes in the
package, once."* The Master Plan locks the authoritative L1/L2 record shapes. Where the
package and the Plan disagree, the package is the one that must move — **additively where
possible, with a coordinated major where structural.** (Per the spec-only decision, `0.1.0`
publishes as-is *without* these changes; the L1 additive subset rides the next minor after
ratification, the L2 model change a later backend-coordinated major.)

## L1 — capability facts (Master Plan `index-builder.html` §4.4 `L1FactRecord`)

Authoritative shape: `{ hash, analyzer_version, cdl_version, effect_surface{net,fs,exec,eval,env,native,dynamic_require,postinstall: bool}, api_shape[], dep_fanout[hashes], license, analysis_partial }`.

| Field | Package today (`L1CapabilityFact` / `L1Provenance`) | Delta | Risk |
|---|---|---|---|
| `hash` = `sha256(bytes)` (**primary key**) | `artifact_sha256` — `nullable`, comment "FUTURE content-addressing key" | promote to the real key; non-null in *produced* records | low (additive; producer-enforced) |
| `analyzer_version` | **absent** | add (re-derivability is "meaningful only relative to a pinned analyzer", §4.3) | **low — pure add** |
| `cdl_version` | **absent** | add (carried into the capability-diff so vocab expansion can't manufacture a flag) | **low — pure add** |
| `analysis_partial` | **absent** | add — deterministic coverage marker (analyzer couldn't fully resolve), not a guess | low — pure add |
| `effect_surface` (struct of bools) | `effect_surface: string` + generic `capabilities: string[]` | structural: string → typed bool struct | medium |
| `api_shape[]`, `dep_fanout[hashes]` | not modeled (folded into `capabilities`) | add explicit fields (dep_fanout consumed from deps.dev, pinned) | medium |

**Safe-additive subset (do first, pre-first-publish):** `analyzer_version`, `cdl_version`,
`analysis_partial`, and making `artifact_sha256` the documented primary key. These match
§4.4 exactly and break nothing. **`effect_surface` struct + `api_shape`/`dep_fanout`** are
the analyzer's authoritative output shape and should land with the analyzer build.

## L2 — attestations (Master Plan `index-builder.html` §6.1 `AttestationRecord`)

Authoritative shape: an **append-only, signature-verified SET per hash** of
`{ hash, attestor_id, predicate: 'vuln'|'health'|'provenance'|'behavioral', value, source_uri, as_of, signature }`,
served in full with **no resolution scalar** (SEAM-3 firewall-by-absence).

Package today: a **single collapsed `L2Overlay`** = `{ package, ecosystem, known_vulns[], license, license_risk, maintenance, transitive_risk, attestation{source, refs[], fetched_at} }`. This **pre-resolves** what SEAM-3 says must stay an unresolved multi-attestor set.

| Authoritative | Package today | Delta |
|---|---|---|
| multi-attestor **set** keyed by `(hash, attestor_id)` | one overlay per `(package, ecosystem)` | **model change**: overlay → set of records |
| `attestor_id` (identity) | `attestation.source` (producer enum) | split identity from source |
| `predicate` (vuln/health/provenance/behavioral) | implicit (vuln=`known_vulns`, health=`maintenance`, license=`license_risk`) | make explicit; decompose the overlay's fields into predicate-typed records |
| `value` | the per-field values | becomes the record's typed payload |
| `source_uri` | `refs[]` | keep as evidence pointers / source uri |
| `as_of` | `attestation.fetched_at` | rename/align (`fetched_at` ≈ `as_of`) |
| `signature` | **absent** | add — verify-or-drop on ingest |
| keyed by content **hash** | keyed by **name**+ecosystem | tie to hash (see name→hash below) |

This is a **major version bump** and a structural redesign. It is **backend-authoritative**
(the index-builder mints `AttestationRecord`s) and should be designed *with* the backend, not
landed unilaterally from the client side. It also operationalizes the SEAM-3 correction
already in `FACTS-CONTRACT.md` / `sy5-correction.md`: union/surface-all, no winner scalar.

## name → hash (Master Plan `maintenance.html` §1.1 surface 3)

The Plan keys L1/L2 on `sha256(bytes)` and marks **name→hash an explicitly-untrusted
convenience** (the supply-chain canon: event-stream, xz-utils). The package today keys facts
on **package name + ecosystem**. Convergence: keep name lookup as the untrusted seam, but the
trusted key is the hash, bound at install against the lockfile integrity hash. Contract-doc
item; no schema field beyond carrying `hash` as the key (covered under L1 above).

## Versioning + sequencing

1. **`facts-schema` minor (e.g. 0.2.0):** the safe-additive L1 subset (`analyzer_version`,
   `cdl_version`, `analysis_partial`; `artifact_sha256` documented as the key). Backward
   compatible; lands in the first minor after ratification (`0.1.0` ships without it).
2. **`facts-schema` major (coordinated with the index-builder build):** the L1
   `effect_surface` struct + `api_shape`/`dep_fanout`, and the **L2 overlay→`AttestationRecord`-set**
   redesign. Designed jointly with the backend; aligns the package, the served `GET /facts`
   envelope, and the producer-contract in one breaking step.

## Net

The package must become a literal mirror of `index-builder.html` §4.4 + §6.1, because both the
client and the index-builder import it. The L1 pins are a cheap additive first step; the L2 set-model
is the real work and is the backend's to co-author. **Until ratified, change no package code.**
