import { describe, it, expect } from 'vitest';
import { jaccardSimilarity, mmrRerank } from './rerank.js';
import type { CapabilityManifest } from '../manifest/schema.js';
import type { SiftrankResult } from './types.js';

// --- Test helpers ---

function makeMockManifest(overrides: Partial<CapabilityManifest>): CapabilityManifest {
  return {
    id: 'mock-lib',
    name: 'Mock Library',
    repo: 'mock/mock',
    ecosystem: 'npm',
    category: 'authentication',
    solves: 'Mock solution',
    stack_affinity: ['next.js', 'react'],
    integration_effort: 'easy',
    best_for: ['prototyping'],
    skip_when: ['enterprise needs'],
    hosted_alternative: null,
    alternative_ids: [],
    health: {
      stars: 1000,
      weekly_downloads: 50000,
      last_commit: '2026-01-01',
      contributors: 10,
      license: 'MIT',
      open_issues: 5,
    },
    quality: {
      has_tests: true,
      has_docs: true,
      has_types: true,
      maintenance_status: 'active',
    },
    ...overrides,
  };
}

// --- Test manifests ---

const authManifestA = makeMockManifest({
  id: 'clerk',
  name: 'Clerk',
  category: 'authentication',
  alternative_ids: ['nextauth', 'auth0'],
  stack_affinity: ['next.js', 'react', 'remix'],
});

const authManifestB = makeMockManifest({
  id: 'nextauth',
  name: 'NextAuth.js',
  category: 'authentication',
  alternative_ids: ['clerk', 'auth0'],
  stack_affinity: ['next.js'],
});

const cachingManifest = makeMockManifest({
  id: 'ioredis',
  name: 'ioredis',
  category: 'caching',
  alternative_ids: ['node-cache'],
  stack_affinity: ['node', 'express'],
});

const featureFlagManifest = makeMockManifest({
  id: 'launchdarkly',
  name: 'LaunchDarkly',
  category: 'feature-flags',
  alternative_ids: [],
  stack_affinity: ['python', 'java'],
});

// Identical to authManifestA for identity test
const authManifestAClone = makeMockManifest({
  id: 'clerk-clone',
  name: 'Clerk Clone',
  category: 'authentication',
  alternative_ids: ['nextauth', 'auth0'],
  stack_affinity: ['next.js', 'react', 'remix'],
});

// --- Siftrank result helpers ---

function makeSiftrankResult(key: string, score: number): SiftrankResult {
  return {
    key,
    value: key,
    object: { id: key },
    score,
    exposure: 1,
    rank: 1,
  };
}

// =======================================================================
// Tests
// =======================================================================

describe('jaccardSimilarity()', () => {
  it('returns 1.0 for identical manifests (same category, alternative_ids, stack_affinity)', () => {
    // authManifestA and authManifestAClone have identical metadata
    const sim = jaccardSimilarity(authManifestA, authManifestAClone);
    expect(sim).toBe(1.0);
  });

  it('returns 0.0 for manifests with no overlapping features', () => {
    // cachingManifest: category=caching, alt_ids=[node-cache], stack=[node, express]
    // featureFlagManifest: category=feature-flags, alt_ids=[], stack=[python, java]
    const sim = jaccardSimilarity(cachingManifest, featureFlagManifest);
    expect(sim).toBe(0.0);
  });

  it('returns value between 0 and 1 for partial overlap', () => {
    // authManifestA: category=authentication, alt_ids=[nextauth, auth0], stack=[next.js, react, remix]
    // authManifestB: category=authentication, alt_ids=[clerk, auth0], stack=[next.js]
    // overlap: authentication, auth0, next.js (3 items)
    // union: authentication, nextauth, auth0, next.js, react, remix, clerk (7 items)
    const sim = jaccardSimilarity(authManifestA, authManifestB);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
    expect(sim).toBeCloseTo(3 / 7);
  });

  it('is symmetric: similarity(a, b) === similarity(b, a)', () => {
    const simAB = jaccardSimilarity(authManifestA, cachingManifest);
    const simBA = jaccardSimilarity(cachingManifest, authManifestA);
    expect(simAB).toBe(simBA);
  });

  it('handles case-insensitive stack_affinity comparison', () => {
    const manifestUpper = makeMockManifest({
      id: 'upper',
      category: 'test',
      alternative_ids: [],
      stack_affinity: ['Next.js', 'React'],
    });
    const manifestLower = makeMockManifest({
      id: 'lower',
      category: 'test',
      alternative_ids: [],
      stack_affinity: ['next.js', 'react'],
    });
    const sim = jaccardSimilarity(manifestUpper, manifestLower);
    expect(sim).toBe(1.0);
  });
});

describe('mmrRerank()', () => {
  // Build a manifest map for reranking tests
  const manifestMap = new Map<string, CapabilityManifest>([
    ['clerk', authManifestA],
    ['nextauth', authManifestB],
    ['ioredis', cachingManifest],
    ['launchdarkly', featureFlagManifest],
  ]);

  it('returns empty array for empty input', () => {
    const result = mmrRerank([], manifestMap, 0.5);
    expect(result).toEqual([]);
  });

  it('returns single item unchanged', () => {
    const input = [makeSiftrankResult('clerk', 90)];
    const result = mmrRerank(input, manifestMap, 0.5);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('clerk');
    expect(result[0].score).toBe(90);
  });

  it('with lambda=1.0, returns items in score-descending order (pure relevance)', () => {
    const input = [
      makeSiftrankResult('clerk', 90),
      makeSiftrankResult('nextauth', 80),
      makeSiftrankResult('ioredis', 70),
      makeSiftrankResult('launchdarkly', 60),
    ];
    const result = mmrRerank(input, manifestMap, 1.0);
    expect(result.map(r => r.key)).toEqual(['clerk', 'nextauth', 'ioredis', 'launchdarkly']);
  });

  it('with lambda=0.0, maximizes diversity (lowest similarity preferred)', () => {
    // clerk and nextauth are very similar (both auth, overlapping alt_ids/stacks)
    // With lambda=0.0 and clerk as first pick (highest score),
    // ioredis or launchdarkly should be preferred over nextauth because they are less similar to clerk
    const input = [
      makeSiftrankResult('clerk', 90),
      makeSiftrankResult('nextauth', 80),
      makeSiftrankResult('ioredis', 70),
      makeSiftrankResult('launchdarkly', 60),
    ];
    const result = mmrRerank(input, manifestMap, 0.0);
    // First pick is always highest score
    expect(result[0].key).toBe('clerk');
    // Second pick should NOT be nextauth (too similar to clerk)
    expect(result[1].key).not.toBe('nextauth');
  });

  it('with lambda=0.5, balances relevance and diversity', () => {
    const input = [
      makeSiftrankResult('clerk', 90),
      makeSiftrankResult('nextauth', 85),
      makeSiftrankResult('ioredis', 70),
      makeSiftrankResult('launchdarkly', 60),
    ];
    const result = mmrRerank(input, manifestMap, 0.5);
    // First is always highest score
    expect(result[0].key).toBe('clerk');
    // Result should have all 4 items
    expect(result).toHaveLength(4);
  });

  it('always returns same number of items as input', () => {
    const input = [
      makeSiftrankResult('clerk', 90),
      makeSiftrankResult('nextauth', 80),
      makeSiftrankResult('ioredis', 70),
    ];
    const result = mmrRerank(input, manifestMap, 0.5);
    expect(result).toHaveLength(input.length);
  });

  it('does not mutate the input array', () => {
    const input = [
      makeSiftrankResult('clerk', 90),
      makeSiftrankResult('nextauth', 80),
      makeSiftrankResult('ioredis', 70),
    ];
    const inputCopy = [...input];
    mmrRerank(input, manifestMap, 0.5);
    expect(input).toEqual(inputCopy);
  });

  it('handles items not found in manifest map gracefully (treats as zero similarity)', () => {
    const input = [
      makeSiftrankResult('clerk', 90),
      makeSiftrankResult('unknown-lib', 80),
    ];
    const result = mmrRerank(input, manifestMap, 0.5);
    expect(result).toHaveLength(2);
  });
});
