import { describe, it, expect } from 'vitest';
import { formatFactView } from './format.js';
import type { FactView } from './compose.js';
import type { L1CapabilityFact } from '@starloghq/facts-schema';
import type { L2Overlay } from '@starloghq/facts-schema';

const L1 = (o: Partial<L1CapabilityFact> = {}): L1CapabilityFact => ({
  package: 'p', ecosystem: 'npm', version_range: null, artifact_sha256: null,
  effect_surface: 'does a thing', capabilities: [],
  provenance: { derived_by: 'hand', source: 's', verified: true }, ...o,
});
const L2 = (o: Partial<L2Overlay> = {}): L2Overlay => ({
  package: 'p', ecosystem: 'npm', known_vulns: [], license: 'MIT', license_risk: 'none',
  maintenance: 'active', transitive_risk: null,
  attestation: { source: 'hand', refs: ['ref'], fetched_at: '2026-06-01' }, ...o,
});
const view = (o: Partial<FactView>): FactView => ({ package: 'p', ecosystem: 'npm', l1: null, l2: null, l3: { decision: 'none' }, ...o });
const lines = (s: string) => s.split('\n');

describe('formatFactView', () => {
  it('miss → honest "No facts on file" naming the package', () => {
    const out = formatFactView('no-such', null);
    expect(out).toContain('No facts on file for "no-such"');
  });

  it('full view: heading, L1 effect surface + capabilities, L2 fields, recency from L2.fetched_at', () => {
    const out = formatFactView('p', view({
      l1: L1({ effect_surface: 'runs in-process', capabilities: ['network', 'fs'] }),
      l2: L2({ maintenance: 'deprecated', license: 'Apache-2.0', license_risk: 'none', attestation: { source: 'hand', refs: ['NVD'], fetched_at: '2026-05-31' } }),
    }));
    expect(out).toContain('## p (npm)');
    expect(out).toContain('**Effect surface:** runs in-process');
    expect(out).toContain('**Capabilities:** network, fs');
    expect(out).toContain('**Maintenance:** deprecated');
    expect(out).toContain('**License:** Apache-2.0 (risk: none)');
    expect(out).toContain('**Verified:** as of 2026-05-31'); // recency comes from L2
  });

  it('lists each vuln in input ORDER (a reorder regression would slip past a presence-only check)', () => {
    const out = formatFactView('p', view({ l2: L2({ known_vulns: [
      { id: 'CVE-A', severity: 'critical', affected: '1', summary: 'a' },
      { id: 'INCIDENT:b', severity: 'high', affected: '2', summary: 'b' },
    ] }) }));
    const rows = lines(out).filter((l) => l.startsWith('  - '));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('CVE-A');
    expect(rows[1]).toContain('INCIDENT:b');
  });

  it('no vulns → the "No known vulnerabilities" sentence', () => {
    expect(formatFactView('p', view({ l2: L2() }))).toContain('No known vulnerabilities/incidents on file.');
  });

  it('transitive_risk renders only when present', () => {
    expect(formatFactView('p', view({ l2: L2({ transitive_risk: 'pulled transitively' }) }))).toContain('**Transitive risk:** pulled transitively');
    expect(formatFactView('p', view({ l2: L2({ transitive_risk: null }) }))).not.toContain('Transitive risk');
  });

  it('L3 verdict renders only when a policy fired', () => {
    expect(formatFactView('p', view({ l1: L1(), l3: { decision: 'deny', rule_id: 'r1', rationale: 'no AGPL' } }))).toContain('**Org policy:** DENY — no AGPL (rule r1)');
    expect(formatFactView('p', view({ l1: L1() }))).not.toContain('Org policy');
  });

  it('partial views: L1-only notes a missing overlay; L2-only renders without an effect surface', () => {
    const l1only = formatFactView('p', view({ l1: L1() }));
    expect(l1only).toContain('**Effect surface:**');
    expect(l1only).toContain('none on file (no L2 record)');

    const l2only = formatFactView('p', view({ l2: L2() }));
    expect(l2only).not.toContain('**Effect surface:**');
    expect(l2only).toContain('**Maintenance:**');
  });
});
