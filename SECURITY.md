# Security Policy

Starlog runs locally and, on `starlog init`, **modifies your `~/.claude/settings.json`
and installs a PostToolUse hook** (a Node script invoked by your agent). Because it
touches agent configuration and runs on package installs, we take reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub Security Advisories:
**https://github.com/starloghq/index/security/advisories/new**

Include: affected version (`starlog --version`), a description, reproduction steps,
and impact. We aim to acknowledge within 3 business days and to share a remediation
timeline after triage. Coordinated disclosure is appreciated — we'll credit you
unless you prefer otherwise.

## Scope

In scope:
- The `init`/`uninstall` flow's edits to `~/.claude/settings.json`, generated hooks,
  and project files (`CLAUDE.md`, `.cursor/`, etc.).
- The generated PostToolUse hook (command parsing, file writes to `.starlog/`).
- The CLI and MCP server (`starlog_search`), including the API-delegation path.
- The anonymous telemetry path.

Out of scope:
- Vulnerabilities in third-party libraries listed in the corpus (report those upstream).
- The accuracy of manifest data (open a normal issue/PR — see CONTRIBUTING.md).
- The separate hosted backend (`api.starlog.dev`).

## Good to know

- Searches run fully locally; no account or API key is required.
- Telemetry is anonymous and opt-out (`STARLOG_TELEMETRY=0`, `DO_NOT_TRACK=1`,
  or `starlog telemetry disable`); it never sends queries, paths, or file contents.
- `starlog init` previews changes and asks before writing; `--dry-run` shows the
  full plan without touching anything.
