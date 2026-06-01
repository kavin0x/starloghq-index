import 'dotenv/config';
import { Command } from 'commander';
import { formatTable, formatJSON } from './engine/format.js';
import { KnownCategorySchema } from './manifest/schema.js';
import { runSearch } from './search-service.js';
import { runInit } from './init.js';
import { runDoctor } from './doctor.js';
import { getPackageVersion } from './paths.js';

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
  .description('Capability indexing layer for AI coding agents');

program
  .command('search')
  .description('Search capability manifests for library recommendations')
  .argument('<query>', 'Natural language query (e.g., "auth for Next.js")')
  .option('--format <type>', 'Output format: json or table', 'table')
  .option('--category <cat>', 'Filter by category')
  .option('--top-k <n>', 'Number of results', '5')
  .option('--stack <stack>', 'Stack affinity filter (e.g., "next.js")')
  .option('--context <desc>', 'Project context for vs_custom analysis')
  .option('--diversity <lambda>', 'Diversity-relevance tradeoff (0=max diversity, 1=pure relevance, default: no MMR)', parseFloat)
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

    if (results.length === 0) {
      console.error('No matching manifests found.');
      process.exit(0);
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
  .action(action('init failed', async (opts: { project?: boolean; all?: boolean; dryRun?: boolean; yes?: boolean; uninstall?: boolean }) => {
    await runInit(opts);
  }));

program
  .command('doctor')
  .description('Diagnose your Starlog setup (corpus, MCP server, hook, agent configs)')
  .action(action('doctor failed', async () => {
    const code = await runDoctor();
    process.exit(code);
  }));

// Backstop: anything that escapes an action handler still exits cleanly.
process.on('unhandledRejection', (reason) => {
  fail('unexpected error', reason);
});

program.parseAsync().catch((err) => fail('command failed', err));
