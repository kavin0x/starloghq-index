import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { L2Overlay, L3Policy } from '@starloghq/facts-schema';
import type { CapabilityManifest } from '../../manifest/schema.js';
import { derivePackageFromCheckout, suggestL3Rules } from './ingest.js';
import { upsertL2Entry, upsertPolicy, buildL3Rule, buildManifestFromInput, upsertManifestEntry } from './authoring.js';

/**
 * Phase-1 LOCAL org sync — the runnable spine. Walk a directory of checkouts,
 * derive an L2 overlay per published package (source never leaves the machine),
 * suggest org policy from the real signals, and assemble the on-disk artifacts
 * the loaders already read. No network, no auth: GitHub enumeration bolts onto
 * the FRONT of this later. Orchestration over the pure ingest primitives.
 */

export interface Checkout {
  dir: string;
  archived?: boolean;
  lastCommitDaysAgo?: number | null;
}

export interface SyncResult {
  privateFacts: { l1: unknown[]; l2: L2Overlay[] };
  policy: L3Policy | null;
  /** Discovery corpus — makes packages findable by `search`, not just vettable by name. */
  corpus: { manifests: CapabilityManifest[] };
  derived: { package: string; flagged: boolean }[];
  /** Packages derived as facts but NOT made discoverable (no usable description). */
  noDescription: string[];
  skipped: string[];
}

export interface SyncOptions {
  fetchedAt: string;
  /** Existing on-disk artifacts to merge over (re-derived facts win; others preserved). */
  seedFacts?: { l1?: unknown[]; l2?: unknown[] } | null;
  seedPolicy?: { org?: string; rules?: unknown[] } | null;
  seedCorpus?: { manifests?: unknown[] } | null;
}

/** Manifest ecosystem is npm|pypi|both; map the package's ecosystem (never 'system' for a derived pkg). */
function manifestEcosystem(eco: string): string {
  return eco === 'pypi' ? 'pypi' : 'npm';
}

/** A directory is a checkout if it has a manifest we can derive from (npm or python). */
function hasManifest(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'pyproject.toml'));
}

/**
 * List the checkouts under rootDir: immediate subdirectories with a manifest we
 * understand (package.json or pyproject.toml), sorted for determinism. If rootDir
 * itself is a package, it is the single checkout.
 */
export function discoverCheckouts(rootDir: string): string[] {
  if (hasManifest(rootDir)) return [rootDir];
  const entries = readdirSync(rootDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && hasManifest(join(rootDir, e.name)))
    .map((e) => join(rootDir, e.name))
    .sort();
}

/**
 * Derive facts for each checkout and fold them into the emitted artifacts. A
 * checkout with no published identity is recorded in `skipped`, never written.
 * Suggested L3 rules are compiled into the policy (flag-only); a package with no
 * suggestions earns no rule. Returns a null policy when nothing is flagged.
 */
export function syncCheckouts(checkouts: Checkout[], opts: SyncOptions): SyncResult {
  let privateFacts: { l1: unknown[]; l2: L2Overlay[] } = {
    l1: Array.isArray(opts.seedFacts?.l1) ? [...(opts.seedFacts!.l1 as unknown[])] : [],
    l2: [],
  };
  // Seed L2 first so re-derived overlays (same package) replace them via upsert.
  for (const seed of Array.isArray(opts.seedFacts?.l2) ? (opts.seedFacts!.l2 as L2Overlay[]) : []) {
    privateFacts = upsertL2Entry(privateFacts, seed);
  }

  // Start from the seed policy (if any) and upsert suggested rules into it.
  let policyShape: { org?: string; rules?: unknown[] } | null = opts.seedPolicy ?? null;

  // Discovery corpus, seeded from any existing file (re-derived entries replace by id).
  let corpus: { manifests: CapabilityManifest[] } = { manifests: [] };
  for (const seed of Array.isArray(opts.seedCorpus?.manifests) ? (opts.seedCorpus!.manifests as CapabilityManifest[]) : []) {
    corpus = upsertManifestEntry(corpus, seed);
  }

  const derived: { package: string; flagged: boolean }[] = [];
  const noDescription: string[] = [];
  const skipped: string[] = [];

  for (const co of checkouts) {
    const pkg = derivePackageFromCheckout(co.dir, {
      fetchedAt: opts.fetchedAt,
      archived: co.archived,
      lastCommitDaysAgo: co.lastCommitDaysAgo,
    });
    if (!pkg) {
      skipped.push(co.dir);
      continue;
    }
    const { overlay, solves, keywords } = pkg;
    privateFacts = upsertL2Entry(privateFacts, overlay);

    const suggestions = suggestL3Rules(overlay);
    if (suggestions.length > 0) {
      const rationale = suggestions.map((s) => s.rationale).join(' ');
      policyShape = upsertPolicy(policyShape, buildL3Rule(overlay.package, 'flag', rationale));
    }

    // Discovery: a usable description makes the package findable by `search`.
    if (solves) {
      corpus = upsertManifestEntry(
        corpus,
        buildManifestFromInput({
          package: overlay.package,
          solves,
          ecosystem: manifestEcosystem(overlay.ecosystem),
          stack: keywords,
          license: overlay.license,
          autoGenerated: true,
        }),
      );
    } else {
      noDescription.push(overlay.package);
    }

    derived.push({ package: overlay.package, flagged: suggestions.length > 0 });
  }

  const policy: L3Policy | null =
    policyShape && Array.isArray(policyShape.rules) && policyShape.rules.length > 0 ? (policyShape as L3Policy) : null;
  return { privateFacts, policy, corpus, derived, noDescription, skipped };
}

/**
 * Best-effort maintenance recency from git: whole days since the last commit in
 * `dir`, or null if it is not a git repo (or git is unavailable). I/O — kept out
 * of the pure orchestration so syncCheckouts stays unit-testable with injected
 * recency.
 */
export function gitLastCommitDaysAgo(dir: string, nowMs: number): number | null {
  try {
    const out = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const sec = Number(out);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return Math.max(0, Math.floor((nowMs - sec * 1000) / 86_400_000));
  } catch {
    return null;
  }
}
