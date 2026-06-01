# Starlog

**Better library decisions for your AI coding agent — free, local, no account.**

AI coding agents (Claude Code, Cursor, Copilot) pick libraries from their training data — which ranks options by how often they appeared in scraped code, not by what actually fits your task. Popularity, not merit. The results are weak: research finds agents draw from only 32–39 unique libraries across projects and are highly inconsistent (83%) in what they recommend, and they default to hand-rolling custom code instead of reaching for a battle-tested library across most capability categories.

AI-suggested dependencies are also often unsafe: research finds ~49% carry known vulnerabilities and ~34% are hallucinated outright — the package simply doesn't exist. Picking a real, well-maintained library, and knowing when to skip one, is most of the battle.

Starlog is a local **capability index** for AI coding agents: a structured, queryable description of what libraries actually do, ranked by fitness for your task and by health/quality signals — not by download count or stars. It runs entirely on your machine as an MCP server and a package-install hook — no API key, no sign-up. This repo ships the engine plus a corpus of 25 manifests across 7 categories.

**Benchmarked across 1,008 runs on 3 Claude models:**

- **11.3pp fewer hand-rolled implementations** (17% → 5.7%)
- **Authentication**: 39.6% → 20.8% custom code
- **Feature flags**: 37.5% → 4.2% custom code
- **100% tool adoption** — agents use it every time it's available
- **Consistent across models** (Sonnet 4.5, Opus 4.5, Opus 4.6)

## What you get

- **`starlog_search` MCP tool** — your agent queries library capabilities in natural language and gets ranked, structured answers instead of training-data recall.
- **Package-install hook** — fires on `npm install` / `pnpm add` / `yarn add` / `pip install` and surfaces a library's `skip_when` conditions and alternatives *before* your agent commits to it.
- **`starlog search` CLI** — query the same index directly from your terminal.
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

`starlog init` writes this for you with an absolute path resolved automatically. To configure by hand, add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "starlog": {
      "command": "node",
      "args": ["/path/to/starloghq/dist/mcp.js"]
    }
  }
}
```

Replace `/path/to/starloghq` with the install location (`$(npm root -g)/starloghq` for a global install, or your clone directory from source). The server exposes one tool — `starlog_search` — accepting a natural-language query with optional `category`, `stack`, and `top_k` filters.

## CLI usage

```bash
starlog search "auth for Next.js SaaS"
```

```
#   Library             Category          Score   Solves
--------------------------------------------------------------------------------
1   Clerk               authentication    75.00   Provides a fully managed authentication and user manag...
    vs custom: Clerk eliminates 2-4 weeks of auth infrastructure work with pre-built UI
2   Auth0               authentication    62.50   Provides a full-stack, framework-agnostic authenticati...
    vs custom: Battle-tested OAuth flows across 80+ providers vs hand-rolling each one
3   Supabase Auth       authentication    50.00   Provides authentication as part of the Supabase platfo...
    vs custom: Auth + database + realtime in one SDK vs stitching 3 services together
```

Options:

```
--category <cat>    Filter by category (authentication, feature-flags, etc.)
--stack <stack>     Filter by stack affinity (e.g., "next.js", "python")
--top-k <n>         Number of results (default: 5)
--format <type>     Output format: table or json
--context <desc>    Project context to tailor the "vs custom" rationale
```

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
| Authentication | 39.6% | 20.8% | **-18.7pp** |
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

Starlog reduces recommendation diversity by ~30%. Manifests narrow the option space — agents converge on fewer libraries. This is actively being investigated. The reduction in hand-rolled code holds across both context-injection and tool-use delivery, suggesting it's a property of the data, not the transport.

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
