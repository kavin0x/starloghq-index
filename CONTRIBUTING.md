# Contributing to Starlog

The most valuable contribution is **a new capability manifest** — that's how the
index grows and how your favorite under-adopted library gets found on merit.

## Add a capability manifest

A manifest is structured **capability data** about a library — not docs. One JSON
file per library under `corpus-free/<category>/<id>.json`.

1. Pick a category (current set: `authentication`, `email`, `background-jobs`,
   `feature-flags`, `caching`, `realtime`, `orm-database`). New categories are
   welcome — add the value to `KnownCategorySchema` in `src/manifest/schema.ts`.
2. Copy an existing manifest in that folder as a template (e.g.
   `corpus-free/caching/keyv.json`).
3. Fill it in. The **schema in `src/manifest/schema.ts` is the source of truth**;
   key fields:
   - `id`, `name`, `repo`, `ecosystem` (`npm`/`pypi`), `category`
   - `solves` — what problem it solves, in plain language
   - `stack_affinity`, `best_for`, `skip_when` — when to reach for it / avoid it
   - `integration_effort` (`easy`/`moderate`/`hard`), `alternative_ids`
   - `health` (stars, downloads, last commit, contributors, license, open issues)
   - `quality` (has_tests, has_docs, has_types, maintenance_status)
4. Keep data **accurate and point-in-time** — cite the source for health/pricing
   where you can. Be fair to competitors; `skip_when` should be honest, not snark.

## Validate before opening a PR

```bash
npm install
npm run typecheck   # types clean
npm test            # schema validation + engine tests (your manifest must parse)
npm run verify:release   # optional: full packaged smoke test (Docker or local)
```

A manifest that fails schema validation is skipped at load time, so `npm test`
must pass.

## Code changes

- Match the surrounding style; keep changes small and focused.
- Add/adjust tests for behavior changes (`*.test.ts`, run with `npm test`).
- `npm run typecheck` and `npm test` must be green; CI runs both plus a packaged
  smoke test on Node 20 + 22.

## License of contributions

By contributing you agree your contribution is licensed under the project's
**Business Source License 1.1** (which converts to Apache-2.0 on 2030-06-01).
See [LICENSE](LICENSE).
