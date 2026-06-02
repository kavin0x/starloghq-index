import { describe, it, expect } from 'vitest';
import type { L2Overlay, Vuln } from '@starloghq/facts-schema';
import { handAuthoredL2Source, overlaySource } from './l2-source.js';

// Minimal L2 factory — only the fields a test cares about, schema-complete.
const overlay = (over: Partial<L2Overlay> & { package: string }): L2Overlay => ({
  ecosystem: 'npm',
  known_vulns: [],
  license: 'MIT',
  license_risk: 'none',
  maintenance: 'active',
  transitive_risk: null,
  attestation: { source: 'hand', refs: [], fetched_at: '2026-06-01' },
  ...over,
});
const vuln = (id: string, severity: Vuln['severity']): Vuln => ({
  id,
  severity,
  affected: '*',
  summary: id,
});

describe('overlaySource — union known_vulns by id (private may add, never suppress)', () => {
  it('passes base through untouched when there is no private source', () => {
    const base = handAuthoredL2Source({ pkg: overlay({ package: 'pkg', known_vulns: [vuln('CVE-1', 'high')] }) });
    expect(overlaySource(base, null).lookup('pkg')).toEqual(base.lookup('pkg'));
  });

  it('returns the private record when base has no overlay for the package', () => {
    const base = handAuthoredL2Source({});
    const priv = handAuthoredL2Source({ pkg: overlay({ package: 'pkg', license: 'AGPL-3.0' }) });
    expect(overlaySource(base, priv).lookup('pkg')?.license).toBe('AGPL-3.0');
  });

  it('returns the base record unchanged when private has no overlay for the package', () => {
    const base = handAuthoredL2Source({ pkg: overlay({ package: 'pkg', known_vulns: [vuln('CVE-1', 'critical')] }) });
    const priv = handAuthoredL2Source({ other: overlay({ package: 'other' }) });
    const merged = overlaySource(base, priv).lookup('pkg');
    expect(merged?.known_vulns.map((v) => v.id)).toEqual(['CVE-1']);
  });

  describe('both present', () => {
    const base = handAuthoredL2Source({
      pkg: overlay({
        package: 'pkg',
        known_vulns: [vuln('CVE-UPSTREAM', 'critical')],
        license: 'MIT',
        license_risk: 'none',
        maintenance: 'active',
      }),
    });
    const priv = handAuthoredL2Source({
      pkg: overlay({
        package: 'pkg',
        // private tries to downgrade the upstream CVE AND adds its own advisory
        known_vulns: [vuln('CVE-UPSTREAM', 'low'), vuln('INCIDENT:acme-internal', 'high')],
        // org rulings on scalar fields
        license: 'UNLICENSED',
        license_risk: 'unknown',
        maintenance: 'deprecated',
      }),
    });
    const merged = overlaySource(base, priv).lookup('pkg')!;

    it('keeps the upstream vuln with its ORIGINAL severity (base wins on id collision — no silent downgrade)', () => {
      const upstream = merged.known_vulns.find((v) => v.id === 'CVE-UPSTREAM');
      expect(upstream?.severity).toBe('critical');
    });

    it('adds the private net-new advisory (union)', () => {
      expect(merged.known_vulns.map((v) => v.id)).toContain('INCIDENT:acme-internal');
    });

    it('never drops the upstream vuln (existence is not deletable)', () => {
      expect(merged.known_vulns.some((v) => v.id === 'CVE-UPSTREAM')).toBe(true);
      // exactly one entry per id — the collision did not duplicate
      expect(merged.known_vulns.filter((v) => v.id === 'CVE-UPSTREAM')).toHaveLength(1);
    });

    it('lets the private org rulings win on scalar fields (license / maintenance)', () => {
      expect(merged.license).toBe('UNLICENSED');
      expect(merged.license_risk).toBe('unknown');
      expect(merged.maintenance).toBe('deprecated');
    });
  });
});
