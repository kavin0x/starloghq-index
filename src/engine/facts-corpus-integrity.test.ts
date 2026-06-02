import { describe, it, expect } from 'vitest';
import { FACT_STUBS, VERIFIED_FACTS } from './facts-data.js';
import { FactRecordSchema } from './facts-types.js';

/**
 * Corpus-integrity tests: validate the SHIPPED corpus in facts-data.ts as DATA.
 *
 * These are deliberately separate from facts.test.ts (which tests the lookup /
 * overlay BEHAVIOR) and mcp-facts.test.ts (which tests MCP wiring). Here we make
 * ground-truth assertions about the bytes that ship: every record is schema-valid,
 * verified, freshly dated, sourced; there are no dup packages; VERIFIED_FACTS is a
 * faithful projection; and a handful of known security/license invariants hold so
 * an accidental corpus edit (e.g. deleting a CVE, flipping a clean baseline) fails
 * loudly in CI rather than silently shipping wrong facts.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True iff `s` is YYYY-MM-DD AND a real calendar date (round-trips through Date). */
function isRealCalendarDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

describe('facts corpus integrity — every shipped record', () => {
  it.each(FACT_STUBS.map((r) => [r.package, r] as const))(
    'record %s parses cleanly against FactRecordSchema',
    (_pkg, rec) => {
      const parsed = FactRecordSchema.safeParse(rec);
      expect(parsed.success).toBe(true);
    },
  );

  it.each(FACT_STUBS.map((r) => [r.package, r] as const))(
    'record %s is verified:true',
    (_pkg, rec) => {
      expect(rec.verified).toBe(true);
    },
  );

  it.each(FACT_STUBS.map((r) => [r.package, r] as const))(
    'record %s last_verified is a real ISO calendar date',
    (_pkg, rec) => {
      expect(rec.last_verified).toMatch(ISO_DATE);
      expect(isRealCalendarDate(rec.last_verified)).toBe(true);
    },
  );

  it.each(FACT_STUBS.map((r) => [r.package, r] as const))(
    'record %s has a non-empty source string',
    (_pkg, rec) => {
      expect(typeof rec.source).toBe('string');
      expect(rec.source.trim().length).toBeGreaterThan(0);
    },
  );

  it.each(FACT_STUBS.map((r) => [r.package, r] as const))(
    'record %s has a non-empty package name and effect_surface',
    (_pkg, rec) => {
      expect(typeof rec.package).toBe('string');
      expect(rec.package.trim().length).toBeGreaterThan(0);
      expect(rec.effect_surface.trim().length).toBeGreaterThan(0);
    },
  );

  it('every known_vuln in every record is itself schema-valid (ids non-empty)', () => {
    for (const rec of FACT_STUBS) {
      for (const v of rec.known_vulns) {
        expect(v.id.trim().length).toBeGreaterThan(0);
        expect(v.affected.trim().length).toBeGreaterThan(0);
        expect(v.summary.trim().length).toBeGreaterThan(0);
        expect(['low', 'medium', 'high', 'critical']).toContain(v.severity);
      }
    }
  });
});

describe('facts corpus integrity — structural invariants', () => {
  it('contains exactly 11 records (guard against accidental add/remove)', () => {
    expect(FACT_STUBS).toHaveLength(11);
  });

  it('has NO duplicate package names', () => {
    const names = FACT_STUBS.map((r) => r.package);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('VERIFIED_FACTS keys exactly equal the set of verified package names', () => {
    const verifiedNames = FACT_STUBS.filter((r) => r.verified).map((r) => r.package).sort();
    const mapKeys = Object.keys(VERIFIED_FACTS).sort();
    expect(mapKeys).toEqual(verifiedNames);
  });

  it('every VERIFIED_FACTS value is verified:true and is the same object as its stub', () => {
    for (const [key, rec] of Object.entries(VERIFIED_FACTS)) {
      expect(rec.verified).toBe(true);
      expect(rec.package).toBe(key);
      // identity: VERIFIED_FACTS projects the same record objects, not copies
      const stub = FACT_STUBS.find((r) => r.package === key);
      expect(rec).toBe(stub);
    }
  });

  it('VERIFIED_FACTS has one entry per record (all 11 are verified)', () => {
    expect(Object.keys(VERIFIED_FACTS)).toHaveLength(11);
  });
});

describe('facts corpus integrity — ground-truth security/license invariants', () => {
  const byName = (name: string) => {
    const rec = FACT_STUBS.find((r) => r.package === name);
    expect(rec, `expected corpus to contain ${name}`).toBeDefined();
    return rec!;
  };

  it.each(['xz-utils', 'event-stream', 'ua-parser-js', 'node-ipc', 'colors'])(
    'compromised/incident package %s carries at least one known_vuln',
    (name) => {
      const rec = byName(name);
      expect(rec.known_vulns.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(['chalk', 'date-fns'])(
    'clean baseline %s has zero known_vulns and is actively maintained',
    (name) => {
      const rec = byName(name);
      expect(rec.known_vulns).toHaveLength(0);
      expect(rec.maintenance).toBe('active');
    },
  );

  it('grafana is flagged license_risk copyleft-strong (AGPL trap)', () => {
    expect(byName('grafana').license_risk).toBe('copyleft-strong');
  });

  it('xz-utils carries the CVE-2024-3094 critical backdoor entry', () => {
    const rec = byName('xz-utils');
    const cve = rec.known_vulns.find((v) => v.id === 'CVE-2024-3094');
    expect(cve).toBeDefined();
    expect(cve?.severity).toBe('critical');
    expect(rec.maintenance).toBe('compromised');
  });
});
