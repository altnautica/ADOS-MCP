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
  '192\.168\.'
  '₹'
  'fundraise'
)

# Overlay a private, gitignored denylist (one extended-regex pattern per line,
# blank lines and # comments ignored). Absent file => structural sweep only.
denylist_file="${ADOS_DENYLIST_FILE:-.private/denylist.txt}"
if [ -f "$denylist_file" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    patterns+=("$line")
  done < "$denylist_file"
fi

# Files / dirs the sweep ignores.
excludes=(
  ':!pnpm-lock.yaml'
  ':!dist/'
  ':!coverage/'
  ':!node_modules/'
  ':!vendor/'
  ':!scripts/clean-for-public.sh'
)

found=0
# Scan the whole WORKING TREE with plain grep (not `git grep`): it sees tracked,
# staged, AND untracked files, and tolerates excluded dirs that do not exist —
# `git grep --untracked` fatals on a missing exclude pathspec, which a swallowed
# error can turn into a false pass. A fresh, not-yet-indexed file must never slip
# past the sweep.
for p in "${patterns[@]}"; do
  hits=$(grep -rnEI -i \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=coverage \
    --exclude-dir=.git --exclude-dir=vendor --exclude-dir=.private \
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

echo "clean-for-public sweep passed."
