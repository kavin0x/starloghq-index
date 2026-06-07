import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Where Claude Code stores the user-level MCP servers + hooks that `starlog
 *  init` writes. Same file doctor.ts inspects. */
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/**
 * Tri-state wiring check for the `starlog` MCP server in Claude Code's
 * user-level settings.json:
 *
 *  - 'wired'      — settings.json exists and registers `mcpServers.starlog`.
 *  - 'unwired'    — settings.json exists (the user IS a Claude Code user) but has
 *                   no starlog entry. This is the high-signal case worth nudging:
 *                   they run an agent but never `starlog init`'d (exactly the
 *                   first-user failure we observed — install ≠ wired).
 *  - 'unknown'    — no settings.json, or it's unreadable/invalid JSON. Ambiguous
 *                   (maybe not even a Claude Code user, maybe a hermetic test
 *                   env). Stay silent — never nudge on a guess.
 *
 * Deliberately conservative: 'unknown' (not 'unwired') on absence keeps CI/tests
 * hermetic and avoids nagging people who don't use Claude Code at all.
 */
export type McpWiring = 'wired' | 'unwired' | 'unknown';

export async function starlogMcpWiring(settingsPath = SETTINGS_PATH): Promise<McpWiring> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch {
    return 'unknown'; // absent or unreadable — ambiguous
  }
  let settings: { mcpServers?: Record<string, unknown> };
  try {
    settings = JSON.parse(raw);
  } catch {
    return 'unknown'; // malformed — doctor/init will flag it; don't nag here
  }
  const servers = settings.mcpServers;
  if (servers && typeof servers === 'object' && 'starlog' in servers) return 'wired';
  return 'unwired';
}
