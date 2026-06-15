import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * End-to-end test for `starlog org sync` — spawns the REAL built binary
 * (dist/cli.js), so it exercises commander parsing, the discover→derive→suggest
 * orchestration, the atomic file writes, and the exit code together. It then
 * runs `starlog facts <pkg>` against the written artifacts to prove the bulk-
 * ingested facts actually reach the agent-facing serve path.
 *
 * dist/ is assumed pre-built.
 */
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = 'dist/cli.js';

interface RunResult { status: number; stdout: string; stderr: string; }

function run(args: string[], env?: Record<string, string>): RunResult {
  const childEnv: Record<string, string | undefined> = { ...process.env, STARLOG_NO_NUDGE: '1' };
  delete childEnv.STARLOG_PRIVATE_FACTS;
  delete childEnv.STARLOG_API_KEY;
  delete childEnv.STARLOG_POLICY;
  Object.assign(childEnv, env);
  try {
    const stdout = execFileSync('node', [CLI, ...args, '--no-telemetry'], { cwd: REPO, env: childEnv, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

function makeOrg(): string {
  const root = mkdtempSync(join(tmpdir(), 'org-e2e-'));
  const repo = (name: string, pkg: Record<string, unknown>) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  };
  repo('clean', { name: '@acme/clean', license: 'MIT', description: 'rotates short-lived database credentials', keywords: ['secrets', 'database'] });
  repo('legacy', { name: '@acme/legacy', license: 'GPL-3.0-only' }); // no description
  repo('scripts', { private: true }); // no name → skipped
  return root;
}

describe('starlog org sync (e2e)', () => {
  it('bulk-derives facts from a directory of checkouts and writes loadable artifacts', () => {
    const orgDir = makeOrg();
    const factsOut = join(orgDir, 'out-facts.json');
    const policyOut = join(orgDir, 'out-policy.json');
    try {
      const r = run(['org', 'sync', orgDir, '--facts-out', factsOut, '--policy-out', policyOut, '--no-git']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/derived 2 package fact\(s\), skipped 1/);

      const facts = JSON.parse(readFileSync(factsOut, 'utf8'));
      expect(facts.l2.map((o: { package: string }) => o.package).sort()).toEqual(['@acme/clean', '@acme/legacy']);
      expect(facts.l2.every((o: { attestation: { source: string } }) => o.attestation.source === 'analyzer')).toBe(true);

      const policy = JSON.parse(readFileSync(policyOut, 'utf8'));
      expect(policy.rules.map((rl: { match: { package: string } }) => rl.match.package)).toEqual(['@acme/legacy']);
    } finally {
      rmSync(orgDir, { recursive: true, force: true });
    }
  });

  it('makes a described package DISCOVERABLE — `search` surfaces it by capability', () => {
    const orgDir = makeOrg();
    const factsOut = join(orgDir, 'out-facts.json');
    const corpusOut = join(orgDir, 'out-corpus.json');
    const policyOut = join(orgDir, 'out-suggested.json');
    try {
      const sync = run(['org', 'sync', orgDir, '--facts-out', factsOut, '--corpus-out', corpusOut, '--policy-out', policyOut, '--no-git']);
      expect(sync.status).toBe(0);
      expect(sync.stdout).toMatch(/Made 1 package\(s\) DISCOVERABLE/);
      expect(sync.stdout).toMatch(/not discoverable: @acme\/legacy/i); // no description

      const corpus = JSON.parse(readFileSync(corpusOut, 'utf8'));
      expect(corpus.manifests.map((m: { id: string }) => m.id)).toEqual(['@acme/clean']);

      // The agent can now find it by capability, without knowing its name.
      const search = run(['search', 'rotate database credentials'], { STARLOG_PRIVATE_CORPUS: corpusOut });
      expect(search.status).toBe(0);
      expect(search.stdout).toMatch(/@acme\/clean/);
    } finally {
      rmSync(orgDir, { recursive: true, force: true });
    }
  });

  it('surfaces derived facts to the agent, but suggested policy is a PROPOSAL — not applied until adopted', () => {
    const orgDir = makeOrg();
    const factsOut = join(orgDir, 'out-facts.json');
    const policyOut = join(orgDir, 'out-suggested.json');
    try {
      run(['org', 'sync', orgDir, '--facts-out', factsOut, '--policy-out', policyOut, '--no-git']);
      expect(existsSync(factsOut)).toBe(true);

      // Facts reach the agent immediately; the suggested verdict does NOT (no STARLOG_POLICY).
      const unadopted = run(['facts', '@acme/legacy'], { STARLOG_PRIVATE_FACTS: factsOut });
      expect(unadopted.status).toBe(0);
      expect(unadopted.stdout).toMatch(/risk:\s*copyleft-strong/);
      expect(unadopted.stdout).not.toMatch(/Org policy:/);

      // Only when the org adopts the proposal (points STARLOG_POLICY at it) does it fire.
      const adopted = run(['facts', '@acme/legacy'], { STARLOG_PRIVATE_FACTS: factsOut, STARLOG_POLICY: policyOut });
      expect(adopted.stdout).toMatch(/Org policy:\*\*\s*FLAG/);
    } finally {
      rmSync(orgDir, { recursive: true, force: true });
    }
  });

  it('errors with a non-zero exit when no checkouts are found', () => {
    const empty = mkdtempSync(join(tmpdir(), 'org-e2e-empty-'));
    try {
      const r = run(['org', 'sync', empty, '--no-git']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/no checkouts found/i);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('writes an empty proposal (no flags) when every package is clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'org-e2e-clean-'));
    const d = join(root, 'clean');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@acme/clean', license: 'MIT' }));
    const policyOut = join(root, 'suggested.json');
    try {
      const r = run(['org', 'sync', root, '--facts-out', join(root, 'f.json'), '--corpus-out', join(root, 'c.json'), '--policy-out', policyOut, '--no-git']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/No policy flags suggested/);
      expect(JSON.parse(readFileSync(policyOut, 'utf8')).rules).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
