import 'dotenv/config';
import { Command } from 'commander';
import { formatTable, formatJSON } from './engine/format.js';
import { KnownCategorySchema } from './manifest/schema.js';
import { runSearch } from './search-service.js';
import { runInit } from './init.js';
import { runDoctor } from './doctor.js';
import { startMcpServer } from './mcp.js';
import { buildComposeDeps, lookupFactView, formatFactView } from './engine/facts.js';
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
  .description('Capability indexing layer for AI coding agents')
  .option('--no-telemetry', 'Disable anonymous usage telemetry for this run');

/** True when the user passed --no-telemetry. */
const noTelemetry = () => program.opts().telemetry === false;

program
  .command('search')
  .description('Search capability manifests for library recommendations')
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
  .option('--api-key <key>', 'Wire a hosted STARLOG_API_KEY into the MCP server (enables experimental hosted ranking for your agent)')
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

program
  .command('facts')
  .description('Look up authoritative facts (CVEs, license, maintenance) for a package')
  .argument('<package>', 'Package name to look up (e.g., "ua-parser-js")')
  .option('--format <type>', 'Output format: json or table', 'table')
  .action(action('facts lookup failed', async (pkg: string, opts: { format: string }) => {
    if (opts.format !== 'json' && opts.format !== 'table') {
      console.error(`Invalid format: ${opts.format}. Use "json" or "table".`);
      process.exit(1);
    }

    // Same layered serve path as the MCP server: public L1+L2, overlaid with
    // private L1+L2 (STARLOG_PRIVATE_FACTS) and an org policy (STARLOG_POLICY).
    const deps = buildComposeDeps();
    const view = lookupFactView(pkg, deps);

    await track(
      'cli_facts',
      {
        hit: view !== null,
        format: opts.format,
        private_overlay: !!process.env.STARLOG_PRIVATE_FACTS,
        policy: !!process.env.STARLOG_POLICY,
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
