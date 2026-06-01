# Starlog

**Capability manifests for AI coding agents.**

AI coding agents (Claude Code, Cursor, Copilot) rely on training data to pick libraries. The results are bad: agents recommend only 32-39 unique libraries across projects, show 83% inconsistency between model versions, and build custom implementations 60% of the time -- even when battle-tested libraries exist.

Starlog fixes this with structured capability manifests generated from code analysis. This repo bundles the free-tier corpus (25 manifests across 7 categories); the full hosted index is available via the Starlog API.

**Benchmarked across 1,008 runs on 3 Claude models:**

- **11.3pp DIY rate reduction** (17% baseline to 5.7% with Starlog)
- **Authentication**: 39.6% DIY drops to 20.8%
- **Feature flags**: 37.5% DIY drops to 4.2%
- **100% tool adoption** -- agents use Starlog every time it's available
- **Works across all 3 models** (Sonnet 4.5, Opus 4.5, Opus 4.6)

## Quick start

```bash
git clone https://github.com/starlog/mcp.git starlog
cd starlog && npm install
```

### One-command setup (recommended)

```bash
npx tsx src/cli.ts init
```

This wires everything into Claude Code automatically:

- **MCP server** added to `~/.claude/settings.json` -- exposes the `starlog_search` tool
- **PostToolUse hook** installed -- fires on `npm install`/`pnpm add`/`yarn add`/`pip install` and surfaces skip_when conditions and alternatives from the manifest corpus
- All operations are **idempotent** -- safe to re-run

Add `--project` to also inject CLAUDE.md instructions into your current project, telling Claude to always consult Starlog before recommending libraries:

```bash
npx tsx src/cli.ts init --project
```

To remove the integration cleanly:

```bash
npx tsx src/cli.ts init --uninstall
```

### Manual setup

If you prefer to configure manually, add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "starlog": {
      "command": "npx",
      "args": ["tsx", "/path/to/starlog/src/mcp.ts"]
    }
  }
}
```

Replace `/path/to/starlog` with the actual clone location. The MCP server exposes a single tool -- `starlog_search` -- that accepts natural language queries with optional category, stack, and top_k filters.

## CLI usage

For direct queries outside an agent context:

```bash
npx tsx src/cli.ts search "auth for Next.js SaaS"
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
--context <desc>    Project context for vs_custom analysis
```

To query the full hosted index instead of the bundled free-tier corpus, set `STARLOG_API_KEY` -- the CLI and MCP server will delegate to the Starlog API automatically.

## Auto-registry hook

Starlog grows its corpus organically. When an AI agent installs a package that has no manifest, the PostToolUse hook queues it:

```
[Starlog] Queued "drizzle-orm" for manifest generation (no existing manifest found).
```

Queued packages are written to a project-local log (`.starlog/pending.json`) and a global queue (`~/.starlog/pending.json`), then added to the index automatically.

## How it works

```
Corpus (bundled free-tier manifests + hosted full index)
    |
    v
Query Engine (keyword matching + relevance scoring)
    |
    v
Transport (MCP server or CLI)
```

Each manifest is a structured description of a library -- not documentation, but **capability data**: what it solves, which stacks it fits, integration effort, when to skip it, and hosted alternatives.

**Stored fields** (in manifests): `id`, `name`, `category`, `solves`, `stack_affinity`, `integration_effort`, `best_for`, `skip_when`, `hosted_alternative`, `health`, `quality`

**Computed fields** (at query time): `relevance_score`, `context_fit`, `vs_custom`, `tradeoffs`

This separation means the corpus is static and cacheable while analysis adapts to each query's context.

## Benchmark results

Tested across 3 Claude models, 4 project types (nextjs-saas, python-api, react-spa, node-cli), 7 categories, 3 repetitions per configuration.

### DIY rate reduction by category

| Category | Baseline | With Starlog | Reduction |
|---|---|---|---|
| Authentication | 39.6% | 20.8% | **-18.7pp** |
| Feature Flags | 37.5% | 4.2% | **-33.3pp** |
| Caching | 14.6% | 0% | **-14.6pp** |
| Background Jobs | 12.5% | 0% | **-12.5pp** |
| Real-time | 12.5% | 8.3% | -4.2pp |
| Email | 2.1% | 6.3% | +4.2pp |
| ORM/Database | 0% | 0% | 0pp |

### DIY rate reduction by model

| Model | Baseline | With Starlog | Reduction |
|---|---|---|---|
| Claude Sonnet 4.5 | 14.3% | 6.3% | **-8.0pp** |
| Claude Opus 4.5 | 17.0% | 4.5% | **-12.5pp** |
| Claude Opus 4.6 | 19.6% | 6.3% | **-13.4pp** |

### Known limitation: diversity trade-off

Starlog reduces recommendation diversity by ~30%. Manifests narrow the option space -- agents converge on fewer libraries. This is actively being investigated. The DIY reduction holds across both context-injection and tool-use delivery mechanisms, suggesting it's a property of the data, not the transport.

## Categories

The bundled free-tier corpus covers 7 categories:

| Category | Examples |
|---|---|
| Authentication | Clerk, Auth0 |
| Real-time | Socket.IO, Ably, Pusher, Supabase Realtime, ws |
| ORM/Database | Prisma, Drizzle, Kysely |
| Background Jobs | BullMQ, Inngest, Bree |
| Email | Resend, SendGrid, Nodemailer |
| Feature Flags | LaunchDarkly, PostHog, Flagsmith, ConfigCat, DevCycle |
| Caching | ioredis, Upstash Redis, Keyv, Cacheable |

Each manifest includes health signals (stars, downloads, last commit, contributors), quality indicators (tests, docs, types, maintenance status), and competitive context (hosted alternatives, alternative IDs). The full hosted index covers more libraries per category and expands dynamically via the auto-registry hook.

## Testing

```bash
npx vitest run
```

Unit tests cover schema validation, corpus loading, format output, and relevance ranking. All tests run without API keys or external binaries.

## License

MIT
