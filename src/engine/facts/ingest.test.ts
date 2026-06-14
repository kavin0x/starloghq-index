import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L2OverlaySchema } from '@starloghq/facts-schema';
import {
  spdxToLicenseRisk,
  maintenanceFromActivity,
  packageIdentityFromManifest,
  buildDerivedL2,
  deriveL2FromCheckout,
  suggestL3Rules,
  packageIdentityFromPyproject,
  licenseFromPyproject,
  descriptionFromManifest,
  descriptionFromPyproject,
  keywordsFromManifest,
  keywordsFromPyproject,
  derivePackageFromCheckout,
} from './ingest.js';
import { upsertL2Entry } from './authoring.js';
import { parseOverlay } from './l2-source.js';
import { buildComposeDeps, resolveFactView } from './service.js';

describe('spdxToLicenseRisk', () => {
  it('classifies permissive licenses as none', () => {
    for (const spdx of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']) {
      expect(spdxToLicenseRisk(spdx)).toBe('none');
    }
  });

  it('classifies weak copyleft (MPL/LGPL) as copyleft-weak', () => {
    for (const spdx of ['MPL-2.0', 'LGPL-3.0-only', 'LGPL-2.1']) {
      expect(spdxToLicenseRisk(spdx)).toBe('copyleft-weak');
    }
  });

  it('classifies strong copyleft (GPL/AGPL) as copyleft-strong', () => {
    for (const spdx of ['GPL-3.0-only', 'GPL-2.0', 'AGPL-3.0-only']) {
      expect(spdxToLicenseRisk(spdx)).toBe('copyleft-strong');
    }
  });

  it('returns unknown for missing/unrecognized/proprietary licenses — never a false "none"', () => {
    for (const spdx of [null, undefined, '', 'UNLICENSED', 'SEE LICENSE IN FILE', 'WTFPL-ish']) {
      expect(spdxToLicenseRisk(spdx)).toBe('unknown');
    }
  });
});

describe('maintenanceFromActivity', () => {
  it('maps an archived repo or a deprecated package to deprecated (deterministic signals)', () => {
    expect(maintenanceFromActivity({ archived: true })).toBe('deprecated');
    expect(maintenanceFromActivity({ deprecated: true })).toBe('deprecated');
  });

  it('grades on recency when there is no hard signal', () => {
    expect(maintenanceFromActivity({ lastCommitDaysAgo: 30 })).toBe('active');
    expect(maintenanceFromActivity({ lastCommitDaysAgo: 200 })).toBe('maintenance-only');
    expect(maintenanceFromActivity({ lastCommitDaysAgo: 800 })).toBe('abandoned');
  });

  it('defaults to active when recency is unknown (no false "abandoned")', () => {
    expect(maintenanceFromActivity({})).toBe('active');
    expect(maintenanceFromActivity({ lastCommitDaysAgo: null })).toBe('active');
  });
});

describe('packageIdentityFromManifest', () => {
  it('maps a named package.json to (name, npm)', () => {
    expect(packageIdentityFromManifest({ name: '@acme/widgets' })).toEqual({ package: '@acme/widgets', ecosystem: 'npm' });
  });

  it('returns null for an unpublishable manifest (no name) — defer synthetic keys, never fabricate identity', () => {
    expect(packageIdentityFromManifest({})).toBeNull();
    expect(packageIdentityFromManifest({ name: '' })).toBeNull();
    expect(packageIdentityFromManifest(null)).toBeNull();
  });
});

describe('buildDerivedL2', () => {
  it("stamps attestation.source='analyzer' (not 'hand') and the injected fetched_at", () => {
    const o = buildDerivedL2({
      package: '@acme/widgets',
      license: 'MIT',
      maintenance: 'active',
      fetchedAt: '2026-06-10',
    });
    expect(o.attestation.source).toBe('analyzer');
    expect(o.attestation.fetched_at).toBe('2026-06-10');
    expect(o.license).toBe('MIT');
    expect(o.license_risk).toBe('none'); // derived from license when not given
    expect(L2OverlaySchema.safeParse(o).success).toBe(true);
  });

  it('honors an explicit licenseRisk over the derived one', () => {
    const o = buildDerivedL2({
      package: 'p',
      license: 'MIT',
      licenseRisk: 'unknown',
      maintenance: 'active',
      fetchedAt: '2026-06-10',
    });
    expect(o.license_risk).toBe('unknown');
  });

  it('throws a clear error on an invalid fetched_at rather than emitting an unparseable fact', () => {
    expect(() =>
      buildDerivedL2({ package: 'p', license: 'MIT', maintenance: 'active', fetchedAt: 'yesterday' }),
    ).toThrow(/fetched_at/i);
  });
});

describe('packageIdentityFromPyproject', () => {
  it('maps a PEP 621 [project].name to (name, pypi)', () => {
    expect(packageIdentityFromPyproject('[project]\nname = "vuln-confidence"\n')).toEqual({ package: 'vuln-confidence', ecosystem: 'pypi' });
  });

  it('returns null without a [project] table or name (e.g. a name only under [tool.poetry])', () => {
    expect(packageIdentityFromPyproject('[tool.poetry]\nname = "x"\n')).toBeNull();
    expect(packageIdentityFromPyproject('[project]\nversion = "1.0"\n')).toBeNull();
    expect(packageIdentityFromPyproject('')).toBeNull();
  });
});

describe('licenseFromPyproject', () => {
  it('reads the PEP 621 SPDX string form', () => {
    expect(licenseFromPyproject('[project]\nname = "a"\nlicense = "MIT"\n')).toBe('MIT');
    expect(licenseFromPyproject('[project]\nlicense = "LicenseRef-Proprietary"\n')).toBe('LicenseRef-Proprietary');
  });

  it('reads the inline-table { text = ... } form, but not a { file = ... } ref', () => {
    expect(licenseFromPyproject('[project]\nlicense = { text = "Apache-2.0" }\n')).toBe('Apache-2.0');
    expect(licenseFromPyproject('[project]\nlicense = { file = "LICENSE" }\n')).toBeNull();
  });

  it('falls back to an OSI classifier when there is no license field', () => {
    expect(licenseFromPyproject('[project]\nname="a"\nclassifiers = [\n  "License :: OSI Approved :: MIT License",\n]\n')).toBe('MIT');
    expect(licenseFromPyproject('[project]\nclassifiers = ["License :: OSI Approved :: GNU General Public License v3 (GPLv3)"]\n')).toBe('GPL-3.0');
  });

  it('returns null when no license is declared anywhere (→ caller treats as UNLICENSED)', () => {
    expect(licenseFromPyproject('[project]\nname = "a"\n')).toBeNull();
  });

  it('does not read a license from outside the [project] table', () => {
    expect(licenseFromPyproject('[project]\nname = "a"\n[tool.x]\nlicense = "GPL-3.0"\n')).toBeNull();
  });
});

describe('description / keywords extraction (the "what it does" the agent needs)', () => {
  it('reads a npm description, rejecting empty and the cookiecutter placeholder', () => {
    expect(descriptionFromManifest({ description: 'Headless Burp Suite scanner' })).toBe('Headless Burp Suite scanner');
    expect(descriptionFromManifest({ description: '   ' })).toBeNull();
    expect(descriptionFromManifest({ description: 'Add your description here' })).toBeNull();
    expect(descriptionFromManifest({})).toBeNull();
  });

  it('reads a pyproject [project].description, rejecting the placeholder', () => {
    expect(descriptionFromPyproject('[project]\nname="a"\ndescription = "Autonomous pentest agent on Hermes Agent"\n')).toBe('Autonomous pentest agent on Hermes Agent');
    expect(descriptionFromPyproject('[project]\ndescription = "Add your description here"\n')).toBeNull();
    expect(descriptionFromPyproject('[project]\nname="a"\n')).toBeNull();
  });

  it('reads keywords from both ecosystems (inline or multiline arrays)', () => {
    expect(keywordsFromManifest({ keywords: ['security', 'ai'] })).toEqual(['security', 'ai']);
    expect(keywordsFromManifest({})).toEqual([]);
    expect(keywordsFromPyproject('[project]\nkeywords = ["security", "vulnerability", "ai"]\n')).toEqual(['security', 'vulnerability', 'ai']);
    expect(keywordsFromPyproject('[project]\nkeywords = [\n  "a",\n  "b",\n]\n')).toEqual(['a', 'b']);
    expect(keywordsFromPyproject('[project]\nname="a"\n')).toEqual([]);
  });
});

describe('derivePackageFromCheckout (facts + discovery in one pass)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'starlog-derive-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the overlay plus solves+keywords for an npm package', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/scan', license: 'MIT', description: 'scans things', keywords: ['scan'] }));
    const r = derivePackageFromCheckout(dir, { fetchedAt: '2026-06-10' })!;
    expect(r.overlay.package).toBe('@acme/scan');
    expect(r.solves).toBe('scans things');
    expect(r.keywords).toEqual(['scan']);
  });

  it('returns the overlay plus solves+keywords for a python package', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "cybereval"\ndescription = "Evaluation framework for cybersecurity testing agents"\nkeywords = ["cybersecurity", "evaluation"]\n');
    const r = derivePackageFromCheckout(dir, { fetchedAt: '2026-06-10' })!;
    expect(r.overlay.ecosystem).toBe('pypi');
    expect(r.solves).toBe('Evaluation framework for cybersecurity testing agents');
    expect(r.keywords).toEqual(['cybersecurity', 'evaluation']);
  });

  it('solves is null when no usable description (→ not discoverable, flagged upstream)', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "vuln-confidence"\n');
    const r = derivePackageFromCheckout(dir, { fetchedAt: '2026-06-10' })!;
    expect(r.overlay.package).toBe('vuln-confidence');
    expect(r.solves).toBeNull();
  });

  it('returns null when there is no published identity', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true }));
    expect(derivePackageFromCheckout(dir, { fetchedAt: '2026-06-10' })).toBeNull();
  });
});

describe('suggestL3Rules', () => {
  const base = { package: 'p', license: 'MIT', maintenance: 'active' as const, fetchedAt: '2026-06-10' };

  it('suggests nothing for a clean overlay (permissive license, active, no vulns)', () => {
    expect(suggestL3Rules(buildDerivedL2(base))).toEqual([]);
  });

  it('always suggests flag (conservative), never deny', () => {
    const o = buildDerivedL2({ ...base, license: 'GPL-3.0-only', maintenance: 'abandoned' });
    const rules = suggestL3Rules(o);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.decision === 'flag')).toBe(true);
  });

  it('flags an abandoned or deprecated package on a maintenance signal', () => {
    for (const m of ['abandoned', 'deprecated'] as const) {
      const rules = suggestL3Rules(buildDerivedL2({ ...base, maintenance: m }));
      expect(rules.some((r) => r.signal === `maintenance: ${m}`)).toBe(true);
    }
  });

  it('flags strong copyleft and unknown licenses on a license signal', () => {
    expect(suggestL3Rules(buildDerivedL2({ ...base, license: 'AGPL-3.0-only' })).some((r) => r.signal === 'license_risk: copyleft-strong')).toBe(true);
    expect(suggestL3Rules(buildDerivedL2({ ...base, license: 'UNLICENSED' })).some((r) => r.signal === 'license_risk: unknown')).toBe(true);
  });

  it('flags a package with known vulns/incidents', () => {
    const o = buildDerivedL2({ ...base, knownVulns: [{ id: 'INCIDENT:x', severity: 'high', affected: '*', summary: 's' }] });
    expect(suggestL3Rules(o).some((r) => r.signal === 'has_known_vulns')).toBe(true);
  });
});

describe('deriveL2FromCheckout', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-ingest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives a schema-valid, analyzer-sourced overlay from a real checkout, then loads back through upsertL2Entry', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/widgets', license: 'Apache-2.0' }));
    const overlay = deriveL2FromCheckout(dir, { fetchedAt: '2026-06-10', archived: false, lastCommitDaysAgo: 10 });
    expect(overlay).not.toBeNull();
    expect(overlay!.package).toBe('@acme/widgets');
    expect(overlay!.ecosystem).toBe('npm');
    expect(overlay!.license).toBe('Apache-2.0');
    expect(overlay!.license_risk).toBe('none');
    expect(overlay!.maintenance).toBe('active');
    expect(overlay!.attestation.source).toBe('analyzer');

    const file = upsertL2Entry({ l1: [], l2: [] }, overlay!);
    expect(file.l2).toHaveLength(1);
    expect(parseOverlay(file.l2[0])).not.toBeNull(); // round-trips through the loader's validator
  });

  it('returns null when the checkout has no published identity (no package.json name)', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true }));
    expect(deriveL2FromCheckout(dir, { fetchedAt: '2026-06-10' })).toBeNull();
  });

  it('derives a pypi overlay from pyproject.toml when there is no npm package', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "vuln-confidence"\nlicense = "MIT"\n');
    const o = deriveL2FromCheckout(dir, { fetchedAt: '2026-06-10', lastCommitDaysAgo: 10 })!;
    expect(o.package).toBe('vuln-confidence');
    expect(o.ecosystem).toBe('pypi');
    expect(o.license).toBe('MIT');
    expect(o.license_risk).toBe('none');
    expect(o.maintenance).toBe('active');
    expect(o.attestation.source).toBe('analyzer');
  });

  it('a pyproject with no license → UNLICENSED / unknown (honest, not a false none)', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "armeyes"\n');
    const o = deriveL2FromCheckout(dir, { fetchedAt: '2026-06-10' })!;
    expect(o.license).toBe('UNLICENSED');
    expect(o.license_risk).toBe('unknown');
  });

  it('npm wins when both package.json and pyproject.toml are present', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/dual', license: 'MIT' }));
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "dual_py"\nlicense = "GPL-3.0-only"\n');
    const o = deriveL2FromCheckout(dir, { fetchedAt: '2026-06-10' })!;
    expect(o.package).toBe('@acme/dual');
    expect(o.ecosystem).toBe('npm');
  });

  it('falls back to license UNLICENSED → license_risk unknown when none is declared', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'internal-thing' }));
    const overlay = deriveL2FromCheckout(dir, { fetchedAt: '2026-06-10' });
    expect(overlay!.license).toBe('UNLICENSED');
    expect(overlay!.license_risk).toBe('unknown');
  });

  // The real bar: a derived, analyzer-sourced overlay written to STARLOG_PRIVATE_FACTS must
  // reach the agent through the ACTUAL load+serve path (buildComposeDeps → resolveFactView),
  // not merely re-validate. This is what Phase 0's enum change existed to unblock.
  it('a derived overlay written to STARLOG_PRIVATE_FACTS resolves end-to-end through the serve path', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/widgets', license: 'Apache-2.0' }));
    const overlay = deriveL2FromCheckout(dir, { fetchedAt: '2026-06-10', lastCommitDaysAgo: 10 })!;

    const factsPath = join(dir, 'private-facts.json');
    writeFileSync(factsPath, JSON.stringify(upsertL2Entry({ l1: [], l2: [] }, overlay)));

    const deps = buildComposeDeps({ STARLOG_PRIVATE_FACTS: factsPath } as NodeJS.ProcessEnv);
    const view = await resolveFactView('@acme/widgets', { local: deps, api: null });

    expect(view).not.toBeNull();
    expect(view!.l2?.attestation.source).toBe('analyzer'); // the enum change is load-bearing here
    expect(view!.l2?.license).toBe('Apache-2.0');
    expect(view!.l2?.license_risk).toBe('none');
  });
});
