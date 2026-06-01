import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

export type AgentKey = 'cursor' | 'copilot' | 'codex';

export interface DetectedAgent {
  detected: boolean;
  reason: string;
}

export type AgentDetection = Record<AgentKey, DetectedAgent>;

export interface DetectOptions {
  /** Override the user's home directory (for tests). */
  home?: string;
  /** Project directory to inspect (defaults to process.cwd()). */
  projectDir?: string;
  /** PATH string to search for CLI binaries (defaults to process.env.PATH). */
  pathEnv?: string;
}

/** True if an executable named `cmd` (or `cmd.exe`/`cmd.cmd`) exists on PATH. */
function onPath(cmd: string, pathEnv: string): boolean {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' ? [cmd, `${cmd}.exe`, `${cmd}.cmd`] : [cmd];
  return dirs.some((d) => candidates.some((c) => existsSync(join(d, c))));
}

/**
 * Detect which AI coding agents (beyond Claude Code) are present, so `init`
 * can configure only the ones the user actually uses. An existing project
 * config for an agent always counts as detected, so re-running init never
 * silently drops an agent the user has already adopted.
 */
export function detectAgents(opts: DetectOptions = {}): AgentDetection {
  const home = opts.home ?? homedir();
  const projectDir = opts.projectDir ?? process.cwd();
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';

  // Cursor
  let cursor: DetectedAgent;
  if (existsSync(join(projectDir, '.cursor'))) {
    cursor = { detected: true, reason: 'project .cursor/ directory' };
  } else if (existsSync(join(home, '.cursor'))) {
    cursor = { detected: true, reason: '~/.cursor present' };
  } else {
    cursor = { detected: false, reason: 'no Cursor install detected' };
  }

  // VS Code Copilot
  let copilot: DetectedAgent;
  if (existsSync(join(projectDir, '.github', 'copilot-instructions.md'))) {
    copilot = { detected: true, reason: 'existing .github/copilot-instructions.md' };
  } else if (onPath('code', pathEnv)) {
    copilot = { detected: true, reason: '`code` on PATH' };
  } else if (existsSync(join(home, '.vscode'))) {
    copilot = { detected: true, reason: '~/.vscode present' };
  } else {
    copilot = { detected: false, reason: 'no VS Code/Copilot detected' };
  }

  // Codex
  let codex: DetectedAgent;
  if (existsSync(join(projectDir, 'AGENTS.md'))) {
    codex = { detected: true, reason: 'existing AGENTS.md' };
  } else if (onPath('codex', pathEnv)) {
    codex = { detected: true, reason: '`codex` on PATH' };
  } else if (existsSync(join(home, '.codex'))) {
    codex = { detected: true, reason: '~/.codex present' };
  } else {
    codex = { detected: false, reason: 'no Codex detected' };
  }

  return { cursor, copilot, codex };
}
