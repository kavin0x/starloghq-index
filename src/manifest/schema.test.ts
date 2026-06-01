import { describe, it, expect } from 'vitest';
import {
  CategorySchema,
  IntegrationEffortSchema,
  HostedAlternativeSchema,
  HealthSchema,
  QualitySchema,
  CapabilityManifestSchema,
  QueryResultSchema,
} from './schema.js';

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

function makeValidManifest() {
  return {
    id: 'clerk',
    name: 'Clerk',
    repo: 'clerkinc/clerk-sdk-node',
    ecosystem: 'npm',
    category: 'authentication',
    solves: 'Managed authentication with pre-built UI components for React and Next.js.',
    stack_affinity: ['next.js', 'react'],
    integration_effort: 'easy',
    best_for: ['SaaS apps', 'rapid prototyping', 'teams wanting hosted auth'],
    skip_when: ['self-hosted required', 'air-gapped environment', 'custom auth flow'],
    hosted_alternative: null,
    alternative_ids: ['nextauth', 'passport'],
    health: {
      stars: 8000,
      weekly_downloads: 200000,
      last_commit: '2026-01-15',
      contributors: 45,
      license: 'MIT',
      open_issues: 12,
    },
    quality: {
      has_tests: true,
      has_docs: true,
      has_types: true,
      maintenance_status: 'active',
    },
  };
}

// ---------------------------------------------------------------------------
// CategorySchema
// ---------------------------------------------------------------------------

describe('CategorySchema', () => {
  const valid = [
    'authentication',
    'feature-flags',
    'caching',
    'realtime',
    'background-jobs',
    'email',
    'orm-database',
  ] as const;

  it.each(valid)('accepts valid category: %s', (cat) => {
    expect(CategorySchema.safeParse(cat).success).toBe(true);
  });

  it('accepts any string as dynamic category', () => {
    expect(CategorySchema.safeParse('logging').success).toBe(true);
  });

  it('accepts non-empty string', () => {
    expect(CategorySchema.safeParse('custom-category').success).toBe(true);
  });

  it('rejects numeric value', () => {
    expect(CategorySchema.safeParse(42).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IntegrationEffortSchema
// ---------------------------------------------------------------------------

describe('IntegrationEffortSchema', () => {
  const valid = ['drop-in', 'easy', 'moderate', 'significant', 'major'] as const;

  it.each(valid)('accepts valid effort level: %s', (level) => {
    expect(IntegrationEffortSchema.safeParse(level).success).toBe(true);
  });

  it('rejects unknown effort level', () => {
    expect(IntegrationEffortSchema.safeParse('trivial').success).toBe(false);
  });

  it('rejects null', () => {
    expect(IntegrationEffortSchema.safeParse(null).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HostedAlternativeSchema
// ---------------------------------------------------------------------------

describe('HostedAlternativeSchema', () => {
  it('accepts a valid hosted alternative object', () => {
    const result = HostedAlternativeSchema.safeParse({
      name: 'Clerk',
      manifest_id: 'clerk',
      pricing_summary: 'Free up to 10k MAU, then $25/mo',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(
      HostedAlternativeSchema.safeParse({
        manifest_id: 'clerk',
        pricing_summary: 'Free tier available',
      }).success,
    ).toBe(false);
  });

  it('rejects missing pricing_summary', () => {
    expect(
      HostedAlternativeSchema.safeParse({
        name: 'Clerk',
        manifest_id: 'clerk',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HealthSchema
// ---------------------------------------------------------------------------

describe('HealthSchema', () => {
  it('accepts valid health object with all fields', () => {
    const result = HealthSchema.safeParse({
      stars: 5000,
      weekly_downloads: 100000,
      last_commit: '2026-01-01',
      contributors: 20,
      license: 'MIT',
      open_issues: 8,
    });
    expect(result.success).toBe(true);
  });

  it('accepts health object without optional weekly_downloads', () => {
    const result = HealthSchema.safeParse({
      stars: 500,
      last_commit: '2025-06-01',
      contributors: 3,
      license: 'Apache-2.0',
      open_issues: 2,
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-numeric stars', () => {
    const result = HealthSchema.safeParse({
      stars: 'many',
      last_commit: '2025-06-01',
      contributors: 3,
      license: 'MIT',
      open_issues: 2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing last_commit', () => {
    const result = HealthSchema.safeParse({
      stars: 1000,
      contributors: 5,
      license: 'MIT',
      open_issues: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QualitySchema
// ---------------------------------------------------------------------------

describe('QualitySchema', () => {
  it('accepts valid quality object', () => {
    const result = QualitySchema.safeParse({
      has_tests: true,
      has_docs: false,
      has_types: true,
      maintenance_status: 'maintained',
    });
    expect(result.success).toBe(true);
  });

  it.each(['active', 'maintained', 'slowing', 'archived'] as const)(
    'accepts maintenance_status: %s',
    (status) => {
      const result = QualitySchema.safeParse({
        has_tests: true,
        has_docs: true,
        has_types: true,
        maintenance_status: status,
      });
      expect(result.success).toBe(true);
    },
  );

  it('rejects invalid maintenance_status', () => {
    const result = QualitySchema.safeParse({
      has_tests: true,
      has_docs: true,
      has_types: true,
      maintenance_status: 'deprecated',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean has_tests', () => {
    const result = QualitySchema.safeParse({
      has_tests: 'yes',
      has_docs: true,
      has_types: true,
      maintenance_status: 'active',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CapabilityManifestSchema
// ---------------------------------------------------------------------------

describe('CapabilityManifestSchema', () => {
  it('accepts a fully valid manifest', () => {
    const result = CapabilityManifestSchema.safeParse(makeValidManifest());
    expect(result.success).toBe(true);
  });

  it('accepts repo as null (DIY manifest)', () => {
    const manifest = { ...makeValidManifest(), repo: null };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('accepts hosted_alternative as a structured object', () => {
    const manifest = {
      ...makeValidManifest(),
      hosted_alternative: {
        name: 'Clerk',
        manifest_id: 'clerk',
        pricing_summary: 'Free up to 10k MAU',
      },
    };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('accepts weekly_downloads as optional in health', () => {
    const manifest = makeValidManifest();
    delete (manifest.health as Record<string, unknown>).weekly_downloads;
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('accepts all valid ecosystem values', () => {
    for (const ecosystem of ['npm', 'pypi', 'both'] as const) {
      const manifest = { ...makeValidManifest(), ecosystem };
      expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(true);
    }
  });

  it('accepts dynamic category (non-enum string)', () => {
    const manifest = { ...makeValidManifest(), category: 'logging' };
    const result = CapabilityManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects invalid integration_effort', () => {
    const manifest = { ...makeValidManifest(), integration_effort: 'trivial' };
    const result = CapabilityManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects invalid ecosystem', () => {
    const manifest = { ...makeValidManifest(), ecosystem: 'cargo' };
    const result = CapabilityManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects missing id field', () => {
    const manifest = makeValidManifest();
    delete (manifest as Record<string, unknown>).id;
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects missing name field', () => {
    const manifest = makeValidManifest();
    delete (manifest as Record<string, unknown>).name;
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects stack_affinity as non-array', () => {
    const manifest = { ...makeValidManifest(), stack_affinity: 'next.js' };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects best_for as non-array', () => {
    const manifest = { ...makeValidManifest(), best_for: 'all apps' };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects null health (required object)', () => {
    const manifest = { ...makeValidManifest(), health: null };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('parses and returns typed data for a valid manifest', () => {
    const result = CapabilityManifestSchema.safeParse(makeValidManifest());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('clerk');
    expect(result.data.category).toBe('authentication');
    expect(result.data.ecosystem).toBe('npm');
    expect(result.data.health.stars).toBe(8000);
    expect(result.data.quality.maintenance_status).toBe('active');
  });

  it('rejects alternative_ids as non-array', () => {
    const manifest = { ...makeValidManifest(), alternative_ids: 'nextauth' };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QueryResultSchema
// ---------------------------------------------------------------------------

describe('QueryResultSchema', () => {
  function makeValidQueryResult() {
    return {
      manifest: makeValidManifest(),
      relevance_score: 87.5,
      context_fit: 'Fits perfectly for a Next.js SaaS project needing hosted auth.',
      vs_custom: 'Saves 3-4 weeks of custom auth development.',
      tradeoffs: ['Vendor lock-in', 'Monthly cost after free tier'],
    };
  }

  it('accepts a valid QueryResult', () => {
    expect(QueryResultSchema.safeParse(makeValidQueryResult()).success).toBe(true);
  });

  it('accepts empty string for vs_custom (LLM skipped)', () => {
    const qr = { ...makeValidQueryResult(), vs_custom: '' };
    expect(QueryResultSchema.safeParse(qr).success).toBe(true);
  });

  it('accepts empty array for tradeoffs', () => {
    const qr = { ...makeValidQueryResult(), tradeoffs: [] };
    expect(QueryResultSchema.safeParse(qr).success).toBe(true);
  });

  it('accepts relevance_score of 0', () => {
    const qr = { ...makeValidQueryResult(), relevance_score: 0 };
    expect(QueryResultSchema.safeParse(qr).success).toBe(true);
  });

  it('accepts relevance_score of 100', () => {
    const qr = { ...makeValidQueryResult(), relevance_score: 100 };
    expect(QueryResultSchema.safeParse(qr).success).toBe(true);
  });

  it('rejects missing manifest', () => {
    const qr = makeValidQueryResult();
    delete (qr as Record<string, unknown>).manifest;
    expect(QueryResultSchema.safeParse(qr).success).toBe(false);
  });

  it('rejects non-numeric relevance_score', () => {
    const qr = { ...makeValidQueryResult(), relevance_score: 'high' };
    expect(QueryResultSchema.safeParse(qr).success).toBe(false);
  });

  it('rejects tradeoffs as non-array', () => {
    const qr = { ...makeValidQueryResult(), tradeoffs: 'some tradeoff' };
    expect(QueryResultSchema.safeParse(qr).success).toBe(false);
  });

  it('accepts dynamic category in nested manifest inside QueryResult', () => {
    const qr = {
      ...makeValidQueryResult(),
      manifest: { ...makeValidManifest(), category: 'not-a-category' },
    };
    expect(QueryResultSchema.safeParse(qr).success).toBe(true);
  });
});
