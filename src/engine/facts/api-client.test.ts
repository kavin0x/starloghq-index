import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { parseFactsApiResponse, createFactsApiClient } from './api-client.js';
import type { L2Overlay } from '@starloghq/facts-schema';

const validL1 = { package: 'p', ecosystem: 'npm', version_range: null, artifact_sha256: null, effect_surface: 'x', capabilities: [], provenance: { derived_by: 'hand', source: 's', verified: true } };
const validL2: L2Overlay = { package: 'p', ecosystem: 'npm', known_vulns: [], license: 'MIT', license_risk: 'none', maintenance: 'active', transitive_risk: null, attestation: { source: 'osv', refs: ['OSV-1'], fetched_at: '2026-06-01' } };
const validPolicy = { org: 'acme', rules: [{ id: 'r', decision: 'deny', match: { package: 'p' }, rationale: 'x' }] };

describe('parseFactsApiResponse — defensive envelope reader', () => {
  it('reads l1/l2/l3 and found from a well-formed envelope', () => {
    const r = parseFactsApiResponse({ l1: validL1, l2: validL2, l3: validPolicy, found: true });
    expect(r.l1?.package).toBe('p');
    expect(r.l2?.attestation.source).toBe('osv');
    expect(r.l3?.org).toBe('acme');
    expect(r.found).toBe(true);
  });

  it('a malformed layer becomes null (not a throw), independent of the others', () => {
    const r = parseFactsApiResponse({ l1: { garbage: true }, l2: validL2, l3: null, found: true });
    expect(r.l1).toBeNull();
    expect(r.l2).not.toBeNull();
    expect(r.l3).toBeNull();
  });

  it('derives found from presence when the field is absent', () => {
    expect(parseFactsApiResponse({ l2: validL2 }).found).toBe(true);
    expect(parseFactsApiResponse({}).found).toBe(false);
  });

  it('a bare/garbage payload yields all-null, found:false (never throws)', () => {
    expect(parseFactsApiResponse(null).found).toBe(false);
    expect(parseFactsApiResponse([1, 2, 3]).found).toBe(false);
    expect(parseFactsApiResponse('nope').l1).toBeNull();
  });
});

describe('createFactsApiClient', () => {
  // Hermetic env: createFactsApiClient falls back to process.env.STARLOG_API_KEY
  // when opts.apiKey is undefined (api-client.ts), so a key exported in the dev/CI
  // shell would otherwise make the "no key → null" case pass-or-fail on ambient
  // state. Stub it empty so the guard is exercised deterministically everywhere.
  beforeEach(() => vi.stubEnv('STARLOG_API_KEY', ''));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns null when no key is configured', () => {
    expect(createFactsApiClient({ apiKey: undefined, baseUrl: 'http://t' })).toBeNull();
  });

  const fakeRes = (ok: boolean, body: unknown, status = ok ? 200 : 500): Response =>
    ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: async () => body } as unknown as Response);

  it('getFacts sends Bearer auth + package param and parses the envelope', async () => {
    const fetchMock = vi.fn(async () => fakeRes(true, { l1: validL1, l2: validL2, l3: null, found: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createFactsApiClient({ apiKey: 'k', baseUrl: 'http://t' })!;
    const res = await client.getFacts('p', 'npm');
    expect(res?.found).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://t/facts?package=p&ecosystem=npm');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('getFacts returns null on non-OK and on network error (caller falls back to local)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(false, {}, 503)));
    expect(await createFactsApiClient({ apiKey: 'k', baseUrl: 'http://t' })!.getFacts('p')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await createFactsApiClient({ apiKey: 'k', baseUrl: 'http://t' })!.getFacts('p')).toBeNull();
  });

  it('pushL2 POSTs a batch and reports count; pushPolicy POSTs the policy', async () => {
    const fetchMock = vi.fn(async () => fakeRes(true, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createFactsApiClient({ apiKey: 'k', baseUrl: 'http://t' })!;
    const push = await client.pushL2([validL2]);
    expect(push).toEqual({ ok: true, count: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://t/facts/l2');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ overlays: [validL2] });

    const polRes = await client.pushPolicy(validPolicy as never);
    expect(polRes.ok).toBe(true);
  });

  it('pushL2 with no overlays is a no-op success (no request)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await createFactsApiClient({ apiKey: 'k', baseUrl: 'http://t' })!.pushL2([])).toEqual({ ok: true, count: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pushL2 reports the error on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(false, {}, 401)));
    const res = await createFactsApiClient({ apiKey: 'k', baseUrl: 'http://t' })!.pushL2([validL2]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('401');
  });

  it('relays X-Starlog-Anon-Id when an anon id is present (the CLI->person stitch)', async () => {
    const fetchMock = vi.fn(async () => fakeRes(true, { found: false }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createFactsApiClient({ apiKey: 'k', baseUrl: 'http://t', anonId: 'anon-123' })!;
    await client.getFacts('p');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Starlog-Anon-Id']).toBe('anon-123');
    // still carries auth
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('omits X-Starlog-Anon-Id entirely when telemetry is opted out (anonId null)', async () => {
    const fetchMock = vi.fn(async () => fakeRes(true, { found: false }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createFactsApiClient({ apiKey: 'k', baseUrl: 'http://t', anonId: null })!;
    await client.getFacts('p');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Starlog-Anon-Id']).toBeUndefined();
  });
});
