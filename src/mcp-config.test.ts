import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { starlogMcpWiring } from './mcp-config.js';

describe('starlogMcpWiring', () => {
  let dir: string | null = null;
  const settings = (obj: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-mcpcfg-'));
    const p = join(dir, 'settings.json');
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    return p;
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("'wired' when settings.json registers mcpServers.starlog", async () => {
    const p = settings({ mcpServers: { starlog: { command: 'node', args: ['x'] } } });
    expect(await starlogMcpWiring(p)).toBe('wired');
  });

  it("'unwired' when settings.json exists with other servers but no starlog", async () => {
    const p = settings({ mcpServers: { somethingElse: {} } });
    expect(await starlogMcpWiring(p)).toBe('unwired');
  });

  it("'unwired' when settings.json exists with no mcpServers at all", async () => {
    const p = settings({ hooks: {} });
    expect(await starlogMcpWiring(p)).toBe('unwired');
  });

  it("'unknown' when settings.json is absent (ambiguous — never nudge on a guess)", async () => {
    expect(await starlogMcpWiring(join(tmpdir(), `nope-${process.pid}`, 'settings.json'))).toBe('unknown');
  });

  it("'unknown' when settings.json is malformed JSON", async () => {
    const p = settings('{ not valid json ');
    expect(await starlogMcpWiring(p)).toBe('unknown');
  });
});
