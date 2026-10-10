# Changelog

All notable changes to ADOS MCP are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses semantic
versioning.

## [0.2.0]

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
