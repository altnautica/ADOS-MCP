# Architecture

ADOS MCP is a thin Model Context Protocol server over interfaces that already
exist on an ADOS drone or ground station. It reimplements no flight, telemetry,
or administration logic; it calls the platform's own surfaces and presents them
through MCP.

## One core, two modes

A single TypeScript core runs in either of two modes, chosen at launch with
`--target`:

- **agent-mode** (`--target agent <host>`) reaches one node over the LAN: its
  HTTP control surface, its local state and MAVLink sockets, and its MAVLink
  WebSocket.
- **fleet-mode** (`--target fleet`) reaches the whole fleet through the cloud
  relay, and every tool takes a `node` argument.

Both modes expose the identical tool, resource, and prompt catalog. What differs
is the adapter behind a `PlatformPlane` interface: a LAN-direct adapter for
agent-mode, a cloud-relay adapter for fleet-mode. A tool is written once against
the interface and runs on either.

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

## Tokens

The connection credential is a self-contained, scoped, revocable bearer token
signed with HMAC. It carries the scopes it grants, the nodes it may target, and
an expiry. The signing key is derived at request time from the node's pairing key
(LAN) or a per-operator secret (fleet); the repository holds no secret material.

## Audit

Every call, allowed or denied, produces one redacted event in the platform's
durable logging store, so an operator can review exactly what an AI client did.
