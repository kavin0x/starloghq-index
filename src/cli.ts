import 'dotenv/config';
import { Command } from 'commander';
import { formatTable, formatJSON } from './engine/format.js';
import { KnownCategorySchema } from './manifest/schema.js';
import { runSearch } from './search-service.js';
import { runInit } from './init.js';
import { runDoctor } from './doctor.js';
import { startMcpServer } from './mcp.js';
import {
  buildComposeDeps,
  resolveFactView,
  createFactsApiClient,
  formatFactView,
  buildL2FromInput,
  upsertL2Entry,
  buildManifestFromInput,
  upsertManifestEntry,
  buildL3Rule,
  upsertPolicy,
  L2OverlaySchema,
  L3PolicySchema,
  type L2Overlay,
} from './engine/facts.js';
import { readFileSync } from 'node:fs';
import { atomicWrite } from './fsutil.js';
import { getPackageVersion } from './paths.js';
import { detectAgents } from './install/detect.js';
import { track, telemetryStatus, setTelemetryEnabled } from './telemetry.js';

const VALID_CATEGORIES = KnownCategorySchema.options;

/** Turn a thrown error into a concise, actionable message + non-zero exit,
 *  instead of an UnhandledPromiseRejection stack trace. */
function fail(context: string, err: unknown): never {
  const e = err as NodeJS.ErrnoException;
  let hint = e?.message ?? String(err);
  if (e?.code === 'EACCES' || e?.code === 'EPERM') {
    hint = `permission denied (${e.path ?? 'a required file'}). Try a path you own or re-run with appropriate permissions.`;
  } else if (e instanceof SyntaxError) {
    hint = `invalid JSON — ${e.message}. Fix or remove the malformed file, then retry.`;
  }
  console.error(`starlog: ${context}: ${hint}`);
  process.exit(1);
}

/** Wrap an async action so any rejection is reported cleanly via fail(). */
function action<A extends unknown[]>(
  context: string,
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      fail(context, err);
    }
  };
}

const program = new Command();

program
  .name('starlog')
  .version(getPackageVersion())
  .description('Vet a package before you use it: authoritative facts (CVEs, license, maintenance, capability) for your AI coding agent. Run "starlog facts <package>" to look one up.')
  .option('--no-telemetry', 'Disable anonymous usage telemetry for this run');

/** True when the user passed --no-telemetry. */
const noTelemetry = () => program.opts().telemetry === false;

program
  .command('search')
  .description('Discover candidate packages for a capability (org-sanctioned ones first when configured), then vet the named pick with "starlog facts <package>"')
  .argument('<query>', 'Natural language query (e.g., "auth for Next.js")')
  .option('--format <type>', 'Output format: json or table', 'table')
  .option('--category <cat>', 'Filter by category')
  .option('--top-k <n>', 'Number of results', '5')
  .option('--stack <stack>', 'Stack affinity filter (e.g., "next.js")')
  .option('--context <desc>', 'Project context for vs_custom analysis')
  .option('--diversity <lambda>', 'Diversity-relevance tradeoff (0=max diversity, 1=pure relevance; default: 0.5 MMR on)', parseFloat)
  .action(action('search failed', async (query: string, opts: Record<string, string>) => {
    // Validate category -- warn for unknown categories but still search (D-04)
    if (opts.category && !VALID_CATEGORIES.includes(opts.category as any)) {
      console.warn(`Note: "${opts.category}" is not a known category (${VALID_CATEGORIES.join(', ')}). Searching corpus anyway.`);
    }

    // Validate format
    if (opts.format !== 'json' && opts.format !== 'table') {
      console.error(`Invalid format: ${opts.format}. Use "json" or "table".`);
      process.exit(1);
    }

    // Shared search service: delegates to the hosted API when STARLOG_API_KEY
    // is set, otherwise runs the local engine — and falls back to local on API
    // failure (parity with the MCP server).
    const topK = Number.parseInt(opts.topK as string, 10);
    const results = await runSearch({
      query,
      category: opts.category,
      stack: opts.stack,
      top_k: Number.isNaN(topK) ? undefined : topK,
      context: opts.context,
      diversity_lambda: (opts as { diversity?: number }).diversity,
    });

    await track(
      'cli_search',
      {
        category: opts.category ?? null,
        top_k: Number.isNaN(topK) ? null : topK,
        result_count: results.length,
        used_api: !!process.env.STARLOG_API_KEY,
        format: opts.format,
      },
      { noTelemetry: noTelemetry() },
    );

    if (results.length === 0) {
      console.error(
        `No strong match in the local index. It covers: ${VALID_CATEGORIES.join(', ')}.\n` +
        `Try rephrasing toward one of those capabilities.`,
      );
      process.exit(0);
    }

    // A single isolated, modestly-scored hit means the query likely matched a
    // stray keyword rather than a real capability (the in-domain case returns a
    // cluster of same-category libraries). Flag it so a lone off-topic result
    // doesn't read as a confident recommendation. JSON output stays clean.
    if (opts.format !== 'json' && results.length === 1 && results[0].relevance_score < 70) {
      console.error(
        `No strong match in the local index (covers: ${VALID_CATEGORIES.join(', ')}). ` +
        `Closest by keyword:`,
      );
    }

    const output = opts.format === 'json'
      ? formatJSON(results)
      : formatTable(results);

    console.log(output);
  }));

program
  .command('init')
  .description('Configure AI coding agents to use Starlog (MCP server, hooks, instructions)')
  .option('--project', 'Also add Starlog instructions to the current project CLAUDE.md')
  .option('--all', 'Configure all supported agents, even ones not detected in this environment')
  .option('--dry-run', 'Preview the changes without writing anything')
  .option('-y, --yes', 'Apply changes without the confirmation prompt (for CI/non-interactive use)')
  .option('--uninstall', 'Remove Starlog from Claude Code settings and hooks')
  .option('--api-key <key>', 'Wire your org STARLOG_API_KEY into the MCP server (enables hosted org-private facts for your agent)')
  .action(action('init failed', async (opts: { project?: boolean; all?: boolean; dryRun?: boolean; yes?: boolean; uninstall?: boolean; apiKey?: string }) => {
    await runInit(opts);

    const agents = detectAgents();
    const detected = (Object.keys(agents) as (keyof typeof agents)[]).filter((k) => agents[k].detected);
    await track(
      'cli_init',
      {
        mode: opts.uninstall ? 'uninstall' : opts.dryRun ? 'dry-run' : 'apply',
        project: !!opts.project,
        all: !!opts.all,
        yes: !!opts.yes,
        agents_detected: detected,
        agents_count: detected.length,
      },
      { noTelemetry: noTelemetry() },
    );
  }));

program
  .command('doctor')
  .description('Diagnose your Starlog setup (corpus, MCP server, hook, agent configs)')
  .action(action('doctor failed', async () => {
    const code = await runDoctor();
    await track('cli_doctor', { ok: code === 0, code }, { noTelemetry: noTelemetry() });
    process.exit(code);
  }));

program
  .command('mcp')
  .description('Start the Starlog MCP server on stdio (for npx-launched registry clients)')
  .action(action('mcp server failed to start', async () => {
    // stdio transport owns stdout for the JSON-RPC protocol — emit nothing here.
    // This is the npx-launchable entry point (`npx -y starloghq mcp`) that MCP
    // registries and clients use; `dist/mcp.js`'s run-if-main guard remains for
    // the absolute-path invocation that `init` wires into settings.json.
    await startMcpServer();
  }));

const facts = program
  .command('facts')
  .description("Vet a package by name — authoritative facts (CVEs, license, maintenance, capability), or push your org's facts to the hosted API");

// `starlog facts <package>` keeps working via this default subcommand.
facts
  .command('lookup <package>', { isDefault: true })
  .description('Look up authoritative facts (CVEs, license, maintenance, capability) for a package')
  .option('--format <type>', 'Output format: json or table', 'table')
  .action(action('facts lookup failed', async (pkg: string, opts: { format: string }) => {
    if (opts.format !== 'json' && opts.format !== 'table') {
      console.error(`Invalid format: ${opts.format}. Use "json" or "table".`);
      process.exit(1);
    }

    // Same API-first serve path as the MCP server: hosted facts (org-private L2
    // + policy) when STARLOG_API_KEY is set, with the local layered corpus
    // (public L1+L2 + STARLOG_PRIVATE_FACTS/STARLOG_POLICY) as the offline fallback.
    const local = buildComposeDeps();
    const api = createFactsApiClient();
    const view = await resolveFactView(pkg, { local, api });

    await track(
      'cli_facts',
      {
        hit: view !== null,
        format: opts.format,
        private_overlay: !!process.env.STARLOG_PRIVATE_FACTS,
        policy: !!process.env.STARLOG_POLICY,
        api: !!api,
      },
      { noTelemetry: noTelemetry() },
    );

    if (opts.format === 'json') {
      console.log(JSON.stringify(view, null, 2));
    } else {
      console.log(formatFactView(pkg, view));
    }
    // A miss is an honest answer, not an error — exit 0 either way.
  }));

// Documented default paths for LOCAL authoring (distinct from push's
// `.starlog/facts.json`, which is a different shape). These match the file
// shapes loadPrivateFacts / loadPolicy read back.
const DEFAULT_PRIVATE_FACTS = '.starlog/private-facts.json';
const DEFAULT_POLICY = '.starlog/policy.json';

/** ENOENT-tolerant JSON read: missing file → null; malformed JSON → throws
 *  (SyntaxError → fail() prints the "invalid JSON — fix or remove" message,
 *  so we never silently clobber an existing-but-broken file). */
function readJsonIfPresent(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// `starlog facts add <package>` — write/upsert a private L2 overlay LOCALLY
// (no hosted API call; that's `facts push`). Minimal input is --license +
// --status; defaults fill the rest so it validates (AUTH-01/02). Bad input
// fails loudly with a non-zero exit (AUTH-04).
facts
  .command('add <package>')
  .description('Add or update a private fact (L2 overlay) for a package — license, maintenance, optional vulns')
  .requiredOption('--license <spdx>', 'SPDX license id (e.g. MIT)')
  .requiredOption('--status <maintenance>', 'active | maintenance-only | deprecated | abandoned | compromised')
  .option('--ecosystem <eco>', 'npm | pypi | system', 'npm')
  .option('--license-risk <risk>', 'none | copyleft-weak | copyleft-strong | unknown', 'none')
  .option(
    '--vuln <id:severity:summary>',
    'A known vuln/incident (repeatable)',
    (v: string, acc: string[]) => {
      acc.push(v);
      return acc;
    },
    [] as string[],
  )
  .option('--transitive-risk <text>', 'Free-text note about transitive dependency risk')
  .action(
    action(
      'facts add failed',
      async (
        pkg: string,
        opts: {
          license: string;
          status: string;
          ecosystem: string;
          licenseRisk: string;
          vuln: string[];
          transitiveRisk?: string;
        },
      ) => {
        // A thrown Error here (bad enum / bad --vuln) → fail() → stderr + exit 1.
        const overlay = buildL2FromInput({
          package: pkg,
          license: opts.license,
          status: opts.status,
          ecosystem: opts.ecosystem,
          licenseRisk: opts.licenseRisk,
          transitiveRisk: opts.transitiveRisk,
          vulns: opts.vuln,
        });

        const envPath = process.env.STARLOG_PRIVATE_FACTS;
        const path = envPath ?? DEFAULT_PRIVATE_FACTS;
        const existing = readJsonIfPresent(path); // SyntaxError throws → no clobber
        const merged = upsertL2Entry(existing as { l1?: unknown[]; l2?: unknown[] } | null, overlay);
        // Unwritable path → EACCES → fail() prints the permission-denied message (AUTH-04).
        await atomicWrite(path, JSON.stringify(merged, null, 2) + '\n');

        await track(
          'cli_facts_add',
          { ecosystem: overlay.ecosystem, has_vulns: overlay.known_vulns.length > 0, default_path: !envPath },
          { noTelemetry: noTelemetry() },
        );

        console.log(`Added ${pkg} to ${path}.`);
        if (envPath) {
          console.log(`Your agent already reads this file (STARLOG_PRIVATE_FACTS). Vet it now: starlog facts ${pkg}`);
        } else {
          console.log(`To have your agent read it, set:  export STARLOG_PRIVATE_FACTS=${path}`);
          console.log(`Then vet it: STARLOG_PRIVATE_FACTS=${path} starlog facts ${pkg}`);
        }
      },
    ),
  );

// `starlog facts policy <package> <verdict>` — set an org allow/deny/flag
// verdict LOCALLY (writes/upserts an L3 rule). The verdict renders in
// `facts <pkg>` only when the package also has an L1/L2 record (AUTH-03).
facts
  .command('policy <package> <verdict>')
  .description('Set an org allow/deny/flag verdict for a package (writes an L3 policy rule)')
  .option('--reason <text>', 'Rationale recorded with the verdict')
  .action(
    action('facts policy failed', async (pkg: string, verdict: string, opts: { reason?: string }) => {
      // Bad verdict throws "Invalid verdict ..." → fail() → exit 1.
      const rule = buildL3Rule(pkg, verdict, opts.reason);

      const envPath = process.env.STARLOG_POLICY;
      const path = envPath ?? DEFAULT_POLICY;
      const existing = readJsonIfPresent(path); // SyntaxError throws → no clobber
      const policy = upsertPolicy(existing as { org?: string; rules?: unknown[] } | null, rule);
      await atomicWrite(path, JSON.stringify(policy, null, 2) + '\n');

      await track(
        'cli_facts_policy',
        { decision: rule.decision, default_path: !envPath },
        { noTelemetry: noTelemetry() },
      );

      console.log(`Set org verdict ${verdict.toUpperCase()} for ${pkg} in ${path}.`);
      if (envPath) {
        console.log(`Your agent already reads this policy (STARLOG_POLICY). Vet it now: starlog facts ${pkg}`);
      } else {
        console.log(`To have your agent apply it, set:  export STARLOG_POLICY=${path}`);
        console.log(`Then vet it: STARLOG_POLICY=${path} starlog facts ${pkg}`);
      }
    }),
  );

// `starlog facts push [file]` — upload the org's private L2 overlays (+ optional
// L3 policy) to the hosted facts API. File shape: { "l2": [L2Overlay...], "policy": L3Policy? }.
facts
  .command('push [file]')
  .description("Push your org's private L2 overlays (+ optional L3 policy) to the hosted facts API (needs STARLOG_API_KEY)")
  .action(action('facts push failed', async (file: string | undefined) => {
    const api = createFactsApiClient();
    if (!api) {
      console.error('facts push needs STARLOG_API_KEY (the org key these facts belong to).');
      process.exit(1);
    }
    const path = file ?? '.starlog/facts.json';
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const msg = e.code === 'ENOENT' ? `no facts file at ${path}` : `cannot read ${path}: ${e.message}`;
      console.error(`facts push: ${msg}`);
      process.exit(1);
    }
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

    const overlays: L2Overlay[] = [];
    for (const entry of Array.isArray(obj.l2) ? obj.l2 : []) {
      const r = L2OverlaySchema.safeParse(entry);
      if (r.success) overlays.push(r.data);
      else console.error('facts push: skipping an invalid L2 overlay (failed schema validation).');
    }

    let pushedPolicy = false;
    if (obj.policy !== undefined) {
      const p = L3PolicySchema.safeParse(obj.policy);
      if (!p.success) {
        console.error('facts push: policy failed schema validation; not pushed.');
      } else {
        const res = await api.pushPolicy(p.data);
        if (!res.ok) {
          console.error(`facts push: policy push failed (${res.error}).`);
          process.exit(1);
        }
        pushedPolicy = true;
      }
    }

    const res = await api.pushL2(overlays);
    if (!res.ok) {
      console.error(`facts push: L2 push failed (${res.error}).`);
      process.exit(1);
    }
    await track('cli_facts_push', { l2_count: overlays.length, policy: pushedPolicy }, { noTelemetry: noTelemetry() });
    console.log(`Pushed ${res.count ?? overlays.length} L2 overlay(s)${pushedPolicy ? ' + org policy' : ''} to the hosted facts API.`);
  }));

// ── corpus: org-private DISCOVERY authoring ───────────────────────────────────
// Mirror of `facts add` for the OTHER private overlay: `facts add` makes an
// internal package vettable (STARLOG_PRIVATE_FACTS); `corpus add` makes it
// DISCOVERABLE (STARLOG_PRIVATE_CORPUS) so `search` surfaces it private-first.
const DEFAULT_PRIVATE_CORPUS = '.starlog/private-corpus.json';

/** commander value parser: "a, b ,c" → ['a','b','c'] (repeatable-free comma list). */
function commaList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const corpus = program
  .command('corpus')
  .description('Author org-private DISCOVERY entries so `search` surfaces your internal packages first');

corpus
  .command('add <package>')
  .description('Make an internal package discoverable — `search` surfaces it (private-first) for a matching capability')
  .requiredOption('--solves <text>', 'One line: what the package does (search matches capability queries against this)')
  .option('--category <cat>', 'Capability category, free-form (e.g. feature-flags, authentication)', 'other')
  .option('--stack <list>', 'Comma-separated stack affinity (e.g. node,next.js)', commaList, [] as string[])
  .option('--best-for <list>', 'Comma-separated use cases', commaList, [] as string[])
  .option('--skip-when <list>', 'Comma-separated anti-patterns', commaList, [] as string[])
  .option('--effort <level>', 'drop-in | easy | moderate | significant | major', 'moderate')
  .option('--ecosystem <eco>', 'npm | pypi | both', 'npm')
  .option('--name <name>', 'Human-readable name (default: the package name)')
  .option('--repo <owner/repo>', 'Source repo (default: none)')
  .option('--license <spdx>', 'License id for the discovery card (default: UNLICENSED)')
  .action(
    action(
      'corpus add failed',
      async (
        pkg: string,
        opts: {
          solves: string;
          category: string;
          stack: string[];
          bestFor: string[];
          skipWhen: string[];
          effort: string;
          ecosystem: string;
          name?: string;
          repo?: string;
          license?: string;
        },
      ) => {
        // A thrown Error here (missing --solves / bad enum) → fail() → stderr + exit 1.
        const manifest = buildManifestFromInput({
          package: pkg,
          solves: opts.solves,
          name: opts.name,
          category: opts.category,
          ecosystem: opts.ecosystem,
          stack: opts.stack,
          bestFor: opts.bestFor,
          skipWhen: opts.skipWhen,
          effort: opts.effort,
          repo: opts.repo,
          license: opts.license,
        });

        const envPath = process.env.STARLOG_PRIVATE_CORPUS;
        const path = envPath ?? DEFAULT_PRIVATE_CORPUS;
        const existing = readJsonIfPresent(path); // SyntaxError throws → no clobber
        const merged = upsertManifestEntry(existing as { manifests?: unknown[] } | null, manifest);
        await atomicWrite(path, JSON.stringify(merged, null, 2) + '\n');

        await track(
          'cli_corpus_add',
          { ecosystem: manifest.ecosystem, default_path: !envPath },
          { noTelemetry: noTelemetry() },
        );

        console.log(`Added ${pkg} to ${path} (discovery).`);
        if (envPath) {
          console.log(`Your agent already discovers via this file (STARLOG_PRIVATE_CORPUS). Find it: starlog search "${manifest.solves}"`);
        } else {
          console.log(`To have search surface it, set:  export STARLOG_PRIVATE_CORPUS=${path}`);
          console.log(`Then discover it: STARLOG_PRIVATE_CORPUS=${path} starlog search "<the capability>"`);
        }
        console.log(`Tip: also vet it — starlog facts add ${pkg} --status active --license ${opts.license ?? '<spdx>'}`);
      },
    ),
  );

program
  .command('telemetry')
  .description('Show or change anonymous usage telemetry (status | enable | disable)')
  .argument('[action]', 'status (default), enable, or disable', 'status')
  .action(action('telemetry command failed', async (action: string) => {
    if (action === 'enable' || action === 'disable') {
      setTelemetryEnabled(action === 'enable');
      console.log(`Telemetry ${action}d.`);
      return;
    }
    if (action !== 'status') {
      console.error(`Unknown action "${action}". Use: status, enable, or disable.`);
      process.exit(1);
    }
    const s = telemetryStatus();
    console.log(`Telemetry: ${s.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Anonymous ID: ${s.anonymousId}`);
    console.log(`Config: ${s.file}`);
    console.log('Opt out anytime: STARLOG_TELEMETRY=0, DO_NOT_TRACK=1, or `starlog telemetry disable`.');
  }));

// Backstop: anything that escapes an action handler still exits cleanly.
process.on('unhandledRejection', (reason) => {
  fail('unexpected error', reason);
});

program.parseAsync().catch((err) => fail('command failed', err));
