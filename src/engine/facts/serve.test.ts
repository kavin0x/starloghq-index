import { describe, it, expect } from 'vitest';
import { resolveFactView, buildComposeDeps } from './service.js';
import type { FactsApiClient, FactsApiResponse, PushResult } from './api-client.js';
import type { L2Overlay, L3Policy } from '@starloghq/facts-schema';

const local = buildComposeDeps({}); // public corpus only (no env)

// A stub API client that returns a fixed GET /facts envelope.
const stubApi = (res: FactsApiResponse | null): FactsApiClient => ({
  getFacts: async () => res,
  pushL2: async (): Promise<PushResult> => ({ ok: true }),
  pushPolicy: async (): Promise<PushResult> => ({ ok: true }),
});

const apiL2: L2Overlay = { package: 'left-pad', ecosystem: 'npm', known_vulns: [], license: 'ORG-RULING', license_risk: 'none', maintenance: 'deprecated', transitive_risk: null, attestation: { source: 'osv', refs: ['OSV-x'], fetched_at: '2026-06-02' } };
const policy: L3Policy = { org: 'acme', rules: [{ id: 'dep', decision: 'flag', match: { maintenance: 'deprecated' }, rationale: 'use the v2' }] };

describe('resolveFactView — API-first with local fallback', () => {
  it('no API client → pure local compose', async () => {
    const v = await resolveFactView('ua-parser-js', { local, api: null });
    expect(v?.l1?.effect_surface).toBeTruthy();
    expect(v?.l2?.known_vulns[0].id).toContain('ua-parser-js');
    expect(v?.l3.decision).toBe('none');
  });

  it('API wins per layer: API L2 + local L1, and the org policy is evaluated client-side', async () => {
    const api = stubApi({ l1: null, l2: apiL2, l3: policy, found: true });
    const v = await resolveFactView('left-pad', { local, api });
    expect(v?.l2?.license).toBe('ORG-RULING'); // API L2 authoritative
    expect(v?.l1?.effect_surface).toContain('Pads a string'); // filled from local L1
    expect(v?.l3.decision).toBe('flag'); // evaluatePolicy(API policy) ran here
    expect(v?.l3.rule_id).toBe('dep');
  });

  it('API error (getFacts → null) falls back to the local corpus', async () => {
    const v = await resolveFactView('chalk', { local, api: stubApi(null) });
    expect(v?.l2?.license).toBe('MIT'); // local public value
    expect(v?.l3.decision).toBe('none');
  });

  it('API found:false falls through to local (offline-first: the bundled corpus still serves)', async () => {
    const v = await resolveFactView('chalk', { local, api: stubApi({ l1: null, l2: null, l3: null, found: false }) });
    expect(v?.package).toBe('chalk');
    expect(v?.l1).not.toBeNull();
  });

  it('an org-private-only package (not in local corpus) resolves purely from the API', async () => {
    const privL2: L2Overlay = { ...apiL2, package: '@acme/internal' };
    const v = await resolveFactView('@acme/internal', { local, api: stubApi({ l1: null, l2: privL2, l3: null, found: true }) });
    expect(v?.package).toBe('@acme/internal');
    expect(v?.l2?.license).toBe('ORG-RULING');
    expect(v?.l1).toBeNull(); // not in local corpus, none from API
  });

  it('a genuine miss (no API, not in local) → null', async () => {
    expect(await resolveFactView('totally-unknown-xyz', { local, api: null })).toBeNull();
  });
});
