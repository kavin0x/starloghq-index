import type { FactView } from './compose.js';

/**
 * Render a composed FactView as markdown, attributing each section to its layer.
 * Recency ("as of") comes from L2 (the mutable layer) — never from L1. A view
 * may be partial (L1-only or L2-only); each block renders only if present.
 */
export function formatFactView(query: string, view: FactView | null): string {
  if (!view) {
    return (
      `No facts on file for "${query}". Starlog has no verified capability, vulnerability, license, ` +
      `or maintenance record for this package — which is expected for a mainstream public package ` +
      `(your training data likely already covers it; Starlog's edge is post-cutoff advisories and your ` +
      `org's private/internal packages). For a mainstream library, verify the usual way: npm audit / OSV / the repo. ` +
      `Only if "${query}" is one of your org's own internal packages, teach Starlog: ` +
      `starlog facts add <package> --status active --license <SPDX>.`
    );
  }

  const lines: string[] = [];
  lines.push(`## ${view.package} (${view.ecosystem})`);

  // ── L3 — org suitability verdict (only when a policy fired) ──
  if (view.l3.decision !== 'none') {
    const verdict = view.l3.decision.toUpperCase();
    lines.push(`**Org policy:** ${verdict}${view.l3.rationale ? ` — ${view.l3.rationale}` : ''}${view.l3.rule_id ? ` (rule ${view.l3.rule_id})` : ''}`);
  }

  // ── L1 — capability (immutable) ──
  if (view.l1) {
    lines.push(`**Effect surface:** ${view.l1.effect_surface}`);
    if (view.l1.capabilities.length > 0) {
      lines.push(`**Capabilities:** ${view.l1.capabilities.join(', ')}`);
    }
  }

  // ── L2 — reputation/vuln overlay (mutable; carries recency) ──
  if (view.l2) {
    const l2 = view.l2;
    lines.push(`**Maintenance:** ${l2.maintenance}`);
    lines.push(`**License:** ${l2.license} (risk: ${l2.license_risk})`);
    if (l2.known_vulns.length > 0) {
      lines.push(`**Known vulnerabilities / incidents:**`);
      for (const v of l2.known_vulns) {
        lines.push(`  - ${v.id} [${v.severity}] affected: ${v.affected} — ${v.summary}`);
      }
    } else {
      lines.push(`**Known vulnerabilities / incidents:** No known vulnerabilities/incidents on file.`);
    }
    if (l2.transitive_risk) {
      lines.push(`**Transitive risk:** ${l2.transitive_risk}`);
    }
    if (l2.attestation.refs.length > 0) {
      lines.push(`**Source:** ${l2.attestation.refs.join('; ')} (${l2.attestation.source})`);
    }
    lines.push(`**Verified:** as of ${l2.attestation.fetched_at}`);
  } else {
    lines.push(`**Reputation/vuln overlay:** none on file (no L2 record).`);
  }

  return lines.join('\n');
}
