import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, formatFacts } from './mcp.js';
import type { FactRecord } from './engine/facts.js';

/**
 * Surface tests for the MCP facts tool: the markdown FORMATTER (formatFacts)
 * and the MCP wiring (input schema + org-private overlay reaching the tool).
 *
 * Goes BEYOND src/engine/facts.test.ts (engine only) and src/mcp-facts.test.ts
 * (happy-path callTool + verbatim description) — here we pin the exact rendered
 * lines, the present/absent branches, and the schema's required/optional shape.
 */

function makeRecord(overrides: Partial<FactRecord> = {}): FactRecord {
  return {
    package: 'placeholder',
    ecosystem: 'npm',
    effect_surface: 'does a thing',
    known_vulns: [],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'active',
    transitive_risk: null,
    source: 'test fixture',
    verified: true,
    last_verified: '2026-01-01',
    ...overrides,
  };
}

function lines(s: string): string[] {
  return s.split('\n');
}

// ── formatFacts: the markdown renderer ───────────────────────────────────────

describe('formatFacts — record rendering', () => {
  it('renders the heading as "## <package> (<ecosystem>)"', () => {
    const out = formatFacts('whatever', makeRecord({ package: 'xz-utils', ecosystem: 'system' }));
    expect(lines(out)[0]).toBe('## xz-utils (system)');
  });

  it('heading uses the RECORD package/ecosystem, not the pkg argument', () => {
    // pkg arg differs from the record — the heading must follow the record.
    const out = formatFacts('typo-name', makeRecord({ package: 'real-pkg', ecosystem: 'pypi' }));
    expect(out).toContain('## real-pkg (pypi)');
    expect(out).not.toContain('typo-name');
  });

  it('emits the maintenance, license(+risk) and effect-surface lines verbatim', () => {
    const out = formatFacts('p', makeRecord({
      maintenance: 'deprecated',
      license: 'Apache-2.0',
      license_risk: 'copyleft-weak',
      effect_surface: 'makes outbound network requests',
    }));
    expect(out).toContain('**Maintenance:** deprecated');
    expect(out).toContain('**License:** Apache-2.0 (risk: copyleft-weak)');
    expect(out).toContain('**Effect surface:** makes outbound network requests');
  });

  it('lists EACH known vuln as "  - <id> [<severity>] affected: <affected> — <summary>"', () => {
    const out = formatFacts('p', makeRecord({
      known_vulns: [
        { id: 'CVE-2024-3094', severity: 'critical', affected: '5.6.0, 5.6.1', summary: 'backdoor' },
        { id: 'INCIDENT:x-2021', severity: 'high', affected: '0.7.29', summary: 'hijack' },
      ],
    }));
    expect(out).toContain('**Known vulnerabilities / incidents:**');
    expect(out).toContain('  - CVE-2024-3094 [critical] affected: 5.6.0, 5.6.1 — backdoor');
    expect(out).toContain('  - INCIDENT:x-2021 [high] affected: 0.7.29 — hijack');
    // both vuln rows are present (one per vuln)
    const vulnRows = lines(out).filter((l) => l.startsWith('  - '));
    expect(vulnRows.length).toBe(2);
    // ORDER is load-bearing: rows must render in the SAME order as known_vulns
    // (a .reverse()/sort regression would still pass the "both present" check).
    expect(vulnRows[0]).toContain('CVE-2024-3094');
    expect(vulnRows[1]).toContain('INCIDENT:x-2021');
    // the "No known vulnerabilities" sentence must NOT appear when vulns exist
    expect(out).not.toContain('No known vulnerabilities/incidents on file.');
  });

  it('uses the em-dash separator (—), not a hyphen, between affected and summary', () => {
    const out = formatFacts('p', makeRecord({
      known_vulns: [{ id: 'V1', severity: 'low', affected: 'all', summary: 'note' }],
    }));
    expect(out).toContain('affected: all — note');
  });

  it('prints the "No known vulnerabilities/incidents on file." sentence for an empty vuln list', () => {
    const out = formatFacts('p', makeRecord({ known_vulns: [] }));
    expect(out).toContain('**Known vulnerabilities / incidents:** No known vulnerabilities/incidents on file.');
    // no per-vuln rows rendered
    expect(lines(out).some((l) => l.startsWith('  - '))).toBe(false);
  });

  it('emits a "**Transitive risk:**" line when transitive_risk is present', () => {
    const out = formatFacts('p', makeRecord({ transitive_risk: 'pulled by build tooling' }));
    expect(out).toContain('**Transitive risk:** pulled by build tooling');
  });

  it('emits NO "**Transitive risk:**" line when transitive_risk is null', () => {
    const out = formatFacts('p', makeRecord({ transitive_risk: null }));
    expect(out).not.toContain('**Transitive risk:**');
  });

  it('emits NO "**Transitive risk:**" line when transitive_risk is an empty string (falsy)', () => {
    const out = formatFacts('p', makeRecord({ transitive_risk: '' }));
    expect(out).not.toContain('**Transitive risk:**');
  });

  it('always ends with the Source line then the "Verified: as of <date>" line', () => {
    const out = formatFacts('p', makeRecord({
      source: 'NVD advisory',
      last_verified: '2026-06-01',
    }));
    const ls = lines(out);
    expect(ls[ls.length - 2]).toBe('**Source:** NVD advisory');
    expect(ls[ls.length - 1]).toBe('**Verified:** as of 2026-06-01');
  });

  it('places Source/Verified AFTER the transitive-risk line when present', () => {
    const out = formatFacts('p', makeRecord({ transitive_risk: 'risky' }));
    const ls = lines(out);
    const transIdx = ls.findIndex((l) => l.startsWith('**Transitive risk:**'));
    const srcIdx = ls.findIndex((l) => l.startsWith('**Source:**'));
    const verIdx = ls.findIndex((l) => l.startsWith('**Verified:**'));
    expect(transIdx).toBeGreaterThan(-1);
    expect(srcIdx).toBeGreaterThan(transIdx);
    expect(verIdx).toBe(ls.length - 1);
  });
});

describe('formatFacts — miss (null record)', () => {
  it('returns the exact "No facts on file" sentence including the package name', () => {
    expect(formatFacts('no-such-pkg', null)).toBe(
      'No facts on file for "no-such-pkg". Starlog has no verified vulnerability, license, or maintenance record for this package.',
    );
  });

  it('does not emit any markdown heading or label lines on a miss', () => {
    const out = formatFacts('ghost', null);
    expect(out).not.toContain('## ');
    expect(out).not.toContain('**Source:**');
    expect(out).not.toContain('**Verified:**');
  });
});

// ── MCP wiring: input schema + overlay reaching the tool ─────────────────────

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((b) => b.text ?? '').join('\n');
}

async function connectClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'facts-format-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('starlog_facts MCP tool — schema & listing', () => {
  // (Tool-listing + verbatim-description char-lock live in mcp-facts.test.ts;
  // this file focuses on input-schema shape, error paths, and rendering.)

  it("the input schema marks 'package' required and 'context' optional", async () => {
    const client = await connectClient();
    const facts = (await client.listTools()).tools.find((t) => t.name === 'starlog_facts');
    const schema = facts?.inputSchema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(schema?.properties).toHaveProperty('package');
    expect(schema?.properties).toHaveProperty('context');
    expect(schema?.required ?? []).toContain('package');
    expect(schema?.required ?? []).not.toContain('context');
    await client.close();
  });

  it('errors when called WITHOUT package (required arg missing)', async () => {
    const client = await connectClient();
    // The MCP SDK surfaces a schema-validation failure as an error RESULT
    // (isError: true) rather than a rejected promise; the message names the
    // missing required field.
    const result = await client.callTool({ name: 'starlog_facts', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(toolText(result).toLowerCase()).toContain('package');
    await client.close();
  });

  it('accepts an optional context arg alongside package (no error, still resolves the fact)', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'starlog_facts',
      arguments: { package: 'chalk', context: 'Next.js SaaS, needs SSO' },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(toolText(result)).toContain('## chalk (npm)');
    await client.close();
  });
});

describe('starlog_facts MCP tool — org-private overlay reaches the tool', () => {
  let tmpDir: string | null = null;
  const ENV_KEY = 'STARLOG_PRIVATE_FACTS';
  let savedEnv: string | undefined;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('returns a PRIVATE-only fact through the MCP tool when env is set before createServer()', async () => {
    savedEnv = process.env[ENV_KEY];
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-mcp-priv-'));
    const file = join(tmpDir, 'private-facts.json');
    const priv = makeRecord({
      package: '@acme/secret-sauce',
      effect_surface: 'INTERNAL: reads the prod vault',
      maintenance: 'deprecated',
      source: 'ACME security council ruling',
      last_verified: '2026-05-01',
    });
    writeFileSync(file, JSON.stringify([priv]), 'utf-8');

    // The map is loaded ONCE at createServer(); env MUST be set first.
    process.env[ENV_KEY] = file;
    const client = await connectClient();

    const result = await client.callTool({
      name: 'starlog_facts',
      arguments: { package: '@acme/secret-sauce' },
    });
    const text = toolText(result);
    expect(text).toContain('## @acme/secret-sauce (npm)');
    expect(text).toContain('INTERNAL: reads the prod vault');
    expect(text).toContain('**Source:** ACME security council ruling');
    expect(text).toContain('**Verified:** as of 2026-05-01');
    await client.close();
  });

  it('a PRIVATE override wins over the public record for the same package, through the tool', async () => {
    savedEnv = process.env[ENV_KEY];
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-mcp-priv-'));
    const file = join(tmpDir, 'private-facts.json');
    const override = makeRecord({
      package: 'left-pad',
      effect_surface: 'ORG BAN: use internal fork only',
      source: 'ACME internal',
    });
    writeFileSync(file, JSON.stringify([override]), 'utf-8');

    process.env[ENV_KEY] = file;
    const client = await connectClient();

    const text = toolText(
      await client.callTool({ name: 'starlog_facts', arguments: { package: 'left-pad' } }),
    );
    expect(text).toContain('ORG BAN: use internal fork only');
    expect(text).toContain('**Source:** ACME internal');
    await client.close();
  });
});
