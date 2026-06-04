import { describe, it, expect } from 'vitest';
import { search } from './search.js';
import { keywordSiftrank } from './siftrank.js';
import { buildManifestFromInput } from './facts/authoring.js';
import type { CapabilityManifest } from '../manifest/schema.js';
import type { SiftrankFn, LlmFn } from './types.js';

// --- Mock data ---

function makeManifest(overrides: Partial<CapabilityManifest>): CapabilityManifest {
  return {
    id: 'mock',
    name: 'Mock',
    repo: 'mock/mock',
    ecosystem: 'npm',
    category: 'authentication',
    solves: 'mock',
    stack_affinity: ['node'],
    integration_effort: 'easy',
    best_for: ['x'],
    skip_when: ['y'],
    hosted_alternative: null,
    alternative_ids: [],
    health: { stars: 0, weekly_downloads: 0, last_commit: '2026-01-01', contributors: 1, license: 'MIT', open_issues: 0 },
    quality: { has_tests: true, has_docs: true, has_types: true, maintenance_status: 'active' },
    ...overrides,
  };
}

const pubA = makeManifest({ id: 'pub-a', name: 'Public A' });
const pubB = makeManifest({ id: 'pub-b', name: 'Public B' });
const privP = makeManifest({ id: 'priv-p', name: 'Private P (org-sanctioned)' });
const privOffTopic = makeManifest({ id: 'priv-off', name: 'Private Off-topic' });

const allManifests = [pubA, pubB, privP, privOffTopic];

/** Siftrank that assigns explicit scores by id; preserves filtered order. */
function scoredSiftrank(scoreMap: Record<string, number>): SiftrankFn {
  return async (manifests, _query) =>
    manifests.map((m, i) => ({
      key: m.id,
      value: m.name,
      object: { id: m.id },
      score: scoreMap[m.id] ?? 0,
      exposure: i + 1,
      rank: i + 1,
    }));
}

const noLlm: LlmFn = async () => '{}';

// Pin diversityLambda >= 1.0 so `ranked` is pure score-desc (MMR off) — we are
// testing the private-first PARTITION in isolation, not MMR reordering.
const PURE = { diversityLambda: 1.0 } as const;

describe('search() — private-first partition (FACTS-03)', () => {
  it('Test 1: a RELEVANT (score>=70) lower-scored private id is floated ahead of higher public picks before the slice', async () => {
    // pub-a=100, pub-b=90, priv-p=80 (relevant, >=70). topK=2.
    // Without partition: slice(0,2) => [pub-a, pub-b], priv-p excluded.
    // With partition: priv-p floats first => priv-p in topResults.
    const results = await search(
      'auth',
      allManifests.filter((m) => m.id !== 'priv-off'),
      { topK: 2, privateIds: new Set(['priv-p']), ...PURE },
      { siftrank: scoredSiftrank({ 'pub-a': 100, 'pub-b': 90, 'priv-p': 80 }), llm: noLlm },
    );
    const ids = results.map((r) => r.manifest.id);
    expect(ids).toContain('priv-p');
    expect(ids[0]).toBe('priv-p'); // floated to #1
    expect(ids).toHaveLength(2);
  });

  it('Test 2: with privateIds undefined, topResults are pure score-desc (no regression)', async () => {
    const results = await search(
      'auth',
      [pubA, pubB, privP],
      { topK: 3, ...PURE },
      { siftrank: scoredSiftrank({ 'pub-a': 100, 'pub-b': 90, 'priv-p': 80 }), llm: noLlm },
    );
    expect(results.map((r) => r.manifest.id)).toEqual(['pub-a', 'pub-b', 'priv-p']);
  });

  it('Test 3: partition is stable — relative order within floated group and within the rest is preserved; scores unmutated', async () => {
    // two private floated (priv-p=85, priv-p2=75), two public (pub-a=100, pub-b=90)
    const privP2 = makeManifest({ id: 'priv-p2', name: 'Private P2' });
    const results = await search(
      'auth',
      [pubA, privP, pubB, privP2],
      { topK: 4, privateIds: new Set(['priv-p', 'priv-p2']), ...PURE },
      { siftrank: scoredSiftrank({ 'pub-a': 100, 'priv-p': 85, 'pub-b': 90, 'priv-p2': 75 }), llm: noLlm },
    );
    const ids = results.map((r) => r.manifest.id);
    // floated group (score-desc): priv-p(85), priv-p2(75); then rest (score-desc): pub-a(100), pub-b(90)
    expect(ids).toEqual(['priv-p', 'priv-p2', 'pub-a', 'pub-b']);
    // scores unmutated
    const byId = Object.fromEntries(results.map((r) => [r.manifest.id, r.relevance_score]));
    expect(byId['priv-p']).toBe(85);
    expect(byId['pub-a']).toBe(100);
  });

  it('Test 4 (relevance guard): an off-topic private id scoring BELOW 70 is NOT floated', async () => {
    // priv-off scores 0 (off-topic, e.g. org auth pkg on a caching query); must stay in plain score order.
    const results = await search(
      'caching',
      [pubA, pubB, privOffTopic],
      { topK: 3, privateIds: new Set(['priv-off']), ...PURE },
      { siftrank: scoredSiftrank({ 'pub-a': 100, 'pub-b': 90, 'priv-off': 0 }), llm: noLlm },
    );
    const ids = results.map((r) => r.manifest.id);
    expect(ids[0]).not.toBe('priv-off'); // not hijacking #1
    expect(ids).toEqual(['pub-a', 'pub-b', 'priv-off']); // plain score-desc
  });
});

describe('corpus add → search: a minimal authored private entry is DISCOVERABLE (real keyword scorer)', () => {
  // End-to-end of the discovery authoring path with the SHIPPED scorer (not mocked):
  // a manifest built exactly as `corpus add` emits it (defaulted health/quality)
  // must clear the relevance bar AND float private-first for a matching capability.
  // This is the unit lock-in of the empirical "@acme/flags surfaced #1 at 76.86" result.
  const authored = buildManifestFromInput({
    package: '@acme/flags',
    solves: 'Feature flags and remote configuration for Acme Node services — gradual rollout, kill switches, audit log.',
    category: 'feature-flags',
    stack: ['node'],
    bestFor: ['feature flags', 'remote config', 'gradual rollout', 'kill switches'],
  });
  const publicFlagLib: CapabilityManifest = makeManifest({
    id: 'some-public-flags',
    name: 'Some Public Flags',
    category: 'feature-flags',
    solves: 'Feature flags and remote config for JavaScript apps.',
    best_for: ['feature flags', 'remote config'],
  });

  it('surfaces the authored internal package and floats it ahead of the public option', async () => {
    const results = await search(
      'feature flags for a node app',
      [publicFlagLib, authored],
      { topK: 5, privateIds: new Set(['@acme/flags']), ...PURE },
      { siftrank: keywordSiftrank, llm: noLlm },
    );
    const ids = results.map((r) => r.manifest.id);
    expect(ids).toContain('@acme/flags'); // discoverable (cleared the relevance bar)
    expect(ids[0]).toBe('@acme/flags'); // floated private-first over the public lib
  });

  it('an authored entry that is OFF-TOPIC for the query does not hijack #1 (relevance guard holds)', async () => {
    const results = await search(
      'image resizing library',
      [publicFlagLib, authored],
      { topK: 5, privateIds: new Set(['@acme/flags']), ...PURE },
      { siftrank: keywordSiftrank, llm: noLlm },
    );
    expect(results[0]?.manifest.id).not.toBe('@acme/flags'); // below the 70 guard on an unrelated query
  });
});
