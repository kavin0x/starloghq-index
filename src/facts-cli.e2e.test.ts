import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * End-to-end tests for the `starlog facts` CLI command.
 *
 * These spawn the REAL built binary (dist/cli.js) via execFileSync — exercising
 * the whole shipped path: commander argument parsing, loadFactMap() reading the
 * STARLOG_PRIVATE_FACTS env var off the actual process environment, lookupFacts,
 * formatFacts/JSON serialization, and the process exit code. This is the layer
 * the unit tests (facts.test.ts, mcp-facts.test.ts) cannot reach: they never run
 * cli.ts, never read argv, and never observe a real exit status.
 *
 * dist/ is assumed pre-built (the assignment guarantees it).
 */

const REPO = '/Users/scandal/ai/starlog-index';
const CLI = 'dist/cli.js';

/** Result of running the CLI: captured stdout, stderr, and exit status. */
interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node dist/cli.js <args>` from the repo root. Returns a normalized
 * RunResult for BOTH zero and non-zero exits — execFileSync throws on non-zero,
 * and we recover status/stdout/stderr from the thrown error so a failing exit is
 * a first-class, assertable outcome rather than an unhandled throw.
 *
 * --no-telemetry keeps the run hermetic (no network, no telemetry config writes)
 * and guarantees telemetry never injects lines into the stdout we assert on.
 */
function runFacts(args: string[], env?: Record<string, string>): RunResult {
  // Hermetic env: start from the real environment but DROP STARLOG_PRIVATE_FACTS
  // so a value inherited from the dev/CI shell can never leak an overlay into the
  // public-corpus baseline runs. Explicit per-test overrides are applied last.
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.STARLOG_PRIVATE_FACTS;
  Object.assign(childEnv, env ?? {});
  try {
    const stdout = execFileSync(
      'node',
      [CLI, '--no-telemetry', 'facts', ...args],
      {
        cwd: REPO,
        encoding: 'utf8',
        env: childEnv,
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      // A thrown error with no numeric status (e.g. signal kill) → treat as -1
      // so the caller's `not.toBe(0)` assertion still holds.
      status: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

describe('starlog facts CLI (e2e, spawned binary)', () => {
  let tmpDir: string | null = null;

  function writePrivate(json: unknown): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-cli-e2e-'));
    const p = join(tmpDir, 'private-facts.json');
    writeFileSync(p, JSON.stringify(json), 'utf8');
    return p;
  }

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('on a hit (ua-parser-js) prints the incident id and an "as of <date>" line, exits 0', () => {
    const { status, stdout } = runFacts(['ua-parser-js']);
    expect(status).toBe(0);
    // The verified incident id for the 2021 maintainer-account compromise.
    expect(stdout).toContain('INCIDENT:ua-parser-js-2021');
    // Recency is surfaced as a dated "as of <YYYY-MM-DD>" line.
    expect(stdout).toMatch(/as of \d{4}-\d{2}-\d{2}/);
    // Exact date this record carries in the public corpus.
    expect(stdout).toContain('as of 2026-06-01');
    // The package heading renders with its ecosystem.
    expect(stdout).toContain('## ua-parser-js (npm)');
  });

  it('on a miss prints "No facts on file" and exits 0 (a miss is NOT an error)', () => {
    const { status, stdout, stderr } = runFacts(['no-such-pkg-xyz']);
    expect(status).toBe(0);
    expect(stdout).toContain('No facts on file');
    expect(stdout).toContain('no-such-pkg-xyz');
    // A miss must not leak an error to stderr — it is an honest, clean answer.
    expect(stderr).toBe('');
  });

  it('--format json on a hit emits valid JSON parsing to an object with package==="chalk"', () => {
    const { status, stdout } = runFacts(['chalk', '--format', 'json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
    expect(parsed.package).toBe('chalk');
    // chalk is the clean baseline control — no vulns, active, permissive.
    expect(parsed.known_vulns).toEqual([]);
    expect(parsed.maintenance).toBe('active');
    expect(parsed.last_verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('--format json on a miss emits the literal JSON null and exits 0', () => {
    const { status, stdout } = runFacts(['no-such-pkg-xyz', '--format', 'json']);
    expect(status).toBe(0);
    // The literal token "null", and it parses to JS null.
    expect(stdout.trim()).toBe('null');
    expect(JSON.parse(stdout)).toBeNull();
  });

  it('an invalid --format value exits non-zero with a clear error on stderr', () => {
    const { status, stdout, stderr } = runFacts(['chalk', '--format', 'xml']);
    expect(status).not.toBe(0);
    expect(status).toBe(1);
    expect(stderr).toContain('Invalid format');
    expect(stderr).toContain('xml');
    // The fact record must NOT be emitted when the format is rejected.
    expect(stdout).not.toContain('chalk (npm)');
  });

  describe('org-private overlay (STARLOG_PRIVATE_FACTS) end-to-end', () => {
    // One brand-new package (no public entry) and one override of an existing
    // public package (chalk). Both are valid + verified, both carry last_verified.
    const NEW_PKG = '@acme/internal-widget';
    const OVERRIDE_MARKER = 'ORG OVERRIDE: internal banned chalk fork';

    function overlayFile(): string {
      return writePrivate([
        {
          package: NEW_PKG,
          ecosystem: 'npm',
          effect_surface: 'Internal widget; runs in-process.',
          known_vulns: [
            {
              id: 'INCIDENT:acme-widget-internal',
              severity: 'high',
              affected: '< 2.0.0',
              summary: 'Internal ruling: banned below 2.0.0.',
            },
          ],
          license: 'UNLICENSED',
          license_risk: 'unknown',
          maintenance: 'deprecated',
          transitive_risk: null,
          source: 'ACME internal registry',
          verified: true,
          last_verified: '2026-05-15',
        },
        {
          package: 'chalk',
          ecosystem: 'npm',
          effect_surface: OVERRIDE_MARKER,
          known_vulns: [],
          license: 'MIT',
          license_risk: 'none',
          maintenance: 'abandoned',
          transitive_risk: null,
          source: 'ACME security ruling',
          verified: true,
          last_verified: '2026-05-16',
        },
      ]);
    }

    it('resolves a NEW private-only package through the spawned CLI', () => {
      const path = overlayFile();
      const { status, stdout } = runFacts([NEW_PKG], { STARLOG_PRIVATE_FACTS: path });
      expect(status).toBe(0);
      expect(stdout).toContain(`## ${NEW_PKG} (npm)`);
      expect(stdout).toContain('INCIDENT:acme-widget-internal');
      expect(stdout).toContain('ACME internal registry');
      expect(stdout).toContain('as of 2026-05-15');
    });

    it("the override's text replaces the public record for an existing package", () => {
      const path = overlayFile();
      const { status, stdout } = runFacts(['chalk'], { STARLOG_PRIVATE_FACTS: path });
      expect(status).toBe(0);
      // The private override wins on key collision: its effect_surface and
      // maintenance status appear, NOT the public corpus values.
      expect(stdout).toContain(OVERRIDE_MARKER);
      expect(stdout).toContain('**Maintenance:** abandoned');
      expect(stdout).toContain('as of 2026-05-16');
      // The public effect surface for chalk must be gone.
      expect(stdout).not.toContain('Terminal string styling');
    });

    it('a missing/unreadable overlay file falls back to public facts (no crash, exit 0)', () => {
      const missing = join(tmpdir(), `starlog-cli-no-such-${Date.now()}`, 'nope.json');
      const { status, stdout } = runFacts(['chalk'], { STARLOG_PRIVATE_FACTS: missing });
      // Soft failure: the public chalk record still serves, exit stays clean.
      expect(status).toBe(0);
      expect(stdout).toContain('## chalk (npm)');
      expect(stdout).toContain('Terminal string styling');
    });
  });
});
