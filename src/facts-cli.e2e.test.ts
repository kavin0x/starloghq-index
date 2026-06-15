import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Repo root, derived from this file's location (src/ → ..) so the spawn cwd works
// on any machine/CI — NOT a hardcoded absolute path (which only existed on the
// original author's box and made every spawn ENOENT on Linux CI).
const REPO = fileURLToPath(new URL('..', import.meta.url));
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
  // Also drop STARLOG_API_KEY (else resolveFactView goes API-first → network/flaky)
  // and STARLOG_POLICY (else an inherited org verdict leaks into baseline runs).
  // Explicit per-test overrides below still win.
  delete childEnv.STARLOG_API_KEY;
  delete childEnv.STARLOG_POLICY;
  // Suppress the self-heal init nudge by default — it reads the ambient
  // ~/.claude/settings.json, so leaving it on would make stderr non-deterministic
  // across machines/CI and break the "a miss leaks nothing to stderr" assertion.
  childEnv.STARLOG_NO_NUDGE = '1';
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
    // Layered view: vuln/license/maintenance live under l2; recency is l2.attestation.fetched_at.
    expect(parsed.l2.known_vulns).toEqual([]);
    expect(parsed.l2.maintenance).toBe('active');
    expect(parsed.l2.attestation.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.l1.effect_surface).toContain('Terminal string styling');
    expect(parsed.l3.decision).toBe('none');
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
    // Layered private overlay: independent l1 + l2 arrays. One brand-new package
    // (private L1 + L2, no public entry) and one override of an existing public
    // package (chalk) — overriding its L1 effect surface AND its L2 maintenance.
    const NEW_PKG = '@acme/internal-widget';
    const OVERRIDE_MARKER = 'ORG OVERRIDE: internal banned chalk fork';

    function overlayFile(): string {
      return writePrivate({
        l1: [
          { package: NEW_PKG, ecosystem: 'npm', version_range: null, artifact_sha256: null, effect_surface: 'Internal widget; runs in-process.', capabilities: [], provenance: { derived_by: 'hand', source: 'ACME internal', verified: true } },
          { package: 'chalk', ecosystem: 'npm', version_range: null, artifact_sha256: null, effect_surface: OVERRIDE_MARKER, capabilities: [], provenance: { derived_by: 'hand', source: 'ACME security ruling', verified: true } },
        ],
        l2: [
          {
            package: NEW_PKG, ecosystem: 'npm',
            known_vulns: [{ id: 'INCIDENT:acme-widget-internal', severity: 'high', affected: '< 2.0.0', summary: 'Internal ruling: banned below 2.0.0.' }],
            license: 'UNLICENSED', license_risk: 'unknown', maintenance: 'deprecated', transitive_risk: null,
            attestation: { source: 'hand', refs: ['ACME internal registry'], fetched_at: '2026-05-15' },
          },
          {
            package: 'chalk', ecosystem: 'npm', known_vulns: [], license: 'MIT', license_risk: 'none', maintenance: 'abandoned', transitive_risk: null,
            attestation: { source: 'hand', refs: ['ACME security ruling'], fetched_at: '2026-05-16' },
          },
        ],
      });
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

/**
 * Authoring (`facts add` / `facts policy`) e2e — Phase 11. Spawns the built
 * binary and proves the author→vet loop: a minimal one-command add writes a
 * schema-valid record that `facts <pkg>` reads back; a policy verdict renders;
 * bad input fails loudly (AUTH-04); and — the phase's CORE story — the env-UNSET
 * default-path branch works hermetically from a temp cwd.
 */
describe('starlog facts authoring (add / policy) e2e', () => {
  let tmpDir: string | null = null;

  // env-UNSET helper (W1): spawn from a temp cwd with an ABSOLUTE cli path so
  // the relative default `.starlog/private-facts.json` resolves UNDER tmpDir
  // (no repo-tree pollution). A relative CLI from cwd:tmpDir would ENOENT, so
  // both the absolute cli path AND the tmp cwd are required together.
  function runFactsInDir(cwd: string, args: string[], env?: Record<string, string>): RunResult {
    const childEnv: Record<string, string | undefined> = { ...process.env };
    delete childEnv.STARLOG_PRIVATE_FACTS;
    delete childEnv.STARLOG_API_KEY;
    delete childEnv.STARLOG_POLICY;
    childEnv.STARLOG_NO_NUDGE = '1';
    Object.assign(childEnv, env ?? {});
    try {
      const stdout = execFileSync('node', [join(REPO, 'dist/cli.js'), '--no-telemetry', 'facts', ...args], {
        cwd,
        encoding: 'utf8',
        env: childEnv,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
      return {
        status: typeof e.status === 'number' ? e.status : -1,
        stdout: e.stdout ? e.stdout.toString() : '',
        stderr: e.stderr ? e.stderr.toString() : '',
      };
    }
  }

  function newTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-authoring-e2e-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  // 1. ROUND-TRIP — the headline: one command writes a valid record that
  //    `facts <pkg>` reads back (AUTH-01 + AUTH-02 through the real binary).
  it('add → lookup round-trips a private-only package (AUTH-01/02)', () => {
    const dir = newTmpDir();
    const privPath = join(dir, 'private-facts.json');

    const add = runFacts(['add', '@acme/roundtrip', '--license', 'MIT', '--status', 'active'], {
      STARLOG_PRIVATE_FACTS: privPath,
    });
    expect(add.status).toBe(0);
    expect(add.stdout).toContain('Added @acme/roundtrip to ');
    expect(add.stdout).toContain(privPath);

    const parsed = JSON.parse(readFileSync(privPath, 'utf8'));
    expect(Array.isArray(parsed.l1)).toBe(true);
    expect(parsed.l2[0].package).toBe('@acme/roundtrip');
    expect(parsed.l2[0].attestation.source).toBe('hand');
    expect(parsed.l2[0].attestation.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const vet = runFacts(['@acme/roundtrip'], { STARLOG_PRIVATE_FACTS: privPath });
    expect(vet.status).toBe(0);
    expect(vet.stdout).toContain('## @acme/roundtrip (npm)');
    expect(vet.stdout).toContain('**License:** MIT');
    expect(vet.stdout).toContain('**Maintenance:** active');
  });

  // 2. UPSERT — same package replaced in place; a second package coexists.
  it('add upserts the same package and preserves a second one', () => {
    const dir = newTmpDir();
    const privPath = join(dir, 'private-facts.json');

    runFacts(['add', '@acme/roundtrip', '--license', 'MIT', '--status', 'active'], { STARLOG_PRIVATE_FACTS: privPath });
    runFacts(['add', '@acme/roundtrip', '--license', 'MIT', '--status', 'deprecated'], { STARLOG_PRIVATE_FACTS: privPath });
    let parsed = JSON.parse(readFileSync(privPath, 'utf8'));
    expect(parsed.l2).toHaveLength(1);
    expect(parsed.l2[0].maintenance).toBe('deprecated');

    runFacts(['add', '@acme/other', '--license', 'MIT', '--status', 'active'], { STARLOG_PRIVATE_FACTS: privPath });
    parsed = JSON.parse(readFileSync(privPath, 'utf8'));
    expect(parsed.l2).toHaveLength(2);
    const pkgs = parsed.l2.map((o: { package: string }) => o.package).sort();
    expect(pkgs).toEqual(['@acme/other', '@acme/roundtrip']);
  });

  // 3. POLICY → verdict renders (AUTH-03).
  it('policy verdict renders in facts <pkg> (AUTH-03)', () => {
    const dir = newTmpDir();
    const privPath = join(dir, 'private-facts.json');
    const polPath = join(dir, 'policy.json');

    // Give it an L2 record so the package resolves and the verdict can attach.
    runFacts(['add', '@acme/policed', '--license', 'MIT', '--status', 'active'], { STARLOG_PRIVATE_FACTS: privPath });

    const setPolicy = runFacts(['policy', '@acme/policed', 'deny', '--reason', 'banned by security'], {
      STARLOG_PRIVATE_FACTS: privPath,
      STARLOG_POLICY: polPath,
    });
    expect(setPolicy.status).toBe(0);
    expect(setPolicy.stdout).toContain('Set org verdict DENY for @acme/policed');

    const parsed = JSON.parse(readFileSync(polPath, 'utf8'));
    expect(typeof parsed.org).toBe('string');
    expect(parsed.rules[0].id).toBe('pkg-@acme/policed');
    expect(parsed.rules[0].decision).toBe('deny');

    const vet = runFacts(['@acme/policed'], { STARLOG_PRIVATE_FACTS: privPath, STARLOG_POLICY: polPath });
    expect(vet.status).toBe(0);
    expect(vet.stdout).toContain('**Org policy:** DENY');
    expect(vet.stdout).toContain('banned by security');
  });

  // 4. ERRORS (AUTH-04) — each exits non-zero with an actionable message.
  it('missing --license exits non-zero with a license error', () => {
    const { status, stderr } = runFacts(['add', '@acme/x', '--status', 'active']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('license');
  });

  it('bad --status exits non-zero with "Invalid --status" naming the value', () => {
    const { status, stderr } = runFacts(['add', '@acme/x', '--license', 'MIT', '--status', 'bogus']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Invalid --status');
    expect(stderr).toContain('bogus');
  });

  it('bad verdict exits non-zero with "Invalid verdict" naming the value', () => {
    const { status, stderr } = runFacts(['policy', '@acme/x', 'maybe']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Invalid verdict');
    expect(stderr).toContain('maybe');
  });

  it('bad --vuln severity exits non-zero with "Invalid vuln severity"', () => {
    const { status, stderr } = runFacts([
      'add',
      '@acme/x',
      '--license',
      'MIT',
      '--status',
      'active',
      '--vuln',
      'CVE-1:nope:bad',
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Invalid vuln severity');
  });

  // 5. ENV-UNSET author→vet (W1) — the phase's CORE user story, hermetic.
  it('env-UNSET add writes the default path + prints the nudge, and the nudged vet reads it back', () => {
    const dir = newTmpDir();

    // NO env arg → STARLOG_PRIVATE_FACTS stays unset; cwd is tmpDir so the
    // relative default resolves under tmpDir.
    const add = runFactsInDir(dir, ['add', '@acme/unset', '--license', 'MIT', '--status', 'active']);
    expect(add.status).toBe(0);
    // Nudge is accurate about the agent path: the agent auto-reads the default
    // .starlog file after `starlog init` (the MCP server's baked env), and the
    // inline-env form is for CLI use in this shell. A shell `export` never reaches
    // the agent-spawned server, so we no longer tell users to do that.
    expect(add.stdout).toContain('starlog init');
    expect(add.stdout).toContain('STARLOG_PRIVATE_FACTS=');
    expect(add.stdout).not.toContain('export STARLOG_PRIVATE_FACTS=');

    const defaultPath = join(dir, '.starlog', 'private-facts.json');
    const parsed = JSON.parse(readFileSync(defaultPath, 'utf8'));
    expect(parsed.l2[0].package).toBe('@acme/unset');

    // Follow the nudge: set the absolute path the loader reads verbatim.
    const vet = runFactsInDir(dir, ['@acme/unset'], { STARLOG_PRIVATE_FACTS: defaultPath });
    expect(vet.status).toBe(0);
    expect(vet.stdout).toContain('## @acme/unset (npm)');
    expect(vet.stdout).toContain('**License:** MIT');
  });
});

/**
 * Self-heal init nudge (e2e) — the install-≠-wired gap. A first user ran
 * `npm i starloghq` then drove the CLI through their agent without ever running
 * `starlog init`; the MCP tools were never registered. When settings.json exists
 * but lacks starlog, a single stderr line steers them to `starlog init`.
 *
 * Hermetic via HOME override: os.homedir() honours $HOME on POSIX, so we point it
 * at a temp dir with a controlled ~/.claude/settings.json and assert the CLI's
 * real reading of it. STARLOG_NO_NUDGE: '' opts back in (the harness defaults it on).
 */
describe('starlog facts CLI — self-heal init nudge (e2e)', () => {
  let home: string | null = null;

  function writeHomeSettings(settings: unknown | null): string {
    home = mkdtempSync(join(tmpdir(), 'starlog-nudge-home-'));
    if (settings !== null) {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings), 'utf8');
    }
    return home;
  }

  // The nudge writes to STDERR on a clean (exit-0) miss. runFacts() above only
  // captures stderr on a NON-zero exit (execFileSync returns stdout only), so it
  // can't see a success-path nudge — use spawnSync, which captures both streams
  // regardless of exit code. STARLOG_NO_NUDGE is left UNSET here so the nudge can
  // fire; HOME points os.homedir() at our controlled ~/.claude/settings.json.
  function runRawFacts(args: string[], home: string): { status: number; stderr: string } {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.STARLOG_PRIVATE_FACTS;
    delete env.STARLOG_API_KEY;
    delete env.STARLOG_POLICY;
    delete env.STARLOG_NO_NUDGE;
    env.HOME = home;
    const r = spawnSync('node', [CLI, '--no-telemetry', 'facts', ...args], { cwd: REPO, encoding: 'utf8', env });
    return { status: r.status ?? -1, stderr: r.stderr ?? '' };
  }

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('fires when settings.json exists but has no starlog MCP server (unwired user)', () => {
    const h = writeHomeSettings({ mcpServers: { other: {} }, hooks: {} });
    const { status, stderr } = runRawFacts(['no-such-pkg-xyz'], h);
    expect(status).toBe(0);
    expect(stderr).toContain('starlog init');
  });

  it('stays silent when starlog IS wired into settings.json', () => {
    const h = writeHomeSettings({ mcpServers: { starlog: { command: 'node', args: ['x'] } } });
    const { status, stderr } = runRawFacts(['no-such-pkg-xyz'], h);
    expect(status).toBe(0);
    expect(stderr).not.toContain('starlog init');
  });

  it('stays silent when there is no settings.json at all (ambiguous — never nudge on a guess)', () => {
    const h = writeHomeSettings(null);
    const { status, stderr } = runRawFacts(['no-such-pkg-xyz'], h);
    expect(status).toBe(0);
    expect(stderr).not.toContain('starlog init');
  });
});

describe('facts push — flag wiring (hermetic, no key)', () => {
  it('accepts the --policy flag and reaches the API-key guard (proves it is registered)', () => {
    // No STARLOG_API_KEY in the child env → the action's guard fires. If --policy
    // were not a registered option, commander would instead error "unknown option".
    const { status, stderr } = runFacts(['push', 'some-facts.json', '--policy', 'some-policy.json']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('STARLOG_API_KEY');
    expect(stderr).not.toMatch(/unknown option/i);
  });
});
