import type { L2Overlay } from './l2-overlay.js';

/**
 * Public L2 overlay (hand-authored stand-in for the future OSV/deps.dev pull).
 * Reputation/vuln/license/maintenance only — NO effect_surface (that is L1).
 * Freshness lives in attestation.fetched_at; source is 'hand' until osvL2Source
 * is built (see l2-source.ts). The original citations live in attestation.refs.
 */
const FETCHED = '2026-06-01';

export const L2_OVERLAYS_LIST: L2Overlay[] = [
  {
    package: 'xz-utils',
    ecosystem: 'system',
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
    attestation: { source: 'hand', refs: ['NVD CVE-2024-3094', 'oss-security 2024-03-29 (A. Freund)'], fetched_at: FETCHED },
  },
  {
    package: 'event-stream',
    ecosystem: 'npm',
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
    attestation: { source: 'hand', refs: ['npm/GitHub advisory 2018', 'Snyk, npm blog'], fetched_at: FETCHED },
  },
  {
    package: 'ua-parser-js',
    ecosystem: 'npm',
    known_vulns: [
      {
        id: 'INCIDENT:ua-parser-js-2021',
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
    attestation: { source: 'hand', refs: ['GitHub Security Advisory', 'CISA alert Oct 2021'], fetched_at: FETCHED },
  },
  {
    package: 'node-ipc',
    ecosystem: 'npm',
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
    attestation: { source: 'hand', refs: ['NVD CVE-2022-23812'], fetched_at: FETCHED },
  },
  {
    package: 'colors',
    ecosystem: 'npm',
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
    attestation: { source: 'hand', refs: ['Bleeping Computer, GitHub (Jan 2022)'], fetched_at: FETCHED },
  },
  {
    package: 'request',
    ecosystem: 'npm',
    known_vulns: [],
    license: 'Apache-2.0',
    license_risk: 'none',
    maintenance: 'deprecated',
    transitive_risk: null,
    attestation: { source: 'hand', refs: ['request#3142 (deprecated Feb 2020)'], fetched_at: FETCHED },
  },
  {
    package: 'moment',
    ecosystem: 'npm',
    known_vulns: [],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'maintenance-only',
    transitive_risk: null,
    attestation: { source: 'hand', refs: ['momentjs.com project-status'], fetched_at: FETCHED },
  },
  {
    package: 'left-pad',
    ecosystem: 'npm',
    known_vulns: [],
    license: 'WTFPL',
    license_risk: 'none',
    maintenance: 'abandoned',
    transitive_risk: null,
    attestation: { source: 'hand', refs: ['2016 unpublish incident (cautionary)'], fetched_at: FETCHED },
  },
  {
    package: 'grafana',
    ecosystem: 'system',
    known_vulns: [],
    license: 'AGPL-3.0-only',
    license_risk: 'copyleft-strong',
    maintenance: 'active',
    transitive_risk:
      'Relicensed Apache-2.0 → AGPL-3.0 at v8 (2021). Forking/modifying a self-hosted, network-served closed-source product can trigger AGPL source-disclosure.',
    attestation: { source: 'hand', refs: ['Grafana Labs relicense announcement 2021'], fetched_at: FETCHED },
  },
  {
    package: 'chalk',
    ecosystem: 'npm',
    known_vulns: [],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'active',
    transitive_risk: null,
    attestation: { source: 'hand', refs: ['Active, permissive, no known advisories'], fetched_at: FETCHED },
  },
  {
    package: 'date-fns',
    ecosystem: 'npm',
    known_vulns: [],
    license: 'MIT',
    license_risk: 'none',
    maintenance: 'active',
    transitive_risk: null,
    attestation: { source: 'hand', refs: ['Active, permissive, no known advisories'], fetched_at: FETCHED },
  },
];

/** package -> L2 overlay. */
export const L2_BY_PACKAGE: Record<string, L2Overlay> = Object.fromEntries(
  L2_OVERLAYS_LIST.map((o) => [o.package, o]),
);
