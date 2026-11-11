#!/usr/bin/env bash
# Local check ladder for this repo: scripts/dev-check.sh [fast|push|full] [--base <ref>] [--list] [--e2e]
# Logic lives in scripts/dev-check.mjs (tested by scripts/dev-check.test.mjs); see TESTING.md.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-check.mjs" "$@"
