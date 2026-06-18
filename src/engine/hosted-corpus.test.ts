import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fetchHostedCorpus } from './hosted-corpus.js';

// A real, schema-valid manifest from the bundled corpus-free tier — guarantees
// the fixture passes CapabilityManifestSchema without hand-maintaining a shape.
const here = fileURLToPath(new URL('.', import.meta.url));
const drizzle = JSON.parse(
  readFileSync(join(here, '..', '..', 'corpus-free', 'orm-database', 'drizzle.json'), 'utf-8'),
);

function okResponse(results: unknown[]): Response {
  return { ok: true, status: 200, json: async () => ({ results }) } as unknown as Response;
}
const KEY = 'sk-test-123';

describe('fetchHostedCorpus', () => {
  it('returns null with no API key (keyless → local tier)', async () => {
    const out = await fetchHostedCorpus('orm', undefined, { fetchImpl: (() => { throw new Error('should not fetch'); }) as unknown as typeof fetch });
    expect(out).toBeNull();
  });

  it('returns null for an empty query', async () => {
    const out = await fetchHostedCorpus('  ', undefined, { apiKey: KEY, fetchImpl: (() => { throw new Error('should not fetch'); }) as unknown as typeof fetch });
    expect(out).toBeNull();
  });

  it('returns the manifests from /search results on a 200', async () => {
    let calledUrl = '';
    let auth = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calledUrl = String(url);
      auth = String((init.headers as Record<string, string>).Authorization);
      return okResponse([{ rank: 1, score: 9, manifest: drizzle }]);
    }) as unknown as typeof fetch;
    const out = await fetchHostedCorpus('orm', 'orm-database', { apiKey: KEY, baseUrl: 'https://api.example.test', fetchImpl });
    expect(out).not.toBeNull();
    expect(out!.map((m) => m.id)).toEqual(['drizzle']);
    expect(calledUrl).toContain('/search?');
    expect(calledUrl).toContain('q=orm');
    expect(calledUrl).toContain('category=orm-database');
    expect(calledUrl).toContain('top_k=50');
    expect(auth).toBe(`Bearer ${KEY}`);
  });

  it('returns null on a non-200 (→ local fallback)', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchHostedCorpus('orm', undefined, { apiKey: KEY, fetchImpl })).toBeNull();
  });

  it('returns null when fetch throws (network/abort)', async () => {
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await fetchHostedCorpus('orm', undefined, { apiKey: KEY, fetchImpl })).toBeNull();
  });

  it('returns null on an empty/garbage results body', async () => {
    expect(await fetchHostedCorpus('orm', undefined, { apiKey: KEY, fetchImpl: (async () => okResponse([])) as unknown as typeof fetch })).toBeNull();
    expect(await fetchHostedCorpus('orm', undefined, { apiKey: KEY, fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch })).toBeNull();
  });

  it('drops schema-invalid manifests, returns null if none survive', async () => {
    const fetchImpl = (async () => okResponse([{ rank: 1, score: 9, manifest: { id: 'broken' } }])) as unknown as typeof fetch;
    expect(await fetchHostedCorpus('orm', undefined, { apiKey: KEY, fetchImpl })).toBeNull();
  });
});
