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

## Submission checklist (outward-facing — do these by hand)

- [ ] **Official MCP Registry** — publish `server.json` with the
      [`mcp-publisher` CLI](https://github.com/modelcontextprotocol/registry/blob/main/docs/guides/publishing/publish-server.md).
      Requires GitHub auth as the `starloghq` org to claim the `io.github.starloghq/*`
      namespace.
- [ ] **Smithery** — connect the `starloghq/index` repo at smithery.ai; it reads
      `smithery.yaml`.
- [ ] **Glama** — https://glama.ai/mcp/servers (auto-indexes public GitHub MCP
      repos; can also submit). Gets you the score badge used elsewhere.
- [ ] **PulseMCP** — https://www.pulsemcp.com (submit form).
- [ ] **mcp.so** — https://mcp.so (submit form).
- [ ] **awesome-mcp-servers** — PR adding the entry below.

### awesome-mcp-servers entry

Open a PR to [`punkpeye/awesome-mcp-servers`](https://github.com/punkpeye/awesome-mcp-servers)
adding this under **🛠️ Developer Tools** (alpha-ordered):

```
- [starloghq/index](https://github.com/starloghq/index) 📇 🏠 🍎 🪟 🐧 - Local capability index that helps AI coding agents choose libraries by what they actually do (best-for, skip-when, DIY-vs-buy) instead of training-data popularity. No account, no API key.
```

## Launch posts (the benchmark numbers are the hook)

Lead with the result, not the mechanism:

> AI coding agents pick libraries by training-data popularity, not fit — and
> ~34% of their suggested packages are hallucinated. Starlog is a local MCP
> capability index that puts real library data in front of the agent at decision
> time. Benchmarked across 1,008 runs on 3 Claude models: **11.3pp fewer
> hand-rolled implementations** (17% → 5.7%), 100% tool adoption. Free, local, no
> account.

- [ ] **Show HN** — `npx starloghq search "auth for a Next.js app"` is a strong
      zero-install demo for the first line.
- [ ] **r/mcp**, **r/ClaudeAI**
- [ ] **dev.to / blog** — the benchmark methodology is worth a full writeup.
- [ ] Cross-link from `starlog.dev`.
