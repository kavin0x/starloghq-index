import { describe, it, expect } from 'vitest';
import { L1CapabilityFactSchema } from './l1-capability.js';
import { L2OverlaySchema } from './l2-overlay.js';
import { L1_FACTS, L1_BY_PACKAGE } from './l1-data.js';
import { L2_OVERLAYS_LIST, L2_BY_PACKAGE } from './l2-data.js';

const CORPUS = ['xz-utils', 'event-stream', 'ua-parser-js', 'node-ipc', 'colors', 'request', 'moment', 'left-pad', 'grafana', 'chalk', 'date-fns'];
const isCalendarDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

describe('L1 corpus (capability facts)', () => {
  it('has exactly the 11 corpus packages, no duplicates, in stable order', () => {
    expect(L1_FACTS.map((f) => f.package)).toEqual(CORPUS);
    expect(new Set(L1_FACTS.map((f) => f.package)).size).toBe(11);
  });

  it.each(L1_FACTS)('$package: valid L1 schema, verified, NO freshness field, non-empty effect_surface', (f) => {
    expect(L1CapabilityFactSchema.safeParse(f).success).toBe(true);
    expect(f.provenance.verified).toBe(true);
    expect(f.provenance.derived_by).toBe('hand'); // stand-in until the analyzer ships
    expect(f.effect_surface.length).toBeGreaterThan(0);
    expect(f).not.toHaveProperty('last_verified');
    expect(f).not.toHaveProperty('known_vulns'); // L2 data must NOT leak into L1
    expect(f).not.toHaveProperty('license');
  });

  it('L1_BY_PACKAGE keys equal the verified package set', () => {
    expect(Object.keys(L1_BY_PACKAGE).sort()).toEqual([...CORPUS].sort());
  });
});

describe('L2 corpus (overlay)', () => {
  it('has the 11 corpus packages, no duplicates', () => {
    expect(new Set(L2_OVERLAYS_LIST.map((o) => o.package)).size).toBe(11);
    expect(Object.keys(L2_BY_PACKAGE).sort()).toEqual([...CORPUS].sort());
  });

  it.each(L2_OVERLAYS_LIST)('$package: valid L2 schema, hand-attested, valid fetched_at date, NO effect_surface', (o) => {
    expect(L2OverlaySchema.safeParse(o).success).toBe(true);
    expect(o.attestation.source).toBe('hand');
    expect(o.attestation.refs.length).toBeGreaterThan(0);
    expect(isCalendarDate(o.attestation.fetched_at)).toBe(true);
    expect(o).not.toHaveProperty('effect_surface'); // L1 data must NOT leak into L2
  });
});

describe('ground-truth invariants (cross-layer, by package)', () => {
  it('incident packages carry >=1 known vuln in L2; clean baselines carry none', () => {
    for (const p of ['xz-utils', 'event-stream', 'ua-parser-js', 'node-ipc', 'colors']) {
      expect(L2_BY_PACKAGE[p].known_vulns.length).toBeGreaterThan(0);
    }
    for (const p of ['chalk', 'date-fns']) {
      expect(L2_BY_PACKAGE[p].known_vulns.length).toBe(0);
      expect(L2_BY_PACKAGE[p].maintenance).toBe('active');
    }
  });

  it('grafana is a strong-copyleft license trap (L2); xz-utils is compromised with CVE-2024-3094', () => {
    expect(L2_BY_PACKAGE['grafana'].license_risk).toBe('copyleft-strong');
    expect(L2_BY_PACKAGE['xz-utils'].maintenance).toBe('compromised');
    expect(L2_BY_PACKAGE['xz-utils'].known_vulns[0].id).toBe('CVE-2024-3094');
  });

  it('every L2 package has a matching L1 capability fact (and vice versa) — layers cover the same corpus', () => {
    expect(Object.keys(L2_BY_PACKAGE).sort()).toEqual(Object.keys(L1_BY_PACKAGE).sort());
  });
});
