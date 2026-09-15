#!/usr/bin/env bash
# Clean-for-public sweep. This repository is public and MIT-licensed, so no
# internal-planning, attribution, machine-path, or business-framing content may
# land in code, fixtures, docs, or commit messages. The sweep greps the whole
# tracked tree and exits non-zero on any hit, so it runs in CI and as a pre-push
# check. Naming the Model Context Protocol / MCP is allowed (it is a standard
# this repo implements).
#
# This file is PUBLIC, so it holds only GENERIC structural patterns. Identity,
# customer, and other sensitive literals are never written here; they are loaded
# at run time from a private, gitignored denylist file (default `.private/denylist.txt`,
# or the path in $ADOS_DENYLIST_FILE) that a local pre-push hook / private CI
# secret supplies. The public sweep on its own catches the structural leaks; the
# private overlay catches the named ones without publishing the names.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

# Generic structural patterns, safe to publish. Extended-regex, case-insensitive.
patterns=(
  'DEC-[0-9]+'
  'MSN-[0-9]+'
  'Phase [0-9]'
  'Wave [A-Z] '
  'Bug #[0-9]'
  'BT-G?[0-9]'
  'Rule [0-9]'
  'referenceCode'
  'MissionPlanner'
  'QGroundControl'
  'betaflight-configurator'
  'inav-configurator'
  'dimensional ?os'
  '/Users/[a-z]'
  '192\.168\.(200|0)\.'
  '₹'
  'fundraise'
)

# Overlay a private, gitignored denylist (one extended-regex pattern per line,
# blank lines and # comments ignored). The named half of the sweep lives ONLY
# there, so a file that is absent — or present but contributes no pattern —
# means the run covered structural patterns and nothing else. That must never
# read as a full pass: it warns, and it FAILS outright when the caller declares
# the overlay mandatory with ADOS_DENYLIST_REQUIRED=1 (which CI sets, writing the
# list from a repository secret).
denylist_file="${ADOS_DENYLIST_FILE:-.private/denylist.txt}"
denylist_count=0
if [ -f "$denylist_file" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    patterns+=("$line")
    denylist_count=$((denylist_count + 1))
  done < "$denylist_file"
fi
if [ "$denylist_count" -eq 0 ] && [ "${ADOS_DENYLIST_REQUIRED:-0}" = "1" ]; then
  echo "clean-for-public: FAIL — named denylist missing or empty at '$denylist_file'; set ADOS_DENYLIST_FILE or provide .private/denylist.txt"
  exit 2
fi

found=0

# Scan the whole WORKING TREE with plain grep (not `git grep`): it sees tracked,
# staged, AND untracked files, and tolerates excluded dirs that do not exist —
# `git grep --untracked` fatals on a missing exclude pathspec, which a swallowed
# error can turn into a false pass. A fresh, not-yet-indexed file must never slip
# past the sweep.
#
# Two of the excluded directories are not build output: `.private` holds the
# denylist itself, and `.omp` is a gitignored local agent-tooling bridge that is
# never published — a hit in either is noise that would train a reader to ignore
# this guard.
for p in "${patterns[@]}"; do
  hits=$(grep -rnEI -i \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=coverage \
    --exclude-dir=.git --exclude-dir=vendor --exclude-dir=.private --exclude-dir=.omp \
    --exclude=pnpm-lock.yaml --exclude=clean-for-public.sh \
    -- "$p" . 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "clean-for-public: forbidden pattern found:"
    echo "$hits"
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  echo ""
  echo "clean-for-public sweep FAILED. Remove the content above before pushing."
  exit 1
fi

if [ "$denylist_count" -gt 0 ]; then
  echo "clean-for-public sweep passed (structural + $denylist_count named pattern(s))."
else
  echo "clean-for-public: WARNING — structural patterns only, named denylist not loaded."
  echo "clean-for-public: PARTIAL sweep passed. Set ADOS_DENYLIST_FILE (and ADOS_DENYLIST_REQUIRED=1 in CI) for the full sweep."
fi
