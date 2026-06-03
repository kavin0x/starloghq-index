import {
  L3RuleSchema,
  L3PolicySchema,
  type L2Overlay,
  type L3Rule,
  type L3Policy,
  type Vuln,
} from '@starloghq/facts-schema';
import { parseOverlay } from './l2-source.js';

/**
 * PURE authoring layer — constructs schema-valid L2 overlays and L3 rules from
 * minimal CLI input, and upserts them into the on-disk file shapes the loaders
 * read. NO file I/O, NO env reads, NO CLI here (plan 11-02 wires these to
 * commander + atomicWrite).
 *
 * This is the seam that makes AUTH-02 (defaults fill the required L2 fields so
 * minimal `{license,status}` input validates against L2OverlaySchema) and
 * AUTH-04 (clear, actionable errors — never a silent default/skip) true and
 * unit-testable before any spawned-binary e2e.
 */

const MAINTENANCE = ['active', 'maintenance-only', 'deprecated', 'abandoned', 'compromised'] as const;
const LICENSE_RISK = ['none', 'copyleft-weak', 'copyleft-strong', 'unknown'] as const;
const SEVERITY = ['low', 'medium', 'high', 'critical'] as const;
const ECOSYSTEMS = ['npm', 'pypi', 'system'] as const;
const DECISIONS = ['allow', 'deny', 'flag'] as const;

/** Today as a YYYY-MM-DD date. MUST be slice(0,10) — z.iso.date() rejects a full timestamp. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface AddL2Input {
  package: string;
  license?: string;
  status?: string;
  ecosystem?: string;
  licenseRisk?: string;
  transitiveRisk?: string;
  vulns?: string[];
}

/**
 * Parse a `--vuln id:severity:summary` string. Splits on the FIRST TWO colons
 * only, so the summary may itself contain colons. `affected` defaults to
 * 'unspecified' (the flag is intentionally terse; refine via a full file later).
 */
export function parseVulnFlag(s: string): Vuln {
  const i = s.indexOf(':');
  const j = s.indexOf(':', i + 1);
  if (i === -1 || j === -1) {
    throw new Error(`Invalid --vuln "${s}": expected id:severity:summary (e.g. CVE-2024-1:high:RCE in parser).`);
  }
  const id = s.slice(0, i);
  const severity = s.slice(i + 1, j);
  const summary = s.slice(j + 1);
  if (!(SEVERITY as readonly string[]).includes(severity)) {
    throw new Error(`Invalid vuln severity "${severity}": use one of: ${SEVERITY.join(', ')}.`);
  }
  return { id, severity: severity as Vuln['severity'], affected: 'unspecified', summary };
}

/**
 * Build a schema-valid L2 overlay from minimal input, filling the required
 * fields with documented defaults. Throws a clear, actionable Error (AUTH-04)
 * on missing/invalid input rather than silently defaulting.
 */
export function buildL2FromInput(input: AddL2Input): L2Overlay {
  const license = input.license;
  if (!license) {
    throw new Error('Missing --license <spdx> (e.g. --license MIT). A private fact needs a license to be useful.');
  }
  const status = input.status;
  if (!status) {
    throw new Error('Missing --status <maintenance> — one of: ' + MAINTENANCE.join(', '));
  }
  if (!(MAINTENANCE as readonly string[]).includes(status)) {
    throw new Error('Invalid --status "' + status + '" — use one of: ' + MAINTENANCE.join(', '));
  }

  const licenseRisk = input.licenseRisk ?? 'none';
  if (!(LICENSE_RISK as readonly string[]).includes(licenseRisk)) {
    throw new Error('Invalid --license-risk "' + licenseRisk + '" — use one of: ' + LICENSE_RISK.join(', '));
  }

  const ecosystem = input.ecosystem ?? 'npm';
  if (!(ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
    throw new Error('Invalid --ecosystem "' + ecosystem + '" — use one of: ' + ECOSYSTEMS.join(', '));
  }

  const known_vulns = (input.vulns ?? []).map(parseVulnFlag);

  const candidate = {
    package: input.package,
    ecosystem,
    known_vulns,
    license,
    license_risk: licenseRisk,
    maintenance: status,
    transitive_risk: input.transitiveRisk ?? null,
    attestation: { source: 'hand', refs: [], fetched_at: today() },
  };

  // Proves AUTH-02 at the function layer: minimal input must validate.
  const overlay = parseOverlay(candidate);
  if (!overlay) throw new Error('Internal: constructed L2 overlay failed schema validation.');
  return overlay;
}

export interface PrivateFactsFile {
  l1: unknown[];
  l2: L2Overlay[];
}

/**
 * Upsert an L2 overlay into the `{ l1, l2 }` private-facts file shape. l1 and
 * unrelated l2 entries are preserved; the same-package l2 entry is replaced.
 * An absent/empty/malformed file object yields `{ l1: [], l2: [overlay] }`.
 */
export function upsertL2Entry(
  file: { l1?: unknown[]; l2?: unknown[] } | null | undefined,
  overlay: L2Overlay,
): { l1: unknown[]; l2: L2Overlay[] } {
  const l1 = Array.isArray(file?.l1) ? file!.l1 : [];
  const existing = (Array.isArray(file?.l2) ? file!.l2 : []) as L2Overlay[];
  const filtered = existing.filter((o) => o.package !== overlay.package);
  return { l1, l2: [...filtered, overlay] };
}

/** Stable rule id for a package — re-running policy UPSERTS, never duplicates. */
export function ruleIdFor(pkg: string): string {
  return 'pkg-' + pkg;
}

/**
 * Build a schema-valid L3 rule from a package + verdict (+ optional reason).
 * Throws a clear Error (AUTH-04) on a bad verdict.
 */
export function buildL3Rule(pkg: string, decision: string, reason?: string): L3Rule {
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    throw new Error('Invalid verdict "' + decision + '" — use one of: allow, deny, flag');
  }
  const candidate = {
    id: ruleIdFor(pkg),
    decision,
    match: { package: pkg },
    rationale: reason && reason.trim() ? reason : 'Set via starlog facts policy.',
  };
  const r = L3RuleSchema.safeParse(candidate);
  if (!r.success) throw new Error('Internal: constructed L3 rule failed schema validation.');
  return r.data;
}

/**
 * Upsert an L3 rule into the `{ org, rules }` policy file shape. The org field
 * and unrelated rules are preserved; the rule with the same id is replaced. A
 * null/absent policy yields `{ org: 'local', rules: [rule] }`.
 */
export function upsertPolicy(
  policy: { org?: string; rules?: unknown[] } | null | undefined,
  rule: L3Rule,
): L3Policy {
  const org = policy?.org && typeof policy.org === 'string' ? policy.org : 'local';
  const existing = (Array.isArray(policy?.rules) ? policy!.rules : []) as L3Rule[];
  const filtered = existing.filter((r) => r.id !== rule.id);
  const p = L3PolicySchema.safeParse({ org, rules: [...filtered, rule] });
  if (!p.success) throw new Error('Internal: constructed L3 policy failed schema validation.');
  return p.data;
}
