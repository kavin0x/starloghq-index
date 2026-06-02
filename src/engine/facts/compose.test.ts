import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeFact, type ComposeDeps } from './compose.js';
import { evaluatePolicy, type L3Policy } from './l3-policy.js';
import { handAuthoredL2Source } from './l2-source.js';
import { buildComposeDeps, lookupFactView } from './service.js';
import type { L1CapabilityFact } from './l1-capability.js';
import type { L2Overlay } from './l2-overlay.js';

const mkL1 = (o: Partial<L1CapabilityFact> = {}): L1CapabilityFact => ({
  package: 'p', ecosystem: 'npm', version_range: null, artifact_sha256: null,
  effect_surface: 'does a thing', capabilities: [],
  provenance: { derived_by: 'hand', source: 's', verified: true }, ...o,
});
const mkL2 = (o: Partial<L2Overlay> = {}): L2Overlay => ({
  package: 'p', ecosystem: 'npm', known_vulns: [], license: 'MIT', license_risk: 'none',
  maintenance: 'active', transitive_risk: null,
  attestation: { source: 'hand', refs: ['r'], fetched_at: '2026-06-01' }, ...o,
});
const deps = (l1: L1CapabilityFact | null, l2: L2Overlay | null, policy?: L3Policy | null): ComposeDeps => ({
  l1Lookup: () => l1,
  l2Source: handAuthoredL2Source(l2 ? { [l2.package]: l2 } : {}),
  policy,
});

describe('composeFact — joins independent layers, supports partial views', () => {
  it('L1 + L2 → both present, default L3 verdict none', () => {
    const v = composeFact('p', deps(mkL1(), mkL2()));
    expect(v?.l1).not.toBeNull();
    expect(v?.l2).not.toBeNull();
    expect(v?.l3.decision).toBe('none');
  });

  it('L1-only (no overlay) → l2 is null, still a view', () => {
    const v = composeFact('p', deps(mkL1(), null));
    expect(v?.l1).not.toBeNull();
    expect(v?.l2).toBeNull();
  });

  it('L2-only (no capability fact) → l1 null, package + ecosystem come from L2', () => {
    const v = composeFact('p', deps(null, mkL2({ package: 'p', ecosystem: 'pypi' })));
    expect(v?.l1).toBeNull();
    expect(v?.package).toBe('p');
    expect(v?.ecosystem).toBe('pypi');
  });

  it('neither layer → null (genuine "no facts on file")', () => {
    expect(composeFact('p', deps(null, null))).toBeNull();
  });
});

describe('evaluatePolicy — L3 judges L1+L2 without mutating them', () => {
  const facts = { l1: mkL1({ capabilities: ['network'] }), l2: mkL2({ license_risk: 'copyleft-strong', maintenance: 'deprecated', known_vulns: [{ id: 'X', severity: 'high', affected: '1', summary: 's' }] }) };

  it('no policy / empty rules → none', () => {
    expect(evaluatePolicy(null, facts).decision).toBe('none');
    expect(evaluatePolicy({ org: 'a', rules: [] }, facts).decision).toBe('none');
  });

  it('matches on license_risk / maintenance / has_known_vulns / capability', () => {
    expect(evaluatePolicy({ org: 'a', rules: [{ id: 'lic', decision: 'deny', match: { license_risk: 'copyleft-strong' }, rationale: 'no AGPL' }] }, facts).decision).toBe('deny');
    expect(evaluatePolicy({ org: 'a', rules: [{ id: 'm', decision: 'flag', match: { maintenance: 'deprecated' }, rationale: 'stale' }] }, facts).decision).toBe('flag');
    expect(evaluatePolicy({ org: 'a', rules: [{ id: 'v', decision: 'flag', match: { has_known_vulns: true }, rationale: 'cve' }] }, facts).decision).toBe('flag');
    expect(evaluatePolicy({ org: 'a', rules: [{ id: 'c', decision: 'flag', match: { capability: 'network' }, rationale: 'net' }] }, facts).decision).toBe('flag');
  });

  it('first matching rule wins and reports its id + rationale', () => {
    const v = evaluatePolicy({ org: 'a', rules: [
      { id: 'first', decision: 'deny', match: { maintenance: 'deprecated' }, rationale: 'A' },
      { id: 'second', decision: 'flag', match: { maintenance: 'deprecated' }, rationale: 'B' },
    ] }, facts);
    expect(v.rule_id).toBe('first');
    expect(v.rationale).toBe('A');
  });

  it('a match on package alone works even with null facts (deny-by-name)', () => {
    expect(evaluatePolicy({ org: 'a', rules: [{ id: 'p', decision: 'deny', match: { package: 'left-pad' }, rationale: 'banned' }] }, { l1: mkL1({ package: 'left-pad' }), l2: null }).decision).toBe('deny');
  });

  it('a rule with an empty match object does NOT fire (footgun guard)', () => {
    expect(evaluatePolicy({ org: 'a', rules: [{ id: 'all', decision: 'deny', match: {}, rationale: 'oops' }] }, facts).decision).toBe('none');
  });
});

describe('end-to-end via buildComposeDeps — three independent inputs', () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

  it('private L1+L2 (STARLOG_PRIVATE_FACTS) and policy (STARLOG_POLICY) all flow into the composed view', () => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-e2e-'));
    const privPath = join(dir, 'priv.json');
    const polPath = join(dir, 'pol.json');
    writeFileSync(privPath, JSON.stringify({
      l1: [mkL1({ package: '@acme/internal', effect_surface: 'internal auth service', capabilities: ['network'] })],
      l2: [mkL2({ package: '@acme/internal', maintenance: 'deprecated', attestation: { source: 'hand', refs: ['acme'], fetched_at: '2026-06-01' } })],
    }));
    writeFileSync(polPath, JSON.stringify({ org: 'acme', rules: [{ id: 'dep', decision: 'flag', match: { maintenance: 'deprecated' }, rationale: 'use the v2 service' }] }));

    const deps = buildComposeDeps({ STARLOG_PRIVATE_FACTS: privPath, STARLOG_POLICY: polPath } as NodeJS.ProcessEnv);
    const view = lookupFactView('@acme/internal', deps);
    expect(view?.l1?.effect_surface).toBe('internal auth service'); // private L1
    expect(view?.l2?.maintenance).toBe('deprecated'); // private L2
    expect(view?.l3.decision).toBe('flag'); // L3 policy fired on the private L2 fact
    expect(view?.l3.rule_id).toBe('dep');
  });

  it('private L2 overlay overrides public L2 (private wins), public L1 untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-e2e-'));
    const privPath = join(dir, 'priv.json');
    writeFileSync(privPath, JSON.stringify({ l2: [mkL2({ package: 'left-pad', license: 'ORG-OVERRIDE', attestation: { source: 'hand', refs: ['acme ruling'], fetched_at: '2026-06-02' } })] }));
    const view = lookupFactView('left-pad', buildComposeDeps({ STARLOG_PRIVATE_FACTS: privPath } as NodeJS.ProcessEnv));
    expect(view?.l2?.license).toBe('ORG-OVERRIDE'); // private wins
    expect(view?.l1?.effect_surface).toContain('Pads a string'); // public L1 intact
  });
});
