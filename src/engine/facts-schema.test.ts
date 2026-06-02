import { describe, it, expect } from 'vitest';
import { FactRecordSchema, VulnSchema, type FactRecord, type Vuln } from './facts-types.js';

/**
 * Schema-level tests for FactRecordSchema + VulnSchema via safeParse.
 *
 * Distinct from facts.test.ts (which exercises lookupFacts/loadFactMap behavior)
 * and mcp-facts.test.ts. Here we drive the Zod schemas directly: defaults, each
 * enum domain, nullable-vs-optional, array shapes, the last_verified regex, and
 * required-field enforcement. Rejections assert on issue.path (not version-fragile
 * issue codes) so a green test fails for the RIGHT field.
 */

// Local valid-record factory — we control every field; spread overrides per case.
function validRecord(overrides: Partial<FactRecord> = {}): FactRecord {
  return {
    package: 'chalk',
    ecosystem: 'npm',
    effect_surface: 'Terminal string styling; in-process, no network, no fs.',
    known_vulns: [],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'active',
    transitive_risk: null,
    source: 'baseline clean control',
    verified: true,
    last_verified: '2026-01-01',
    ...overrides,
  };
}

function validVuln(overrides: Partial<Vuln> = {}): Vuln {
  return {
    id: 'CVE-2024-0001',
    severity: 'high',
    affected: '< 1.2.3',
    summary: 'A test vulnerability summary.',
    ...overrides,
  };
}

/** True iff some issue's dotted path equals `path`. */
function hasIssueAtPath(error: { issues: { path: PropertyKey[] }[] }, path: string): boolean {
  return error.issues.some((i) => i.path.join('.') === path);
}

describe('FactRecordSchema — valid records & defaults', () => {
  it('parses a fully-valid record and preserves its fields', () => {
    const input = validRecord({
      package: 'xz-utils',
      ecosystem: 'system',
      known_vulns: [validVuln({ id: 'CVE-2024-3094', severity: 'critical' })],
      license: 'GPL-2.0-or-later',
      license_risk: 'copyleft-strong',
      maintenance: 'compromised',
      transitive_risk: 'Pulled transitively by build tooling.',
    });
    const result = FactRecordSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.package).toBe('xz-utils');
      expect(result.data.ecosystem).toBe('system');
      expect(result.data.known_vulns).toHaveLength(1);
      expect(result.data.known_vulns[0].severity).toBe('critical');
      expect(result.data.maintenance).toBe('compromised');
      expect(result.data.transitive_risk).toBe('Pulled transitively by build tooling.');
    }
  });

  it('applies the ecosystem default of "npm" when ecosystem is omitted', () => {
    const { ecosystem: _omit, ...withoutEcosystem } = validRecord();
    const result = FactRecordSchema.safeParse(withoutEcosystem);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ecosystem).toBe('npm');
    }
  });

  it('accepts all three explicit ecosystem values', () => {
    for (const eco of ['npm', 'pypi', 'system'] as const) {
      const result = FactRecordSchema.safeParse(validRecord({ ecosystem: eco }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.ecosystem).toBe(eco);
    }
  });
});

describe('FactRecordSchema — enum rejection', () => {
  it('rejects an out-of-domain ecosystem with an issue at "ecosystem"', () => {
    const result = FactRecordSchema.safeParse(validRecord({ ecosystem: 'cargo' as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(hasIssueAtPath(result.error, 'ecosystem')).toBe(true);
  });

  it('rejects an out-of-domain license_risk with an issue at "license_risk"', () => {
    const result = FactRecordSchema.safeParse(validRecord({ license_risk: 'permissive' as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(hasIssueAtPath(result.error, 'license_risk')).toBe(true);
  });

  it('rejects an out-of-domain maintenance with an issue at "maintenance"', () => {
    const result = FactRecordSchema.safeParse(validRecord({ maintenance: 'stable' as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(hasIssueAtPath(result.error, 'maintenance')).toBe(true);
  });

  it('accepts every valid license_risk value', () => {
    for (const lr of ['none', 'copyleft-weak', 'copyleft-strong', 'unknown'] as const) {
      expect(FactRecordSchema.safeParse(validRecord({ license_risk: lr })).success).toBe(true);
    }
  });

  it('accepts every valid maintenance value', () => {
    for (const m of ['active', 'maintenance-only', 'deprecated', 'abandoned', 'compromised'] as const) {
      expect(FactRecordSchema.safeParse(validRecord({ maintenance: m })).success).toBe(true);
    }
  });
});

describe('VulnSchema — severity enum & required sub-fields', () => {
  it('parses a fully-valid vuln', () => {
    const result = VulnSchema.safeParse(validVuln());
    expect(result.success).toBe(true);
  });

  it('accepts every valid severity value', () => {
    for (const sev of ['low', 'medium', 'high', 'critical'] as const) {
      const result = VulnSchema.safeParse(validVuln({ severity: sev }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.severity).toBe(sev);
    }
  });

  it('rejects an out-of-domain severity with an issue at "severity"', () => {
    const result = VulnSchema.safeParse(validVuln({ severity: 'sev:9000' as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(hasIssueAtPath(result.error, 'severity')).toBe(true);
  });

  it('rejects a vuln missing the required "summary" sub-field', () => {
    const { summary: _drop, ...noSummary } = validVuln();
    const result = VulnSchema.safeParse(noSummary);
    expect(result.success).toBe(false);
    if (!result.success) expect(hasIssueAtPath(result.error, 'summary')).toBe(true);
  });

  it('rejects each missing required vuln sub-field with a path hit', () => {
    for (const key of ['id', 'severity', 'affected', 'summary'] as const) {
      const base = validVuln();
      delete (base as Record<string, unknown>)[key];
      const result = VulnSchema.safeParse(base);
      expect(result.success, `vuln missing "${key}" should fail`).toBe(false);
      if (!result.success) {
        expect(hasIssueAtPath(result.error, key), `issue path should include "${key}"`).toBe(true);
      }
    }
  });
});

describe('FactRecordSchema — known_vulns array', () => {
  it('accepts an empty known_vulns array', () => {
    const result = FactRecordSchema.safeParse(validRecord({ known_vulns: [] }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.known_vulns).toEqual([]);
  });

  it('accepts a populated known_vulns array', () => {
    const result = FactRecordSchema.safeParse(
      validRecord({ known_vulns: [validVuln({ severity: 'low' }), validVuln({ severity: 'critical' })] }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.known_vulns).toHaveLength(2);
  });

  it('rejects a known_vulns entry missing a required sub-field, pathed at the index', () => {
    const { affected: _drop, ...badVuln } = validVuln();
    const result = FactRecordSchema.safeParse(validRecord({ known_vulns: [badVuln as Vuln] }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(hasIssueAtPath(result.error, 'known_vulns.0.affected')).toBe(true);
    }
  });

  it('rejects when known_vulns is not an array', () => {
    const result = FactRecordSchema.safeParse(validRecord({ known_vulns: 'none' as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(hasIssueAtPath(result.error, 'known_vulns')).toBe(true);
  });
});

describe('FactRecordSchema — transitive_risk (nullable, but required key)', () => {
  it('accepts transitive_risk === null', () => {
    const result = FactRecordSchema.safeParse(validRecord({ transitive_risk: null }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.transitive_risk).toBeNull();
  });

  it('accepts a transitive_risk string', () => {
    const result = FactRecordSchema.safeParse(validRecord({ transitive_risk: 'pulled by build tooling' }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.transitive_risk).toBe('pulled by build tooling');
  });

  it('rejects when the transitive_risk KEY is omitted (nullable != optional)', () => {
    const { transitive_risk: _omit, ...noKey } = validRecord();
    const result = FactRecordSchema.safeParse(noKey);
    expect(result.success).toBe(false);
    if (!result.success) expect(hasIssueAtPath(result.error, 'transitive_risk')).toBe(true);
  });
});

describe('FactRecordSchema — last_verified date format', () => {
  it('accepts a valid YYYY-MM-DD date', () => {
    expect(FactRecordSchema.safeParse(validRecord({ last_verified: '2026-06-01' })).success).toBe(true);
  });

  it.each(['2026-1-1', '06-01-2026', '2026/06/01', 'yesterday', ''])(
    'rejects malformed last_verified %j with an issue at "last_verified"',
    (bad) => {
      const result = FactRecordSchema.safeParse(validRecord({ last_verified: bad }));
      expect(result.success).toBe(false);
      if (!result.success) expect(hasIssueAtPath(result.error, 'last_verified')).toBe(true);
    },
  );
});

describe('FactRecordSchema — required top-level fields', () => {
  // ecosystem is intentionally EXCLUDED: it has .default('npm'), so omitting it succeeds.
  const requiredKeys = [
    'package',
    'effect_surface',
    'known_vulns',
    'license',
    'license_risk',
    'maintenance',
    'transitive_risk',
    'source',
    'verified',
    'last_verified',
  ] as const;

  it.each(requiredKeys)('rejects a record missing required field "%s"', (key) => {
    const rec = validRecord() as Record<string, unknown>;
    delete rec[key];
    const result = FactRecordSchema.safeParse(rec);
    expect(result.success, `missing "${key}" should fail`).toBe(false);
    if (!result.success) {
      expect(hasIssueAtPath(result.error, key), `issue path should include "${key}"`).toBe(true);
    }
  });

  it('confirms omitting ecosystem (the one defaulted field) still SUCCEEDS', () => {
    const rec = validRecord() as Record<string, unknown>;
    delete rec.ecosystem;
    const result = FactRecordSchema.safeParse(rec);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ecosystem).toBe('npm');
  });
});
