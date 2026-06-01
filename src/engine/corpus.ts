import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CapabilityManifestSchema, type CapabilityManifest, type Category } from '../manifest/schema.js';
import { getPackageRoot } from '../paths.js';

/**
 * Load all capability manifests from the corpus directory.
 * Corpus structure: corpus/{category}/{library}.json
 *
 * @param corpusDir - Root corpus directory (defaults to package root /corpus, falls back to /corpus-free)
 * @param category - Optional category filter (exact match)
 * @returns Validated CapabilityManifest array
 */
export async function loadCorpus(
  corpusDir?: string,
  category?: Category,
): Promise<CapabilityManifest[]> {
  // Local loading: try full corpus first, fall back to bundled free tier
  let root = corpusDir;
  if (!root) {
    const pkgRoot = getPackageRoot();
    const fullPath = join(pkgRoot, 'corpus');
    try {
      await readdir(fullPath);
      root = fullPath;
    } catch {
      root = join(pkgRoot, 'corpus-free');
    }
  }

  const manifests: CapabilityManifest[] = [];

  // Read category subdirectories
  const entries = await readdir(root, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory());

  for (const subdir of subdirs) {
    const subdirPath = join(root, subdir.name);
    const files = await readdir(subdirPath);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    for (const file of jsonFiles) {
      const filePath = join(subdirPath, file);
      // Per-file isolation: one unreadable/syntactically-broken/schema-invalid
      // manifest must not abort the whole corpus load. Skip it and warn on
      // stderr (stdout is reserved for CLI output and the MCP stdio protocol).
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const result = CapabilityManifestSchema.safeParse(parsed);
        if (result.success) {
          manifests.push(result.data);
        } else {
          const summary = result.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
          console.error(`[starlog] skipping invalid manifest ${filePath}: ${summary}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[starlog] skipping unreadable manifest ${filePath}: ${msg}`);
      }
    }
  }

  // Filter by category if specified
  if (category) {
    return manifests.filter((m) => m.category === category);
  }

  return manifests;
}
