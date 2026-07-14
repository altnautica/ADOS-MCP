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

## Two ways to run it

| Mode | Command | Reaches |
|------|---------|---------|
| **Agent-mode** | `npx @altnautica/ados-mcp --target agent <host>` | one node on the LAN |
| **Fleet-mode** | `--target fleet` (hosted) | the whole fleet through the cloud relay |

Both expose the same tools; only the reach differs. Agent-mode is local-first (no cloud round-trip) and is the shape a bench or field setup uses.

## Quick start (Claude Code)

Mint a scoped token in the Mission Control MCP tab, then:

```bash
# Local, over the LAN, pointed at one node:
claude mcp add ados -- npx -y @altnautica/ados-mcp --target agent <host>

# Hosted fleet, over Streamable HTTP:
export ADOS_MCP_TOKEN="paste-the-token"
claude mcp add --transport http ados https://mcp.altnautica.com/mcp \
  --header "Authorization: Bearer $ADOS_MCP_TOKEN"
```

Then ask your client for fleet status. See [`docs/`](./docs) for the full connect recipes and the tool catalog.

## Transports

- **Streamable HTTP** (`POST /mcp`, single endpoint, SSE upgrade for streams), the primary networked transport.
- **stdio**, the local one-liner for Claude Code and Desktop.
- **Unix socket** (`/run/ados/mcp.sock`), on-box in agent-mode, where local presence is the credential.

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
