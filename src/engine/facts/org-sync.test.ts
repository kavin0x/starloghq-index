import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCheckouts, syncCheckouts, gitLastCommitDaysAgo } from './org-sync.js';
import type { L2Overlay } from '@starloghq/facts-schema';

function repo(root: string, name: string, pkg: Record<string, unknown>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

describe('discoverCheckouts', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orgsync-disc-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns immediate subdirs that contain a package.json, sorted', () => {
    repo(root, 'b-pkg', { name: 'b' });
    repo(root, 'a-pkg', { name: 'a' });
    mkdirSync(join(root, 'not-a-pkg'), { recursive: true }); // no package.json
    const found = discoverCheckouts(root);
    expect(found.map((d) => d.replace(root + '/', ''))).toEqual(['a-pkg', 'b-pkg']);
  });

  it('treats the root itself as a single checkout when it has a package.json', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'solo' }));
    expect(discoverCheckouts(root)).toEqual([root]);
  });
});

describe('syncCheckouts', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orgsync-sync-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('derives overlays, skips no-name repos, and suggests policy from real signals', () => {
    const clean = repo(root, 'clean', { name: '@acme/clean', license: 'MIT' });
    const legacy = repo(root, 'legacy', { name: '@acme/legacy', license: 'GPL-3.0-only' });
    const noname = repo(root, 'scripts', { private: true });

    const res = syncCheckouts(
      [
        { dir: clean, lastCommitDaysAgo: 5 },
        { dir: legacy, archived: true },
        { dir: noname },
      ],
      { fetchedAt: '2026-06-10' },
    );

    expect(res.privateFacts.l2.map((o) => o.package).sort()).toEqual(['@acme/clean', '@acme/legacy']);
    expect(res.privateFacts.l2.every((o) => o.attestation.source === 'analyzer')).toBe(true);
    expect(res.skipped).toEqual([noname]);

    // Only @acme/legacy (archived → deprecated, GPL → copyleft-strong) earns a rule.
    expect(res.policy?.rules.map((r) => r.match.package)).toEqual(['@acme/legacy']);
    expect(res.policy?.rules[0].decision).toBe('flag');
  });

  it('emits a null policy when nothing is flagged', () => {
    const clean = repo(root, 'clean', { name: '@acme/clean', license: 'MIT' });
    const res = syncCheckouts([{ dir: clean, lastCommitDaysAgo: 1 }], { fetchedAt: '2026-06-10' });
    expect(res.policy).toBeNull();
  });

  it('merges over seeds: a hand-authored fact is preserved, a re-derived one is replaced', () => {
    const clean = repo(root, 'clean', { name: '@acme/clean', license: 'MIT' });
    const seedKept: L2Overlay = {
      package: '@acme/manual', ecosystem: 'npm', known_vulns: [], license: 'MIT', license_risk: 'none',
      maintenance: 'active', transitive_risk: null, attestation: { source: 'hand', refs: [], fetched_at: '2026-01-01' },
    };
    const seedReplaced: L2Overlay = { ...seedKept, package: '@acme/clean', maintenance: 'abandoned', attestation: { source: 'hand', refs: [], fetched_at: '2026-01-01' } };

    const res = syncCheckouts([{ dir: clean, lastCommitDaysAgo: 1 }], {
      fetchedAt: '2026-06-10',
      seedFacts: { l1: [], l2: [seedKept, seedReplaced] },
    });

    const byPkg = Object.fromEntries(res.privateFacts.l2.map((o) => [o.package, o]));
    expect(byPkg['@acme/manual']).toBeDefined(); // untouched seed preserved
    expect(byPkg['@acme/manual'].attestation.source).toBe('hand');
    expect(byPkg['@acme/clean'].attestation.source).toBe('analyzer'); // re-derived wins
    expect(byPkg['@acme/clean'].maintenance).toBe('active');
  });
});

describe('gitLastCommitDaysAgo', () => {
  it('returns a non-negative number for a real git repo (this repo), null for a non-repo', () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..');
    const days = gitLastCommitDaysAgo(repoRoot, Date.now());
    expect(typeof days === 'number' && days >= 0).toBe(true);

    const tmp = mkdtempSync(join(tmpdir(), 'orgsync-nogit-'));
    expect(gitLastCommitDaysAgo(tmp, Date.now())).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
});
