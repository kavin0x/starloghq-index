import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseApiResults, runSearch } from './search-service.js';

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'clerk',
    name: 'Clerk',
    repo: 'clerkinc/clerk',
    ecosystem: 'npm',
    category: 'authentication',
    solves: 'Managed authentication with pre-built UI.',
    stack_affinity: ['next.js', 'react'],
    integration_effort: 'easy',
    best_for: ['SaaS apps'],
    skip_when: ['air-gapped'],
    hosted_alternative: null,
    alternative_ids: [],
    health: { stars: 8000, last_commit: '2026-01-15', contributors: 45, license: 'MIT', open_issues: 12 },
    quality: { has_tests: true, has_docs: true, has_types: true, maintenance_status: 'active' },
    ...overrides,
  };
}

describe('parseApiResults()', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  it('parses the hosted envelope { results: [{ rank, score, manifest }] }', () => {
    const results = parseApiResults({
      query: 'auth', category: 'all', total_manifests: 90, results_count: 2,
      results: [
        { rank: 1, score: 25, manifest: validManifest({ id: 'auth0' }) },
        { rank: 2, score: 25, manifest: validManifest({ id: 'clerk' }) },
      ],
    });
    expect(results.map((r) => r.manifest.id)).toEqual(['auth0', 'clerk']);
    // Score derived from rank (the API's own score is flat) -> monotonic desc.
    expect(results[0].relevance_score).toBe(100);
    expect(results[1].relevance_score).toBeLessThan(results[0].relevance_score);
  });

  it('orders by rank even if the envelope is out of order', () => {
    const results = parseApiResults({
      results: [
        { rank: 2, manifest: validManifest({ id: 'clerk' }) },
        { rank: 1, manifest: validManifest({ id: 'auth0' }) },
      ],
    });
    expect(results.map((r) => r.manifest.id)).toEqual(['auth0', 'clerk']);
  });

  it('still accepts a bare array of manifests (legacy/forward-compat)', () => {
    const results = parseApiResults([validManifest()]);
    expect(results).toHaveLength(1);
    expect(results[0].manifest.id).toBe('clerk');
    expect(results[0].relevance_score).toBe(100);
  });

  it('skips malformed entries but keeps valid ones', () => {
    const results = parseApiResults([
      validManifest({ id: 'good', _score: 10 }),
      { id: 'bad', category: 'authentication' }, // missing required fields
      'not even an object',
      null,
    ]);
    expect(results.map((r) => r.manifest.id)).toEqual(['good']);
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns [] for a non-array payload', () => {
    expect(parseApiResults({ error: 'nope' })).toEqual([]);
    expect(parseApiResults(null)).toEqual([]);
  });

  it('strips the _score field from the returned manifest (schema-clean)', () => {
    const results = parseApiResults([validManifest({ _score: 5 })]);
    expect('_score' in (results[0].manifest as Record<string, unknown>)).toBe(false);
  });
});

describe('runSearch() API tier', () => {
  const origKey = process.env.STARLOG_API_KEY;
  const origGopath = process.env.GOPATH;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.STARLOG_API_KEY = 'test-key';
    // Force the siftrank binary lookup to miss so the local fallback uses the
    // keyword ranker instantly. Otherwise, on a machine that happens to have
    // siftrank installed, these tests spawn the real binary (and may hit the
    // network), making them slow and flaky -- and breaking the "no external
    // binaries" invariant the suite is supposed to hold.
    process.env.GOPATH = '/nonexistent-starlog-test-gopath';
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env.STARLOG_API_KEY;
    else process.env.STARLOG_API_KEY = origKey;
    if (origGopath === undefined) delete process.env.GOPATH;
    else process.env.GOPATH = origGopath;
    vi.unstubAllGlobals();
    errSpy.mockRestore();
  });

  it('returns validated API results without touching the local corpus', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ results: [{ rank: 1, score: 25, manifest: validManifest({ id: 'auth0' }) }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch({ query: 'auth' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].manifest.id).toBe('auth0');
    expect(results[0].relevance_score).toBe(100);
  });

  it('falls back to the local corpus (no throw) when the API request fails', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch({ query: 'authentication', category: 'authentication' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.isArray(results)).toBe(true); // local engine answered instead of crashing
    expect(errSpy).toHaveBeenCalled();          // logged the fallback
  });

  it('falls back to local when the API returns no usable results', async () => {
    // Empty/whiffed API response must NOT black-hole the search -- fall through
    // to the local corpus (the safety net) rather than return [] for an
    // in-corpus query.
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ results: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch({ query: 'authentication', category: 'authentication' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0); // local answered
    expect(errSpy).toHaveBeenCalled();
  });

  it('falls back to local when a non-empty API payload fails validation entirely (shape drift)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ results: [{ rank: 1, manifest: { id: 'broken', category: 'authentication' } }, { rank: 2, manifest: { nope: true } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch({ query: 'authentication', category: 'authentication' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.isArray(results)).toBe(true); // fell back to local instead of masquerading as empty
    expect(errSpy).toHaveBeenCalled();
  });

  it('falls back to local when the API returns a non-ok status', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch({ query: 'authentication', category: 'authentication' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.isArray(results)).toBe(true);
  });

  it('passes an abort signal to fetch (timeout wiring)', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, status: 200, statusText: 'OK', json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);

    await runSearch({ query: 'auth' });
    expect(fetchMock).toHaveBeenCalled();
  });
});
