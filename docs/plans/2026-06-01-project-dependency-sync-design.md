# Design: Project Dependency Sync

**Status:** Design spec — not yet implemented. Captured for later revisit.
**Date:** 2026-06-01
**Author:** brainstormed with Claude

## Problem

Today Starlog only learns about libraries via the `PostToolUse` install hook,
which fires on *new* `npm install` / `pnpm add` / `yarn add` / `pip install`
commands and merely **queues** unknown names to `.starlog/pending.json`. It never
looks at the dependencies a project **already has**, and the bundled corpus
(`corpus-free/`) is static — nothing new ever reaches the local index.

We want Starlog to learn from the libraries a project already uses, pull their
capability manifests into the local index, and contribute unknown packages back
to the online index — **opt-in and anonymous**, without breaking the
"local-first, no account, no network call required" positioning.

## Key decisions (locked)

1. **Network posture: opt-in, anonymous (no account).** Scan + sync are OFF by
   default. When enabled, only direct dependency **names + ecosystem** leave the
   machine — no versions, source, account, or key.
2. **Local storage: both** a global manifest cache (`~/.starlog/cache/manifests/`)
   merged into the query index, **and** a per-project record (`.starlog/project.json`)
   of which deps the project uses.
3. **Trigger: auto-scan on `starlog init --sync` + a standalone `starlog scan`**
   command to re-run. Plain `starlog init` stays no-network.
4. **Sync API: single anonymous batch `POST /sync`** — client sends the name
   list, server returns known manifests and records unknowns for generation
   (pull + push in one round-trip). This repo is the *client*; the `/sync`
   backend on `api.starlog.dev` is a separate dependency to be built.

## Non-goals (YAGNI)

- Transitive / lockfile dependencies — **direct declared deps only**.
- Enhancing the install-time hook to fetch-on-install — stays as-is for now
  (only the misleading message is corrected; see Cleanup).
- Private manifests, accounts, API keys for this path.
- The `/sync` backend implementation (separate repo). We define the contract.
- An MCP `starlog_scan` tool — clean future add, not now.

## Architecture & data flow

New modules under `src/`:

- `config.ts` — read/write `~/.starlog/config.json`, e.g.
  `{ "sync": { "enabled": true, "endpoint": "https://api.starlog.dev/sync" } }`.
  Single source for the opt-in flag + endpoint override.
- `deps.ts` — parsers returning `{ ecosystem, names[] }`:
  - npm: `package.json` `dependencies` + `devDependencies`
  - pypi: `requirements.txt` + `pyproject.toml` `[project.dependencies]`
  - No lockfiles (direct deps only).
- `sync-client.ts` — `postSync(ecosystem, names)`: one `POST /sync`, 10s
  `AbortController` timeout, validates each returned manifest against
  `CapabilityManifestSchema` (reuse the `parseApiResults` pattern from
  `search-service.ts`), returns `{ manifests, unknown }`. Never throws to the
  caller — degrades.
- `scan.ts` — `runScan({ cwd, sync })`: find project root, parse deps,
  orchestrate sync, write cache + project record, print a summary.

Data flow for `starlog scan` (sync enabled, online):

1. `deps.ts` → `{ ecosystem, names[] }` from the project's dep files.
2. `sync-client.postSync` → `{ manifests[], unknown[] }`.
3. Write each manifest to the global cache `~/.starlog/cache/manifests/<id>.json`.
4. Write the project record `.starlog/project.json`.
5. Print: "N deps · M manifests cached · K queued for generation."

Degraded paths:
- Sync disabled → steps 2-3 skipped; only the project record (deps + all-unknown)
  is written; zero network.
- Sync enabled but API unreachable → `postSync` returns empty; scan still writes
  the record and notes "offline — N queued locally." Mirrors the existing
  local-fallback resilience.

Query integration: `engine/corpus.ts loadCorpus()` gains a second source — it
loads bundled `corpus-free/` **and** `~/.starlog/cache/manifests/`, with cache
entries overriding bundled ones on `id` collision. Per-file validation already
skips corrupt files (M8), so a bad cache entry can't break loading.

## Storage formats

Global cache — `~/.starlog/cache/manifests/<id>.json`: one file per manifest,
byte-identical to a `corpus-free/` manifest (same `CapabilityManifestSchema`).
Atomic writes via the existing `atomicWrite`.

Project record — `.starlog/project.json` (joins the existing `.starlog/pending.json`):

```json
{
  "ecosystem": "npm",
  "scanned_at": "2026-06-01T20:00:00Z",
  "dependencies": ["express", "zod", "drizzle-orm"],
  "manifests_found": ["express", "zod"],
  "unknown": ["drizzle-orm"]
}
```

Enables project-aware queries later ("you already use X"). We'll suggest
`.gitignore`-ing `.starlog/`, but committing is the user's call.

## API contract

`POST {endpoint}` (default `https://api.starlog.dev/sync`), **no auth**:

```json
// request
{ "ecosystem": "npm", "packages": ["express", "zod", "drizzle-orm"] }
// response
{ "manifests": [ { /* full CapabilityManifest */ } ],
  "unknown":  ["drizzle-orm"] }
```

The server returns manifests it has and records `unknown` names for generation
(the push half). The client trusts nothing: every `manifests[]` entry is
schema-validated; invalid ones are dropped with a stderr note, not cached.

Privacy envelope: request body carries only ecosystem + direct dependency names.
No versions, paths, source, account, or key. `User-Agent: starlog/<version>`
header, nothing identifying.

Failure modes: non-2xx, timeout, or network error → treat as "no manifests, all
unknown," write the record, exit 0 with a note. Never crash a scan on bad network.

## CLI / UX & opt-in

`starlog scan [path]` — scans `cwd` (or `path`). Respects `~/.starlog/config.json`;
flags override: `--sync` / `--no-sync` for this run, `--json` for machine output.

```
$ starlog scan
Scanned 12 dependencies (npm).
  9 manifests cached   3 queued for generation (express-rate-limit, ...)
Run `starlog search` — your installed libraries are now in the index.
```

Opt-in is explicit and persisted by `init`:

- `starlog init` — today's behavior, **no network, no scan**. Unchanged.
- `starlog init --sync` — writes `config.sync.enabled=true`, then runs an initial
  scan. The preview/confirm flow lists the scan as a planned action, and
  `--dry-run` shows exactly which dep names *would* be sent without sending them.
  This is the consent moment.
- Once enabled, plain `starlog scan` syncs automatically; `--no-sync` forces a
  local-only scan.

`starlog doctor` gains a Sync line: enabled/disabled, cache manifest count, last
scan time.

## Errors, privacy guardrails, testing

Resilience: no dep file → "no dependencies found," exit 0. Malformed
`package.json` → skip with a stderr note (don't crash). Every network failure →
local-only degrade. Cache/record writes are atomic.

Privacy guardrails (enforced in code): `sync-client` is the *only* module that
opens a socket; it's unreachable unless `config.sync.enabled` (or `--sync`) is
set. The request body is built solely from dep names — a unit test asserts no
versions/paths/identifiers ever appear in the payload.

Tests:
- Parser units (`package.json` / `requirements.txt` / `pyproject.toml`, incl.
  malformed).
- `sync-client` against a mocked fetch (success, unknown-split, non-2xx, timeout,
  schema-invalid dropped).
- `scan` in a temp project (writes cache + record; offline path writes record only).
- Cache-merge (cache overrides bundled `id`).
- Payload-privacy test (names only).
- Smoke harness: one offline scan check (sync disabled) — scan a fixture, assert
  `.starlog/project.json`; no network in CI.

Cleanup tie-in: the install-hook message (`init.ts:201`) that wrongly says
"added to the index automatically" gets corrected to reflect the real opt-in
sync state.

## Dependencies / things to resolve on revisit

- **Backend `/sync` endpoint** on `api.starlog.dev` must be built to this
  contract (separate repo). Until then the client degrades to local-only.
- Confirm the anonymous endpoint base + any rate limiting / abuse protection.
- Decide default `.gitignore` guidance for `.starlog/`.
- Possible follow-ups: MCP `starlog_scan` tool; fetch-on-install in the hook;
  project-tailored ranking using `.starlog/project.json`.
