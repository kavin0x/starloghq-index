import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, FACTS_TOOL_DESCRIPTION } from './mcp.js';

/**
 * Integration test: the shipped MCP server registers BOTH starlog_search
 * (unchanged) and starlog_facts, and starlog_facts is callable over the public
 * MCP client API (InMemoryTransport — no stdio, no API key, no internals).
 */

// Literal copy of the validated willingness-benchmark description. This guards
// the exported const itself against an accidental edit — if the const drifts,
// this character-for-character comparison fails.
const VERBATIM_WILLINGNESS_DESCRIPTION =
  'Look up authoritative facts about a software package: known vulnerabilities/CVEs and supply-chain incidents, SPDX license and license risk, maintenance status (active/deprecated/abandoned/compromised), and what the package can do (effect surface). Use it to vet a package before recommending it.';

async function connectClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'facts-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((b) => b.text ?? '').join('\n');
}

describe('starlog MCP server — facts tool', () => {
  it('the exported const equals the verbatim willingness string', () => {
    expect(FACTS_TOOL_DESCRIPTION).toBe(VERBATIM_WILLINGNESS_DESCRIPTION);
  });

  it('registers BOTH starlog_search and starlog_facts', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('starlog_search');
    expect(names).toContain('starlog_facts');
    await client.close();
  });

  it('starlog_facts reports the verbatim willingness description', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const facts = tools.find((t) => t.name === 'starlog_facts');
    expect(facts?.description).toBe(VERBATIM_WILLINGNESS_DESCRIPTION);
    await client.close();
  });

  it('returns verified facts (CVE/incident id + compromised signal) for a known package', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'starlog_facts', arguments: { package: 'ua-parser-js' } });
    const text = toolText(result);
    expect(text).toContain('ua-parser-js');
    expect(text).toContain('INCIDENT:ua-parser-js-2021');
    // recency is surfaced as a dated "as of" line
    expect(text).toMatch(/as of \d{4}-\d{2}-\d{2}/);
    await client.close();
  });

  it('returns a clear "no facts on file" result for an unknown package', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'starlog_facts', arguments: { package: 'no-such-pkg' } });
    const text = toolText(result).toLowerCase();
    expect(text).toContain('no facts on file');
    await client.close();
  });
});
