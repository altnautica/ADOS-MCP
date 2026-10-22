#!/usr/bin/env bash
# Smoke-test a built ADOS MCP image: version, help, non-root user, the stdio
# handshake with exit on stdin EOF, the HTTP transport with auth enforced, and
# the explicit bind address behind a proxy. Needs docker, jq, curl and timeout.
#
#   bash scripts/docker-smoke.sh ados-mcp:smoke
set -euo pipefail

IMG="${1:?usage: docker-smoke.sh IMAGE}"
cd "$(dirname "$0")/.."

HTTP_NAME=ados-mcp-smoke-http
PROXY_NAME=ados-mcp-smoke-proxy
cleanup() { docker rm -f "$HTTP_NAME" "$PROXY_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() { echo "ok: $*"; }

# 1. The image reports the package version.
want="$(jq -r .version package.json)"
got="$(docker run --rm "$IMG" --version | tr -d '\r')"
[ "$got" = "$want" ] || fail "version: image says '$got', package.json says '$want'"
ok "version $got"

# 2. Help prints and exits 0.
help="$(docker run --rm "$IMG" --help)" || fail "help: non-zero exit"
grep -q "ados-mcp - Model Context Protocol server" <<<"$help" || fail "help: banner missing"
ok "help"

# 3. The server runs as a non-root user.
uid="$(docker run --rm --entrypoint id "$IMG" -u | tr -d '\r')"
[ "$uid" = "1000" ] || fail "non-root: uid is '$uid', want 1000"
ok "non-root (uid 1000)"

# 4. stdio handshake, then exit once stdin closes. A timeout means the server
#    outlived its client.
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
initialized='{"jsonrpc":"2.0","method":"notifications/initialized"}'
list='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
set +e
out="$({ printf '%s\n' "$init" "$initialized" "$list"; sleep 5; } |
  timeout 40 docker run -i --rm "$IMG" --target agent 127.0.0.1 2>/dev/null)"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "stdio: exit code $rc (124 means it did not exit on stdin EOF)"
grep -q '"id":2' <<<"$out" || fail "stdio: no tools/list response"
grep -q 'status.get' <<<"$out" || fail "stdio: tools/list lacks status.get"
ok "stdio handshake and exit on stdin EOF"

# Poll /healthz until it answers. 200 means the plane is up, 503 means the
# server is up but the drone is not, which is the honest answer here.
wait_healthz() {
  local port="$1" code=""
  for _ in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz" || true)"
    if [ "$code" = "200" ] || [ "$code" = "503" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# 5. The HTTP transport is reachable from the host and demands a bearer.
docker run -d --name "$HTTP_NAME" -p 127.0.0.1:18091:8091 "$IMG" \
  --target agent 127.0.0.1 --transport http --no-mdns >/dev/null
wait_healthz 18091 || fail "http: /healthz never answered (logs: $(docker logs "$HTTP_NAME" 2>&1 | tail -5))"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' http://127.0.0.1:18091/mcp)"
[ "$code" = "401" ] || fail "http: unauthenticated POST /mcp returned $code, want 401"
ok "http reachable, auth enforced"

# 6. Behind a proxy, an explicit --http-host wins over the loopback default.
docker run -d --name "$PROXY_NAME" -p 127.0.0.1:18092:8091 "$IMG" \
  --target agent 127.0.0.1 --transport http --no-mdns --trust-proxy --http-host 0.0.0.0 >/dev/null
wait_healthz 18092 || fail "proxy bind: /healthz unreachable with --trust-proxy --http-host 0.0.0.0"
ok "proxy bind (--trust-proxy --http-host 0.0.0.0)"
