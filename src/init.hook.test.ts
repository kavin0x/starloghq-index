import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateHookScript } from './init.js';

const hookPath = join(mkdtempSync(join(tmpdir(), 'starlog-hook-')), 'hook.js');

beforeAll(() => {
  // l2-facts.json must exist (build/gen step); regenerate to be safe.
  execFileSync('npx', ['tsx', 'scripts/gen-l2-facts.ts'], { stdio: 'inherit' });
  writeFileSync(hookPath, generateHookScript());
});

function runHook(command: string): any {
  const input = JSON.stringify({ tool_input: { command }, cwd: tmpdir() });
  const out = execFileSync(process.execPath, [hookPath], { input, encoding: 'utf8' });
  const jsonLine = out.split('\n').find((l) => l.trim().startsWith('{'));
  return jsonLine ? JSON.parse(jsonLine) : null;
}

describe('install hook surfaces facts (D-05)', () => {
  it('emits hookSpecificOutput with vuln facts for a package with an L2 record', () => {
    const r = runHook('npm install event-stream');
    expect(r.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(r.hookSpecificOutput.additionalContext).toContain('event-stream');
    expect(r.hookSpecificOutput.additionalContext.toLowerCase()).toMatch(/vuln|incident|maintenance/);
  });

  it('emits honest-absence facts for a package with no record', () => {
    const r = runHook('npm install some-pkg-with-no-record-xyz');
    expect(r.hookSpecificOutput.additionalContext).toContain('No facts on file');
  });

  it('produces valid JS (node --check passes)', () => {
    expect(() => execFileSync(process.execPath, ['--check', hookPath])).not.toThrow();
  });
});
