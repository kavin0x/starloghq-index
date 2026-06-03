<p align="center">
  <img src="assets/logo/starlog-avatar-A.png" alt="Starlog" width="120" height="120">
</p>

<h1 align="center">Starlog</h1>

<p align="center"><strong>Better library decisions for your AI coding agent — free, local, no account.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/starloghq"><img src="https://img.shields.io/npm/v/starloghq?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://github.com/starloghq/index/actions/workflows/ci.yml"><img src="https://github.com/starloghq/index/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-BUSL--1.1-blue" alt="License: BUSL-1.1"></a>
  <img src="https://img.shields.io/badge/MCP-server-6E40C9" alt="MCP server">
</p>

<p align="center">
  <img src="demo/starlog-demo.gif" alt="Starlog returning ranked library recommendations in the terminal, then wiring itself into Claude Code, Cursor, Copilot and Codex with one command" width="820">
</p>

**Try it in one command — nothing to install, no API key, no account:**

```bash
npx starloghq search "auth for a Next.js app"
```

Then wire it into your coding agent (Claude Code, Cursor, Copilot, Codex):

```bash
npx starloghq init
```

> **Source-available** under BUSL-1.1 — free to use, modify, and self-host; **converts to Apache-2.0 in 2030**. [Details ↓](#license)

---

## Why

AI coding agents (Claude Code, Cursor, Copilot) pick libraries from their training data — which ranks options by how often they appeared in scraped code, not by what actually fits your task. Popularity, not merit. The results are weak: research finds agents draw from only 32–39 unique libraries across projects and are highly inconsistent (83%) in what they recommend, and they default to hand-rolling custom code instead of reaching for a battle-tested library across most capability categories.

AI-suggested dependencies are also often unsafe: research finds ~49% carry known vulnerabilities and ~34% are hallucinated outright — the package simply doesn't exist. Picking a real, well-maintained library, and knowing when to skip one, is most of the battle.

Starlog is a local **capability index** for AI coding agents: a structured, queryable description of what libraries actually do — what each solves, which stacks it fits, and when to skip one — put in front of your agent at decision time instead of training-data recall. Results are ranked by how well a library's capability data fits your task, plus health/quality signals (not download count or stars). It runs entirely on your machine as an MCP server and a package-install hook — no API key, no sign-up. This repo ships the engine plus a corpus of 25 manifests across 7 categories.

**Benchmarked across 1,008 runs on 3 Claude models:**

- **11.3pp fewer hand-rolled implementations** (17% → 5.7%)
- **Authentication**: 39.6% → 20.8% custom code
- **Feature flags**: 37.5% → 4.2% custom code
- **100% tool adoption** — agents use it every time it's available
- **Consistent across models** (Sonnet 4.5, Opus 4.5, Opus 4.6)

## What you get

- **`starlog_search` MCP tool** — your agent queries library capabilities in natural language and gets real, structured capability data (ranked by relevance) instead of training-data recall.
- **`starlog_facts` MCP tool** — your agent looks up **authoritative facts about a specific package** before recommending it: known CVEs/supply-chain incidents, SPDX license and license risk, maintenance status (active/deprecated/abandoned/compromised), and effect surface. In a 4-model benchmark, agents called this tool unprompted on package decisions (100% recall, 98% specificity) and it moved them toward the correct install/avoid/pick call. Every record is sourced, verified, and **dated** — each result shows an "as of `<date>`" line so a stale "no known vulns" is never mistaken for a fresh one (the corpus is refreshed and re-verified on an ongoing basis). A package with no record returns an honest "no facts on file." Facts are organized in three independent layers, composed at query time: **L1** capability/effect-surface (immutable), **L2** reputation/vuln/license/maintenance (mutable — carries the `as of` recency), and **L3** org policy (your suitability verdict). Override or extend any of them locally: point `STARLOG_PRIVATE_FACTS` at a JSON file with independent `l1`/`l2` arrays (internal packages, license rulings), and `STARLOG_POLICY` at an org policy (`{ org, rules }`) to get allow/deny/flag verdicts at decision time. With a `STARLOG_API_KEY` set, org-private overlays and policy are served from the hosted facts API (authoritative, with the local corpus as the offline fallback); `starlog facts push` uploads your org's overlays + policy. See [docs/FACTS-CONTRACT.md](docs/FACTS-CONTRACT.md).
- **Package-install hook** — fires the moment your agent runs `npm install` / `pnpm add` / `yarn add` / `pip install` and surfaces that library's `skip_when` conditions and alternatives as context, so the agent can reconsider or swap before building on it. It's advisory — it informs the agent's next move, it doesn't block the install.
- **`starlog search` / `starlog facts` CLI** — query the same index and facts corpus directly from your terminal.
- **Runs on your machine** — the engine and corpus are local; searches need no account, no API key, and no network. (The one exception is anonymous, opt-out usage telemetry — see [Telemetry](#telemetry).)

## Quick start

```bash
npx starloghq init
```

This wires Starlog into Claude Code:

- **MCP server** added to `~/.claude/settings.json` — exposes the `starlog_search` tool
- **PostToolUse hook** installed — surfaces `skip_when` conditions and alternatives on package installs
- Previews every change and asks before writing; **idempotent** and safe to re-run

Install globally so the `starlog` command is always on your PATH:

```bash
npm install -g starloghq
starlog init
```

Add `--project` to also drop Starlog guidance into your project's `CLAUDE.md`:

```bash
starlog init --project
```

Preview without writing, or remove cleanly:

```bash
starlog init --dry-run
starlog init --uninstall
```

### From source

```bash
git clone https://github.com/starloghq/index.git starlog-index
cd starlog-index && npm install
npx tsx src/cli.ts init
```

### Manual MCP setup

`starlog init` writes this for you automatically. To configure by hand, add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "starlog": {
      "command": "npx",
      "args": ["-y", "starloghq", "mcp"]
    }
  }
}
```

This is the same launch command MCP registries use. (From a local source clone instead, point `node` at `dist/mcp.js` — `$(npm root -g)/starloghq/dist/mcp.js` for a global install, or your clone's path.) The server exposes two tools: `starlog_search` (a natural-language capability query with optional `category`, `stack`, and `top_k` filters) and `starlog_facts` (an authoritative per-package fact lookup — CVEs, license, maintenance).

## CLI usage

```bash
starlog search "auth for a Next.js app"
```

```
#   Library             Category          Score   Solves
--------------------------------------------------------------------------------
1   Auth0 Next.js SDK   authentication    71.36   Implements user authentication in Next.js applications using Auth0 ...
2   Clerk               authentication    60.64   Provides a fully managed authentication and user management platfor...
```

Out of the box this uses the **local keyword ranker** — no API key, no network. Scores are absolute (a strong match lands in the 70s–80s; weak matches stay low), so a query outside the indexed categories returns *"no strong match"* rather than a confident wrong answer. See `--context` below for `vs custom` analysis.

Options:

```
--category <cat>    Filter by category (authentication, feature-flags, etc.)
--stack <stack>     Filter by stack affinity (e.g., "next.js", "python")
--top-k <n>         Number of results (default: 5)
--format <type>     Output format: table or json
--context <desc>    Project context to tailor the "vs custom" rationale
```

## Ranking

Starlog ranks results with its **keyword ranker** — the default and only mode. It matches your query against each library's capability data and reports an *absolute* score, so an off-topic or out-of-corpus query returns "no strong match" instead of a forced result. It runs offline: no key, no network, no setup. Add `--context "<your project>"` for a per-library **`vs custom`** rationale.

## Auto-registry hook

The corpus grows from what you actually install. When your agent installs a package that has no manifest yet, the hook records it:

```
[Starlog] Queued "drizzle-orm" for manifest generation (no existing manifest found).
```

Queued packages are written to a project-local log (`.starlog/pending.json`) and a global queue (`~/.starlog/pending.json`).

## How it works

```
Corpus (local capability manifests)
    |
    v
Query Engine (keyword matching + relevance scoring)
    |
    v
Transport (MCP server or CLI)
```

Each manifest is a structured description of a library — not documentation, but **capability data**: what it solves, which stacks it fits, integration effort, and when to skip it. Tools like Context7 index *documentation* (how an API works); Starlog indexes *capability* (what a library is for, and when not to use it).

**Stored fields:** `id`, `name`, `category`, `solves`, `stack_affinity`, `integration_effort`, `best_for`, `skip_when`, `health`, `quality`

**Computed at query time:** `relevance_score`, `context_fit`, `vs_custom`, `tradeoffs`

The corpus is static and cacheable; the analysis adapts to each query's context.

## Benchmark results

Tested across 3 Claude models, 4 project types (nextjs-saas, python-api, react-spa, node-cli), 7 categories, 3 repetitions per configuration.

### Custom-code rate reduction by category

| Category | Baseline | With Starlog | Reduction |
|---|---|---|---|
| Authentication | 39.6% | 20.8% | **-18.8pp** |
| Feature Flags | 37.5% | 4.2% | **-33.3pp** |
| Caching | 14.6% | 0% | **-14.6pp** |
| Background Jobs | 12.5% | 0% | **-12.5pp** |
| Real-time | 12.5% | 8.3% | -4.2pp |
| Email | 2.1% | 6.3% | +4.2pp |
| ORM/Database | 0% | 0% | 0pp |

### Custom-code rate reduction by model

| Model | Baseline | With Starlog | Reduction |
|---|---|---|---|
| Claude Sonnet 4.5 | 14.3% | 6.3% | **-8.0pp** |
| Claude Opus 4.5 | 17.0% | 4.5% | **-12.5pp** |
| Claude Opus 4.6 | 19.6% | 6.3% | **-13.4pp** |

### Known limitation: diversity trade-off

Starlog narrows the option space — by steering toward vetted libraries, agents converge on fewer of them (a measured ~30% diversity reduction). That's an inherent trade-off of recommending proven options over maximal variety. The reduction in hand-rolled code holds across both context-injection and tool-use delivery, indicating it's a property of the capability data, not the delivery method.

## Categories

The bundled corpus covers 7 categories:

| Category | Examples |
|---|---|
| Authentication | Clerk, Auth0 |
| Real-time | Socket.IO, Ably, Pusher, Supabase Realtime, ws |
| ORM/Database | Prisma, Drizzle, Kysely |
| Background Jobs | BullMQ, Inngest, Bree |
| Email | Resend, SendGrid, Nodemailer |
| Feature Flags | LaunchDarkly, PostHog, Flagsmith, ConfigCat, DevCycle |
| Caching | ioredis, Upstash Redis, Keyv, Cacheable |

Each manifest carries health signals (stars, downloads, last commit, contributors) and quality indicators (tests, docs, types, maintenance status).

> **Note:** Manifest data (pricing, health stats, `skip_when`, alternatives) is **point-in-time and may be out of date or imperfect**. It's a decision aid, not ground truth — verify anything load-bearing, and corrections via PR are welcome.

## Testing

```bash
npx vitest run
```

Unit tests cover schema validation, corpus loading, format output, and relevance ranking. All tests run without API keys or external binaries.

## Telemetry

Starlog collects **anonymous, opt-out** usage telemetry to understand which
commands and capabilities are used. It sends: the command run
(`init`/`search`/`doctor`), the CLI/Node/OS version, which agents were detected,
and coarse result counts. It **never** sends your search queries, file paths,
usernames, hostnames, or any file contents. It's also disabled automatically in
CI and test runs.

A one-line notice is printed on first run. Opt out at any time:

```bash
starlog telemetry disable          # persistent opt-out
starlog telemetry status           # see current state + anonymous id
export STARLOG_TELEMETRY=0         # env opt-out
export DO_NOT_TRACK=1              # honored too
starlog <command> --no-telemetry   # one-off
```

## Links

- Website: [starlog.dev](https://starlog.dev)

## License

**Source-available** under the Business Source License 1.1 — see [LICENSE](LICENSE). Not an OSI open-source license: free to use, modify, and self-host (non-competing use), and it **converts to Apache-2.0 on 2030-06-01**.
