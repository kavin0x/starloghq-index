import type { FactRecord } from './facts-types.js';

/**
 * Public facts corpus served by `starlog_facts`.
 *
 * Every record is a real, sourced package fact (a supply-chain incident, a
 * license trap, an abandonment, or a clean baseline). Accuracy is the #1 risk,
 * so each carries a `source` and a `verified` flag — only `verified: true`
 * records are served (see VERIFIED_FACTS).
 *
 * NOTE (honesty): most of these are well-known incidents the model may already
 * recall. The lift from facts is largest where the model CANNOT recall them —
 * recent CVEs, niche licenses, org-private rulings (STARLOG_PRIVATE_FACTS). This
 * set is the seed; expanding toward less-recallable facts is where value grows.
 */
export const FACT_STUBS: FactRecord[] = [
  // ── Compromised / vulnerable (supply-chain canon) ──────────────────────
  {
    package: 'xz-utils',
    ecosystem: 'system',
    effect_surface:
      'Compression library (liblzma) linked into many binaries, incl. sshd via systemd on some distros — i.e., runs in the auth path of remote login.',
    known_vulns: [
      {
        id: 'CVE-2024-3094',
        severity: 'critical',
        affected: '5.6.0, 5.6.1',
        summary:
          'Malicious backdoor planted in upstream release tarballs by a maintainer; allows remote unauthenticated code execution via crafted SSH. CVSS 10.0.',
      },
    ],
    license: 'GPL-2.0-or-later',
    license_risk: 'copyleft-strong',
    maintenance: 'compromised',
    transitive_risk: 'Pulled transitively by build tooling that links liblzma.',
    source: 'NVD CVE-2024-3094; Andres Freund disclosure 2024-03-29 (oss-security).',
    verified: true,
  },
  {
    package: 'event-stream',
    ecosystem: 'npm',
    effect_surface: 'Toolkit for composing Node streams; widely used utility, runs in-process.',
    known_vulns: [
      {
        id: 'INCIDENT:event-stream-flatmap-2018',
        severity: 'critical',
        affected: '3.3.6 (via flatmap-stream@0.1.1)',
        summary:
          'After a maintainer handoff, a malicious transitive dep (flatmap-stream) was added that targeted Copay bitcoin-wallet builds to exfiltrate credentials.',
      },
    ],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'abandoned',
    transitive_risk: 'The payload lived in the transitive dep flatmap-stream, not event-stream itself.',
    source: 'npm/GitHub advisory 2018; widely documented (Snyk, npm blog).',
    verified: true,
  },
  {
    package: 'ua-parser-js',
    ecosystem: 'npm',
    effect_surface: 'Parses User-Agent strings; pure data, but versions below were trojaned.',
    known_vulns: [
      {
        id: 'INCIDENT:ua-parser-js-2021 (GHSA advisory)',
        severity: 'critical',
        affected: '0.7.29, 0.8.0, 1.0.0',
        summary:
          'Maintainer account hijacked (Oct 2021); these versions shipped a password stealer and cryptominer. Treat installs as account-compromise.',
      },
    ],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'active',
    transitive_risk: 'Frequently a transitive dep — pin away from the three bad versions.',
    source: 'GitHub Security Advisory + CISA alert, Oct 2021.',
    verified: true,
  },
  {
    package: 'node-ipc',
    ecosystem: 'npm',
    effect_surface: 'Local/remote IPC; has filesystem access in the install/runtime context.',
    known_vulns: [
      {
        id: 'CVE-2022-23812',
        severity: 'high',
        affected: '10.1.1, 10.1.2',
        summary:
          'Maintainer "protestware" (peacenotwar): overwrote/wiped files on hosts geolocated to Russia/Belarus. Intentional sabotage by the author.',
      },
    ],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'compromised',
    transitive_risk: 'Pulled transitively by some popular packages at the time.',
    source: 'NVD CVE-2022-23812; widely reported March 2022.',
    verified: true,
  },
  {
    package: 'colors',
    ecosystem: 'npm',
    effect_surface: 'Terminal string coloring; runs in-process at import time.',
    known_vulns: [
      {
        id: 'INCIDENT:colors-faker-sabotage-2022',
        severity: 'medium',
        affected: '1.4.44-liberty-2',
        summary:
          'Maintainer self-sabotage (Jan 2022): introduced an infinite loop printing garbage, breaking any app importing it (DoS).',
      },
    ],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'compromised',
    transitive_risk: 'Extremely common transitive dep.',
    source: 'Widely reported Jan 2022 (Bleeping Computer, GitHub).',
    verified: true,
  },

  // ── Stale / abandoned (prefer-alternative) ─────────────────────────────
  {
    package: 'request',
    ecosystem: 'npm',
    effect_surface: 'HTTP client; makes outbound network requests.',
    known_vulns: [],
    license: 'Apache-2.0',
    license_risk: 'none',
    maintenance: 'deprecated',
    transitive_risk: null,
    source: 'Officially deprecated Feb 2020 (request#3142); no longer maintained.',
    verified: true,
  },
  {
    package: 'moment',
    ecosystem: 'npm',
    effect_surface: 'Date/time parsing & formatting; large bundle, mutable API.',
    known_vulns: [],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'maintenance-only',
    transitive_risk: null,
    source: 'momentjs.com project-status: maintenance mode, not recommended for new projects.',
    verified: true,
  },
  {
    package: 'left-pad',
    ecosystem: 'npm',
    effect_surface: 'Pads a string to a length — trivial; reproducible in 3 lines, no real dependency value.',
    known_vulns: [],
    license: 'WTFPL',
    license_risk: 'none',
    maintenance: 'abandoned',
    transitive_risk: null,
    source: 'Trivial by inspection; 2016 unpublish incident is the cautionary tale.',
    verified: true,
  },

  // ── License trap ───────────────────────────────────────────────────────
  {
    package: 'grafana',
    ecosystem: 'system',
    effect_surface: 'Observability dashboards/server; embedded or forked into products.',
    known_vulns: [],
    license: 'AGPL-3.0-only',
    license_risk: 'copyleft-strong',
    maintenance: 'active',
    transitive_risk:
      'Relicensed Apache-2.0 → AGPL-3.0 at v8 (2021). Forking/modifying a self-hosted, network-served closed-source product can trigger AGPL source-disclosure.',
    source: 'Grafana Labs relicense announcement, 2021 (AGPLv3 from v8).',
    verified: true,
  },

  // ── Clean (control-correct: facts must NOT flip a good default) ─────────
  {
    package: 'chalk',
    ecosystem: 'npm',
    effect_surface: 'Terminal string styling; in-process, no network, no fs.',
    known_vulns: [],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'active',
    transitive_risk: null,
    source: 'Active, permissive, no known advisories (baseline clean control).',
    verified: true,
  },
  {
    package: 'date-fns',
    ecosystem: 'npm',
    effect_surface: 'Immutable date utilities; tree-shakeable, in-process, no network.',
    known_vulns: [],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'active',
    transitive_risk: null,
    source: 'Active, permissive, no known advisories (baseline clean control).',
    verified: true,
  },
];

/** Map of package -> fact record, verified-only, served by `starlog_facts`. */
export const VERIFIED_FACTS: Record<string, FactRecord> = Object.fromEntries(
  FACT_STUBS.filter((f) => f.verified).map((f) => [f.package, f]),
);
