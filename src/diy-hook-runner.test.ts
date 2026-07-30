import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractWritePayload, handleDiyPreToolUse } from './diy-hook-runner.js';
import * as adviseService from './advise-service.js';

const DIY_AUTH = `import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!);
}
export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}`;

describe('extractWritePayload', () => {
  it('extracts Write tool content', () => {
    const r = extractWritePayload('Write', { file_path: 'src/auth.ts', content: DIY_AUTH });
    expect(r).toEqual({ relPath: 'src/auth.ts', content: DIY_AUTH });
  });

  it('extracts Edit tool new_string', () => {
    const r = extractWritePayload('Edit', { path: 'src/auth.ts', new_string: DIY_AUTH });
    expect(r?.relPath).toBe('src/auth.ts');
  });

  it('ignores non-write tools', () => {
    expect(extractWritePayload('Bash', { command: 'npm install x' })).toBeNull();
  });

  it('ignores non-source files', () => {
    expect(extractWritePayload('Write', { file_path: 'README.md', content: DIY_AUTH })).toBeNull();
  });
});

describe('handleDiyPreToolUse', () => {
  let projectDir: string;
  let homeDir: string;
  const adviseSpy = vi.spyOn(adviseService, 'runAdvise');

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'starlog-diy-hook-'));
    homeDir = mkdtempSync(join(tmpdir(), 'starlog-diy-home-'));
    process.env.HOME = homeDir;
    delete process.env.STARLOG_API_KEY;
    adviseSpy.mockReset();
    adviseSpy.mockResolvedValue({
      action: 'migrate',
      category: 'authentication',
      rationale: 'Safe alternatives exist',
      candidates: [
        {
          manifest_id: 'clerk',
          name: 'Clerk',
          package_name: '@clerk/nextjs',
          relevance_score: 80,
          facts_available: true,
        },
      ],
      playbook_steps: ['Vet with starlog_facts'],
    });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('emits advisory context for high-confidence DIY auth writes', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await handleDiyPreToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
      cwd: projectDir,
    });

    console.log = origLog;
    expect(adviseSpy).toHaveBeenCalled();
    const line = logs.find((l) => l.includes('hookSpecificOutput'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[Starlog DIY]');
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('stays silent for weak DIY signals', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await handleDiyPreToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: join(projectDir, 'notes.txt.ts'),
        content: '// JWT mentioned in a comment only',
      },
      cwd: projectDir,
    });

    console.log = origLog;
    expect(logs.length).toBe(0);
    expect(adviseSpy).not.toHaveBeenCalled();
  });

  it('emits positive ack when using a known auth library', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await handleDiyPreToolUse({
      hook_event_name: 'preToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: join(projectDir, 'src/middleware/auth.ts'),
        content: `import { clerkMiddleware } from '@clerk/nextjs/server';`,
      },
      cwd: projectDir,
    });

    console.log = origLog;
    expect(adviseSpy).not.toHaveBeenCalled();
    const line = logs.find((l) => l.includes('additional_context'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.additional_context).toContain('Good —');
    expect(parsed.permission).toBe('allow');
  });

  it('denies when org diy_category policy is deny', async () => {
    mkdirSync(join(projectDir, '.starlog'), { recursive: true });
    writeFileSync(
      join(projectDir, '.starlog/policy.json'),
      JSON.stringify({
        org: 'acme',
        rules: [
          {
            id: 'diy-authentication',
            decision: 'deny',
            match: { diy_category: 'authentication' },
            rationale: 'use Clerk/Auth0',
          },
        ],
      }),
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await handleDiyPreToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
      cwd: projectDir,
    });

    console.log = origLog;
    const line = logs.find((l) => l.includes('permissionDecision'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Org policy blocks');
  });

  it('debounces repeated advisories for the same project+category', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
      cwd: projectDir,
    };

    await handleDiyPreToolUse(payload);
    await handleDiyPreToolUse(payload);

    console.log = origLog;
    const outputs = logs.filter((l) => l.includes('hookSpecificOutput'));
    expect(outputs.length).toBe(1);
  });

  it('keeps positive-ack debounce across saveCache prune past the DIY window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    try {
      const positivePayload = {
        hook_event_name: 'preToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: join(projectDir, 'src/middleware/auth.ts'),
          content: `import { clerkMiddleware } from '@clerk/nextjs/server';`,
        },
        cwd: projectDir,
      };
      const diyPayload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
        cwd: projectDir,
      };

      await handleDiyPreToolUse(positivePayload);
      expect(logs.some((l) => l.includes('Good —'))).toBe(true);

      // Past DIY debounce (10m), still inside positive debounce (30m).
      // A DIY saveCache prune must not drop the positive:: entry early.
      vi.advanceTimersByTime(15 * 60 * 1000);
      await handleDiyPreToolUse(diyPayload);

      logs.length = 0;
      await handleDiyPreToolUse(positivePayload);

      expect(logs.some((l) => l.includes('Good —'))).toBe(false);
    } finally {
      console.log = origLog;
      vi.useRealTimers();
    }
  });
});
