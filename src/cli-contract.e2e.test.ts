import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * End-to-end CLI-contract tests for the spawned `starlog` binary (dist/cli.js).
 *
 * THEME: the operational contract a CI / privacy engineer audits before allowing
 * the tool in a pipeline —
 *   1. telemetry opt-out precedence + notice suppression + persisted toggle,
 *   2. opt-out env precedence over explicit opt-in + unknown-action exit codes,
 *   3. `facts push` fails fast (exit 1, clean stderr) when STARLOG_API_KEY is
 *      missing, before any file/network IO.
 *
 * HARNESS / HERMETICITY
 * ---------------------
 * Every test SPAWNS the real built binary via node:child_process (spawnSync, so
 * BOTH stdout and stderr are captured regardless of exit code — telemetry status
 * markers land on stdout @ exit 0, while unknown-action / unknown-command / push
 * errors land on stderr @ exit 1).
 *
 * These tests are SPECIFICALLY about telemetry, so — unlike the facts-cli e2e
 * helper — they must NOT force telemetry off with `--no-telemetry` or
 * STARLOG_TELEMETRY=0. Instead the runner scrubs the ambient env so the test's
 * own per-test signals are authoritative:
 *   - DELETE CI, DO_NOT_TRACK, STARLOG_TELEMETRY, VITEST, NODE_ENV (telemetry.ts
 *     treats all of these as opt-out gates; the vitest runner exports VITEST=true
 *     into the child, which would mask the real "no env → enabled" baseline),
 *   - DELETE STARLOG_API_KEY / STARLOG_PRIVATE_FACTS / STARLOG_POLICY (no network,
 *     no inherited overlay),
 *   - override HOME to a per-test temp dir so ~/.starlog/telemetry.json is isolated.
 * Per-test env is applied LAST so an explicit CI=1 / DO_NOT_TRACK=1 wins.
 *
 * NO NETWORK: telemetry is the only thing that could open a socket, and every
 * code path here either runs `telemetry status/enable/disable` (pure local config
 * IO) or sets an opt-out signal (CI / DO_NOT_TRACK / STARLOG_TELEMETRY=0) before
 * any command that would otherwise attempt the ~1500ms PostHog fetch.
 *
 * dist/ is assumed pre-built (the assignment guarantees it).
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Track every temp dir/HOME so afterEach can purge them all (some tests create
// more than one — a single-variable pattern would leak the others).
let tempPaths: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(d);
  return d;
}

afterEach(() => {
  for (const p of tempPaths) rmSync(p, { recursive: true, force: true });
  tempPaths = [];
});

/**
 * Spawn `node dist/cli.js <args>` with a SCRUBBED, hermetic env. Crucially does
 * NOT inject --no-telemetry and does NOT preset STARLOG_TELEMETRY: these tests
 * are about telemetry, so the test supplies the authoritative signal via `env`.
 *
 * `cwd` defaults to a throwaway temp dir so nothing ever writes under the repo
 * tree. `input: ''` closes stdin so a no-arg subcommand can't block.
 */
function run(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): RunResult {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  // Opt-out / mode signals — delete so the parent (vitest/CI) shell can't decide
  // telemetry state out from under the per-test env.
  delete childEnv.CI;
  delete childEnv.DO_NOT_TRACK;
  delete childEnv.STARLOG_TELEMETRY;
  // telemetry.ts also treats VITEST / NODE_ENV==='test' as an opt-out gate. The
  // vitest runner exports VITEST=true into our child, which would mask the real
  // "enabled" baseline — scrub both so a test run looks like a real install and
  // the per-test signal is authoritative.
  delete childEnv.VITEST;
  delete childEnv.NODE_ENV;
  // No network, no inherited overlay/policy/key.
  delete childEnv.STARLOG_API_KEY;
  delete childEnv.STARLOG_PRIVATE_FACTS;
  delete childEnv.STARLOG_POLICY;
  // Per-test env (e.g. HOME, CI=1, DO_NOT_TRACK=1) wins.
  Object.assign(childEnv, opts.env ?? {});
  const cwd = opts.cwd ?? mkTemp('starlog-cli-contract-cwd-');
  const r = spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv,
    input: '',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('telemetry opt-out precedence, suppression, and persistence (e2e)', () => {
  // Title 1: "Telemetry opt-out precedence + notice suppression + persisted
  // toggle in one CI matrix". Decomposed into focused it()s so each assertion is
  // crisp and no opt-out fact is asserted twice.

  it('reports "Telemetry: enabled" with no opt-out env, and shows an Anonymous ID line', () => {
    const home = mkTemp('starlog-tel-home-');
    const { status, stdout } = run(['telemetry', 'status'], { env: { HOME: home } });
    expect(status).toBe(0);
    expect(stdout).toContain('Telemetry: enabled');
    // Label only — the UUID itself is volatile (regenerated per fresh HOME).
    expect(stdout).toContain('Anonymous ID:');
    // The opt-out hint must be printed to stdout (never a network call).
    expect(stdout).toContain('STARLOG_TELEMETRY=0');
    expect(stdout).toContain('DO_NOT_TRACK');
  });

  it('each CI opt-out signal flips status to "Telemetry: disabled" (env overrides persisted enabled)', () => {
    // Each runs against a FRESH temp HOME (no telemetry.json → persisted default
    // is enabled), so a "disabled" result is purely the env signal at work.
    const signals: Record<string, string>[] = [{ CI: '1' }, { DO_NOT_TRACK: '1' }, { STARLOG_TELEMETRY: '0' }];
    for (const signal of signals) {
      const home = mkTemp('starlog-tel-home-');
      const { status, stdout } = run(['telemetry', 'status'], { env: { HOME: home, ...signal } });
      expect(status).toBe(0);
      expect(stdout).toContain('Telemetry: disabled');
    }
  });

  it('`telemetry disable` persists enabled:false to ~/.starlog/telemetry.json and survives a clean-env status', () => {
    // One HOME deliberately REUSED across disable → status to prove persistence
    // (not just env-driven), per the scenario.
    const home = mkTemp('starlog-tel-persist-home-');

    const disable = run(['telemetry', 'disable'], { env: { HOME: home } });
    expect(disable.status).toBe(0);
    expect(disable.stdout).toContain('Telemetry disabled.');

    const cfg = JSON.parse(readFileSync(join(home, '.starlog', 'telemetry.json'), 'utf8'));
    expect(cfg.enabled).toBe(false);

    // Clean env (no opt-out signal): still disabled → persisted, not env-driven.
    const status = run(['telemetry', 'status'], { env: { HOME: home } });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('Telemetry: disabled');

    // And `enable` is the inverse, exit 0 with its own marker.
    const enable = run(['telemetry', 'enable'], { env: { HOME: home } });
    expect(enable.status).toBe(0);
    expect(enable.stdout).toContain('Telemetry enabled.');
  });

  it('`CI=1 init -y --dry-run` suppresses the first-run telemetry notice (no /telemetry/i line)', () => {
    // Temp cwd AND temp HOME so the dry-run plans only temp paths; CI=1 both
    // suppresses the banner AND guarantees no PostHog fetch. --dry-run writes
    // nothing.
    const home = mkTemp('starlog-init-home-');
    const cwd = mkTemp('starlog-init-cwd-');
    const { status, stdout, stderr } = run(['init', '-y', '--dry-run'], {
      env: { HOME: home, CI: '1' },
      cwd,
    });
    expect(status).toBe(0);
    // Dry-run banner is present (sanity that we exercised the real init path)...
    expect(stdout).toContain('Dry run');
    // ...but the telemetry first-run notice is suppressed under CI.
    expect(stdout + stderr).not.toMatch(/telemetry/i);
  });
});

describe('telemetry env precedence + unknown-command exit codes (e2e)', () => {
  // Title 2: "Telemetry opt-out precedence and hermetic safety: DO_NOT_TRACK
  // beats explicit opt-in; unknown action exits 1".

  it('DO_NOT_TRACK=1 beats an explicit STARLOG_TELEMETRY=1 opt-in → "Telemetry: disabled"', () => {
    const home = mkTemp('starlog-tel-home-');
    const { status, stdout } = run(['telemetry', 'status'], {
      env: { HOME: home, DO_NOT_TRACK: '1', STARLOG_TELEMETRY: '1' },
    });
    expect(status).toBe(0);
    // Opt-out wins over opt-in — the load-bearing privacy guarantee.
    expect(stdout).toContain('Telemetry: disabled');
    // Status remains a pure local readout: Anonymous ID label + opt-out hint.
    expect(stdout).toContain('Anonymous ID:');
    expect(stdout).toContain('STARLOG_TELEMETRY=0');
  });

  it('an unknown telemetry action exits 1 with an actionable "Unknown action" message on stderr', () => {
    const home = mkTemp('starlog-tel-home-');
    const { status, stdout, stderr } = run(['telemetry', 'frobnicate'], {
      env: { HOME: home, STARLOG_TELEMETRY: '0' },
    });
    expect(status).toBe(1);
    expect(stderr).toContain('Unknown action "frobnicate". Use: status, enable, or disable.');
    expect(stdout).toBe('');
  });

  it("an unknown top-level subcommand exits 1 with commander's \"unknown command\" error on stderr", () => {
    const { status, stderr } = run(['frobnicate', 'foo'], { env: { STARLOG_TELEMETRY: '0' } });
    expect(status).toBe(1);
    expect(stderr).toContain("error: unknown command 'frobnicate'");
  });
});

describe('facts push missing-key fast-fail (e2e)', () => {
  // Title 3: "facts push without STARLOG_API_KEY exits 1 with a clean marker
  // before any IO". The runner already DELETES STARLOG_API_KEY, so the guard
  // (createFactsApiClient() === null) is exercised deterministically.
  const MARKER = 'facts push needs STARLOG_API_KEY (the org key these facts belong to).';

  it('`facts push` with no key and no file arg exits 1 with the exact missing-key marker, empty stdout', () => {
    // STARLOG_TELEMETRY=0 keeps the run fully offline; the missing-key guard is
    // the behavior under test.
    const { status, stdout, stderr } = run(['facts', 'push'], { env: { STARLOG_TELEMETRY: '0' } });
    expect(status).toBe(1);
    expect(stderr.trim()).toBe(MARKER);
    expect(stdout).toBe('');
  });

  it('`facts push <nonexistent-file>` fails on the missing key BEFORE reading the file (same marker)', () => {
    // The whole point: a bogus path must NOT change the error — the key guard
    // fires before any readFileSync / fetch, so no "no facts file" / 405 leaks.
    const { status, stdout, stderr } = run(['facts', 'push', '/nonexistent/facts.json'], {
      env: { STARLOG_TELEMETRY: '0' },
    });
    expect(status).toBe(1);
    expect(stderr.trim()).toBe(MARKER);
    expect(stderr).not.toMatch(/no facts file|ENOENT|405/i);
    expect(stdout).toBe('');
  });
});
