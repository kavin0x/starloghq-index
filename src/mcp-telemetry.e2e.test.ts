import { afterEach, describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { NOTICE_VERSION } from './telemetry.js';

/**
 * Proves the MCP-surface telemetry wiring on the REAL wire: spawns the built MCP
 * server, points its telemetry at a LOCAL stand-in for PostHog, calls the tools,
 * and asserts the captured `mcp_facts` / `mcp_search` events. This is the privacy
 * claim's end-to-end proof — that a public package name flows, an org-private one
 * would not, and free-text is scrubbed before it leaves the process.
 *
 * Isolation: a per-test HOME (so ~/.starlog telemetry state never touches the dev
 * box) + STARLOG_TELEMETRY=1 to force-enable + STARLOG_TELEMETRY_HOST to redirect.
 * dist/ is assumed pre-built.
 */
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

interface CapturedEvent { event: string; properties: Record<string, unknown> }

const openClients: Client[] = [];
const tmpDirs: string[] = [];
let httpServer: Server | null = null;

afterEach(async () => {
  for (const c of openClients.splice(0)) { try { await c.close(); } catch { /* already gone */ } }
  if (httpServer) { await new Promise<void>((r) => httpServer!.close(() => r())); httpServer = null; }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A local PostHog `/capture/` stand-in that records every event body. */
async function captureServer(): Promise<{ url: string; events: CapturedEvent[]; waitFor: (name: string) => Promise<CapturedEvent> }> {
  const events: CapturedEvent[] = [];
  const waiters: { name: string; resolve: (e: CapturedEvent) => void }[] = [];
  httpServer = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const json = JSON.parse(body) as CapturedEvent;
        events.push(json);
        for (const w of waiters.splice(0).filter((w) => w.name === json.event ? (w.resolve(json), false) : true)) waiters.push(w);
      } catch { /* ignore non-JSON */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => httpServer!.listen(0, '127.0.0.1', () => r()));
  const port = (httpServer!.address() as { port: number }).port;
  const waitFor = (name: string) =>
    new Promise<CapturedEvent>((resolve) => {
      const found = events.find((e) => e.event === name);
      if (found) return resolve(found);
      waiters.push({ name, resolve });
    });
  return { url: `http://127.0.0.1:${port}`, events, waitFor };
}

async function connectMcp(telemetryHost: string, opts: { acknowledged: boolean }): Promise<Client> {
  const home = mkdtempSync(join(tmpdir(), 'mcp-tel-home-'));
  tmpDirs.push(home);
  // The MCP surface only captures once the CURRENT disclosure was acknowledged via
  // a human-visible CLI run. Simulate that by seeding the state file at the current
  // NOTICE_VERSION; an unacknowledged run (no seed → version 0) must capture nothing.
  if (opts.acknowledged) {
    mkdirSync(join(home, '.starlog'), { recursive: true });
    writeFileSync(join(home, '.starlog', 'telemetry.json'), JSON.stringify({ anonymousId: 'e2e-ack', enabled: true, noticeVersion: NOTICE_VERSION }));
  }
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.STARLOG_API_KEY;
  delete base.STARLOG_PRIVATE_FACTS;
  delete base.STARLOG_POLICY;
  delete base.CI;
  delete base.DO_NOT_TRACK;
  delete base.VITEST;
  delete base.NODE_ENV;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
  env.HOME = home;
  env.STARLOG_NO_NUDGE = '1';
  env.STARLOG_TELEMETRY = '1'; // force-enable despite any ambient guard
  env.STARLOG_TELEMETRY_HOST = telemetryHost; // redirect the capture POST to us

  const transport = new StdioClientTransport({ command: 'node', args: [CLI, 'mcp'], cwd: REPO, env });
  const client = new Client({ name: 'mcp-telemetry-e2e', version: '1.0.0' });
  openClients.push(client);
  await client.connect(transport);
  return client;
}

describe('MCP telemetry wiring (e2e, real wire)', () => {
  it('a starlog_facts call emits mcp_facts with the package name + hit (when acknowledged)', async () => {
    const sink = await captureServer();
    const client = await connectMcp(sink.url, { acknowledged: true });
    await client.callTool({ name: 'starlog_facts', arguments: { package: 'ua-parser-js' } });

    const ev = await sink.waitFor('mcp_facts');
    expect(ev.properties.package).toBe('ua-parser-js'); // public name flows
    expect(ev.properties.hit).toBe(true);
    expect(ev.properties.private).toBe(false);
    expect(ev.properties.$lib).toBe('starlog-cli'); // went through the shared telemetry pipe
  }, 20_000);

  it('a starlog_search call emits mcp_search with the query SCRUBBED of secrets', async () => {
    const sink = await captureServer();
    const client = await connectMcp(sink.url, { acknowledged: true });
    await client.callTool({
      name: 'starlog_search',
      arguments: { query: 'queue for token ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    });

    const ev = await sink.waitFor('mcp_search');
    expect(ev.properties.query).toBe('queue for token ‹redacted›'); // secret never leaves the box
    expect(typeof ev.properties.result_count).toBe('number');
  }, 20_000);

  it('captures NOTHING until the disclosure is acknowledged (no silent MCP capture)', async () => {
    const sink = await captureServer();
    const client = await connectMcp(sink.url, { acknowledged: false }); // never saw the notice
    await client.callTool({ name: 'starlog_facts', arguments: { package: 'ua-parser-js' } });

    // Give the (suppressed) fire-and-forget telemetry ample time to NOT fire.
    await new Promise((r) => setTimeout(r, 1500));
    expect(sink.events).toEqual([]); // the gate held — no event left the process
  }, 20_000);
});
