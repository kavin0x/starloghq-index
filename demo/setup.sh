#!/usr/bin/env bash
# Build a clean, isolated sandbox for the Starlog demo recording.
#
# `starlog init` writes to $HOME/.claude (settings.json, hooks) and to the
# current project dir (CLAUDE.md, AGENTS.md, editor rules), so we point HOME and
# the project at throwaway /tmp dirs and never touch the real ones. The tape
# exports HOME=$DEMO_HOME before running any starlog command.
#
# No siftrank binary and no API key are installed, on purpose: the demo shows
# the default, zero-dependency keyword-ranking experience that a plain
# `npx starloghq` user actually gets.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_HOME=/tmp/starlog-demo-home
DEMO_PROJ=/tmp/starlog-demo-proj

rm -rf "$DEMO_HOME" "$DEMO_PROJ"
mkdir -p "$DEMO_HOME/bin" "$DEMO_PROJ"

# Build the CLI so the demo runs the current source.
(cd "$REPO_DIR" && npm run build >/dev/null)

# A minimal Next.js-shaped project so `init` agent-detection and `doctor`
# output look like a real SaaS repo (which is what the demo query is about).
cat > "$DEMO_PROJ/package.json" <<'JSON'
{
  "name": "acme-saas",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0"
  }
}
JSON

# A real `starlog` command on PATH so the recorded shell types clean commands
# instead of `node dist/cli.js ...`.
cat > "$DEMO_HOME/bin/starlog" <<EOF
#!/usr/bin/env bash
exec node "$REPO_DIR/dist/cli.js" "\$@"
EOF
chmod +x "$DEMO_HOME/bin/starlog"

echo "Sandbox ready: HOME=$DEMO_HOME PROJ=$DEMO_PROJ"
