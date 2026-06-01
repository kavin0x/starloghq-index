# Starlog demo tape — render with:  vhs demo/starlog.tape
# Prereqs: run demo/setup.sh first (builds the CLI + an isolated sandbox).
# The demo deliberately uses the default keyword ranker — no API key, no
# network — so it reflects what a plain `npx starloghq` user sees.

Output demo/starlog-demo.gif

Set Shell "bash"
Set FontSize 22
Set Width 1200
Set Height 700
Set Padding 24
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"

# --- Hidden setup: isolate HOME + project, put starlog on PATH, clear ---
Hide
Type "export HOME=/tmp/starlog-demo-home"
Enter
Type 'export PATH=/tmp/starlog-demo-home/bin:$PATH'
Enter
Type "cd /tmp/starlog-demo-proj"
Enter
Type "clear"
Enter
Show

# --- 1. Instant value, zero install: a ranked library recommendation ---
Type "# Ask which library to use — ranked by fit, not recalled from training data"
Enter
Sleep 1.5s
Type 'starlog search "auth for a Next.js app" --top-k 2'
Enter
Sleep 4.5s

# --- 2. One command wires it into every coding agent ---
Type "# Wire it into Claude Code, Cursor, Copilot & Codex"
Enter
Sleep 1.5s
Type "starlog init --all --project --yes"
Enter
Sleep 4.5s

Sleep 2.5s
