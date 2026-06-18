import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runSearch } from './search-service.js';

/**
 * Integration coverage for the hosted-corpus wiring in runSearch: the unit tests
 * (engine/hosted-corpus.test.ts) prove fetchHostedCorpus in isolation; these prove
 * runSearch actually USES it when keyed, and FALLS BACK to the bundled corpus on
 * any failure. STARLOG_API_KEY is stubbed in every test so the dev/CI shell's real
 * key can't leak in and flip the tier (the same hermeticity trap we hit before).
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const drizzle = JSON.parse(readFileSync(join(here, '..', 'corpus-free', 'orm-database', 'drizzle.json'), 'utf-8'));

function okSearch(manifest: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ results: [{ rank: 1, score: 9, manifest }] }) } as unknown as Response;
}

describe('runSearch — hosted corpus tier wiring', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  function hermeticEnv(key: string) {
    vi.stubEnv('STARLOG_API_KEY', key);
    vi.stubEnv('STARLOG_PRIVATE_CORPUS', ''); // no private overlay interfering
    vi.stubEnv('OPENROUTER_API_KEY', ''); // keep the LLM ranker offline
  }

  it('uses the HOSTED candidate set when STARLOG_API_KEY is set', async () => {
    hermeticEnv('sk-test');
    // A manifest that exists ONLY in the hosted response — if it surfaces, the
    // candidate set came from /search, not the bundled corpus.
    const hostedOnly = { ...drizzle, id: 'hosted-only-orm', name: 'hosted-only-orm' };
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/search?');
      return okSearch(hostedOnly);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await runSearch({ query: 'type-safe orm for the database' });
    expect(fetchMock).toHaveBeenCalled();
    expect(out.map((r) => r.manifest.id)).toContain('hosted-only-orm');
  });

  it('falls back to the LOCAL corpus when the hosted fetch fails', async () => {
    hermeticEnv('sk-test');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);

    const out = await runSearch({ query: 'type-safe orm for the database' });
    // The bundled drizzle is still found — the failure degraded to local, not nothing.
    expect(out.map((r) => r.manifest.id)).toContain('drizzle');
  });

  it('keyless: never calls the hosted API, ranks the local corpus', async () => {
    hermeticEnv('');
    const fetchMock = vi.fn(async () => { throw new Error('should not fetch'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await runSearch({ query: 'type-safe orm for the database' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.map((r) => r.manifest.id)).toContain('drizzle');
  });
});
