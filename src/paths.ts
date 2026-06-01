import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the package root directory from the current module location.
 * Works both in development (tsx src/cli.ts) and after global install (dist/cli.js).
 * In dev: __dirname = src/, root = src/.. = project root
 * In dist: __dirname = dist/, root = dist/.. = package root
 */
export function getPackageRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..');
}

/**
 * The package version, read from package.json at runtime — the single source of
 * truth so `npm version` is all a release needs (no hardcoded strings to drift).
 */
export function getPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(getPackageRoot(), 'package.json'), 'utf8'));
  return pkg.version as string;
}
