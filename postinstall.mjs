// Quiet post-install nudge.
//
// `npm i starloghq` wires NOTHING on its own — the MCP server + PostToolUse hook
// are registered only by `starlog init`. A real first user installed the package,
// launched their agent, and never init'd; the agent fell back to shelling the CLI
// because the MCP tools were never registered. This single line closes that gap.
//
// Rules: ONE line, stays silent in CI / non-interactive / opt-out, and NEVER
// fails the install (a hygiene tool must be an exemplary install citizen).
try {
  const quiet =
    process.env.CI ||
    process.env.STARLOG_NO_NUDGE ||
    process.env.npm_config_loglevel === 'silent' ||
    !process.stdout.isTTY; // piped/programmatic install → don't spam logs
  if (!quiet) {
    process.stdout.write(
      '\n\x1b[1mstarloghq\x1b[0m installed. Next: run \x1b[1mnpx starlog init\x1b[0m to wire your AI agent ' +
        '(MCP + hook) — install alone does nothing. Then restart your agent.\n\n',
    );
  }
} catch {
  /* never fail an install over a nudge */
}
