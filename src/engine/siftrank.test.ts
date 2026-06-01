import { describe, it, expect } from 'vitest';
import { keywordSiftrank } from './siftrank.js';
import type { CapabilityManifest } from '../manifest/schema.js';

// Minimal manifest factory -- only the fields the keyword ranker reads matter;
// the rest satisfy the type without affecting scoring.
function manifest(
  over: Partial<CapabilityManifest> & Pick<CapabilityManifest, 'id' | 'name' | 'category'>,
): CapabilityManifest {
  return {
    repo: null,
    ecosystem: 'npm',
    solves: '',
    stack_affinity: [],
    integration_effort: 'moderate',
    best_for: [],
    skip_when: [],
    hosted_alternative: null,
    alternative_ids: [],
    health: { stars: 0, last_commit: '2025-01-01', contributors: 0, license: 'MIT', open_issues: 0 },
    quality: { has_tests: true, has_docs: true, has_types: true, maintenance_status: 'active' },
    ...over,
  } as CapabilityManifest;
}

const CORPUS: CapabilityManifest[] = [
  manifest({
    id: 'auth0',
    name: 'Auth0 Next.js SDK',
    category: 'authentication',
    solves: 'Implements user authentication in Next.js applications',
    stack_affinity: ['next.js', 'react'],
    health: { stars: 100, weekly_downloads: 2_000_000, last_commit: '2025-01-01', contributors: 50, license: 'MIT', open_issues: 10 },
  }),
  manifest({
    id: 'clerk',
    name: 'Clerk',
    category: 'authentication',
    solves: 'Fully managed authentication and user management platform',
    stack_affinity: ['next.js', 'react'],
    health: { stars: 100, weekly_downloads: 500_000, last_commit: '2025-01-01', contributors: 30, license: 'MIT', open_issues: 5 },
  }),
  manifest({
    id: 'inngest',
    name: 'Inngest',
    category: 'background-jobs',
    solves: 'Durable execution and event-driven background jobs',
    stack_affinity: ['next.js', 'node'],
  }),
  manifest({
    id: 'resend',
    name: 'Resend',
    category: 'email',
    solves: 'Transactional email API for developers',
    stack_affinity: ['node'],
  }),
];

describe('keywordSiftrank', () => {
  it('ranks the on-category libraries first and drops off-category noise', async () => {
    const results = await keywordSiftrank(CORPUS, 'auth for a Next.js app');
    expect(results[0].key).toBe('auth0');
    expect(results[1].key).toBe('clerk');
    // Off-category libraries that only coincide on stack ("next.js") -- inngest,
    // resend -- are filtered out entirely, not just ranked low.
    const keys = results.map((r) => r.key);
    expect(keys).not.toContain('inngest');
    expect(keys).not.toContain('resend');
  });

  it('produces differentiated scores, not flat ties', async () => {
    const results = await keywordSiftrank(CORPUS, 'auth for a Next.js app');
    expect(results[0].score).toBe(100);
    // The runner-up is meaningfully below the top -- the old ranker tied at 100.
    expect(results[1].score).toBeLessThan(100);
    expect(results[0].score).not.toBe(results[1].score);
  });

  it('ignores stopwords -- "auth" and "auth for a good app" rank the same top', async () => {
    const bare = await keywordSiftrank(CORPUS, 'auth');
    const noisy = await keywordSiftrank(CORPUS, 'auth for a good app');
    expect(noisy[0].key).toBe(bare[0].key);
    expect(noisy[0].key).toBe('auth0');
  });

  it('keeps job-queue results in their own category and excludes auth libs', async () => {
    const results = await keywordSiftrank(CORPUS, 'background job queue');
    expect(results[0].key).toBe('inngest');
    // Auth libraries don't match the capability terms at all, so they're absent.
    const keys = results.map((r) => r.key);
    expect(keys).not.toContain('auth0');
    expect(keys).not.toContain('clerk');
  });

  it('returns rank in score-descending order, 1-based', async () => {
    const results = await keywordSiftrank(CORPUS, 'authentication');
    results.forEach((r, i) => expect(r.rank).toBe(i + 1));
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('returns nothing when no real term matches', async () => {
    const results = await keywordSiftrank(CORPUS, 'zzzznomatch');
    expect(results).toHaveLength(0);
  });

  it('drops a result that matches only the stack term, keeping the on-topic hit', async () => {
    // "next.js" matches inngest and auth0 (both list it), but only auth0 matches
    // it in a capability field -> inngest is stack-only noise and is dropped.
    const results = await keywordSiftrank(CORPUS, 'next.js');
    const keys = results.map((r) => r.key);
    expect(keys).toContain('auth0');
    expect(keys).not.toContain('inngest');
  });

  it('breaks ties toward the healthier (more-downloaded) library', async () => {
    // Two libraries identical except download counts -> the popular one leads.
    const twins: CapabilityManifest[] = [
      manifest({ id: 'low', name: 'Acme Cache', category: 'caching', solves: 'in-memory cache', health: { stars: 1, weekly_downloads: 1000, last_commit: '2025-01-01', contributors: 1, license: 'MIT', open_issues: 0 } }),
      manifest({ id: 'high', name: 'Acme Cache', category: 'caching', solves: 'in-memory cache', health: { stars: 1, weekly_downloads: 5_000_000, last_commit: '2025-01-01', contributors: 1, license: 'MIT', open_issues: 0 } }),
    ];
    const results = await keywordSiftrank(twins, 'cache');
    expect(results[0].key).toBe('high');
  });
});
