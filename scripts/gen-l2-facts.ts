import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { L2_BY_PACKAGE } from '../src/engine/facts/l2-data.js';

// Single source of truth: serialize the curated L2 overlay (src/engine/facts/l2-data.ts)
// to a flat on-disk map the install hook reads. The hook needs only the L2 fields for
// ONE named package (no L1+L2+L3 composition, no zod chain), so it reads this JSON
// instead of bundling the ESM facts engine. NEVER hand-edit the JSON — regenerate it.
const out: Record<string, unknown> = {};
for (const [pkg, o] of Object.entries(L2_BY_PACKAGE)) {
  out[pkg] = {
    package: o.package,
    ecosystem: o.ecosystem,
    known_vulns: o.known_vulns.map((v) => ({
      id: v.id,
      severity: v.severity,
      affected: v.affected,
      summary: v.summary,
    })),
    license: o.license,
    license_risk: o.license_risk,
    maintenance: o.maintenance,
    fetched_at: o.attestation.fetched_at,
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(join(root, 'corpus-free', 'l2-facts.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote corpus-free/l2-facts.json (${Object.keys(out).length} L2 records)`);
