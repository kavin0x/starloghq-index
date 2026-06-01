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

  it('maps a valid payload, carrying _score into relevance_score', () => {
    const results = parseApiResults([validManifest({ _score: 87 })]);
    expect(results).toHaveLength(1);
    expect(results[0].manifest.id).toBe('clerk');
    expect(results[0].relevance_score).toBe(87);
  });

  it('defaults relevance_score to 0 when _score is missing', () => {
    const results = parseApiResults([validManifest()]);
    expect(results[0].relevance_score).toBe(0);
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
      json: async () => [validManifest({ id: 'auth0', _score: 99 })],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch({ query: 'auth' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].manifest.id).toBe('auth0');
    expect(results[0].relevance_score).toBe(99);
  });

  it('falls back to the local corpus (no throw) when the API request fails', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch({ query: 'authentication', category: 'authentication' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.isArray(results)).toBe(true); // local engine answered instead of crashing
    expect(errSpy).toHaveBeenCalled();          // logged the fallback
  });

  it('returns [] when the API legitimately finds nothing (trusts the authority)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch({ query: 'nonexistent-capability' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]); // did NOT fall back to local for a genuine empty
  });

  it('falls back to local when a non-empty API payload fails validation entirely (shape drift)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => [{ id: 'broken', category: 'authentication' }, { nope: true }],
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
