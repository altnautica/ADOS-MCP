# Changelog

All notable changes to ADOS MCP are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semantic
versioning.

## [0.2.0] - 2026-10-11

### Added

- Local-fleet mode for many LAN drones with no cloud. The whole fleet can be
  given inline through `ADOS_MCP_FLEET`, with no config file.
- `--discover` (opt-in) browses the LAN and adopts unpaired drones.
- A best-effort local live activity feed that records a `started` marker and
  a `done` entry per call, separate from the durable audit log.

### Changed

- `--sim` is now an opt-in that is checked against the target: the server
  refuses to start unless the target reports a simulated flight controller.
- A stdio client on the operator's machine gets a local-presence principal
  that holds every scope except `flight` and `destructive` and requires an
  operator-present signal. Flight calls need a flight-scoped `--token`.

### Security

- A plugin tool's scope floor now comes from the agent capability catalog:
  every non-read flight-control capability (including `msp.write`,
  `estimator.pose.inject` and `vision.track.designate`) floors at `flight`,
  and every `hardware.*` capability floors at `admin`. A capability that is
  neither in the catalog floor nor on the read/safe-write allowlist is treated
  as `admin`.
- `vision.designate` is a `flight` tool that affects flight and maps to the
  `vision.track.designate` capability, because retargeting the tracker steers
  an active follow.
- New `--trust-proxy` flag. Forwarded client-IP headers are read only when it
  is set; the HTTP listener then binds `127.0.0.1` and takes the client from
  `cf-connecting-ip`, else the right-most `X-Forwarded-For` hop. Without it the
  listener binds `::` and uses the socket peer. Fleet mode no longer implies
  proxy trust.
- Plugin ids, parameter names and service unit names are pattern-checked, and
  agent route path segments containing `..` or `/` are refused with
  `invalid_arguments`.
- Calls over the node's own Unix socket skip only the scope check. They still
  pass the safety gate: admin calls need `confirm: true` and flight calls need
  an operator-present signal or a signed confirm.
