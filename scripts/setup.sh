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

✓ Built. Add the server to Claude Code with the machine credential you mint in
  the Mission Control MCP tab (it has a guided wizard):

  # Your whole Mission Control fleet:
  claude mcp add ados -e ADOS_MCP_TOKEN=<paste-the-credential> -- \\
    node "$ROOT/dist/index.js" --target fleet --gcs prod

  # One drone directly on the LAN:
  claude mcp add ados-lan -- node "$ROOT/dist/index.js" --target agent <host>

  Check a fleet credential works, without a client:
  ADOS_MCP_TOKEN=<the-credential> node "$ROOT/dist/index.js" --target fleet --gcs prod --verify
EOF
