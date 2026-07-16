#!/usr/bin/env bash
# ADOS MCP local setup: install dependencies, build, and print the exact command
# to add the server to your MCP client. Run it from inside the cloned repo:
#   git clone https://github.com/altnautica/ADOS-MCP.git && cd ADOS-MCP && ./scripts/setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# Node >= 20.
node_major="$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')"
if [ -z "${node_major:-}" ] || [ "$node_major" -lt 20 ]; then
  echo "ADOS MCP needs Node >= 20 (found: $(node -v 2>/dev/null || echo none))." >&2
  echo "Install it from https://nodejs.org and re-run." >&2
  exit 1
fi

# pnpm.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is not installed. Install it with:  npm install -g pnpm" >&2
  exit 1
fi

echo "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
echo "Building..."
pnpm build

cat <<EOF

✓ Built. Add the server to Claude Code. Local-first (no login, no cloud) — the
  Mission Control MCP tab has a guided wizard that fills in your drone's host and
  key:

  # One drone on your LAN (its pairing key rides in the client env):
  claude mcp add ados -e ADOS_MCP_AGENT_KEY=<pairing-key> -- \\
    node "$ROOT/dist/index.js" --target agent <host>

  # Many drones on your LAN (keys ride in the fleet file the wizard exports):
  claude mcp add ados -- node "$ROOT/dist/index.js" --target local-fleet ~/.ados/mcp/fleet.json

  # Or reach your fleet from anywhere via the cloud (opt-in; mint a credential in the tab):
  claude mcp add ados -e ADOS_MCP_TOKEN=<credential> -- \\
    node "$ROOT/dist/index.js" --target fleet --gcs prod

  Check it works, without a client:
  ADOS_MCP_AGENT_KEY=<pairing-key> node "$ROOT/dist/index.js" --target agent <host> --verify
EOF
