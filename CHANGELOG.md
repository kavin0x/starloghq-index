# Changelog

All notable changes to `starloghq` are documented here. This project follows [semantic versioning](https://semver.org/) (pre-1.0: minor = features, patch = fixes).

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
