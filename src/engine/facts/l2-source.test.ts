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

  it('keeps the upstream vuln when the private overlay records no vulns at all (the headline bug)', () => {
    // The bare trigger of the original suppression: an org records only a
    // license/maintenance ruling and says nothing about vulns. Whole-record
    // private-wins used to empty known_vulns and flip has_known_vulns false.
    const base = handAuthoredL2Source({ pkg: overlay({ package: 'pkg', known_vulns: [vuln('CVE-1', 'critical')] }) });
    const priv = handAuthoredL2Source({ pkg: overlay({ package: 'pkg', license: 'UNLICENSED' }) });
    expect(overlaySource(base, priv).lookup('pkg')?.known_vulns.map((v) => v.id)).toEqual(['CVE-1']);
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

// Generalizes the per-fixture cases above into an invariant over EVERY base×priv
// combination, so any future change to overlaySource that reintroduces suppression
// (or downgrade, or duplication) fails the build — the mechanical form of SEAM-3's
// "never hide an honest library" floor. Dependency-free (no fast-check): exhaustive
// power-set of a small id universe, base tags 'critical', priv tries to downgrade.
describe('overlaySource — never-shrink invariant over every base×priv combination', () => {
  const UNIVERSE: readonly string[] = ['CVE-A', 'CVE-B', 'INCIDENT:C'];
  const powerset = <T,>(xs: readonly T[]): T[][] =>
    xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
  const subsets = powerset(UNIVERSE);
  // base tags every vuln 'critical' (license MIT / active); priv tags the SAME ids
  // 'low' and asserts an org ruling (AGPL / deprecated) so base-wins + scalar
  // private-wins are both observable.
  const mk = (ids: readonly string[], priv: boolean) =>
    handAuthoredL2Source({
      pkg: overlay({
        package: 'pkg',
        known_vulns: ids.map((id) => vuln(id, priv ? 'low' : 'critical')),
        license: priv ? 'AGPL-3.0' : 'MIT',
        maintenance: priv ? 'deprecated' : 'active',
      }),
    });

  it('every base id survives, keeps its severity, no dups, ids = base ∪ priv, scalar private-wins', () => {
    const violations: string[] = [];
    for (const baseIds of subsets) {
      for (const privIds of subsets) {
        const merged = overlaySource(mk(baseIds, false), mk(privIds, true)).lookup('pkg')!;
        const ids = merged.known_vulns.map((v) => v.id);
        const label = `base={${baseIds.join(',') || '∅'}} priv={${privIds.join(',') || '∅'}}`;
        for (const id of baseIds) if (!ids.includes(id)) violations.push(`${label}: dropped base id ${id} (shrink)`);
        for (const v of merged.known_vulns)
          if (baseIds.includes(v.id) && v.severity !== 'critical') violations.push(`${label}: base id ${v.id} downgraded to ${v.severity}`);
        if (new Set(ids).size !== ids.length) violations.push(`${label}: duplicate ids [${ids.join(',')}]`);
        const expected = new Set([...baseIds, ...privIds]);
        if (expected.size !== new Set(ids).size || ![...expected].every((x) => ids.includes(x)))
          violations.push(`${label}: union mismatch, got [${ids.join(',')}]`);
        if (merged.license !== 'AGPL-3.0' || merged.maintenance !== 'deprecated') violations.push(`${label}: scalar private-wins failed`);
      }
    }
    expect(violations).toEqual([]);
  });
});
