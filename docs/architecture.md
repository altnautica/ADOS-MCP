# Architecture

ADOS MCP is a thin Model Context Protocol server over interfaces that already
exist on an ADOS drone or ground station. It reimplements no flight, telemetry,
or administration logic; it calls the platform's own surfaces and presents them
through MCP.

## One core, two modes

A single TypeScript core runs in either of two modes, chosen at launch with
`--target`. The operator runs the server on their own machine in both.

- **fleet-mode** (`--target fleet --gcs local|prod`) is the primary pathway. It
  connects to a Mission Control (GCS) Convex backend — a local one or the
  production one — as the operator, and reaches the operator's cloud-connected
  drones through the same auth-gated functions Mission Control itself calls.
  Every tool takes a `node` argument. Reach limit: only cloud-connected drones
  are visible; a LAN-only drone is reached in agent-mode.
- **agent-mode** (`--target agent <host>`) is the local-first direct pathway. It
  reaches one drone over the LAN: its HTTP control surface, its local state and
  MAVLink sockets, and its MAVLink WebSocket.

Both modes expose the identical tool, resource, and prompt catalog. What differs
is the adapter behind a `PlatformPlane` interface: a LAN-direct adapter for
agent-mode, a GCS-interface adapter for fleet-mode. A tool is written once
against the interface and runs on either.

Because the server runs on the operator's machine, its durable audit store is a
local newline-delimited JSON file the operator owns, alongside the always-on
stderr sink.

## Transports

- **Streamable HTTP** at `POST /mcp` (a single endpoint, upgraded to an SSE
  stream when a response needs to stream), the primary networked transport.
- **stdio**, the local one-liner an AI client spawns.
- A **Unix socket** on-box in agent-mode, where local presence is the credential.

A `GET /healthz` probe reports readiness for load balancers.

## The gate

Every tool call passes one chokepoint, in order: token verify, scope check,
route-to-capability, a class-specific safety gate (a confirmation for admin
actions, a typed phrase for destructive ones, an operator-present signal for
flight), a per-token rate limit, and an audit record. Reading is open within a
token's scope; writing is gated; flight and destructive actions are off unless
the operator granted the scope and confirms at call time. Tool annotations
(`readOnlyHint`, `destructiveHint`) are advertised honestly but are hints, never
the enforcement point. The server enforces.

## Credentials

The connection credential differs by mode:

- **agent-mode** uses a self-contained, scoped, revocable HMAC token whose signing
  key derives at request time from the node's pairing key. The repository holds no
  secret material and the token verifies offline.
- **fleet-mode** uses one opaque, scoped, revocable machine credential the operator
  mints in the GCS tab. The backend stores only its hash and verifies it on each
  reach; the presented bearer must equal the server's configured credential (so the
  verified principal and the reach identity are one operator), and a revocation in
  the tab cuts the server off within the re-verification window.

## Audit

Every call, allowed or denied, produces one redacted event in the platform's
durable logging store, so an operator can review exactly what an AI client did.
