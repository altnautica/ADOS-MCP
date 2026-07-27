# AGENTS.md - ADOS MCP Server

Agentic coding instructions for ADOS MCP, the Model Context Protocol server
for the ADOS drone platform.

## Purpose

Work in this repository as an engineering agent for the MCP server. Keep changes
typed, tested, and scoped. The server is a thin shim over existing platform
interfaces; it holds no telemetry buffers and runs no inference.

## Read First

- Check `git status --short` before edits and preserve unrelated changes.
- Inspect the nearest existing tool, plane, transport, or test before
  introducing a new pattern.
- Keep TypeScript strict. This repo uses `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax`.

## Stack and Commands

- TypeScript 5 (ES modules, ES2022 target, Node16 module resolution).
- MCP SDK: `@modelcontextprotocol/sdk`.
- Runtime: Node >= 20. Package manager: pnpm 10.28.1.
- License: MIT.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Use `pnpm dev` for local development (runs via tsx). Run `pnpm build` before
committing to verify the TypeScript compilation succeeds. Use `pnpm test` for
focused test runs.

## Architecture Map

- Entry point: `src/index.ts`
- Server setup: `src/server.ts`
- CLI: `src/cli.ts`
- Config: `src/config.ts`
- Version: `src/version.ts`
- Transport layer: `src/transport/`
- Tool planes (read, admin, flight): `src/plane/`
- Gate (safety class checks): `src/gate/`
- Auth (token validation, scopes): `src/auth/`
- Audit trail: `src/audit/`
- Param metadata: `src/param-metadata/`
- Extension catalog: `src/catalog/`
- Discovery (mDNS): `src/discovery/`
- Registry (tool registration): `src/registry/`
- Utilities: `src/util/`
- Tests: `test/`
- Architecture docs: `docs/architecture.md`

## Coding Rules

- Keep TypeScript strict. Avoid `any` in source files; use `unknown` with
  narrowing at boundaries. Test files may use `any` (ESLint is relaxed there).
- Every tool must declare a safety class and go through the gate before
  execution. Never bypass the gate.
- Every call produces one redacted audit event. Do not skip audit logging.
- Token scopes control access. Flight and destructive scopes are off by default.
  Never grant them implicitly.
- Transports are swappable. Keep transport-specific logic in `src/transport/`.
- Keep source files near 300 lines when practical.

## Working in the Open

This is a public, open-source repository. Every commit, diff, and branch is
visible the moment it is pushed and stays in history permanently, so a mistake
cannot be un-published by deleting it later. Review what a change actually
contains before committing.

- **Never commit secrets.** API keys, tokens, deploy keys, passwords, private
  certificates, and `.env` files stay out of the tree. Generated secrets belong
  only in gitignored files. If a secret does land in a commit, treat it as
  compromised and rotate it.
- **Never commit real deployment detail.** Hostnames, IP addresses, tunnel
  names, device identifiers, and account names from a live setup are an attack
  surface. Use placeholders such as `example-oem`, `cloud.example.com`,
  `192.168.1.50`, and `mycompany-fleet`.
- **Never commit other people's data.** Personal names, email addresses,
  customer or employer names, real flight logs and GPS traces, and raw log
  dumps that contain any of the above do not belong in a public repository.
- **Tests are published too.** Fixtures, recorded transport payloads, and audit
  samples get the same care as source.
- **Respect licensing when bringing in outside code.** Third-party source is
  vendored into a vendor directory with its license intact and is never pasted
  into our own modules.
- **Keep contributions technical.** Architecture, APIs, commands, schemas,
  configuration, hardware interfaces, deployment, and troubleshooting.
  Commercial, pricing, or roadmap commentary does not belong in the codebase.
- **Comments, log strings, commit messages, and PR titles are public too.** Keep
  them bland, factual, and technical.

## Verification

- After any source change: `pnpm typecheck && pnpm lint && pnpm test`
- Before committing: `pnpm build` to verify the full compilation pipeline.
- For transport or auth changes: run the relevant test files in `test/`.
- For tool changes: check `test/` for matching test coverage.

## Review Expectations

When reviewing, list findings first and focus on safety bypasses, scope
escalation, audit gaps, transport leaks, and missing tests. Cite file and line
references.

## Related Public Projects

- [ADOS Drone Agent](https://github.com/altnautica/ADOSDroneAgent) - the
  agent the server connects to.
- [ADOS Mission Control](https://github.com/altnautica/ADOSMissionControl) -
  the GCS with an MCP setup wizard.
- [ADOS Extensions](https://github.com/altnautica/ADOSExtensions) - first-party
  plugins for the platform.
