import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCorpus } from './corpus.js';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeValidManifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'clerk',
    name: 'Clerk',
    repo: 'clerkinc/clerk',
    ecosystem: 'npm',
    category: 'authentication',
    solves: 'Managed authentication with pre-built UI components.',
    stack_affinity: ['next.js', 'react'],
    integration_effort: 'easy',
    best_for: ['SaaS apps', 'rapid prototyping', 'multi-tenant apps'],
    skip_when: ['self-hosted required', 'air-gapped', 'custom token format'],
    hosted_alternative: null,
    alternative_ids: [],
    health: {
      stars: 8000,
      weekly_downloads: 200000,
      last_commit: '2026-01-15',
      contributors: 45,
      license: 'MIT',
      open_issues: 12,
    },
    quality: {
      has_tests: true,
      has_docs: true,
      has_types: true,
      maintenance_status: 'active',
    },
    ...overrides,
  });
}

async function writeManifest(dir: string, filename: string, content: string): Promise<void> {
  await writeFile(join(dir, filename), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'starlog-corpus-test-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadCorpus()
// ---------------------------------------------------------------------------

describe('loadCorpus()', () => {
  describe('basic loading', () => {
    it('returns empty array when corpus directory has no subdirectories', async () => {
      const results = await loadCorpus(tmpRoot);
      expect(results).toEqual([]);
    });

    it('loads a single valid manifest from a category subdirectory', async () => {
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);
      await writeManifest(authDir, 'clerk.json', makeValidManifestJson({ id: 'clerk' }));

      const results = await loadCorpus(tmpRoot);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('clerk');
    });

    it('loads multiple manifests from a single category', async () => {
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);
      await writeManifest(authDir, 'clerk.json', makeValidManifestJson({ id: 'clerk', name: 'Clerk' }));
      await writeManifest(
        authDir,
        'nextauth.json',
        makeValidManifestJson({ id: 'nextauth', name: 'NextAuth.js' }),
      );

      const results = await loadCorpus(tmpRoot);
      expect(results).toHaveLength(2);
      const ids = results.map((m) => m.id).sort();
      expect(ids).toEqual(['clerk', 'nextauth']);
    });

    it('loads manifests from multiple category subdirectories', async () => {
      const authDir = join(tmpRoot, 'authentication');
      const cacheDir = join(tmpRoot, 'caching');
      await mkdir(authDir);
      await mkdir(cacheDir);

      await writeManifest(authDir, 'clerk.json', makeValidManifestJson({ id: 'clerk', category: 'authentication' }));
      await writeManifest(
        cacheDir,
        'ioredis.json',
        makeValidManifestJson({ id: 'ioredis', name: 'ioredis', category: 'caching' }),
      );

      const results = await loadCorpus(tmpRoot);
      expect(results).toHaveLength(2);
      const categories = new Set(results.map((m) => m.category));
      expect(categories.has('authentication')).toBe(true);
      expect(categories.has('caching')).toBe(true);
    });

    it('ignores non-JSON files in category directories', async () => {
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);
      await writeManifest(authDir, 'clerk.json', makeValidManifestJson({ id: 'clerk' }));
      await writeFile(join(authDir, 'README.md'), '# Auth manifests', 'utf-8');
      await writeFile(join(authDir, 'notes.txt'), 'some notes', 'utf-8');

      const results = await loadCorpus(tmpRoot);
      expect(results).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('throws SyntaxError when a file contains invalid JSON (known behavior: no try/catch in corpus.ts)', async () => {
      // NOTE: corpus.ts does not wrap JSON.parse in a try/catch despite the comment saying
      // "Silently skip invalid manifests". This test documents the actual behavior.
      // The validator.ts (sync version) does handle this, but loadCorpus (async) does not.
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);
      await writeFile(join(authDir, 'broken.json'), 'not valid json {{', 'utf-8');
      await writeManifest(authDir, 'clerk.json', makeValidManifestJson({ id: 'clerk' }));

      await expect(loadCorpus(tmpRoot)).rejects.toThrow(SyntaxError);
    });

    it('silently skips files that fail schema validation', async () => {
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);

      // Write a JSON file that parses but fails schema (missing required fields)
      await writeFile(
        join(authDir, 'invalid.json'),
        JSON.stringify({ id: 'bad', name: 'Bad', category: 'not-a-category' }),
        'utf-8',
      );
      await writeManifest(authDir, 'clerk.json', makeValidManifestJson({ id: 'clerk' }));

      const results = await loadCorpus(tmpRoot);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('clerk');
    });

    it('returns empty array when category directory is empty', async () => {
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);

      const results = await loadCorpus(tmpRoot);
      expect(results).toEqual([]);
    });

    it('handles manifest with null repo field', async () => {
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);
      await writeManifest(authDir, 'custom.json', makeValidManifestJson({ id: 'custom', repo: null }));

      const results = await loadCorpus(tmpRoot);
      expect(results).toHaveLength(1);
      expect(results[0].repo).toBeNull();
    });

    it('handles manifest with hosted_alternative object', async () => {
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);
      await writeManifest(
        authDir,
        'clerk.json',
        makeValidManifestJson({
          id: 'clerk',
          hosted_alternative: {
            name: 'Clerk',
            manifest_id: 'clerk',
            pricing_summary: 'Free up to 10k MAU',
          },
        }),
      );

      const results = await loadCorpus(tmpRoot);
      expect(results).toHaveLength(1);
      expect(results[0].hosted_alternative).not.toBeNull();
      expect(results[0].hosted_alternative?.name).toBe('Clerk');
    });
  });

  describe('category filtering', () => {
    beforeEach(async () => {
      const authDir = join(tmpRoot, 'authentication');
      const cacheDir = join(tmpRoot, 'caching');
      const flagsDir = join(tmpRoot, 'feature-flags');
      await mkdir(authDir);
      await mkdir(cacheDir);
      await mkdir(flagsDir);

      await writeManifest(authDir, 'clerk.json', makeValidManifestJson({ id: 'clerk', category: 'authentication' }));
      await writeManifest(authDir, 'nextauth.json', makeValidManifestJson({ id: 'nextauth', name: 'NextAuth.js', category: 'authentication' }));
      await writeManifest(cacheDir, 'ioredis.json', makeValidManifestJson({ id: 'ioredis', name: 'ioredis', category: 'caching' }));
      await writeManifest(flagsDir, 'posthog.json', makeValidManifestJson({ id: 'posthog', name: 'PostHog', category: 'feature-flags' }));
    });

    it('returns only authentication manifests when category=authentication', async () => {
      const results = await loadCorpus(tmpRoot, 'authentication');
      expect(results.length).toBe(2);
      for (const m of results) {
        expect(m.category).toBe('authentication');
      }
    });

    it('returns only caching manifests when category=caching', async () => {
      const results = await loadCorpus(tmpRoot, 'caching');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('ioredis');
    });

    it('returns empty array when category has no manifests in corpus', async () => {
      // 'realtime' has no directory in our temp corpus
      const results = await loadCorpus(tmpRoot, 'realtime');
      expect(results).toEqual([]);
    });

    it('returns all manifests when no category filter provided', async () => {
      const results = await loadCorpus(tmpRoot);
      expect(results.length).toBe(4);
    });

    it('returns manifests with correct category field when filter applied', async () => {
      const results = await loadCorpus(tmpRoot, 'feature-flags');
      expect(results.length).toBe(1);
      expect(results[0].category).toBe('feature-flags');
    });
  });

  describe('returned data integrity', () => {
    it('validates all fields of a loaded manifest', async () => {
      const authDir = join(tmpRoot, 'authentication');
      await mkdir(authDir);
      await writeManifest(authDir, 'clerk.json', makeValidManifestJson());

      const results = await loadCorpus(tmpRoot);
      expect(results).toHaveLength(1);
      const m = results[0];
      expect(m.id).toBe('clerk');
      expect(m.name).toBe('Clerk');
      expect(m.category).toBe('authentication');
      expect(m.ecosystem).toBe('npm');
      expect(m.integration_effort).toBe('easy');
      expect(Array.isArray(m.stack_affinity)).toBe(true);
      expect(Array.isArray(m.best_for)).toBe(true);
      expect(Array.isArray(m.skip_when)).toBe(true);
      expect(typeof m.health.stars).toBe('number');
      expect(typeof m.quality.has_tests).toBe('boolean');
    });
  });
});
