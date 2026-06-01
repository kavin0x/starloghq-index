import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CapabilityManifest } from '../manifest/schema.js';
import type { SiftrankFn, SiftrankResult, LlmFn } from './types.js';

const execFileAsync = promisify(execFile);

// Resolve siftrank binary -- check GOPATH/bin first, then fall back to PATH
function getSiftrankPath(): string {
  const gopath = process.env.GOPATH || join(process.env.HOME || '', 'go');
  return join(gopath, 'bin', 'siftrank');
}

/**
 * Create a SiftrankFn that spawns the siftrank Go binary.
 *
 * Maps OPENROUTER_API_KEY to OPENAI_API_KEY and uses --base-url
 * to route through OpenRouter. Uses anthropic/claude-haiku-4.5 for
 * cost efficiency.
 */
export function createSiftrankFn(): SiftrankFn {
  return async (manifests: CapabilityManifest[], query: string): Promise<SiftrankResult[]> => {
    if (manifests.length === 0) return [];

    const tmpFile = join(tmpdir(), `siftrank-${randomUUID()}.json`);

    try {
      // Write manifests to temp file
      await writeFile(tmpFile, JSON.stringify(manifests), 'utf-8');

      const args = [
        '--file', tmpFile,
        '--json',
        '--prompt', query,
        '--model', 'anthropic/claude-haiku-4.5',
        '--base-url', 'https://openrouter.ai/api/v1',
        '--batch-size', '10',
        '--template', '{{ .name }}: {{ .solves }} | Best for: {{ range .best_for }}{{ . }}, {{ end }}',
      ];

      const env = {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENROUTER_API_KEY,
      };

      const { stdout } = await execFileAsync(getSiftrankPath(), args, {
        env,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      const results: SiftrankResult[] = JSON.parse(stdout);
      return results.sort((a, b) => a.rank - b.rank);
    } finally {
      // Clean up temp file
      await unlink(tmpFile).catch(() => {});
    }
  };
}

// Keyword fallback ranker -- used when the siftrank binary / OPENROUTER_API_KEY
// is unavailable. Matches query terms against name + solves + best_for + stack.
const keywordSiftrank: SiftrankFn = async (manifests, query) => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return manifests.map((m, i) => {
    const text = [m.name, m.solves, ...m.best_for, ...m.stack_affinity].join(' ').toLowerCase();
    const score = terms.reduce((s, t) => s + (text.includes(t) ? 25 : 0), 0);
    return { key: m.id, value: m.name, object: {} as Record<string, unknown>, score: Math.min(score, 100), exposure: 1, rank: i };
  });
};

// Emit the fallback notice at most once per process. stderr only -- stdout
// carries the CLI's search output and the MCP stdio protocol.
let warnedFallback = false;

/**
 * Wrap the real (LLM-backed) siftrank so a missing binary or API key degrades
 * to keyword ranking instead of crashing. search() does not catch siftrank
 * errors, so the resilience lives here. Shared by the `starlog search` CLI
 * command and the MCP server so both behave identically.
 */
export function createResilientSiftrankFn(): SiftrankFn {
  const real = createSiftrankFn();
  return async (manifests, query) => {
    try {
      return await real(manifests, query);
    } catch (err) {
      if (!warnedFallback) {
        warnedFallback = true;
        // execFile errors embed the subprocess's full stderr; keep only the
        // first line so a verbose ranker log can't flood our stderr.
        const raw = err instanceof Error ? err.message : String(err);
        const msg = raw.split('\n')[0].slice(0, 200);
        console.error(
          `[starlog] LLM ranking unavailable (${msg}); falling back to keyword ranking. ` +
          `Install the siftrank binary and set OPENROUTER_API_KEY for ranked results.`,
        );
      }
      return keywordSiftrank(manifests, query);
    }
  };
}

/**
 * Create an LlmFn that uses the Anthropic SDK via OpenRouter.
 * Uses anthropic/claude-haiku-4.5 for cost efficiency.
 */
export function createLlmFn(): LlmFn {
  let clientPromise: Promise<any> | null = null;

  function getClient() {
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((mod) => {
        const Anthropic = mod.default;
        return new Anthropic({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: 'https://openrouter.ai/api',
        });
      }).catch(() => {
        throw new Error('LLM enrichment requires @anthropic-ai/sdk. Run from source repo or install it separately.');
      });
    }
    return clientPromise;
  }

  return async (prompt: string, system?: string): Promise<string> => {
    const client = await getClient();
    const response = await client.messages.create({
      model: 'anthropic/claude-haiku-4.5',
      max_tokens: 1024,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    if (block.type === 'text') {
      return block.text;
    }
    return '';
  };
}
