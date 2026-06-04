# Does Starlog actually change the agent's decision?

A capability index is easy to *claim* and easy to *fake*. This is the honest before/after — including the one test we had to throw out.

**Setup.** A controlled comparison. **Control** = a fresh agent answering from training recall only (no tools). **Treatment** = the same agent, same prompt, given the package's Starlog facts. The only variable is the presence of facts.

---

## 1. Time-to-first-value — sub-second, zero setup

Public vetting needs no account, no config, no network. Measured wall-clock (cold start, local corpus):

| Command | Wall-clock | Setup |
|---|---|---|
| `starlog facts event-stream` | 0.49s | none |
| `starlog facts node-sass` | 0.44s | none |
| `starlog facts axios` | 0.45s | none |

Private/org authoring is **one command** — you never hand-write the schema:

```bash
starlog facts add @acme/flags --status active --license MIT   # 0.41s
export STARLOG_PRIVATE_FACTS=.starlog/private-facts.json
starlog facts @acme/flags                                      # agent now sees it, dated
```

✅ Value in under a second to vet; under two minutes to author a private fact.

---

## 2. Does the decision change? — the honest result

### The experiment we threw out

The first private-package test used a fact that said *"POLICY: you must use `@acme/flags`, do not build custom."* The agent complied, 2/2. **That proves nothing** — a "you must use X" fact only demonstrates instruction-following, not that the *information* changed the agent's mind. (A reviewer caught it; it's a tautology trap, and it's exactly what a vendor demo quietly leans on.)

So we re-ran with an **informational-only** fact — it states an active internal package exists, with **no** "must use" and **no** "don't build custom" — and let the agent use its own judgment.

### Private / org packages — the hero case (the model *cannot* recall these)

| Need | Control (recall only) | Treatment (informational-only fact) | Δ |
|---|---|---|---|
| feature flags | **build custom** | **`@acme/flags`** | DIY → internal (own judgment) |
| auth / session | **build custom** | **`@acme/session-core`** | DIY → internal (own judgment) |

With no facts the agent reaches for **build custom** for both — including a hand-rolled, unaudited auth layer. Given only the *information* that an active internal library exists, with no instruction to prefer it, it **still** picks the internal library. **2/2 flipped, DIY → internal, on information alone** — and it survives the tautology check.

### Public packages — the weak case, reported honestly

Claude's public recall is strong, so most of the time facts simply *agree* with what it already knew. We say so rather than hide it:

| Package | Control | Treatment (+facts) | Read |
|---|---|---|---|
| `zod`, `fastify` | ADOPT | ADOPT | healthy decoys — **no spurious flip** ✅ |
| `posthog-node` | ADOPT | ADOPT **+ "pin away from malicious 4.18.1 / 5.11.3 / 5.13.3"** | **action changed** — post-cutoff advisory `MAL-2025-190925` the model can't know |
| `node-cache` | AVOID | ADOPT | changed, but **ambiguous** — no ground truth, so **not** counted as a win |

The one clean, information-carrying public change is `posthog-node`: a supply-chain pin from **after the training cutoff**. The decoys didn't flip — the agent isn't rubber-stamping the tool.

---

## 3. The statistical backbone

The before/after above confirms the *mechanism* on real model calls (single-rep, confirms direction). The powered claim is a prior benchmark across **four model vendors**: correct adopt/avoid decisions moved **~20% → ~78%**, with **100% unprompted adoption** when the facts are available — strongest on packages the model can't recall.

---

## Honest scope

- **Public packages are a weak venue** — by design. Claude's public recall is good, so facts shine where the model *can't* recall: private libraries and anything after the cutoff.
- The before/after is a **single-rep** confirmation of direction; the statistical claim is the prior powered benchmark, not re-run here.
- `node-cache` is **not** counted as a win (ambiguous, no ground truth). A tool that books every change as a victory is lying to you.
- The directive-policy private result (an explicit "must use" org policy → 2/2) is a real **policy-obedience** feature, but is *not* counted as decision-change evidence — it's tautological.

`@acme/*` packages are synthetic stand-ins for the private-library case the model structurally cannot know.
