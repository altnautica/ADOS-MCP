# ADOS MCP

**A Model Context Protocol server for the ADOS drone platform. Read and control a drone or a whole fleet from your AI client, with a scope on every connection, a confirmation on anything that moves an aircraft, and an audit trail on every call.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-2025--06--18-orange.svg)](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

> **Part of the ADOS ecosystem.** Pairs with the [ADOS Drone Agent](https://github.com/altnautica/ADOSDroneAgent), [ADOS Mission Control](https://github.com/altnautica/ADOSMissionControl), and [ADOS Extensions](https://github.com/altnautica/ADOSExtensions).

<p align="center">
  <a href="https://docs.altnautica.com">Docs</a> ·
  <a href="https://github.com/altnautica/ADOS-MCP/issues">Issues</a> ·
  <a href="https://modelcontextprotocol.io">Model Context Protocol</a>
</p>

## What it is

ADOS MCP lets any MCP-capable AI client, Claude Code first-class, plus Claude Desktop, Cursor, VS Code, or a plain HTTP client, connect to an ADOS drone or ground station and:

- Read live status, telemetry, and health for a node or a fleet.
- Read every flight-controller parameter with full meaning and get tuning recommendations.
- Administer the platform: rename a node, update the software, install and configure plugins, restart a service, manage pairing and network settings.
- Query logs and a full audit trail.
- Fly, when the operator explicitly grants it: arm, change mode, go to a point, run a mission, land, return home, or stop.

The drone is the server; the AI is the client. No model runs on the drone. The server is a thin layer over interfaces that already exist, so behavior is defined once and stays consistent whether it is reached from the console, the command line, or an AI client.

**Visibility is broad; action is gated.** Reading is open within the granted scope. Writing is controlled by that scope, a safety class per action, a confirmation step for anything that moves an aircraft or changes state, and an operator-present check for flight. Every call, allowed or denied, is recorded.

## Ways to run it

You run the server yourself, on your own machine. **Local-first: reach your drones directly over the LAN — no sign-in, no cloud.** Cloud is an opt-in path for reaching your fleet from anywhere.

| Mode | Command | Reaches | Needs |
|------|---------|---------|-------|
| **Agent** (default) | `--target agent <host>` | one drone on your LAN | the drone's pairing key |
| **Local fleet** | `--target local-fleet` | many drones on your LAN | the fleet in one env var (or a file), each drone's host + key; `--discover` auto-adopts new unpaired drones |
| **Fleet** (cloud, opt-in) | `--target fleet --gcs prod` | your fleet from anywhere, via Mission Control | a Mission Control sign-in + a minted credential |

All three expose the identical tools; only the reach differs.

- **Agent and local-fleet are the local-first paths.** The server talks straight to your drones over the LAN — no cloud round-trip, no login. A drone's own pairing key (stored when you paired it in Mission Control) authorizes the connection. This is the everyday path for a bench, a field setup, or your own network.
- **Fleet-mode is the opt-in "manage from anywhere" path.** It connects to a Mission Control (GCS) backend — your own local one (`--gcs local`) or the production one (`--gcs prod`) — as you, the operator, and reaches the drones Mission Control tracks in the cloud. Useful when you are off the drones' network; it needs a signed-in operator to mint a credential.

## Set it up (Claude Code)

You run the server yourself, from this repo — there is no package to install. The Mission Control MCP tab has a guided wizard that walks you through these steps and fills in your drone's host and pairing key (local) or your credential (cloud).

**Prerequisites:** Node ≥ 20, git, [pnpm](https://pnpm.io) (`npm install -g pnpm`), and an MCP client (e.g. [Claude Code](https://docs.claude.com/claude-code)).

**1. Get and build the server:**

```bash
git clone https://github.com/altnautica/ADOS-MCP.git
cd ADOS-MCP
./scripts/setup.sh          # installs, builds, and prints your exact add command
# (or do it by hand: pnpm install && pnpm build)
```

**2. Add the server to your client.** Start local — reach a drone on your LAN with no login. The pairing key rides in the client's environment (`-e`), not your shell (the wizard fills it in):

```bash
# One drone on the LAN:
claude mcp add ados -e ADOS_MCP_AGENT_KEY=<pairing-key> -- \
  node "$(pwd)/dist/index.js" --target agent <host>

# Your whole LAN fleet in ONE command (the MCP tab's "control all my drones" wizard
# generates this — every drone's host + key rides in the env, no file):
claude mcp add ados -e ADOS_MCP_FLEET=<blob> -- node "$(pwd)/dist/index.js" --target local-fleet
# (or point at a fleet file: --target local-fleet ~/.ados/mcp/fleet.json)
# Add --discover to also auto-adopt new UNPAIRED drones on your LAN.
```

Or, to reach your fleet from anywhere through the cloud (opt-in), mint a credential in the Mission Control MCP tab:

```bash
claude mcp add ados -e ADOS_MCP_TOKEN=<credential> -- \
  node "$(pwd)/dist/index.js" --target fleet --gcs prod
```

The server auto-selects the **stdio** transport when a client launches it, so no `--transport` flag is needed.

**3. Check it works** (optional, before or without a client):

```bash
# Local (a drone on your LAN):
ADOS_MCP_AGENT_KEY=<pairing-key> node dist/index.js --target agent <host> --verify
# → ✓ Connected — agent mode → http://<host>:8080

# Cloud (your fleet from anywhere):
ADOS_MCP_TOKEN=<credential> node dist/index.js --target fleet --gcs prod --verify
```

Then ask your client for a drone's status. See [`docs/`](./docs) for the tool catalog and the full architecture.

## Transports

- **Streamable HTTP** (`POST /mcp`, single endpoint, SSE upgrade for streams), the primary networked transport.
- **stdio**, the local one-liner for Claude Code and Desktop.
- **Unix socket** (`/run/ados/mcp.sock`), on-box in agent and local-fleet modes, where local presence is the credential.

## Safety model

- A token carries scopes (`read`, `safe_write`, `admin`, `flight`, `destructive`, `secret_read`). Flight and destructive are off by default.
- Every write is checked against the token scope, a per-tool safety class, and, for flight or destructive actions, a typed confirmation and an operator-present signal.
- Annotations (`readOnlyHint`, `destructiveHint`) are advertised honestly but are hints, never the enforcement point. The server enforces.
- Every call produces one redacted audit event.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The connector is a thin shim, so it holds no telemetry buffers and runs no inference. It calls the platform's existing interfaces and presents them through MCP.

## Contributing

Issues and pull requests are welcome. The repository is developed in the open under the MIT license. Please keep contributions technical and free of any private or third-party content.

## License

MIT. See [`LICENSE`](./LICENSE). Built for civilian use.
