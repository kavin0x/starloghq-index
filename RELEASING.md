# Releasing `starloghq`

The repeatable process for cutting a release. The golden rule: **the smoke gate
must pass on the packed tarball before you publish.** A test against the
*published* version can only run after publish — too late to stop a bad one.

## The gate

```bash
npm run verify:release
```

This builds, runs `npm pack`, and installs the resulting tarball into a throwaway
environment (a fresh `node:20-slim` container if Docker is available, otherwise an
isolated `HOME` + npm prefix locally), then exercises the real user flow:

- global install + `starlog` on PATH + `--version` matches `package.json`
- the runtime dependency `@anthropic-ai/sdk` is actually installed
- `starlog search` (table + JSON) returns results via keyword fallback
- `starlog doctor` before/after init
- `starlog init --dry-run` writes nothing
- `starlog init` wires the MCP server + hook; MCP handshake responds
- `starlog init --uninstall` removes the MCP server entry cleanly

It exits non-zero if any check fails. CI also runs this on every push/PR (the
**Smoke (packed)** job in `.github/workflows/ci.yml`, Node 20 + 22).

**Not covered** (be honest about it): the keyed `--context` LLM enrichment path,
which needs `OPENROUTER_API_KEY` and is not exercised in CI. The gate verifies
that `@anthropic-ai/sdk` *installs*, not that enrichment runs end-to-end.

You can also run the smoke test directly against any install source:

```bash
npm run smoke                                   # latest from the registry
STARLOG_VERSION=0.1.1 npm run smoke             # a specific published version
STARLOG_TARBALL=./starloghq-0.1.1.tgz npm run smoke
```

## Publishing — automated via Trusted Publishing (OIDC)

Publishing is **automated**: pushing a `v*` tag triggers `.github/workflows/publish.yml`,
which re-runs the gate and then `npm publish`. Authentication is GitHub Actions
**OIDC** — there is **no npm token stored anywhere** (nothing to leak or rotate),
and npm generates provenance automatically.

One-time npm setup (already done): npmjs.com → package `starloghq` → **Settings →
Trusted Publisher**, with Organization/user `starloghq`, Repository `index`,
Workflow `publish.yml`, Allowed action `npm publish`.

### Release steps

1. Land all changes; `npm test` and `npm run typecheck` green.
2. Bump the version (no auto-tag — the workflow's tag-vs-`package.json` guard
   would fail a mismatched tag):
   ```bash
   npm version 0.1.2 --no-git-tag-version
   ```
3. Commit the bump (and any changelog).
4. **Run the gate locally** (optional but recommended — CI runs it too):
   ```bash
   npm run verify:release
   ```
5. Tag and push — this triggers the publish workflow:
   ```bash
   git tag -a v0.1.2 -m "v0.1.2"
   git push origin main --follow-tags
   ```
6. Watch the run and confirm it's live:
   ```bash
   gh run watch
   npm view starloghq version
   ```

If you ever need to publish **manually** (CI down): `npm publish --otp=<6-digit>`
from an account with publish rights, or a short-lived granular token scoped to
`starloghq` with bypass-2FA — then revoke it.

## Notes

- `files` in `package.json` controls what ships: `dist/` + `corpus-free/`.
  `npm pack --dry-run` shows the exact tarball contents.
- `prepublishOnly` rebuilds on publish, but `npm pack` does **not** — so the gate
  builds explicitly first.
