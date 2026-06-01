import { describe, it, expect, vi } from 'vitest';
import { search } from './search.js';
import type { CapabilityManifest } from '../manifest/schema.js';
import type { SiftrankFn, SiftrankResult, LlmFn } from './types.js';

// --- Mock data ---

function makeMockManifest(overrides: Partial<CapabilityManifest>): CapabilityManifest {
  return {
    id: 'mock-lib',
    name: 'Mock Library',
    repo: 'mock/mock',
    ecosystem: 'npm',
    category: 'authentication',
    solves: 'Mock authentication solution',
    stack_affinity: ['next.js', 'react'],
    integration_effort: 'easy',
    best_for: ['prototyping', 'small apps'],
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

const clerkManifest = makeMockManifest({
  id: 'clerk',
  name: 'Clerk',
  category: 'authentication',
  stack_affinity: ['next.js', 'react', 'remix'],
  solves: 'Managed auth with pre-built UI components',
  best_for: ['SaaS apps', 'rapid prototyping'],
});

const nextauthManifest = makeMockManifest({
  id: 'nextauth',
  name: 'NextAuth.js',
  category: 'authentication',
  stack_affinity: ['next.js'],
  solves: 'Self-hosted authentication for Next.js',
  best_for: ['Next.js apps needing self-hosted auth'],
});

const passportManifest = makeMockManifest({
  id: 'passport',
  name: 'Passport',
  category: 'authentication',
  stack_affinity: ['express', 'node'],
  solves: 'Authentication middleware for Express/Node',
  best_for: ['Express apps'],
});

const ioredisManifest = makeMockManifest({
  id: 'ioredis',
  name: 'ioredis',
  category: 'caching',
  stack_affinity: ['node', 'next.js'],
  solves: 'Redis client for distributed caching',
  best_for: ['production APIs needing shared cache'],
});

const nodeCacheManifest = makeMockManifest({
  id: 'node-cache',
  name: 'node-cache',
  category: 'caching',
  stack_affinity: ['node'],
  solves: 'Simple in-memory caching for Node.js',
  best_for: ['single-process local caching'],
});

const launchdarklyManifest = makeMockManifest({
  id: 'launchdarkly',
  name: 'LaunchDarkly',
  category: 'feature-flags',
  stack_affinity: ['next.js', 'react', 'node', 'python'],
  solves: 'Production feature flag management',
  best_for: ['teams needing gradual rollouts'],
});

const customDiyManifest = makeMockManifest({
  id: 'custom-authentication',
  name: 'Custom/DIY Authentication',
  category: 'authentication',
  repo: null,
  stack_affinity: ['any'],
  integration_effort: 'significant',
  solves: 'Build authentication from scratch',
  best_for: ['learning purposes'],
  skip_when: ['production apps', 'security-critical systems'],
});

const allManifests: CapabilityManifest[] = [
  clerkManifest,
  nextauthManifest,
  passportManifest,
  ioredisManifest,
  nodeCacheManifest,
  launchdarklyManifest,
  customDiyManifest,
];

// --- Mock deps ---

/**
 * Create a mock SiftrankFn that returns ranked results based on manifest order.
 * The first manifest in the filtered set gets the highest score.
 */
function createMockSiftrank(scoreMap?: Record<string, number>): SiftrankFn {
  return async (manifests, _query) => {
    return manifests.map((m, i) => ({
      key: m.id,
      value: m.name,
      object: { id: m.id, name: m.name },
      score: scoreMap?.[m.id] ?? (100 - i * 10),
      exposure: i + 1,
      rank: i + 1,
    }));
  };
}

/**
 * Create a mock LlmFn that returns canned JSON responses.
 * Parses the prompt to extract manifest IDs and returns analysis for each.
 */
function createMockLlm(): LlmFn {
  return async (prompt, _system?) => {
    // Extract manifest IDs from the prompt (format: "Name (id): ...")
    const idMatches = prompt.match(/\(([a-z0-9-]+)\):/g) || [];
    const ids = idMatches.map((m) => m.slice(1, -2)); // strip parens and colon

    const analysis = ids.length > 0
      ? ids.map((id) => ({
          id,
          vs_custom: 'Using this library saves 40 hours of custom development',
          context_fit: 'Good fit for the project stack and requirements',
          tradeoffs: ['Vendor lock-in risk', 'Monthly cost after free tier'],
        }))
      : [{
          id: 'mock',
          vs_custom: 'Using this library saves 40 hours of custom development',
          context_fit: 'Good fit for the project stack and requirements',
          tradeoffs: ['Vendor lock-in risk', 'Monthly cost after free tier'],
        }];

    return JSON.stringify({ analysis });
  };
}

/**
 * Create a mock LlmFn that tracks calls.
 */
function createTrackingMockLlm(): { llm: LlmFn; calls: string[] } {
  const calls: string[] = [];
  const llm: LlmFn = async (prompt, _system?) => {
    calls.push(prompt);
    // Extract manifest IDs from the prompt (format: "Name (id): ...")
    const idMatches = prompt.match(/\(([a-z0-9-]+)\):/g) || [];
    const ids = idMatches.map((m) => m.slice(1, -2));

    const analysis = ids.length > 0
      ? ids.map((id) => ({
          id,
          vs_custom: 'Saves development time',
          context_fit: 'Fits well',
          tradeoffs: ['Some tradeoff'],
        }))
      : [{
          id: 'mock',
          vs_custom: 'Saves development time',
          context_fit: 'Fits well',
          tradeoffs: ['Some tradeoff'],
        }];

    return JSON.stringify({ analysis });
  };
  return { llm, calls };
}

// =======================================================================
// Tests
// =======================================================================

describe('search()', () => {
  // 1. Category filtering (4 tests)
  describe('category filtering', () => {
    it('returns only auth manifests when category=authentication', async () => {
      const results = await search('auth for my app', allManifests, {
        category: 'authentication',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.manifest.category).toBe('authentication');
      }
    });

    it('returns only caching manifests when category=caching', async () => {
      const results = await search('cache for my API', allManifests, {
        category: 'caching',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.manifest.category).toBe('caching');
      }
    });

    it('returns empty array when category matches nothing', async () => {
      const results = await search('background jobs', allManifests, {
        category: 'background-jobs',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results).toEqual([]);
    });

    it('returns manifests from all categories when no category filter', async () => {
      const results = await search('tools for my project', allManifests, {}, {
        siftrank: createMockSiftrank(),
        llm: createMockLlm(),
      });

      const categories = new Set(results.map((r) => r.manifest.category));
      expect(categories.size).toBeGreaterThan(1);
    });
  });

  // 2. Stack filtering (4 tests)
  describe('stack filtering', () => {
    it('filters to manifests with next.js in stack_affinity', async () => {
      const results = await search('auth', allManifests, {
        category: 'authentication',
        stack: 'next.js',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(
          r.manifest.stack_affinity.some((s) => s.toLowerCase().includes('next.js')),
        ).toBe(true);
      }
    });

    it('filters to manifests with python stack affinity', async () => {
      const results = await search('feature flags', allManifests, {
        stack: 'python',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(
          r.manifest.stack_affinity.some((s) => s.toLowerCase().includes('python')),
        ).toBe(true);
      }
    });

    it('stack filter is case-insensitive', async () => {
      const resultsLower = await search('auth', allManifests, {
        category: 'authentication',
        stack: 'next.js',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      const resultsUpper = await search('auth', allManifests, {
        category: 'authentication',
        stack: 'Next.js',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(resultsLower.length).toBe(resultsUpper.length);
      expect(resultsLower.map((r) => r.manifest.id)).toEqual(
        resultsUpper.map((r) => r.manifest.id),
      );
    });

    it('stack + category combined narrows results', async () => {
      const categoryOnly = await search('auth', allManifests, {
        category: 'authentication',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      const combined = await search('auth', allManifests, {
        category: 'authentication',
        stack: 'express',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(combined.length).toBeLessThan(categoryOnly.length);
    });
  });

  // 3. Ranking integration (4 tests)
  describe('ranking integration', () => {
    it('results are sorted by relevance_score descending', async () => {
      const scoreMap = { clerk: 90, nextauth: 70, passport: 50, 'custom-authentication': 30 };
      const results = await search('auth', allManifests, {
        category: 'authentication',
      }, { siftrank: createMockSiftrank(scoreMap), llm: createMockLlm() });

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].relevance_score).toBeGreaterThanOrEqual(results[i].relevance_score);
      }
    });

    it('topK=3 limits results to 3', async () => {
      const results = await search('auth', allManifests, {
        category: 'authentication',
        topK: 3,
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('topK defaults to 5 when not specified', async () => {
      // Create more than 5 auth manifests for this test
      const manyManifests = [
        ...allManifests,
        makeMockManifest({ id: 'auth0', name: 'Auth0', category: 'authentication' }),
        makeMockManifest({ id: 'lucia', name: 'Lucia', category: 'authentication' }),
        makeMockManifest({ id: 'supabase-auth', name: 'Supabase Auth', category: 'authentication' }),
      ];

      const results = await search('auth', manyManifests, {
        category: 'authentication',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('siftrank scores map to relevance_score correctly', async () => {
      const scoreMap = { clerk: 85, nextauth: 42 };
      const results = await search('auth', allManifests, {
        category: 'authentication',
        topK: 2,
        stack: 'next.js',
      }, { siftrank: createMockSiftrank(scoreMap), llm: createMockLlm() });

      const clerkResult = results.find((r) => r.manifest.id === 'clerk');
      const nextauthResult = results.find((r) => r.manifest.id === 'nextauth');
      expect(clerkResult).toBeDefined();
      expect(nextauthResult).toBeDefined();
      expect(clerkResult!.relevance_score).toBe(85);
      expect(nextauthResult!.relevance_score).toBe(42);
    });
  });

  // 4. vs_custom / tradeoffs (4 tests)
  describe('vs_custom and tradeoffs', () => {
    it('when projectContext provided, LLM is called and vs_custom is populated', async () => {
      const { llm, calls } = createTrackingMockLlm();
      const results = await search('auth for my SaaS', allManifests, {
        category: 'authentication',
        projectContext: 'Building a Next.js SaaS application',
        topK: 2,
      }, { siftrank: createMockSiftrank(), llm });

      expect(calls.length).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.vs_custom).toBeTruthy();
      }
    });

    it('when projectContext NOT provided, LLM is NOT called', async () => {
      const { llm, calls } = createTrackingMockLlm();
      const results = await search('auth', allManifests, {
        category: 'authentication',
        topK: 2,
      }, { siftrank: createMockSiftrank(), llm });

      expect(calls.length).toBe(0);
      for (const r of results) {
        expect(r.vs_custom).toBe('');
      }
    });

    it('tradeoffs array is populated from LLM response', async () => {
      const results = await search('auth', allManifests, {
        category: 'authentication',
        projectContext: 'Building a Next.js SaaS',
        topK: 1,
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results[0].tradeoffs.length).toBeGreaterThan(0);
    });

    it('context_fit is populated from LLM response', async () => {
      const results = await search('auth', allManifests, {
        category: 'authentication',
        projectContext: 'Building a Next.js SaaS',
        topK: 1,
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results[0].context_fit).toBeTruthy();
    });
  });

  // 5. Edge cases (4 tests)
  describe('edge cases', () => {
    it('empty corpus returns empty array', async () => {
      const results = await search('auth', [], {}, {
        siftrank: createMockSiftrank(),
        llm: createMockLlm(),
      });

      expect(results).toEqual([]);
    });

    it('corpus with only DIY manifests still returns results', async () => {
      const diyOnly = [customDiyManifest];
      const results = await search('auth', diyOnly, {
        category: 'authentication',
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results.length).toBe(1);
      expect(results[0].manifest.id).toBe('custom-authentication');
    });

    it('search() does not mutate input corpus array', async () => {
      const corpus = [...allManifests];
      const originalLength = corpus.length;
      const originalIds = corpus.map((m) => m.id);

      await search('auth', corpus, { category: 'authentication' }, {
        siftrank: createMockSiftrank(),
        llm: createMockLlm(),
      });

      expect(corpus.length).toBe(originalLength);
      expect(corpus.map((m) => m.id)).toEqual(originalIds);
    });

    it('search() with all filters matching nothing returns empty array', async () => {
      const results = await search('auth', allManifests, {
        category: 'authentication',
        stack: 'rust', // no auth manifest has rust stack_affinity
      }, { siftrank: createMockSiftrank(), llm: createMockLlm() });

      expect(results).toEqual([]);
    });
  });
});
