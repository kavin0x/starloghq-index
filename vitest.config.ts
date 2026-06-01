import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep vitest's defaults (node_modules, dist, etc.) and also ignore
    // Claude Code agent worktrees, which contain their own divergent copies
    // of src/__tests__ and would otherwise pollute the run.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
