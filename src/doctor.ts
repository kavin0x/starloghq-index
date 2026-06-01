import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { loadCorpus } from './engine/corpus.js';

const execFileAsync = promisify(execFile);

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const HOOK_PATH = join(CLAUDE_DIR, 'hooks', 'starlog-pkg-check.js');
const HOOK_FILENAME = 'starlog-pkg-check.js';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  level: Level;
  label: string;
  detail?: string;
}

const SYMBOL: Record<Level, string> = { ok: '[ok]', warn: '[!] ', fail: '[x] ' };

function print(check: Check): void {
  const line = `  ${SYMBOL[check.level]} ${check.label}`;
  console.log(check.detail ? `${line} — ${check.detail}` : line);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read + parse a JSON file, distinguishing "absent" from "present but invalid"
 * so doctor can tell the difference between an unconfigured setup and a corrupt
 * settings.json (which `starlog init` would otherwise choke on).
 */
export type JsonResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string };

export async function readJson(p: string): Promise<JsonResult> {
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', error: (err as Error).message };
  }
  try {
    return { kind: 'ok', data: JSON.parse(raw) };
  } catch (err) {
    return { kind: 'invalid', error: (err as Error).message };
  }
}

// ── Corpus ────────────────────────────────────────────────────────────────

async function checkCorpus(): Promise<Check> {
  try {
    const corpus = await loadCorpus();
    if (corpus.length === 0) {
      return { level: 'fail', label: 'Corpus', detail: 'no manifests found — reinstall starlog' };
    }
    return { level: 'ok', label: 'Corpus', detail: `${corpus.length} manifests loaded` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { level: 'fail', label: 'Corpus', detail: `failed to load (${msg})` };
  }
}

// ── Claude Code MCP server ──────────────────────────────────────────────────

interface McpCommand {
  command: string;
  args: string[];
}

function resolveMcpCommand(settings: Record<string, unknown> | null): McpCommand | null {
  const servers = settings?.mcpServers as Record<string, { command?: string; args?: unknown }> | undefined;
  const entry = servers?.starlog;
  if (entry && typeof entry.command === 'string' && Array.isArray(entry.args)) {
    return { command: entry.command, args: entry.args as string[] };
  }
  return null;
}

/**
 * Spawn the MCP server and run a minimal initialize -> tools/list handshake.
 * Resolves to the list of tool names, or throws on failure/timeout.
 */
function mcpHandshake(cmd: McpCommand, timeoutMs = 8000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('timed out waiting for MCP response'))),
      timeoutMs,
    );

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', () => finish(() => reject(new Error('MCP server exited without responding'))));

    child.stdout.on('data', (d) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) {
            finish(() => resolve(msg.result.tools.map((t: { name: string }) => t.name)));
            return;
          }
        } catch {
          /* partial line */
        }
      }
    });

    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'starlog-doctor', version: '0' } },
    });
    setTimeout(() => {
      if (settled) return;
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }, 150);
  });
}

async function checkMcp(settings: Record<string, unknown> | null): Promise<Check[]> {
  const configured = resolveMcpCommand(settings);
  if (!configured) {
    return [{ level: 'warn', label: 'Claude Code MCP', detail: 'not configured — run `starlog init`' }];
  }

  const checks: Check[] = [
    { level: 'ok', label: 'Claude Code MCP', detail: `${configured.command} ${configured.args.join(' ')}` },
  ];

  try {
    const tools = await mcpHandshake(configured);
    if (tools.includes('starlog_search')) {
      checks.push({ level: 'ok', label: 'MCP handshake', detail: `starlog_search available` });
    } else {
      checks.push({ level: 'fail', label: 'MCP handshake', detail: `server responded but starlog_search missing (tools: ${tools.join(', ') || 'none'})` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ level: 'fail', label: 'MCP handshake', detail: `${msg} — try \`npm run build\` or reinstall` });
  }

  return checks;
}

// ── PostToolUse hook ────────────────────────────────────────────────────────

async function checkHook(settings: Record<string, unknown> | null): Promise<Check[]> {
  const checks: Check[] = [];
  const hookFilePresent = await fileExists(HOOK_PATH);

  const hooks = settings?.hooks as { PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }> } | undefined;
  const registered = (hooks?.PostToolUse ?? []).some((e) =>
    e.hooks?.some((h) => h.command?.includes(HOOK_FILENAME)),
  );

  if (!hookFilePresent && !registered) {
    checks.push({ level: 'warn', label: 'PostToolUse hook', detail: 'not installed — run `starlog init`' });
    return checks;
  }

  if (hookFilePresent) {
    try {
      await execFileAsync(process.execPath, ['--check', HOOK_PATH]);
      checks.push({ level: 'ok', label: 'PostToolUse hook', detail: 'script present and valid' });
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      checks.push({ level: 'fail', label: 'PostToolUse hook', detail: `script has a syntax error (${msg})` });
    }
  } else {
    checks.push({ level: 'fail', label: 'PostToolUse hook', detail: 'registered in settings but script file is missing' });
  }

  if (hookFilePresent && !registered) {
    checks.push({ level: 'warn', label: 'Hook registration', detail: 'script exists but not registered in settings.json' });
  }

  return checks;
}

// ── Project-level agent instructions ────────────────────────────────────────

const STARLOG_MARKER = '<!-- starlog:init -->';

async function fileHasMarker(p: string): Promise<boolean> {
  try {
    return (await readFile(p, 'utf8')).includes(STARLOG_MARKER);
  } catch {
    return false;
  }
}

async function checkProjectAgents(projectDir: string): Promise<Check[]> {
  const cursor = await fileExists(join(projectDir, '.cursor', 'rules', 'starlog.mdc'));
  const copilot = await fileHasMarker(join(projectDir, '.github', 'copilot-instructions.md'));
  const codex = await fileHasMarker(join(projectDir, 'AGENTS.md'));
  const claudeMd = await fileHasMarker(join(projectDir, 'CLAUDE.md'));

  const configured = [
    cursor && 'Cursor',
    copilot && 'Copilot',
    codex && 'Codex',
    claudeMd && 'CLAUDE.md',
  ].filter(Boolean) as string[];

  if (configured.length === 0) {
    return [{ level: 'warn', label: 'Project agents', detail: 'none configured in this directory' }];
  }
  return [{ level: 'ok', label: 'Project agents', detail: configured.join(', ') }];
}

// ── LLM ranking availability (informational) ────────────────────────────────

async function checkRanker(): Promise<Check> {
  const gopath = process.env.GOPATH || join(homedir(), 'go');
  const binary = join(gopath, 'bin', 'siftrank');
  const hasBinary = existsSync(binary);
  const hasKey = Boolean(process.env.OPENROUTER_API_KEY) || Boolean(process.env.STARLOG_API_KEY);

  if (hasKey && (hasBinary || process.env.STARLOG_API_KEY)) {
    const via = process.env.STARLOG_API_KEY ? 'hosted API' : 'siftrank + OPENROUTER_API_KEY';
    return { level: 'ok', label: 'Ranking', detail: `LLM ranking available (${via})` };
  }

  const missing: string[] = [];
  if (!hasBinary) missing.push('siftrank binary');
  if (!process.env.OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');
  return {
    level: 'warn',
    label: 'Ranking',
    detail: `keyword fallback (LLM ranking needs ${missing.join(' + ')}, or set STARLOG_API_KEY)`,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export async function runDoctor(): Promise<number> {
  const projectDir = process.cwd();
  console.log('Starlog doctor — checking your setup...\n');

  const settingsResult = await readJson(SETTINGS_PATH);
  const settings = settingsResult.kind === 'ok' ? settingsResult.data : null;

  const checks: Check[] = [];
  checks.push(await checkCorpus());
  if (settingsResult.kind === 'invalid') {
    checks.push({
      level: 'fail',
      label: 'settings.json',
      detail: `invalid JSON (${settingsResult.error}) — fix or remove ${SETTINGS_PATH}, then run \`starlog init\``,
    });
  }
  checks.push(...(await checkMcp(settings)));
  checks.push(...(await checkHook(settings)));
  checks.push(...(await checkProjectAgents(projectDir)));
  checks.push(await checkRanker());

  for (const c of checks) print(c);

  const failures = checks.filter((c) => c.level === 'fail').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;

  console.log('');
  if (failures > 0) {
    console.log(`Found ${failures} problem${failures === 1 ? '' : 's'}${warnings ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}. See above.`);
    return 1;
  }
  if (warnings > 0) {
    console.log(`All critical checks passed (${warnings} warning${warnings === 1 ? '' : 's'}).`);
    return 0;
  }
  console.log('All checks passed. Starlog is ready.');
  return 0;
}
