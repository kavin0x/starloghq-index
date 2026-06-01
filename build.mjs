import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts', 'src/mcp.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  banner: { js: '#!/usr/bin/env node' },
  packages: 'external',
});

console.log('Built dist/cli.js and dist/mcp.js');
