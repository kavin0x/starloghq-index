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

## Release steps

1. Land all changes; `npm test` and `npm run typecheck` green.
2. Bump the version **without** auto-tagging (we tag only after a green publish):
   ```bash
   npm version 0.1.1 --no-git-tag-version
   ```
3. Commit the bump (and update any changelog).
4. **Run the gate** — must be green:
   ```bash
   npm run verify:release
   ```
5. Publish. Publishing requires 2FA — a plain web login does **not** bypass it:
   - **OTP:** `npm publish --otp=<6-digit-code>` from your authenticator, **or**
   - **Token:** create a *granular* access token on npmjs.com with **Read and
     write** on the `starloghq` package and **Bypass 2FA** enabled, then:
     ```bash
     umask 077; TMPRC=$(mktemp)
     printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$TMPRC"
     npm publish --userconfig "$TMPRC"; rm -f "$TMPRC"
     ```
     Revoke the token afterward. (For the *first ever* publish of a new package
     the token must be scoped to **All packages**, since the name doesn't exist
     yet to scope to.)
6. Verify it's live: `npm view starloghq version`.
7. **Now** tag and push (tagging after publish avoids a dangling tag if the auth
   dance fails):
   ```bash
   git tag -a v0.1.1 -m "v0.1.1"
   git push origin main --follow-tags
   ```

## Notes

- `files` in `package.json` controls what ships: `dist/` + `corpus-free/`.
  `npm pack --dry-run` shows the exact tarball contents.
- `prepublishOnly` rebuilds on publish, but `npm pack` does **not** — so the gate
  builds explicitly first.
