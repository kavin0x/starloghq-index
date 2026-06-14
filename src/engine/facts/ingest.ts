import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { L2OverlaySchema, type Ecosystem, type L2Overlay, type Vuln } from '@starloghq/facts-schema';

/**
 * INGEST primitives — the first slice of org-ingest (see .planning/org-ingest-analysis.md):
 * derive a schema-valid L2 overlay for ONE published package from a local checkout,
 * stamped with the honest attestation.source 'analyzer' (NOT 'hand', which buildL2FromInput
 * hardcodes). Pure, deterministic helpers + one thin checkout reader; no network, no LLM,
 * source never leaves the machine. Vuln/transitive_risk (osv-scanner) and LICENSE-file
 * detection (licensee) are deliberately deferred to a follow-up — this proves the emit seam.
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
 * Construct a schema-valid L2 overlay DIRECTLY against L2OverlaySchema with the honest
 * attestation.source 'analyzer' — the analyzer twin of buildL2FromInput (which is locked
 * to source 'hand'). license_risk is derived from the license when not given. Throws a
 * clear, actionable Error (surfacing the schema's own message, e.g. for a bad fetched_at)
 * rather than emitting an unparseable fact.
 */
export function buildDerivedL2(input: DerivedL2Input): L2Overlay {
  const candidate = {
    package: input.package,
    ecosystem: input.ecosystem ?? 'npm',
    known_vulns: input.knownVulns ?? [],
    license: input.license,
    license_risk: input.licenseRisk ?? spdxToLicenseRisk(input.license),
    maintenance: input.maintenance,
    transitive_risk: input.transitiveRisk ?? null,
    attestation: { source: 'analyzer', refs: [], fetched_at: input.fetchedAt },
  };
  const r = L2OverlaySchema.safeParse(candidate);
  if (!r.success) {
    const why = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error('Could not construct a valid L2 overlay: ' + why);
  }
  return r.data;
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

/**
 * Derive an L2 overlay from a local checkout directory (the quick-win path: one repo,
 * one published npm package). Returns null when the checkout has no published identity —
 * we never emit a fact under a key the read path can't resolve. License comes from
 * package.json.license (string), falling back to 'UNLICENSED' → license_risk 'unknown'.
 */
export function deriveL2FromCheckout(dir: string, opts: DeriveOptions): L2Overlay | null {
  const pkgJson = readPackageJson(dir);
  const identity = packageIdentityFromManifest(pkgJson);
  if (!identity || !pkgJson) return null;

  const declared = pkgJson.license;
  const license = typeof declared === 'string' && declared.trim() ? declared : 'UNLICENSED';
  const maintenance = maintenanceFromActivity({
    deprecated: Boolean(pkgJson.deprecated),
    archived: opts.archived,
    lastCommitDaysAgo: opts.lastCommitDaysAgo,
  });

  return buildDerivedL2({
    package: identity.package,
    ecosystem: identity.ecosystem,
    license,
    maintenance,
    fetchedAt: opts.fetchedAt,
  });
}
