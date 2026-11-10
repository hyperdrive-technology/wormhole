#!/usr/bin/env bash
# Points git at the versioned hooks in .githooks/ (pre-push runs `scripts/dev-check.sh fast`).
# The setting is per repository (shared by its worktrees); undo with `git config --unset core.hooksPath`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git config core.hooksPath .githooks
echo "install-hooks: core.hooksPath=.githooks (pre-push → scripts/dev-check.sh fast; skip once with HYPERDRIVE_SKIP_HOOKS=1)"
