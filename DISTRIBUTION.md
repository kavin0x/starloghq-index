# Distribution & Discoverability

Where Starlog gets found, and the steps to list it. The repo ships two registry
manifests; the rest is submission + launch work.

## Shipped in-repo

- **`server.json`** — official [MCP Registry](https://github.com/modelcontextprotocol/registry)
  manifest. Launches via `npx -y starloghq mcp`. Version must match the published
  npm version on each release.
- **`smithery.yaml`** — [Smithery](https://smithery.ai) stdio listing. Same launch
  command; no required config (local-first, no key).
- **README badges** — npm version, CI, license, MCP.

Both manifests depend on the `starlog mcp` subcommand (added in 0.1.8). Keep the
`version` fields in `server.json` in sync with `package.json` at release time.
As of **0.5.0** both `server.json` version fields are synced to 0.5.0 and the
description matches the current facts/vetting positioning — a registry re-publish
(`mcp-publisher publish`) is the remaining step to surface 0.5.0 in the listing.

## Submission checklist

- [x] **Official MCP Registry** — published via the
      [`mcp-publisher` CLI](https://github.com/modelcontextprotocol/registry/tree/main/cmd/publisher)
      as `io.github.starloghq/starlog` (npm 0.1.9 first carried the required
      `mcpName` field; every release since does too). Re-run `mcp-publisher publish`
      after each release to bump the listed version. Namespace auth requires
      **public** `starloghq` org membership (publicized for `basicScandal`).
      **Pending: re-publish 0.5.0** — `server.json` is synced; run
      `mcp-publisher login github && mcp-publisher publish` from the repo root.
- [x] **awesome-mcp-servers** — PR [#7250](https://github.com/punkpeye/awesome-mcp-servers/pull/7250)
      (awaiting maintainer merge).
- [ ] **Smithery** — connect the `starloghq/index` repo at smithery.ai; it reads
      `smithery.yaml`. (GitHub-app authorize flow — needs a browser login.)
- [ ] **Glama** — https://glama.ai/mcp/servers — auto-indexes public GitHub MCP
      repos; usually picks up the repo on its own. Claim it to get the score badge.
- [ ] **PulseMCP** — https://www.pulsemcp.com (crawls + submit form).
- [ ] **mcp.so** — https://mcp.so (submit form).

### awesome-mcp-servers entry

Open a PR to [`punkpeye/awesome-mcp-servers`](https://github.com/punkpeye/awesome-mcp-servers)
adding this under **🛠️ Developer Tools** (alpha-ordered):

```
- [starloghq/index](https://github.com/starloghq/index) 📇 🏠 🍎 🪟 🐧 - Gives AI coding agents authoritative, dated facts (CVEs, license, maintenance) to vet a package before using it, plus capability discovery — and `org sync` to bulk-onboard your own internal repos. Local, no account, no API key.
```

## Launch posts (the benchmark numbers are the hook)

Lead with the result, not the mechanism:

> AI coding agents pick libraries by training-data popularity, not fit — and
> ~34% of their suggested packages are hallucinated. Starlog is a local MCP
> capability index that puts real library data in front of the agent at decision
> time. Benchmarked across 1,008 runs on 3 Claude models: **11.3pp fewer
> hand-rolled implementations** (17% → 5.7%), 100% tool adoption. Free, local, no
> account.

**0.5.0 angle (internal packages):** `starlog org sync <dir>` points at a folder
of internal repos and derives their facts (license, maintenance) + makes them
discoverable to the agent — npm *and* Python, fully local. The hook: "your agent
vets `lodash` but has never heard of your company's own packages; one command
fixes that." A strong second post distinct from the benchmark numbers.

- [ ] **Show HN** — `npx starloghq search "auth for a Next.js app"` is a strong
      zero-install demo for the first line.
- [ ] **r/mcp**, **r/ClaudeAI**
- [ ] **dev.to / blog** — the benchmark methodology is worth a full writeup.
- [ ] Cross-link from `starlog.dev`.
