import type { L1CapabilityFact } from '@starloghq/facts-schema';

/**
 * Public L1 capability facts (hand-authored stand-in for the future deterministic
 * analyzer). Capability only — what the code can DO. NO vuln/license/maintenance
 * here (that is L2) and NO freshness date (L1 is immutable).
 *
 * Order is load-bearing: the name resolver iterates these keys first-match-wins,
 * so this array preserves the original corpus order (the eval baseline encodes it).
 */
export const L1_FACTS: L1CapabilityFact[] = [
  {
    package: 'xz-utils',
    ecosystem: 'system',
    version_range: null,
    artifact_sha256: null,
    effect_surface:
      'Compression library (liblzma) linked into many binaries, incl. sshd via systemd on some distros — i.e., can run in the auth path of remote login.',
    capabilities: ['compression', 'native-code', 'auth-path'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'event-stream',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Toolkit for composing Node streams; widely used utility, runs in-process.',
    capabilities: ['streams'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'ua-parser-js',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Parses User-Agent strings; pure data transformation, in-process.',
    capabilities: ['parsing'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'node-ipc',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Local/remote IPC; has filesystem access in the install/runtime context.',
    capabilities: ['ipc', 'filesystem', 'network'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'colors',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Terminal string coloring; runs in-process at import time.',
    capabilities: ['terminal'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'request',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'HTTP client; makes outbound network requests.',
    capabilities: ['network', 'http-client'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'moment',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Date/time parsing & formatting; large bundle, mutable API, in-process.',
    capabilities: ['datetime'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'left-pad',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Pads a string to a length — trivial; reproducible in 3 lines, no real dependency value.',
    capabilities: ['string-util'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'grafana',
    ecosystem: 'system',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Observability dashboards/server; embedded or forked into products; serves over the network.',
    capabilities: ['observability', 'server', 'network'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'chalk',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Terminal string styling; in-process, no network, no fs.',
    capabilities: ['terminal'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
  {
    package: 'date-fns',
    ecosystem: 'npm',
    version_range: null,
    artifact_sha256: null,
    effect_surface: 'Immutable date utilities; tree-shakeable, in-process, no network.',
    capabilities: ['datetime'],
    provenance: { derived_by: 'hand', source: 'hand-authored capability observation (pre-analyzer stub)', verified: true },
  },
];

/** package -> L1 fact, verified-only, in corpus order. */
export const L1_BY_PACKAGE: Record<string, L1CapabilityFact> = Object.fromEntries(
  L1_FACTS.filter((f) => f.provenance.verified).map((f) => [f.package, f]),
);
