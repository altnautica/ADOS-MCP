#!/usr/bin/env bash
# Clean-for-public sweep. This repository is public and MIT-licensed, so no
# partner, personal, business, attribution, or internal-planning content may
# land in code, fixtures, docs, or commit messages. The sweep greps the whole
# tracked tree and exits non-zero on any hit, so it can run in CI and as a
# pre-push check. Naming the Model Context Protocol / MCP is allowed (it is a
# standard this repo implements).
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

# Patterns that must never appear. Extended-regex, case-insensitive.
patterns=(
  # Internal planning tags
  'DEC-[0-9]+'
  'MSN-[0-9]+'
  'Phase [0-9]'
  'Wave [A-Z] '
  'Bug #[0-9]'
  'BT-G?[0-9]'
  # Reference codebases (attribution)
  'referenceCode'
  'MissionPlanner'
  'QGroundControl'
  'betaflight-configurator'
  'inav-configurator'
  'dimensional ?os'
  # Personal / machine / infra
  '/Users/[a-z]'
  'ajaymohan'
  'skynet\.local'
  '192\.168\.'
  'Kasphersky'
  # Partner / customer / cofounder identities
  'WaveControl'
  'Aurelius'
  'Gagandeep'
  # Defense / classified vocabulary
  'battlenet'
  'shahed'
  'kamikaze'
  'warhead'
  'anti-uav'
  'loitering munition'
  # Business framing
  '₹'
  'fundraise'
)

# Files / dirs the sweep ignores (build output, deps, lockfile, this script).
excludes=(
  ':!pnpm-lock.yaml'
  ':!dist/'
  ':!coverage/'
  ':!node_modules/'
  ':!scripts/clean-for-public.sh'
)

found=0
in_git=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git rev-parse HEAD >/dev/null 2>&1; then
  in_git=1
fi

for p in "${patterns[@]}"; do
  if [ "$in_git" -eq 1 ]; then
    hits=$(git grep -nEI -i -- "$p" "${excludes[@]}" 2>/dev/null || true)
  else
    hits=$(grep -rnEI -i \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=coverage --exclude-dir=.git \
      --exclude=pnpm-lock.yaml --exclude=clean-for-public.sh \
      -- "$p" . 2>/dev/null || true)
  fi
  if [ -n "$hits" ]; then
    echo "clean-for-public: forbidden pattern '$p' found:"
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
