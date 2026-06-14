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
