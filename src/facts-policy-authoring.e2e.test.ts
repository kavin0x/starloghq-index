import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * End-to-end tests for `starlog facts add` / `facts policy` authoring +
 * adversarial overlay robustness, exercised through the REAL built binary
 * (dist/cli.js) spawned via node:child_process. This is the author→vet loop the
 * unit tests can't reach: commander argv parsing, the atomic overlay writer,
 * loadFactMap() reading STARLOG_PRIVATE_FACTS / STARLOG_POLICY off the actual
 * process env, schema validation of overlay entries, formatFacts / JSON
 * serialization, and the real process exit code.
 *
 * HERMETICITY (mirrors facts-cli.e2e.test.ts verbatim):
 *  - Every child env starts from {...process.env} then DELETES the three
 *    ambient overlay knobs (STARLOG_PRIVATE_FACTS, STARLOG_API_KEY,
 *    STARLOG_POLICY) so a value inherited from the dev/CI shell can never leak
 *    into a baseline run. Dropping STARLOG_API_KEY also keeps resolveFactView on
 *    the LOCAL layered corpus (never API-first → no network / flake).
 *  - STARLOG_NO_NUDGE='1' (none of these tests are about the init nudge) and
 *    STARLOG_TELEMETRY='0' (an offline PostHog fetch otherwise hangs ~1500ms).
 *  - Explicit per-test env (the temp overlay/policy paths) is applied LAST.
 *  - EVERY spawn runs from a fresh mkdtempSync cwd with an ABSOLUTE cli path so
 *    the relative default `.starlog/...` can never touch the repo tree, and we
 *    rmSync the temp dir in afterEach. All overlay/policy files live under temp.
 *
 * DATE POLICY: every record authored via `facts add` carries a freshly-stamped
 * "Verified: as of <date>" — that value tracks wall-clock, so we assert it ONLY
 * as a /\d{4}-\d{2}-\d{2}/ shape, never a literal day (Rule 1: no volatile
 * exact values).
 *
 * Scope: CLI surface only. MCP stdio parity has its own dedicated file.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ABS_CLI = join(REPO, 'dist/cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node dist/cli.js --no-telemetry facts <args>` from `cwd` (always a temp
 * dir) with an absolute cli path. Returns a normalized RunResult for BOTH zero
 * and non-zero exits — execFileSync throws on non-zero, and we recover
 * status/stdout/stderr from the thrown error so a failing exit is a first-class,
 * assertable outcome (the no-clobber test depends on reading stderr off exit 1).
 */
function runFactsInDir(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): RunResult {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.STARLOG_PRIVATE_FACTS;
  delete childEnv.STARLOG_API_KEY;
  delete childEnv.STARLOG_POLICY;
  childEnv.STARLOG_NO_NUDGE = '1';
  childEnv.STARLOG_TELEMETRY = '0';
  Object.assign(childEnv, env ?? {});
  try {
    const stdout = execFileSync(
      'node',
      [ABS_CLI, '--no-telemetry', 'facts', ...args],
      { cwd, encoding: 'utf8', env: childEnv },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      status: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

describe('starlog facts authoring + policy + overlay robustness (e2e, spawned binary)', () => {
  let tmpDir: string | null = null;

  function newTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-policy-authoring-e2e-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  // ---------------------------------------------------------------------------
  // AUTH-03 footgun: a policy verdict with NO accompanying L1/L2 record is
  // invisible to the agent. Adding a record makes the same verdict surface.
  // ---------------------------------------------------------------------------
  it('policy-only ban with no L1/L2 record silently does NOT reach the agent (AUTH-03 footgun)', () => {
    const dir = newTmpDir();
    const privPath = join(dir, '.starlog', 'private-facts.json');
    const polPath = join(dir, '.starlog', 'policy.json');

    // 1. Set a DENY verdict by policy alone (no facts record exists yet).
    const setPolicy = runFactsInDir(
      dir,
      ['policy', '@acme/internal-tool', 'deny', '--reason', 'banned'],
      { STARLOG_POLICY: polPath },
    );
    expect(setPolicy.status).toBe(0);
    expect(setPolicy.stdout).toContain(
      'Set org verdict DENY for @acme/internal-tool',
    );

    // 2. Vet with ONLY the policy set: the verdict is a silent no-op because
    //    there is no L1/L2 record for it to attach to. The agent sees the honest
    //    miss message and — critically — NOT the DENY. This is the AUTH-03
    //    footgun: a security engineer who runs only `facts policy <pkg> deny`
    //    believes the ban is live, but it never reaches the agent.
    const vet1 = runFactsInDir(dir, ['@acme/internal-tool'], {
      STARLOG_POLICY: polPath,
    });
    expect(vet1.status).toBe(0);
    // The package has no L1/L2 record, so the vet is the honest miss. We do NOT
    // assert the verdict is ABSENT here — that would enshrine the footgun and go red
    // if the product is fixed to surface policy-only bans. The desired behavior is
    // pinned by the it.fails living marker below.
    expect(vet1.stdout).toContain('No facts on file for "@acme/internal-tool"');

    // 3. Author a minimal record so the package resolves.
    const add = runFactsInDir(
      dir,
      ['add', '@acme/internal-tool', '--license', 'MIT', '--status', 'active'],
      { STARLOG_PRIVATE_FACTS: privPath },
    );
    expect(add.status).toBe(0);
    expect(add.stdout).toContain('Added @acme/internal-tool to ');

    // 4. Re-vet with BOTH overlay and policy: now the DENY composes onto the
    //    record and finally reaches the agent.
    const vet2 = runFactsInDir(dir, ['@acme/internal-tool'], {
      STARLOG_PRIVATE_FACTS: privPath,
      STARLOG_POLICY: polPath,
    });
    expect(vet2.status).toBe(0);
    expect(vet2.stdout).toContain(
      '**Org policy:** DENY — banned (rule pkg-@acme/internal-tool)',
    );

    // Both files landed under TEMP/.starlog/ (no repo-tree pollution).
    expect(() => readFileSync(polPath, 'utf8')).not.toThrow();
    expect(() => readFileSync(privPath, 'utf8')).not.toThrow();
  });

  // KNOWN FOOTGUN (living marker): a policy-only DENY (no L1/L2 record) is currently a
  // silent no-op — the verdict never reaches the agent's vet output. This `it.fails`
  // asserts the DESIRED behavior (the DENY is visible even without an authored record);
  // it PASSES today because the body fails, and FLIPS to a real failure if/when the
  // product surfaces policy-only bans. Reported in the suspected-bugs report.
  it.fails('a policy-only DENY (no facts record) should still reach the agent', () => {
    const dir = newTmpDir();
    const polPath = join(dir, '.starlog', 'policy.json');
    runFactsInDir(dir, ['policy', '@acme/ghost', 'deny', '--reason', 'banned'], { STARLOG_POLICY: polPath });
    const vet = runFactsInDir(dir, ['@acme/ghost'], { STARLOG_POLICY: polPath });
    expect(vet.stdout).toContain('DENY'); // fails today (silent no-op) -> it.fails passes
  });

  // ---------------------------------------------------------------------------
  // L2 override + L3 deny compose in the machine-readable JSON the agent parses.
  // The override MERGES (license/maintenance superseded; public vuln retained).
  // ---------------------------------------------------------------------------
  it('override a public record with an internal ruling: private L2 overlay + L3 deny stack in one JSON verdict', () => {
    const dir = newTmpDir();
    const privPath = join(dir, '.starlog', 'private-facts.json');
    const polPath = join(dir, '.starlog', 'policy.json');

    const add = runFactsInDir(
      dir,
      ['add', 'ua-parser-js', '--license', 'GPL-3.0', '--status', 'deprecated'],
      { STARLOG_PRIVATE_FACTS: privPath },
    );
    expect(add.status).toBe(0);
    expect(add.stdout).toContain('Added ua-parser-js');

    const setPolicy = runFactsInDir(
      dir,
      ['policy', 'ua-parser-js', 'deny', '--reason', 'internal ruling'],
      { STARLOG_POLICY: polPath },
    );
    expect(setPolicy.status).toBe(0);
    expect(setPolicy.stdout).toContain('Set org verdict DENY for ua-parser-js');

    const vet = runFactsInDir(dir, ['ua-parser-js', '--format', 'json'], {
      STARLOG_PRIVATE_FACTS: privPath,
      STARLOG_POLICY: polPath,
    });
    expect(vet.status).toBe(0);

    const parsed = JSON.parse(vet.stdout);
    expect(parsed.package).toBe('ua-parser-js');

    // L3: the policy deny composes verbatim into the JSON.
    expect(parsed.l3).toEqual({
      decision: 'deny',
      rule_id: 'pkg-ua-parser-js',
      rationale: 'internal ruling',
    });

    // L2: the shipped contract is an OBJECT (not an array — see
    // facts-cli.e2e.test.ts, which reads parsed.l2.known_vulns / .maintenance).
    // The org override SUPERSEDES license + maintenance on the public record.
    expect(parsed.l2).toBeTypeOf('object');
    expect(Array.isArray(parsed.l2)).toBe(false);
    expect(parsed.l2.license).toBe('GPL-3.0');
    expect(parsed.l2.maintenance).toBe('deprecated');
    // NOTE: the override MERGES — the public 2021 incident is intentionally
    // retained (the add only set license/status), so we do NOT assert vulns are
    // empty. We assert the merge preserved the public advisory's id.
    expect(JSON.stringify(parsed.l2.known_vulns)).toContain(
      'INCIDENT:ua-parser-js-2021',
    );
  });

  // ---------------------------------------------------------------------------
  // Author a high-severity CVE + license on an internal fork and vet it back.
  // ---------------------------------------------------------------------------
  it('author a private vuln/license record for a forked dependency and vet it back', () => {
    const dir = newTmpDir();
    const privPath = join(dir, '.starlog', 'private-facts.json');

    const add = runFactsInDir(
      dir,
      [
        'add',
        '@acme/forked-parser',
        '--license',
        'MIT',
        '--status',
        'active',
        '--vuln',
        'CVE-2025-9:high:RCE in parser',
      ],
      { STARLOG_PRIVATE_FACTS: privPath },
    );
    expect(add.status).toBe(0);
    expect(add.stdout).toContain('Added @acme/forked-parser to ');

    const vet = runFactsInDir(dir, ['@acme/forked-parser'], {
      STARLOG_PRIVATE_FACTS: privPath,
    });
    expect(vet.status).toBe(0);
    expect(vet.stdout).toContain('## @acme/forked-parser (npm)');
    expect(vet.stdout).toContain('**Known vulnerabilities / incidents:**');
    // The authored advisory renders verbatim under the header.
    expect(vet.stdout).toContain(
      '  - CVE-2025-9 [high] affected: unspecified — RCE in parser',
    );
    expect(vet.stdout).toContain('**License:** MIT');
    // Date is wall-clock-stamped → assert shape only, never a literal day.
    expect(vet.stdout).toMatch(/\*\*Verified:\*\* as of \d{4}-\d{2}-\d{2}/);

    // Negative: a bad --vuln severity is a loud local schema failure (exit 1).
    const bad = runFactsInDir(
      dir,
      [
        'add',
        '@acme/x',
        '--license',
        'MIT',
        '--status',
        'active',
        '--vuln',
        'CVE-1:bogus:x',
      ],
      { STARLOG_PRIVATE_FACTS: join(dir, '.starlog', 'pf2.json') },
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Invalid vuln severity');
    expect(bad.stderr).toContain('bogus');
  });

  // ---------------------------------------------------------------------------
  // Weird/hostile package names round-trip as inert DATA — no shell expansion,
  // no fabrication on near-misses (matcher is exact-only).
  // ---------------------------------------------------------------------------
  it('weird/hostile package names round-trip safely through authoring and lookup', () => {
    const dir = newTmpDir();
    const privPath = join(dir, '.starlog', 'pf.json');

    const SCOPED = '@acme/secret-sdk';
    // Passed as a SINGLE argv token via the spawn arg array — the test never
    // lets a shell expand $()/rm; the point is the BINARY treats it as data.
    const SHELLISH = 'weird;rm -rf $(echo x)';
    const LONG = 'a'.repeat(300);

    for (const name of [SCOPED, SHELLISH, LONG]) {
      const add = runFactsInDir(
        dir,
        ['add', name, '--license', 'MIT', '--status', 'active'],
        { STARLOG_PRIVATE_FACTS: privPath },
      );
      expect(add.status).toBe(0);
      expect(add.stdout).toContain(`Added ${name} to `);
    }

    // The overlay parses and stores each weird name verbatim as a package key.
    const parsed = JSON.parse(readFileSync(privPath, 'utf8'));
    const stored: string[] = parsed.l2.map((o: { package: string }) => o.package);
    expect(stored).toContain(SCOPED);
    expect(stored).toContain(SHELLISH);
    expect(stored).toContain(LONG);

    // Exact lookup of each weird name resolves its own record (round-trip).
    for (const name of [SCOPED, SHELLISH]) {
      const vet = runFactsInDir(dir, [name], {
        STARLOG_PRIVATE_FACTS: privPath,
      });
      expect(vet.status).toBe(0);
      expect(vet.stdout).toContain(`## ${name} (npm)`);
      expect(vet.stdout).toContain('**License:** MIT');
      expect(vet.stdout).toContain('**Maintenance:** active');
    }

    // The shell-ish name caused NO file deletion / no extra files — the arg was
    // treated as inert data, never executed. Only our single overlay exists.
    expect(readdirSync(join(dir, '.starlog'))).toEqual(['pf.json']);

    // Near-miss (substring of the scoped name) MUST be an honest miss, not a
    // fabricated hit — the matcher is documented exact-only.
    const nearMiss = runFactsInDir(dir, ['@acme/secret'], {
      STARLOG_PRIVATE_FACTS: privPath,
    });
    expect(nearMiss.status).toBe(0);
    expect(nearMiss.stdout).toContain('No facts on file for "@acme/secret"');
  });

  // ---------------------------------------------------------------------------
  // No-clobber: `facts add` refuses to overwrite a corrupt existing overlay,
  // leaving the user's bytes byte-for-byte intact and no atomic-write sidecar.
  // ---------------------------------------------------------------------------
  it('authoring no-clobber: `facts add` refuses to overwrite a corrupt existing overlay', () => {
    const dir = newTmpDir();
    const privPath = join(dir, 'private-facts.json');

    // Deliberately corrupt (truncated, invalid JSON).
    const CORRUPT = '{ "l2": [ {CORRUPT';
    writeFileSync(privPath, CORRUPT, 'utf8');
    const before = readFileSync(privPath); // raw bytes

    const add = runFactsInDir(
      dir,
      ['add', 'foo', '--license', 'MIT', '--status', 'active'],
      { STARLOG_PRIVATE_FACTS: privPath },
    );

    expect(add.status).toBe(1);
    expect(add.stderr).toContain('starlog: facts add failed: invalid JSON —');
    expect(add.stderr).toContain('Fix or remove the malformed file');
    // The success line must NEVER have printed.
    expect(add.stdout).not.toContain('Added foo to');

    // The user's overlay is byte-for-byte UNCHANGED (no clobber).
    const after = readFileSync(privPath);
    expect(after.equals(before)).toBe(true);

    // No `*.tmp` sidecar from the atomic-write path leaked into the dir.
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // A schema-invalid overlay ENTRY (impossible date) is dropped whole; the
  // package honestly degrades to "No facts on file" — never a crash or a
  // half-parsed record. A control with a valid date proves the date is the cause.
  // ---------------------------------------------------------------------------
  it("schema-invalid overlay ENTRY (impossible date 2026-13-99) is dropped, package degrades to 'No facts on file'", () => {
    const dir = newTmpDir();
    const badPath = join(dir, 'overlay-bad.json');
    const goodPath = join(dir, 'overlay-good.json');

    const entry = (fetchedAt: string) => ({
      l2: [
        {
          package: 'weirddate-pkg',
          ecosystem: 'npm',
          known_vulns: [],
          license: 'MIT',
          license_risk: 'none',
          maintenance: 'active',
          transitive_risk: null,
          attestation: { source: 'hand', refs: [], fetched_at: fetchedAt },
        },
      ],
    });

    // Well-formed JSON, but an impossible calendar date → the entry fails schema
    // validation and is dropped.
    writeFileSync(badPath, JSON.stringify(entry('2026-13-99')), 'utf8');
    const bad = runFactsInDir(dir, ['weirddate-pkg'], {
      STARLOG_PRIVATE_FACTS: badPath,
    });
    expect(bad.status).toBe(0); // a miss is an honest answer, not an error
    expect(bad.stdout).toContain('No facts on file for "weirddate-pkg"');
    // Robustness: no crash / stack trace surfaced.
    expect(bad.stdout).not.toMatch(/UnhandledPromiseRejection|at Object\.<anonymous>/);
    expect(bad.stderr).not.toMatch(/UnhandledPromiseRejection|at Object\.<anonymous>/);

    // Control: identical record except a VALID date now resolves — proving the
    // date field (not the entry shape) caused the drop above.
    writeFileSync(goodPath, JSON.stringify(entry('2026-06-01')), 'utf8');
    const good = runFactsInDir(dir, ['weirddate-pkg'], {
      STARLOG_PRIVATE_FACTS: goodPath,
    });
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('## weirddate-pkg (npm)');
    expect(good.stdout).toContain('**License:** MIT');
    expect(good.stdout).toContain('**Maintenance:** active');
  });
});
