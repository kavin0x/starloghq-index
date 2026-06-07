# Changelog

All notable changes to `starloghq` are documented here. This project follows [semantic versioning](https://semver.org/) (pre-1.0: minor = features, patch = fixes).

## 0.4.0

First-real-user fixes: a tester ran `npm i starloghq` and drove the CLI through their agent **without ever running `starlog init`**, so the MCP tools were never registered (the agent fell back to shelling the CLI), and they judged the tool on a mainstream public stack where most vetting honestly returns *"no facts on file."* These changes close the install-≠-wired gap and turn the two dead-end messages into pointers — without overclaiming public-package coverage (the value remains private/internal packages + post-cutoff advisories).

### Added
- **Post-install nudge.** `npm i starloghq` now prints one line — *"run `npx starlog init` to wire your AI agent — install alone does nothing"* — because install registers no MCP server or hook on its own. Stays silent in CI / non-interactive / piped installs and never fails the install. (P0)
- **CLI self-heal nudge.** When `starlog search` / `starlog facts` runs but `~/.claude/settings.json` exists *without* a `starlog` MCP server (a confirmed agent user who skipped `init`), a single stderr line points at `starlog init`. Conservative by design: silent when settings.json is absent/invalid (ambiguous) and suppressible with `STARLOG_NO_NUDGE`. (P0)
- **Anonymous key↔issuance link (opt-out aware).** Keyed `facts` API requests now relay an anonymous CLI id (`X-Starlog-Anon-Id`) so the server can associate a key with its issuance. The header is omitted entirely under `DO_NOT_TRACK` / `STARLOG_TELEMETRY=0` / CI / tests, and never carries queries, file paths, or package names.

### Changed
- **"No facts on file" now converts instead of dead-ending.** The miss message explains that a blank for a *mainstream public* package is expected (your model already knows it; Starlog's edge is post-cutoff advisories + your private packages), points to `npm audit`/OSV for mainstream vetting, and shows the one-liner to teach Starlog an internal package. Shared by the CLI and the `starlog_facts` MCP tool. (P1)
- **"No strong match" search result names the scope.** Both the CLI and `starlog_search` now state that discovery covers JS/TS capabilities, and that a non-JS/TS stack has no candidates to surface — while `starlog facts <pkg>` still vets any package by name and `starlog corpus add` makes internal packages discoverable. (P2)

## 0.3.0

The **private/internal-package** flow is now first-class: an org makes its internal package both *discoverable* and *vettable* in two commands, and the agent picks it up automatically per-project. Plus a class of trust-breaking fact mis-attribution is fixed.

### Fixed
- **Facts vetting resolves package names exactly — no more fabricated facts.** Previously a scoped or hyphenated name could fuzzy-/substring-match and return a *different* package's facts as authoritative (e.g. `@your-scope/pkg` → `q`, `express-rate-limit` → `express`). Resolution is now exact (normalized); an unknown name returns an honest *"no facts on file."* Natural-language *discovery* stays in `starlog_search`, where it belongs. (#7, #9)

### Added
- **`starlog corpus add <pkg> --solves "…"`** — make an internal/private package **discoverable** in one command: `starlog_search` surfaces it (private-first) for a matching capability. Defaults the public-signal fields that don't apply to internal packages, so there's no manifest to hand-write. (#11)
- **`starlog init` wires per-project private overlays into the agent.** The MCP server entry now carries `${CLAUDE_PROJECT_DIR}/.starlog/{private-facts,private-corpus,policy}.json`, so private vetting + discovery work **automatically in each project** — no shell `export` (which never reached the agent-spawned server). One global entry, resolved per-project, no cross-project leak. (#13)
- **`starlog doctor` reports the private setup** — whether overlays are wired into the agent (warns to re-run `init` on a pre-wiring install) and what the current project has authored (`vetting N, discovery N, policy N`), flagging an invalid overlay file instead of ignoring it. (#14)

### Changed
- `facts add` / `corpus add` guidance now describes the agent path accurately (overlays are auto-read per-project after `init`; the inline-env form is for CLI use) instead of suggesting a shell `export` that the agent never sees. README documents the two-command internal-package on-ramp. (#15)

## 0.2.0

Initial public release: `starlog_facts` (vet a package by name — CVEs/incidents, SPDX license + risk, maintenance, dated) and `starlog_search` (discover candidates) as a local MCP server + CLI + package-install hook. Curated facts corpus (42 packages) + discovery corpus (25 capability manifests). Free, local, no account.
