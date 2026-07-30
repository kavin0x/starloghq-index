/** Agent hook output formats differ; normalize emission here. */

export type HookPlatform = 'claude' | 'cursor' | 'copilot';

export interface PreToolUseEmit {
  additionalContext?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
}

/** Infer platform from hook stdin payload shape. */
export function detectHookPlatform(data: Record<string, unknown>): HookPlatform {
  const event = String(data.hook_event_name ?? data.hookEventName ?? '');
  // Cursor uses camelCase lifecycle names; Claude Code + VS Code Copilot use PascalCase.
  if (
    event === 'preToolUse' ||
    event === 'postToolUse' ||
    event === 'postToolUseFailure' ||
    event === 'beforeShellExecution'
  ) {
    return 'cursor';
  }
  return 'copilot';
}

export function emitPreToolUse(platform: HookPlatform, out: PreToolUseEmit): void {
  if (platform === 'cursor') {
    const payload: Record<string, unknown> = { permission: out.permissionDecision === 'deny' ? 'deny' : 'allow' };
    if (out.permissionDecisionReason) payload.user_message = out.permissionDecisionReason;
    if (out.additionalContext) payload.additional_context = out.additionalContext;
    if (out.permissionDecision === 'deny' && out.permissionDecisionReason) {
      payload.agent_message = out.permissionDecisionReason;
    }
    console.log(JSON.stringify(payload));
    return;
  }

  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: 'PreToolUse',
  };
  if (out.additionalContext) hookSpecificOutput.additionalContext = out.additionalContext;
  if (out.permissionDecision) hookSpecificOutput.permissionDecision = out.permissionDecision;
  if (out.permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = out.permissionDecisionReason;
  console.log(JSON.stringify({ hookSpecificOutput }));
}

export function emitPostToolUseContext(platform: HookPlatform, context: string): void {
  if (platform === 'cursor') {
    console.log(JSON.stringify({ additional_context: context }));
    return;
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
    }),
  );
}
