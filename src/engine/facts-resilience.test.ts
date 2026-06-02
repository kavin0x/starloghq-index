import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  lookupFacts,
  loadFactMap,
  VERIFIED_FACTS,
  FACT_STUBS,
  FactRecordSchema,
  type FactRecord,
} from './facts.js';

/**
 * Engine-resilience suite for src/engine/facts.ts.
 *
 * Goes BEYOND src/engine/facts.test.ts: matcher precedence/ambiguity, the full
 * file-level fallback matrix (missing / directory / invalid-JSON / non-array /
 * empty-array), and entry-level skip semantics — including the date-format gate,
 * where one case documents a real product bug (see DATE-GATE below).
 *
 * All private files are real temp files (mkdtempSync), cleaned up in afterEach.
 */

// Build a FactRecord from overrides — defaults are valid + verified.
function makeRecord(overrides: Partial<FactRecord> = {}): FactRecord {
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

describe('lookupFacts — matching branches & boundaries', () => {
  it('returns the exact record reference on an exact hit (not a copy)', () => {
    const rec = lookupFacts('chalk');
    expect(rec).toBe(VERIFIED_FACTS['chalk']);
  });

  it('matches via query.includes(pkg): query is longer and contains the package', () => {
    expect(lookupFacts('should I use moment for dates?')?.package).toBe('moment');
  });

  it('matches via pkg.includes(query): a short query is a substring of the package', () => {
    // 'parser' is a substring of 'ua-parser-js' (and of no earlier package)
    expect(lookupFacts('parser')?.package).toBe('ua-parser-js');
  });

  it('is case-insensitive in BOTH directions (query upper, pkg lower)', () => {
    expect(lookupFacts('GRAFANA')?.package).toBe('grafana');
    expect(lookupFacts('CHALK STYLING')?.package).toBe('chalk');
  });

  it('trims surrounding whitespace and tabs/newlines before matching', () => {
    expect(lookupFacts('\t\n  request  \n')?.package).toBe('request');
  });

  it('returns null for an empty string and for whitespace-only queries', () => {
    expect(lookupFacts('')).toBeNull();
    expect(lookupFacts('   ')).toBeNull();
    expect(lookupFacts('\t\n')).toBeNull();
  });

  it('returns null on a genuine miss (no substring relation either way)', () => {
    expect(lookupFacts('zzz-nonexistent')).toBeNull();
  });

  it('does NOT match when only a partial (non-substring) overlap exists', () => {
    // 'lefty' shares a prefix with 'left-pad' but is neither a sub- nor super-string
    expect(lookupFacts('lefty')).toBeNull();
  });
});

describe('lookupFacts — precedence / ambiguity (insertion order wins)', () => {
  it('returns the FIRST inserted package when a query substring-matches two, regardless of query word order', () => {
    // 'chalk and colors' contains both 'chalk' (idx 9) and 'colors' (idx 4).
    // Insertion order — not the order names appear in the query — decides:
    // 'colors' is inserted earlier, so it wins even though 'chalk' appears first.
    expect(lookupFacts('chalk and colors')?.package).toBe('colors');
  });

  it('precedence is governed by factMap insertion order on a custom map', () => {
    const recA = makeRecord({ package: 'alpha', source: 'A' });
    const recB = makeRecord({ package: 'beta', source: 'B' });
    // Query 'a' is a substring of BOTH 'alpha' and 'beta' — a genuine 2-way tie.
    const map: Record<string, FactRecord> = { alpha: recA, beta: recB };
    expect(lookupFacts('a', map)).toBe(recA);

    // Reversed insertion order flips the winner — proves order, not name, decides.
    const reversed: Record<string, FactRecord> = { beta: recB, alpha: recA };
    expect(lookupFacts('a', reversed)).toBe(recB);
  });

  it('a custom map shadows the public corpus entirely (chalk not found in a foo-only map)', () => {
    const map = { foo: makeRecord({ package: 'foo' }) };
    expect(lookupFacts('foo', map)?.package).toBe('foo');
    expect(lookupFacts('chalk', map)).toBeNull();
  });

  it('returns null against an empty custom map', () => {
    expect(lookupFacts('chalk', {})).toBeNull();
  });
});

describe('loadFactMap — file-level fallback matrix (never throws)', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function writePrivate(raw: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-res-'));
    const p = join(tmpDir, 'private-facts.json');
    writeFileSync(p, raw, 'utf-8');
    return p;
  }

  it('undefined path returns the VERIFIED_FACTS reference itself (identity, byte-identical public-only)', () => {
    const map = loadFactMap(undefined);
    expect(map).toBe(VERIFIED_FACTS); // same reference, not just equal
  });

  it('empty-string path is falsy → returns the VERIFIED_FACTS reference', () => {
    expect(loadFactMap('')).toBe(VERIFIED_FACTS);
  });

  it('missing file → public-only, value-equal to VERIFIED_FACTS, no throw', () => {
    const missing = join(tmpdir(), 'starlog-missing-' + Date.now(), 'nope.json');
    let map!: Record<string, FactRecord>;
    expect(() => {
      map = loadFactMap(missing);
    }).not.toThrow();
    expect(map).toEqual(VERIFIED_FACTS);
  });

  it('path that is a DIRECTORY (readFileSync throws EISDIR) → public-only, no throw', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-res-'));
    let map!: Record<string, FactRecord>;
    expect(() => {
      map = loadFactMap(tmpDir as string); // the dir path itself
    }).not.toThrow();
    expect(map).toEqual(VERIFIED_FACTS);
  });

  it('invalid JSON → public-only, no throw', () => {
    const map = loadFactMap(writePrivate('{ not valid json'));
    expect(map).toEqual(VERIFIED_FACTS);
  });

  it('non-array JSON object → treated as no entries → public-only (fresh object, value-equal)', () => {
    const map = loadFactMap(writePrivate('{"package":"x"}'));
    expect(map).toEqual(VERIFIED_FACTS);
    // non-array path returns { ...VERIFIED_FACTS } — value-equal but a FRESH object
    expect(map).not.toBe(VERIFIED_FACTS);
  });

  it('non-array JSON bare number → public-only', () => {
    expect(loadFactMap(writePrivate('42'))).toEqual(VERIFIED_FACTS);
  });

  it('non-array JSON bare null → public-only', () => {
    expect(loadFactMap(writePrivate('null'))).toEqual(VERIFIED_FACTS);
  });

  it('non-array JSON string → public-only', () => {
    expect(loadFactMap(writePrivate('"just a string"'))).toEqual(VERIFIED_FACTS);
  });

  it('empty array → public-only (fresh object, value-equal, every public key intact)', () => {
    const map = loadFactMap(writePrivate('[]'));
    expect(map).toEqual(VERIFIED_FACTS);
    expect(map).not.toBe(VERIFIED_FACTS);
    expect(Object.keys(map).sort()).toEqual(Object.keys(VERIFIED_FACTS).sort());
  });
});

describe('loadFactMap — entry-level merge & skip semantics', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function writePrivate(entries: unknown[]): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-res-'));
    const p = join(tmpDir, 'private-facts.json');
    writeFileSync(p, JSON.stringify(entries), 'utf-8');
    return p;
  }

  it('private overlay merges on top of public; a private-only package resolves and public is untouched', () => {
    const internal = makeRecord({ package: '@acme/secret', maintenance: 'deprecated', source: 'ACME' });
    const map = loadFactMap(writePrivate([internal]));
    expect(map['@acme/secret']?.maintenance).toBe('deprecated');
    expect(lookupFacts('@acme/secret', map)?.package).toBe('@acme/secret');
    // public corpus preserved by reference for non-colliding keys
    expect(map['chalk']).toBe(VERIFIED_FACTS['chalk']);
    expect(Object.keys(map).length).toBe(Object.keys(VERIFIED_FACTS).length + 1);
  });

  it('on a package collision the PRIVATE entry WINS (replaces the public record wholesale)', () => {
    const override = makeRecord({
      package: 'chalk',
      maintenance: 'compromised',
      effect_surface: 'ORG OVERRIDE: internal banned fork',
      source: 'ACME internal ruling',
    });
    const map = loadFactMap(writePrivate([override]));
    expect(map['chalk'].maintenance).toBe('compromised');
    expect(map['chalk'].effect_surface).toBe('ORG OVERRIDE: internal banned fork');
    expect(map['chalk']).not.toBe(VERIFIED_FACTS['chalk']);
    // key count unchanged (override, not addition)
    expect(Object.keys(map).length).toBe(Object.keys(VERIFIED_FACTS).length);
  });

  it('with two private entries for the SAME package, the LAST one in the array wins', () => {
    const first = makeRecord({ package: '@acme/dup', source: 'first' });
    const second = makeRecord({ package: '@acme/dup', source: 'second' });
    const map = loadFactMap(writePrivate([first, second]));
    expect(map['@acme/dup'].source).toBe('second');
  });

  it('skips a schema-malformed entry (missing required fields) but loads the valid sibling', () => {
    const valid = makeRecord({ package: '@acme/good' });
    const malformed = { package: '@acme/broken', verified: true }; // missing effect_surface, etc.
    const map = loadFactMap(writePrivate([valid, malformed]));
    expect(map['@acme/good']).toBeDefined();
    expect(map['@acme/broken']).toBeUndefined();
  });

  it('skips an entry with an out-of-enum field (bad maintenance value)', () => {
    const valid = makeRecord({ package: '@acme/good2' });
    const badEnum = { ...makeRecord({ package: '@acme/badenum' }), maintenance: 'mostly-fine' };
    const map = loadFactMap(writePrivate([valid, badEnum]));
    expect(map['@acme/good2']).toBeDefined();
    expect(map['@acme/badenum']).toBeUndefined();
  });

  it('skips a verified:false entry; the public corpus is unchanged in count', () => {
    const draft = makeRecord({ package: '@acme/draft', verified: false });
    const map = loadFactMap(writePrivate([draft]));
    expect(map['@acme/draft']).toBeUndefined();
    expect(Object.keys(map).length).toBe(Object.keys(VERIFIED_FACTS).length);
  });

  it('a verified:false override for a PUBLIC package does NOT override it (public record survives)', () => {
    const sabotage = makeRecord({ package: 'chalk', verified: false, maintenance: 'compromised' });
    const map = loadFactMap(writePrivate([sabotage]));
    // skipped → public chalk remains the authoritative record
    expect(map['chalk']).toBe(VERIFIED_FACTS['chalk']);
    expect(map['chalk'].maintenance).toBe('active');
  });

  it('skips entries whose last_verified is the WRONG FORMAT (single-digit, slashes, no dashes, prose)', () => {
    const valid = makeRecord({ package: '@acme/dated-ok' });
    const singleDigit = makeRecord({ package: '@acme/d1', last_verified: '2026-6-1' });
    const slashes = makeRecord({ package: '@acme/d2', last_verified: '06/01/2026' });
    const noDashes = makeRecord({ package: '@acme/d3', last_verified: '20260601' });
    const prose = makeRecord({ package: '@acme/d4', last_verified: 'June 1 2026' });
    const map = loadFactMap(writePrivate([valid, singleDigit, slashes, noDashes, prose]));
    expect(map['@acme/dated-ok']).toBeDefined();
    expect(map['@acme/d1']).toBeUndefined();
    expect(map['@acme/d2']).toBeUndefined();
    expect(map['@acme/d3']).toBeUndefined();
    expect(map['@acme/d4']).toBeUndefined();
  });

  it('applies ecosystem default ("npm") to a private entry that omits the field', () => {
    const noEco = { ...makeRecord({ package: '@acme/no-eco' }) } as Record<string, unknown>;
    delete noEco.ecosystem;
    const map = loadFactMap(writePrivate([noEco]));
    expect(map['@acme/no-eco']?.ecosystem).toBe('npm');
  });

  // ── DATE-GATE: the freshness gate rejects impossible calendar dates ───────
  // last_verified uses z.iso.date(), which validates the YYYY-MM-DD shape AND
  // calendar validity. An impossible date (month 13, day 99 / Feb 30) must fail
  // the schema and be SKIPPED by the overlay loader — otherwise a garbage "as
  // of" date would be served to agents, defeating the freshness gate.
  // (Regression guard for the shape-only-regex bug found in review.)
  it('rejects an impossible-calendar last_verified and the loader skips it', () => {
    for (const bad of ['2026-13-99', '2026-02-30', '2026-00-10', '2026-06-31']) {
      expect(FactRecordSchema.safeParse(makeRecord({ last_verified: bad })).success).toBe(false);
    }
    const impossible = makeRecord({ package: '@acme/impossible-date', last_verified: '2026-13-99' });
    const valid = makeRecord({ package: '@acme/good-date', last_verified: '2026-06-01' });
    const map = loadFactMap(writePrivate([impossible, valid]));
    expect(map['@acme/impossible-date']).toBeUndefined(); // skipped — garbage date
    expect(map['@acme/good-date']).toBeDefined(); // valid sibling still loads
  });
});

describe('VERIFIED_FACTS / FACT_STUBS — corpus invariants', () => {
  it('VERIFIED_FACTS keys are exactly the verified FACT_STUBS package names, in insertion order', () => {
    const expected = FACT_STUBS.filter((f) => f.verified).map((f) => f.package);
    expect(Object.keys(VERIFIED_FACTS)).toEqual(expected);
  });

  it('every served record passes its own schema and is verified:true', () => {
    for (const rec of Object.values(VERIFIED_FACTS)) {
      expect(FactRecordSchema.safeParse(rec).success).toBe(true);
      expect(rec.verified).toBe(true);
    }
  });
});
