#!/usr/bin/env tsx
/**
 * Generates a small multi-page static site that walks through the org-ingest
 * automation END-TO-END, driven by REAL output from the shipped code:
 *   - deriveL2FromCheckout / packageIdentityFromManifest  (src/engine/facts/ingest.ts)
 *   - upsertL2Entry / buildL3Rule / upsertPolicy          (src/engine/facts/authoring.ts)
 *   - buildComposeDeps / resolveFactView                  (src/engine/facts/service.ts)
 *   - formatFactView                                       (src/engine/facts/format.ts)
 *
 * Stages that are NOT yet shipped (GitHub enumeration, L1 analyzer, hosted push)
 * are clearly badged PLANNED and never faked into the real artifacts.
 *
 * Run:  npx tsx scripts/demo-org-ingest-site.ts
 * Out:  demo/org-ingest-site/*.html
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveL2FromCheckout, packageIdentityFromManifest, suggestL3Rules, type SuggestedRule } from '../src/engine/facts/ingest.js';
import { upsertL2Entry, buildL3Rule, upsertPolicy, today } from '../src/engine/facts/authoring.js';
import { buildComposeDeps, resolveFactView } from '../src/engine/facts/service.js';
import { formatFactView } from '../src/engine/facts/format.js';
import type { L2Overlay, L3Policy } from '@starloghq/facts-schema';

const OUT_DIR = join(process.cwd(), 'demo', 'org-ingest-site');
const FETCHED_AT = today();

// ── Fixture: a private GitHub org "acme" as the enumeration step WOULD return it ──
interface RepoFixture {
  repo: string;
  archived: boolean;
  lastCommitDaysAgo: number;
  pkg: Record<string, unknown>;
  capabilitiesPreview: string[]; // PLANNED L1 analyzer output — illustrative only
}

const REPOS: RepoFixture[] = [
  { repo: 'acme/auth-tokens', archived: false, lastCommitDaysAgo: 12,
    pkg: { name: '@acme/auth-tokens', version: '2.3.1', license: 'Apache-2.0' },
    capabilitiesPreview: ['auth-path', 'crypto'] },
  { repo: 'acme/billing-legacy', archived: true, lastCommitDaysAgo: 540,
    pkg: { name: '@acme/billing-legacy', version: '1.0.0', license: 'GPL-3.0-only' },
    capabilitiesPreview: ['network', 'filesystem'] },
  { repo: 'acme/data-pipeline', archived: false, lastCommitDaysAgo: 700,
    pkg: { name: '@acme/data-pipeline', version: '0.9.0' /* no license declared */ },
    capabilitiesPreview: ['network', 'child-process'] },
  { repo: 'acme/ui-kit', archived: false, lastCommitDaysAgo: 200,
    pkg: { name: '@acme/ui-kit', version: '4.1.0', license: 'MIT' },
    capabilitiesPreview: ['dom'] },
  { repo: 'acme/internal-scripts', archived: false, lastCommitDaysAgo: 30,
    pkg: { private: true /* NO name — unpublishable */ },
    capabilitiesPreview: [] },
];

// ── Derivation reasoning (for display only — mirrors the real code's branches) ──
function licenseReason(o: L2Overlay): string {
  const map: Record<string, string> = {
    none: 'permissive SPDX → safe to use',
    'copyleft-weak': 'weak copyleft (MPL/LGPL) → file-level obligations',
    'copyleft-strong': 'strong copyleft (GPL/AGPL) → review before proprietary use',
    unknown: 'no/unrecognized license → resolve before depending',
  };
  return `${o.license} → ${o.license_risk} (${map[o.license_risk]})`;
}
function maintReason(r: RepoFixture, o: L2Overlay): string {
  if (r.archived) return `repo archived → ${o.maintenance}`;
  if (o.maintenance === 'abandoned') return `last commit ${r.lastCommitDaysAgo}d ago (≥540) → abandoned`;
  if (o.maintenance === 'maintenance-only') return `last commit ${r.lastCommitDaysAgo}d ago (≥180) → maintenance-only`;
  return `last commit ${r.lastCommitDaysAgo}d ago → active`;
}

// L3 suggester is now SHIPPED code (src/engine/facts/ingest.ts) — call it directly.

export interface Row {
  fix: RepoFixture;
  identity: { package: string; ecosystem: 'npm' } | null;
  overlay: L2Overlay | null;
  suggestions: SuggestedRule[];
  agentMarkdown: string;
  verdictFired: boolean;
}

async function runPipeline(): Promise<{ rows: Row[]; privateFacts: { l1: unknown[]; l2: L2Overlay[] }; policy: L3Policy }> {
  const work = mkdtempSync(join(tmpdir(), 'starlog-site-'));
  const rows: Row[] = [];
  let privateFacts: { l1: unknown[]; l2: L2Overlay[] } = { l1: [], l2: [] };
  let policy: L3Policy | null = null;

  // 1) Identity + 2) derive L2 (REAL), folding into the emitted artifacts.
  for (const fix of REPOS) {
    const dir = join(work, fix.repo.replace('/', '__'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(fix.pkg));

    const identity = packageIdentityFromManifest(fix.pkg);
    const overlay = deriveL2FromCheckout(dir, { fetchedAt: FETCHED_AT, archived: fix.archived, lastCommitDaysAgo: fix.lastCommitDaysAgo });

    const suggestions = overlay ? suggestL3Rules(overlay) : [];
    if (overlay) {
      privateFacts = upsertL2Entry(privateFacts, overlay);
      if (suggestions.length > 0) {
        const rationale = suggestions.map((s) => s.rationale).join(' ');
        policy = upsertPolicy(policy, buildL3Rule(overlay.package, 'flag', rationale));
      }
    }
    rows.push({ fix, identity, overlay, suggestions, agentMarkdown: '', verdictFired: false });
  }

  // 5) Emit artifacts to disk, then 6) resolve through the REAL serve path.
  const factsPath = join(work, 'private-facts.json');
  const policyPath = join(work, 'policy.json');
  writeFileSync(factsPath, JSON.stringify(privateFacts, null, 2));
  if (policy) writeFileSync(policyPath, JSON.stringify(policy, null, 2));

  const deps = buildComposeDeps({
    STARLOG_PRIVATE_FACTS: factsPath,
    ...(policy ? { STARLOG_POLICY: policyPath } : {}),
  } as NodeJS.ProcessEnv);

  for (const row of rows) {
    if (!row.identity) continue;
    const view = await resolveFactView(row.identity.package, { local: deps, api: null });
    row.agentMarkdown = formatFactView(row.identity.package, view);
    row.verdictFired = !!view && view.l3.decision !== 'none';
  }

  rmSync(work, { recursive: true, force: true });
  return { rows, privateFacts, policy: policy ?? { org: 'local', rules: [] } };
}

// ── tiny html helpers ──
export const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export { runPipeline, FETCHED_AT, OUT_DIR };

// ── site structure ──
interface Page { slug: string; n: number | null; nav: string; title: string; }
const PAGES: Page[] = [
  { slug: 'index', n: null, nav: 'Overview', title: 'Org-ingest, end to end' },
  { slug: '1-enumerate', n: 1, nav: 'Enumerate', title: 'Enumerate the private org' },
  { slug: '2-identify', n: 2, nav: 'Identify', title: 'Resolve package identity' },
  { slug: '3-derive', n: 3, nav: 'Derive L2', title: 'Derive the L2 overlay' },
  { slug: '4-suggest', n: 4, nav: 'Suggest L3', title: 'Suggest org policy' },
  { slug: '5-emit', n: 5, nav: 'Emit', title: 'Emit the facts artifacts' },
  { slug: '6-agent', n: 6, nav: 'Agent view', title: 'What the agent sees' },
];

const badge = (kind: 'shipped' | 'planned' | 'preview') => {
  const label = { shipped: 'SHIPPED', planned: 'PLANNED', preview: 'PREVIEW' }[kind];
  return `<span class="badge ${kind}">${label}</span>`;
};

function shell(page: Page, body: string): string {
  const i = PAGES.findIndex((p) => p.slug === page.slug);
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];
  const nav = PAGES.map((p) => {
    const here = p.slug === page.slug ? ' aria-current="page"' : '';
    const step = p.n ? `<span class="step">${p.n}</span>` : `<span class="step home">★</span>`;
    return `<a class="navlink"${here} href="${p.slug}.html">${step}${esc(p.nav)}</a>`;
  }).join('');
  const pager = `<div class="pager">${
    prev ? `<a class="pg prev" href="${prev.slug}.html">← ${esc(prev.nav)}</a>` : '<span></span>'
  }${
    next ? `<a class="pg next" href="${next.slug}.html">${esc(next.nav)} →</a>` : '<span></span>'
  }</div>`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)} · Starlog org-ingest</title>
<link rel="stylesheet" href="styles.css"></head>
<body>
<header class="top">
  <a class="brand" href="index.html"><span class="logo">✦</span> Starlog <span class="sub">org-ingest</span></a>
  <span class="asof">generated ${esc(FETCHED_AT)} · real output from <code>src/engine/facts</code></span>
</header>
<nav class="stepper">${nav}</nav>
<main>
  <h1>${page.n ? `<span class="hn">${page.n}</span>` : ''}${esc(page.title)}</h1>
  ${body}
  ${pager}
</main>
<footer class="foot">
  <span class="badge shipped">SHIPPED</span> runs in the shipped code today (incl. <code>starlog org sync</code>) ·
  <span class="badge planned">PLANNED</span> next phase, not faked into artifacts
</footer>
</body></html>`;
}

const CSS = `:root{
  --bg:#0e0b16; --panel:#16121f; --panel2:#1d1830; --ink:#ece8f5; --mut:#9b93b5;
  --line:#2c2640; --purple:#8b5cf6; --purple2:#6e40c9; --orange:#ff6b35;
  --green:#3ecf8e; --amber:#f5a623; --blue:#5aa7ff;
}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink)}
code,pre{font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 22px;border-bottom:1px solid var(--line);background:linear-gradient(90deg,#1a1430,#120e1f)}
.brand{font-weight:700;font-size:18px;color:var(--ink)}
.brand:hover{text-decoration:none}
.logo{color:var(--orange)}
.brand .sub{color:var(--purple);font-weight:600;font-size:14px}
.asof{color:var(--mut);font-size:12px}
.asof code{color:var(--purple)}
.stepper{display:flex;flex-wrap:wrap;gap:6px;padding:12px 22px;border-bottom:1px solid var(--line);background:var(--panel)}
.navlink{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:8px;color:var(--mut);font-size:13px;font-weight:600;border:1px solid transparent}
.navlink:hover{background:var(--panel2);text-decoration:none;color:var(--ink)}
.navlink[aria-current]{background:var(--panel2);color:var(--ink);border-color:var(--purple2)}
.step{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--panel2);color:var(--purple);font-size:12px;border:1px solid var(--line)}
.step.home{color:var(--orange)}
main{max-width:1040px;margin:0 auto;padding:28px 22px 10px}
h1{font-size:26px;margin:6px 0 18px;display:flex;align-items:center;gap:12px}
h1 .hn{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--purple2),var(--orange));color:#fff;font-size:18px}
h2{font-size:17px;margin:26px 0 10px;color:var(--ink)}
p.lead{color:var(--mut);font-size:15px;max-width:72ch}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:14px 0}
.grid{display:grid;gap:14px}
.grid.two{grid-template-columns:1fr 1fr}
@media(max-width:820px){.grid.two{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin:8px 0}
th,td{text-align:left;padding:9px 11px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:none}
td.mono,code.k{font-family:'SF Mono',ui-monospace,Menlo,monospace;font-size:12.5px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:700;letter-spacing:.04em;vertical-align:middle}
.badge.shipped{background:rgba(62,207,142,.14);color:var(--green);border:1px solid rgba(62,207,142,.35)}
.badge.preview{background:rgba(90,167,255,.14);color:var(--blue);border:1px solid rgba(90,167,255,.35)}
.badge.planned{background:rgba(245,166,35,.14);color:var(--amber);border:1px solid rgba(245,166,35,.35)}
.pill{display:inline-block;padding:2px 9px;border-radius:6px;font-size:12px;font-weight:600}
.pill.none{background:rgba(62,207,142,.13);color:var(--green)}
.pill.weak{background:rgba(245,166,35,.13);color:var(--amber)}
.pill.strong,.pill.unknown{background:rgba(255,107,53,.14);color:var(--orange)}
.pill.active{background:rgba(62,207,142,.13);color:var(--green)}
.pill.maint{background:rgba(90,167,255,.13);color:var(--blue)}
.pill.dep,.pill.aband{background:rgba(255,107,53,.14);color:var(--orange)}
.pill.skip{background:rgba(155,147,181,.16);color:var(--mut)}
.pill.flag{background:rgba(245,166,35,.16);color:var(--amber)}
pre{background:#0a0712;border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;font-size:12.5px;line-height:1.55}
pre.json .k{color:var(--purple)}
.agent{background:#07060d;border:1px solid var(--purple2);border-radius:10px;padding:0;overflow:hidden}
.agent .bar{background:var(--panel2);padding:6px 12px;font-size:11px;color:var(--mut);border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
.agent pre{margin:0;border:none;border-radius:0;background:transparent}
.md-h{color:var(--orange);font-weight:700}
.md-k{color:var(--purple)}
.note{border-left:3px solid var(--purple2);padding:8px 14px;margin:12px 0;color:var(--mut);background:var(--panel);border-radius:0 8px 8px 0}
.note b{color:var(--ink)}
.pager{display:flex;justify-content:space-between;margin:28px 0 10px;gap:12px}
.pg{padding:10px 16px;border:1px solid var(--line);border-radius:9px;background:var(--panel);font-weight:600;font-size:13px}
.pg:hover{border-color:var(--purple2);text-decoration:none}
.foot{max-width:1040px;margin:10px auto 40px;padding:14px 22px;color:var(--mut);font-size:12px;border-top:1px solid var(--line)}
.flow{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;margin:16px 0}
.flow .node{flex:1;min-width:120px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center}
.flow .node .n{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.flow .node .t{font-weight:700;margin:4px 0 6px;font-size:14px}
.flow .arrow{align-self:center;color:var(--purple);font-size:18px}
.kv{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0}
.kv span{font-size:12px;color:var(--mut)}
ul.tight{margin:6px 0;padding-left:18px}
ul.tight li{margin:3px 0}`;

// light markdown → html for the agent output block
function mdToHtml(md: string): string {
  return esc(md)
    .split('\n')
    .map((ln) => {
      if (ln.startsWith('## ')) return `<span class="md-h">${ln.slice(3)}</span>`;
      return ln.replace(/\*\*(.+?):\*\*/g, '<span class="md-k">$1:</span>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    })
    .join('\n');
}

const riskPill = (r: string) => `<span class="pill ${ { 'none':'none','copyleft-weak':'weak','copyleft-strong':'strong','unknown':'unknown' }[r] ?? 'unknown'}">${esc(r)}</span>`;
const maintPill = (m: string) => `<span class="pill ${ { 'active':'active','maintenance-only':'maint','deprecated':'dep','abandoned':'aband' }[m] ?? 'maint'}">${esc(m)}</span>`;
const P = (page: Page, body: string) => writeFileSync(join(OUT_DIR, `${page.slug}.html`), shell(page, body));
const pageBy = (slug: string) => PAGES.find((p) => p.slug === slug)!;

function renderIndex(rows: Row[]) {
  const flow = [
    ['1', 'Enumerate', 'planned'], ['2', 'Identify', 'shipped'], ['3', 'Derive L2', 'shipped'],
    ['4', 'Suggest L3', 'shipped'], ['5', 'Emit', 'shipped'], ['6', 'Agent sees', 'shipped'],
  ].map((s, i, a) => `<div class="node"><div class="n">step ${s[0]}</div><div class="t">${s[1]}</div>${badge(s[2] as 'shipped')}</div>${i < a.length - 1 ? '<div class="arrow">→</div>' : ''}`).join('');
  const kept = rows.filter((r) => r.overlay).length;
  const skipped = rows.length - kept;
  const flagged = rows.filter((r) => r.verdictFired).length;
  P(pageBy('index'), `
<p class="lead">An org has hundreds of internal repos. Nobody is going to hand-author facts for each one. This walkthrough runs the <b>shipped</b> derive + serve code against a fixture private org <code class="k">acme</code> and shows the real output at every stage — so an AI coding agent vets your internal packages the same way it vets public ones.</p>
<div class="flow">${flow}</div>
<div class="grid two">
  <div class="card"><h2 style="margin-top:0">This run, by the numbers</h2>
    <table>
      <tr><td>Repos enumerated</td><td class="mono">${rows.length}</td></tr>
      <tr><td>Resolved to a package</td><td class="mono">${kept}</td></tr>
      <tr><td>Skipped (no published identity)</td><td class="mono">${skipped}</td></tr>
      <tr><td>L2 overlays derived <span class="badge shipped">SHIPPED</span></td><td class="mono">${kept}</td></tr>
      <tr><td>Policy verdicts that fired <span class="badge shipped">SHIPPED</span></td><td class="mono">${flagged}</td></tr>
    </table>
  </div>
  <div class="card"><h2 style="margin-top:0">What's real vs. planned</h2>
    <ul class="tight">
      <li>${badge('shipped')} identity, L2 derivation, emit, and the serve path are the <i>actual</i> functions in <code class="k">src/engine/facts</code>.</li>
      <li>${badge('shipped')} the L3 <i>suggester</i> is real code (<code class="k">suggestL3Rules</code>), run by <code class="k">starlog org sync</code> over a directory of checkouts.</li>
      <li>${badge('planned')} GitHub enumeration and the L1 capability analyzer are the next phase; never faked into the emitted artifacts.</li>
    </ul>
    <div class="note">Full plan: <code class="k">.planning/org-ingest-analysis.md</code> — chosen architecture <b>hybrid-local-then-action</b>.</div>
  </div>
</div>`);
}

function renderEnumerate(rows: Row[]) {
  const tr = rows.map((r) => `<tr>
    <td class="mono">${esc(r.fix.repo)}</td>
    <td>${r.fix.archived ? '<span class="pill dep">archived</span>' : '<span class="pill active">active</span>'}</td>
    <td class="mono">${r.fix.lastCommitDaysAgo}d</td>
    <td class="mono">${'name' in r.fix.pkg ? esc(r.fix.pkg.name) : '<span class="pill skip">private / no name</span>'}</td>
  </tr>`).join('');
  P(pageBy('1-enumerate'), `
<p class="lead">${badge('planned')} The first phase installs a GitHub App (or a fine-grained PAT) and lists the org's repos with the metadata the later stages need: the <code class="k">archived</code> flag and last-commit recency feed the maintenance call; source itself never leaves the runner.</p>
<div class="card">
  <table><thead><tr><th>repo</th><th>state</th><th>last commit</th><th>manifest name</th></tr></thead><tbody>${tr}</tbody></table>
</div>
<div class="note"><b>Source residency:</b> enumeration reads metadata only. Derivation (next stages) happens on a local checkout / CI runner — Starlog pushes <i>derived facts</i>, never your code.</div>`);
}

function renderIdentify(rows: Row[]) {
  const tr = rows.map((r) => {
    const got = r.identity ? `<span class="pill active">${esc(r.identity.package)}</span> <code class="k">${esc(r.identity.ecosystem)}</code>` : '<span class="pill skip">null — skipped</span>';
    const why = r.identity ? 'package.json has a name → keyed (name, npm)' : 'no name (private) → deferred, never fabricated';
    return `<tr><td class="mono">${esc(r.fix.repo)}</td><td>${got}</td><td style="color:var(--mut)">${esc(why)}</td></tr>`;
  }).join('');
  P(pageBy('2-identify'), `
<p class="lead">${badge('shipped')} <code class="k">packageIdentityFromManifest()</code> maps a repo's manifest to a <code class="k">(package, ecosystem)</code> key. Facts key on that pair, and the read path is exact-match-only — so a repo with no published name is <b>skipped</b> rather than written under a key the agent could never look up.</p>
<div class="card">
  <table><thead><tr><th>repo</th><th>identity</th><th>why</th></tr></thead><tbody>${tr}</tbody></table>
</div>
<div class="note"><b>Deferred honestly:</b> monorepos (N manifests → N packages) and synthetic keys for unpublished/git-URL deps are a later phase. This slice resolves published npm names only.</div>`);
}

function renderDerive(rows: Row[]) {
  const cards = rows.filter((r) => r.overlay).map((r) => {
    const o = r.overlay!;
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">${esc(o.package)}</h2><code class="k">${esc(o.attestation.source)} · as of ${esc(o.attestation.fetched_at)}</code></div>
      <table>
        <tr><td>license</td><td class="mono">${esc(o.license)}</td><td>→ ${riskPill(o.license_risk)}</td><td style="color:var(--mut)">${esc(licenseReason(o))}</td></tr>
        <tr><td>maintenance</td><td>${maintPill(o.maintenance)}</td><td></td><td style="color:var(--mut)">${esc(maintReason(r.fix, o))}</td></tr>
        <tr><td>known vulns</td><td class="mono">${o.known_vulns.length}</td><td colspan="2" style="color:var(--mut)">osv-scanner integration is ${badge('planned')} — this slice derives license + maintenance + identity</td></tr>
      </table>
      <div class="kv"><span>L1 capabilities ${badge('planned')}:</span> ${r.fix.capabilitiesPreview.map((c) => `<code class="k">${esc(c)}</code>`).join(' ') || '<i style="color:var(--mut)">none</i>'} <span>— illustrative; the analyzer is the next phase</span></div>
    </div>`;
  }).join('');
  P(pageBy('3-derive'), `
<p class="lead">${badge('shipped')} <code class="k">deriveL2FromCheckout()</code> reads the checkout and produces a schema-valid <code class="k">L2Overlay</code>, stamped <code class="k">source: "analyzer"</code> (the honest provenance label added in the Phase-0 schema change) and a real <code class="k">fetched_at</code> freshness date. Every value below is the function's actual output.</p>
${cards}
<div class="note"><b>Why <code class="k">analyzer</code>, not <code class="k">hand</code>:</b> a clone-derived fact must not masquerade as hand-curated. The enum member <code class="k">analyzer</code> was added to <code class="k">@starloghq/facts-schema</code> so the serve path accepts these without a provenance lie.</div>`);
}

function renderSuggest(rows: Row[]) {
  const tr = rows.filter((r) => r.overlay).map((r) => {
    const s = r.suggestions;
    const cell = s.length
      ? s.map((x) => `<div><span class="pill flag">flag</span> <code class="k">${esc(x.signal)}</code><div style="color:var(--mut);margin:2px 0 8px">${esc(x.rationale)}</div></div>`).join('')
      : '<span class="pill none">clean — no rule suggested</span>';
    return `<tr><td class="mono">${esc(r.overlay!.package)}</td><td>${cell}</td></tr>`;
  }).join('');
  P(pageBy('4-suggest'), `
<p class="lead">${badge('shipped')} <code class="k">suggestL3Rules()</code> turns the <i>real</i> L2 signals into candidate <code class="k">L3</code> rules — conservative (always <code class="k">flag</code>, never auto-<code class="k">deny</code>). <code class="k">starlog org sync</code> writes these to <code class="k">policy.json</code> as <b>proposals for human approval</b>, never auto-applied: the no-collapse invariant means policy is the org's call.</p>
<div class="card">
  <table><thead><tr><th>package</th><th>suggested policy</th></tr></thead><tbody>${tr}</tbody></table>
</div>
<div class="note"><b>Approved rules</b> compile to <code class="k">buildL3Rule()</code> / <code class="k">upsertPolicy()</code> — the same shipped authoring functions <code class="k">starlog facts policy</code> already uses. See the emitted <code class="k">policy.json</code> next.</div>`);
}

function renderEmit(privateFacts: { l1: unknown[]; l2: L2Overlay[] }, policy: L3Policy) {
  const facts = esc(JSON.stringify(privateFacts, null, 2));
  const pol = esc(JSON.stringify(policy, null, 2));
  P(pageBy('5-emit'), `
<p class="lead">${badge('shipped')} Approved facts fan into the on-disk shapes the loaders already read — built with <code class="k">upsertL2Entry()</code> and <code class="k">upsertPolicy()</code>. Point <code class="k">STARLOG_PRIVATE_FACTS</code> / <code class="k">STARLOG_POLICY</code> at these (Phase 1, local) — or push L2+L3 to the hosted API for team sharing (Phase 2).</p>
<div class="grid two">
  <div><h2><code class="k">private-facts.json</code> <span style="color:var(--mut);font-weight:400">→ STARLOG_PRIVATE_FACTS (agent reads)</span></h2><pre class="json">${facts}</pre></div>
  <div><h2><code class="k">policy.suggested.json</code> <span style="color:var(--mut);font-weight:400">→ proposals, agent does NOT read</span></h2><pre class="json">${pol}</pre></div>
</div>
<div class="note"><b>Propose, don't apply.</b> Facts go to the file the agent reads; suggested verdicts go to a <i>separate</i> proposal file that <code class="k">STARLOG_POLICY</code> does not load. They fire only once a human adopts them — regenerated fresh each sync, so a fixed package stops being flagged. <b>L1 stays local</b> too: the hosted API takes L2 + L3 only, so <code class="k">l1</code> is empty here.</div>`);
}

function renderAgent(rows: Row[]) {
  const cards = rows.filter((r) => r.identity).map((r) => `
    <div class="agent" style="margin:16px 0">
      <div class="bar"><span>$ starlog facts ${esc(r.identity!.package)}</span><span>${r.verdictFired ? '⚑ org policy fired' : 'no policy verdict'}</span></div>
      <pre>${mdToHtml(r.agentMarkdown)}</pre>
    </div>`).join('');
  P(pageBy('6-agent'), `
<p class="lead">${badge('shipped')} The payoff. Each block is the <i>exact</i> string <code class="k">resolveFactView()</code> + <code class="k">formatFactView()</code> return — the same serve path the <code class="k">starlog_facts</code> MCP tool and CLI use. The agent now sees license risk, maintenance, and the org's verdict on internal packages it has never been trained on.</p>
${cards}
<div class="note"><b>End to end, for real:</b> these came from resolving the emitted <code class="k">private-facts.json</code> through <code class="k">buildComposeDeps()</code> with no API key — pure local offline path. The <span class="pill flag">flag</span> verdicts shown reflect the suggested policy <i>after a human adopts it</i> (<code class="k">STARLOG_POLICY</code>); without adoption the agent still sees the facts, just no verdict.</div>`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const { rows, privateFacts, policy } = await runPipeline();
  writeFileSync(join(OUT_DIR, 'styles.css'), CSS);
  renderIndex(rows);
  renderEnumerate(rows);
  renderIdentify(rows);
  renderDerive(rows);
  renderSuggest(rows);
  renderEmit(privateFacts, policy);
  renderAgent(rows);
  console.log(`Wrote ${PAGES.length} pages + styles.css to ${OUT_DIR}`);
}

main();
