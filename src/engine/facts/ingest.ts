import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Ecosystem, L2Overlay, Vuln } from '@starloghq/facts-schema';
import { assembleL2 } from './authoring.js';

/**
 * INGEST primitives — the org-ingest derivation layer (see .planning/org-ingest-analysis.md):
 * derive a schema-valid L2 overlay (+ discovery signals) for ONE published package from a
 * local checkout, stamped with the honest attestation.source 'analyzer' (NOT 'hand', which
 * buildL2FromInput hardcodes). Pure, deterministic helpers + thin checkout readers; no
 * network, no LLM, source never leaves the machine. Vuln/transitive_risk (osv-scanner) is
 * still deferred to a follow-up.
 */

export type LicenseRisk = L2Overlay['license_risk'];
export type Maintenance = L2Overlay['maintenance'];

/**
 * Deterministic SPDX → license_risk classification. Conservative: anything missing,
 * proprietary, or unrecognized is 'unknown' — never a false 'none'. AGPL/LGPL are
 * checked before the bare GPL match (they contain 'GPL' as a substring).
 */
export function spdxToLicenseRisk(spdx: string | null | undefined): LicenseRisk {
  if (!spdx) return 'unknown';
  const s = spdx.trim().toUpperCase();
  if (!s || s === 'UNLICENSED' || s.startsWith('SEE LICENSE')) return 'unknown';

  const permissive = ['MIT', 'APACHE-2.0', 'APACHE', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'BSD', 'ISC', '0BSD', 'UNLICENSE'];
  if (permissive.some((p) => s === p || s.startsWith(p + '-') || s === p)) return 'none';

  if (s.startsWith('AGPL')) return 'copyleft-strong';
  if (s.startsWith('LGPL')) return 'copyleft-weak';
  if (s.startsWith('MPL')) return 'copyleft-weak';
  if (s.startsWith('GPL')) return 'copyleft-strong';

  return 'unknown';
}

export interface ActivitySignals {
  archived?: boolean;
  deprecated?: boolean;
  lastCommitDaysAgo?: number | null;
}

const MAINTENANCE_ONLY_DAYS = 180; // ~6mo without a commit → maintenance-only
const ABANDONED_DAYS = 540; // ~18mo without a commit → abandoned (heuristic; flag for human review)

/**
 * Heuristic maintenance status from repo signals. Hard signals (archived repo /
 * package.json `deprecated`) are deterministic → 'deprecated'. Otherwise grade on
 * commit recency, defaulting to 'active' when recency is unknown (no false 'abandoned').
 */
export function maintenanceFromActivity(signals: ActivitySignals): Maintenance {
  if (signals.deprecated || signals.archived) return 'deprecated';
  const days = signals.lastCommitDaysAgo;
  if (days == null) return 'active';
  if (days >= ABANDONED_DAYS) return 'abandoned';
  if (days >= MAINTENANCE_ONLY_DAYS) return 'maintenance-only';
  return 'active';
}

/**
 * Resolve a package's identity from its package.json. A named manifest → (name, npm).
 * No name (private/unpublishable) → null: we DEFER synthetic keys rather than fabricate
 * identity the read path can't resolve (resolvePackage is exact-name-only by design).
 */
export function packageIdentityFromManifest(pkgJson: unknown): { package: string; ecosystem: 'npm' } | null {
  if (!pkgJson || typeof pkgJson !== 'object') return null;
  const name = (pkgJson as { name?: unknown }).name;
  if (typeof name !== 'string' || name.trim() === '') return null;
  return { package: name, ecosystem: 'npm' };
}

export interface DerivedL2Input {
  package: string;
  ecosystem?: Ecosystem;
  license: string;
  licenseRisk?: LicenseRisk;
  maintenance: Maintenance;
  knownVulns?: Vuln[];
  transitiveRisk?: string | null;
  /** Injected ISO date (YYYY-MM-DD) — the freshness gate. Caller stamps it (e.g. today()). */
  fetchedAt: string;
}

/**
 * Construct a schema-valid L2 overlay with the honest attestation.source 'analyzer'
 * — the analyzer twin of buildL2FromInput (which is locked to source 'hand'). Both
 * route through the shared assembleL2 seam; license_risk is derived from the license
 * when not given. Throws a clear, actionable Error (surfacing the schema's own
 * message, e.g. for a bad fetched_at) rather than emitting an unparseable fact.
 */
export function buildDerivedL2(input: DerivedL2Input): L2Overlay {
  // The analyzer twin of buildL2FromInput: derive license_risk from the license
  // when not given, stamp source='analyzer', then construct + validate through the
  // shared assembleL2 seam (single source of truth for L2 shape + validation).
  return assembleL2({
    package: input.package,
    ecosystem: input.ecosystem,
    license: input.license,
    licenseRisk: input.licenseRisk ?? spdxToLicenseRisk(input.license),
    maintenance: input.maintenance,
    knownVulns: input.knownVulns,
    transitiveRisk: input.transitiveRisk,
    source: 'analyzer',
    fetchedAt: input.fetchedAt,
  });
}

/**
 * The `[project]` table body of a pyproject.toml (PEP 621) — from the `[project]`
 * header up to the next table header. name/license/classifiers live here, before
 * any `[project.*]` subtable, so this is enough to read them without a full TOML
 * parser (zero new deps). Returns '' when there is no `[project]` table.
 */
function pyprojectSection(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[project\]\s*$/.test(l));
  if (start === -1) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break; // next table (incl. [project.*]) ends the main body
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** Common cookiecutter/placeholder descriptions that carry no real meaning. */
function isPlaceholderDescription(s: string): boolean {
  return /^add your description here\.?$/i.test(s.trim());
}

/** A usable one-line "what it does" from package.json, or null (empty/placeholder/missing). */
export function descriptionFromManifest(pkgJson: unknown): string | null {
  if (!pkgJson || typeof pkgJson !== 'object') return null;
  const d = (pkgJson as { description?: unknown }).description;
  if (typeof d !== 'string' || !d.trim() || isPlaceholderDescription(d)) return null;
  return d.trim();
}

/** keywords[] from package.json (strings only), or []. */
export function keywordsFromManifest(pkgJson: unknown): string[] {
  if (!pkgJson || typeof pkgJson !== 'object') return [];
  const k = (pkgJson as { keywords?: unknown }).keywords;
  return Array.isArray(k) ? k.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

export function packageIdentityFromPyproject(text: string): { package: string; ecosystem: 'pypi' } | null {
  const m = /^\s*name\s*=\s*"([^"]+)"/m.exec(pyprojectSection(text));
  return m && m[1].trim() ? { package: m[1], ecosystem: 'pypi' } : null;
}

/** A usable [project].description from pyproject.toml, or null. */
export function descriptionFromPyproject(text: string): string | null {
  const m = /^\s*description\s*=\s*"([^"]*)"/m.exec(pyprojectSection(text));
  if (!m || !m[1].trim() || isPlaceholderDescription(m[1])) return null;
  return m[1].trim();
}

/** keywords[] from a pyproject [project].keywords array (inline or multiline), or []. */
export function keywordsFromPyproject(text: string): string[] {
  const section = pyprojectSection(text);
  const arr = /^\s*keywords\s*=\s*\[([\s\S]*?)\]/m.exec(section);
  if (!arr) return [];
  return [...arr[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Map an OSI "License :: OSI Approved :: <X>" classifier string to an SPDX id. */
function classifierToSpdx(c: string): string | null {
  if (/\bMIT\b/.test(c)) return 'MIT';
  if (/Apache/i.test(c)) return 'Apache-2.0';
  if (/\bISC\b/.test(c)) return 'ISC';
  if (/\bBSD\b/.test(c)) return 'BSD-3-Clause';
  if (/Affero|AGPL/i.test(c)) return 'AGPL-3.0';
  if (/Lesser|LGPL/i.test(c)) return 'LGPL-3.0';
  if (/General Public|GPL/i.test(c)) return 'GPL-3.0';
  if (/Mozilla|MPL/i.test(c)) return 'MPL-2.0';
  return null;
}

/**
 * Read the declared license from a pyproject.toml [project] table: the SPDX string
 * form (`license = "MIT"`), the inline-table text form (`{ text = "..." }`), else the
 * first recognized OSI classifier. A `{ file = "..." }` ref is NOT read (we don't crack
 * the file open here) → null. Null means "none declared" — the caller treats it as
 * UNLICENSED so it never becomes a false 'none'.
 */
export function licenseFromPyproject(text: string): string | null {
  const section = pyprojectSection(text);
  if (!section) return null;

  const str = /^\s*license\s*=\s*"([^"]+)"/m.exec(section);
  if (str) return str[1];

  const inlineText = /^\s*license\s*=\s*\{[^}]*\btext\s*=\s*"([^"]+)"/m.exec(section);
  if (inlineText) return inlineText[1];

  for (const m of section.matchAll(/License :: OSI Approved :: ([^"]+)"/g)) {
    const spdx = classifierToSpdx(m[1]);
    if (spdx) return spdx;
  }
  return null;
}

export interface SuggestedRule {
  decision: 'flag';
  signal: string;
  rationale: string;
}

/**
 * PREVIEW → SHIPPED: turn the REAL L2 signals into candidate L3 rules. Conservative
 * by design — always 'flag', never auto-'deny' (a deny is the org's deliberate call,
 * never a derived default). These are PROPOSALS; the caller decides whether to apply
 * them, preserving the no-collapse invariant (policy is org-owned).
 */
export function suggestL3Rules(overlay: L2Overlay): SuggestedRule[] {
  const out: SuggestedRule[] = [];
  if (overlay.maintenance === 'deprecated' || overlay.maintenance === 'abandoned') {
    out.push({ decision: 'flag', signal: `maintenance: ${overlay.maintenance}`, rationale: `Internal package is ${overlay.maintenance}; assign an owner or migrate off it.` });
  }
  if (overlay.license_risk === 'copyleft-strong') {
    out.push({ decision: 'flag', signal: 'license_risk: copyleft-strong', rationale: `${overlay.license} is strong copyleft; legal review before shipping in a proprietary product.` });
  }
  if (overlay.license_risk === 'unknown') {
    out.push({ decision: 'flag', signal: 'license_risk: unknown', rationale: 'No clear license; resolve licensing before depending on this internally.' });
  }
  if (overlay.known_vulns.length > 0) {
    out.push({ decision: 'flag', signal: 'has_known_vulns', rationale: 'Known vulnerabilities/incidents on file; review before use.' });
  }
  return out;
}

export interface DeriveOptions {
  /** Injected ISO date (YYYY-MM-DD). */
  fetchedAt: string;
  /** From the GitHub repo metadata (enumeration step); absent in the bare-checkout case. */
  archived?: boolean;
  lastCommitDaysAgo?: number | null;
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Identify an SPDX license from the TEXT of a LICENSE file by its well-known header.
 * Conservative: returns null on anything unrecognized (never a false positive). The
 * GPL family is version-aware and ordered so AGPL/LGPL are matched before bare GPL
 * (both contain "general public license").
 */
export function detectLicenseFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const head = text.slice(0, 3000);
  if (/affero general public license/i.test(head)) return 'AGPL-3.0';
  if (/lesser general public license/i.test(head)) return 'LGPL-3.0';
  if (/general public license/i.test(head)) return /version 2/i.test(head) ? 'GPL-2.0' : 'GPL-3.0';
  if (/apache license/i.test(head)) return 'Apache-2.0';
  if (/mozilla public license/i.test(head)) return 'MPL-2.0';
  if (/\bISC License\b/i.test(head)) return 'ISC';
  if (/\bMIT License\b/i.test(head) || /permission is hereby granted, free of charge/i.test(head)) return 'MIT';
  if (/\bBSD\b/.test(head) && /redistribution and use/i.test(head)) return 'BSD-3-Clause';
  return null;
}

/** Read a checkout's LICENSE/LICENCE/COPYING file (any extension), or null if none. */
function readLicenseFile(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const match = entries.find((e) => /^(licen[sc]e|copying)(\..+)?$/i.test(e));
  return match ? readTextIfPresent(join(dir, match)) : null;
}

/** What a single checkout yields: the L2 overlay (vetting) plus the discovery
 *  signals (solves/keywords) that make the package KNOWN and findable, not just
 *  vettable-by-name. `solves` is null when the manifest declares no usable
 *  description — the caller treats that as "not discoverable, prompt for one". */
export interface DerivedPackage {
  overlay: L2Overlay;
  solves: string | null;
  keywords: string[];
}

/**
 * Derive everything we can from a local checkout in ONE pass. Tries npm
 * (package.json) first, then pypi (pyproject.toml) — npm wins when both are
 * present. Returns null when there is no published identity (never emit under a
 * key the exact-match read path can't resolve). A missing/unrecognized license
 * falls back to 'UNLICENSED' → license_risk 'unknown' (never a false 'none').
 */
export function derivePackageFromCheckout(dir: string, opts: DeriveOptions): DerivedPackage | null {
  const maintenance = (extra?: { deprecated?: boolean }) =>
    maintenanceFromActivity({ ...extra, archived: opts.archived, lastCommitDaysAgo: opts.lastCommitDaysAgo });

  // npm
  const pkgJson = readPackageJson(dir);
  const npmId = packageIdentityFromManifest(pkgJson);
  if (npmId && pkgJson) {
    const declared = pkgJson.license;
    const license =
      (typeof declared === 'string' && declared.trim() ? declared : null) ??
      detectLicenseFromText(readLicenseFile(dir)) ??
      'UNLICENSED';
    return {
      overlay: buildDerivedL2({
        package: npmId.package,
        ecosystem: npmId.ecosystem,
        license,
        maintenance: maintenance({ deprecated: Boolean(pkgJson.deprecated) }),
        fetchedAt: opts.fetchedAt,
      }),
      solves: descriptionFromManifest(pkgJson),
      keywords: keywordsFromManifest(pkgJson),
    };
  }

  // pypi (PEP 621 pyproject.toml)
  const pyproject = readTextIfPresent(join(dir, 'pyproject.toml'));
  if (pyproject) {
    const pyId = packageIdentityFromPyproject(pyproject);
    if (pyId) {
      return {
        overlay: buildDerivedL2({
          package: pyId.package,
          ecosystem: pyId.ecosystem,
          license: licenseFromPyproject(pyproject) ?? detectLicenseFromText(readLicenseFile(dir)) ?? 'UNLICENSED',
          maintenance: maintenance(),
          fetchedAt: opts.fetchedAt,
        }),
        solves: descriptionFromPyproject(pyproject),
        keywords: keywordsFromPyproject(pyproject),
      };
    }
  }

  return null;
}

/** Back-compat / facts-only convenience: just the L2 overlay from a checkout. */
export function deriveL2FromCheckout(dir: string, opts: DeriveOptions): L2Overlay | null {
  return derivePackageFromCheckout(dir, opts)?.overlay ?? null;
}
