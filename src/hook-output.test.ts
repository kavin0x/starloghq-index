import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectHookPlatform, emitPreToolUse } from './hook-output.js';

describe('hook-output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects Cursor from camelCase hook events', () => {
    expect(detectHookPlatform({ hook_event_name: 'preToolUse' })).toBe('cursor');
    expect(detectHookPlatform({ hook_event_name: 'beforeShellExecution' })).toBe('cursor');
  });

  it('detects Claude/Copilot from PascalCase events', () => {
    expect(detectHookPlatform({ hook_event_name: 'PreToolUse' })).toBe('copilot');
  });

  it('emits Cursor preToolUse shape', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(String(args[0])));

    emitPreToolUse('cursor', { additionalContext: 'hello' });
    const parsed = JSON.parse(logs[0]);
    expect(parsed.permission).toBe('allow');
    expect(parsed.additional_context).toBe('hello');
  });

  it('emits Claude hookSpecificOutput shape', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(String(args[0])));

    emitPreToolUse('copilot', { additionalContext: 'hello', permissionDecision: 'deny', permissionDecisionReason: 'blocked' });
    const parsed = JSON.parse(logs[0]);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('hello');
  });
});
