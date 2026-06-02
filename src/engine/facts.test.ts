import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lookupFacts, loadFactMap, VERIFIED_FACTS, type FactRecord } from './facts.js';

describe('lookupFacts', () => {
  it('returns the record on an exact name hit', () => {
    const rec = lookupFacts('ua-parser-js');
    expect(rec).not.toBeNull();
    expect(rec?.package).toBe('ua-parser-js');
    expect(rec?.known_vulns.length).toBeGreaterThan(0);
  });

  it('fuzzy-matches when the query CONTAINS the package name', () => {
    const rec = lookupFacts('left-pad utility');
    expect(rec?.package).toBe('left-pad');
  });

  it('fuzzy-matches when the package name CONTAINS the query', () => {
    const rec = lookupFacts('xz');
    expect(rec?.package).toBe('xz-utils');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(lookupFacts('  UA-Parser-JS  ')?.package).toBe('ua-parser-js');
  });

  it('returns null on a miss', () => {
    expect(lookupFacts('totally-made-up-pkg')).toBeNull();
  });

  it('returns null on an empty query', () => {
    expect(lookupFacts('')).toBeNull();
    expect(lookupFacts('   ')).toBeNull();
  });

  it('accepts a custom fact map', () => {
    const map = { foo: { ...VERIFIED_FACTS['chalk'], package: 'foo' } };
    expect(lookupFacts('foo', map)?.package).toBe('foo');
    expect(lookupFacts('chalk', map)).toBeNull();
  });
});

describe('VERIFIED_FACTS', () => {
  it('contains only verified:true records', () => {
    const values = Object.values(VERIFIED_FACTS);
    expect(values.length).toBeGreaterThan(0);
    for (const rec of values) {
      expect(rec.verified).toBe(true);
    }
  });
});

describe('loadFactMap', () => {
  let tmpDir: string | null = null;

  function writePrivate(entries: unknown[]): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-priv-'));
    const p = join(tmpDir, 'private-facts.json');
    writeFileSync(p, JSON.stringify(entries), 'utf-8');
    return p;
  }

  function makeRecord(overrides: Partial<FactRecord>): FactRecord {
    return {
      package: 'placeholder',
      ecosystem: 'npm',
      effect_surface: 'does a thing',
      known_vulns: [],
      license: 'MIT',
      license_risk: 'none',
      maintenance: 'active',
      transitive_risk: null,
      source: 'test fixture',
      verified: true,
      last_verified: '2026-01-01',
      ...overrides,
    };
  }

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('returns VERIFIED_FACTS unchanged when privatePath is undefined (unset env → public-only)', () => {
    expect(loadFactMap(undefined)).toEqual(VERIFIED_FACTS);
  });

  it('merges public + private with the PRIVATE entry winning on key collision', () => {
    const override = makeRecord({
      package: 'left-pad',
      effect_surface: 'ORG OVERRIDE: internal banned fork',
      source: 'ACME internal',
    });
    const map = loadFactMap(writePrivate([override]));
    // public entries still present
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(Object.keys(VERIFIED_FACTS).length);
    // private wins on collision
    expect(map['left-pad'].effect_surface).toBe('ORG OVERRIDE: internal banned fork');
    expect(map['left-pad'].source).toBe('ACME internal');
  });

  it('resolves a private-only package (no public entry) through the merged map', () => {
    const internal = makeRecord({
      package: '@acme/internal-auth',
      maintenance: 'deprecated',
      source: 'ACME internal registry',
    });
    const map = loadFactMap(writePrivate([internal]));
    expect(map['@acme/internal-auth']).toBeDefined();
    expect(lookupFacts('@acme/internal-auth', map)?.package).toBe('@acme/internal-auth');
    // public unaffected
    expect(map['left-pad']).toEqual(VERIFIED_FACTS['left-pad']);
  });

  it('skips a malformed entry and an unverified entry without throwing; valid verified entries still load', () => {
    const valid = makeRecord({ package: '@acme/good', source: 'ACME internal' });
    const malformed = { package: '@acme/broken', verified: true }; // missing required fields
    const unverified = makeRecord({ package: '@acme/draft', verified: false });
    let map!: Record<string, FactRecord>;
    expect(() => {
      map = loadFactMap(writePrivate([valid, malformed, unverified]));
    }).not.toThrow();
    expect(map['@acme/good']).toBeDefined();
    expect(map['@acme/broken']).toBeUndefined();
    expect(map['@acme/draft']).toBeUndefined();
  });

  it('falls back to the full public map when the file is missing/unreadable (no throw)', () => {
    const missing = join(tmpdir(), 'starlog-does-not-exist-' + Date.now(), 'nope.json');
    let map!: Record<string, FactRecord>;
    expect(() => {
      map = loadFactMap(missing);
    }).not.toThrow();
    expect(map).toEqual(VERIFIED_FACTS);
  });

  it('falls back to the full public map on invalid JSON (no throw)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-priv-'));
    const p = join(tmpDir, 'bad.json');
    writeFileSync(p, '{ not valid json', 'utf-8');
    expect(loadFactMap(p)).toEqual(VERIFIED_FACTS);
  });
});
