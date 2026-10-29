#!/usr/bin/env bash
# Proves the documented out-of-repo path for importers (docs/WRITING_AN_IMPORTER.md §8):
# templates/importer, copied outside this repository, installs @wormhole/sdk as a pnpm git
# subdirectory dependency, which makes pnpm fetch the repository and build the SDK through
# its `prepare` script, then passes typecheck, unit and conformance tests, and build.
#
# The template depends on `github:hyperdrive-technology/wormhole#<tag>&path:/packages/sdk`.
# Here the same dependency points at this checkout's HEAD commit through `git+file://`, so
# CI tests the commit under review with the same pnpm git-dependency mechanism (fetch,
# workspace install, prepare build) without needing the commit on GitHub. Uncommitted
# changes are NOT part of the test; the script warns about them.
#
# Needs the full git history of HEAD (CI: actions/checkout with fetch-depth: 0).
#
# Usage: scripts/verify-template.sh   (from anywhere; exits non-zero on any failure)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template_dir="$repo_root/templates/importer"
head_sha="$(git -C "$repo_root" rev-parse HEAD)"
if [[ -n "$(git -C "$repo_root" status --porcelain -- packages templates pnpm-lock.yaml)" ]]; then
  echo "verify-template: warning: uncommitted changes are not tested (HEAD is $head_sha)" >&2
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wormhole-template.XXXXXX")"
log_file="$work_dir/step.log"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

# Runs a command quietly; on failure prints its output and exits with its status.
step() {
  local label="$1"
  shift
  printf '==> %s\n' "$label"
  local status=0
  "$@" >"$log_file" 2>&1 || status=$?
  if [[ $status -ne 0 ]]; then
    cat "$log_file" >&2
    printf 'verify-template: "%s" failed (exit %d)\n' "$label" "$status" >&2
    exit "$status"
  fi
}

# Copy the template without build output or installed modules.
project="$work_dir/importer"
mkdir -p "$project"
tar -C "$template_dir" --exclude ./node_modules --exclude ./dist -cf - . | tar -C "$project" -xf -

# Same dependency form as the template, pointed at this checkout's HEAD.
node -e '
  const fs = require("node:fs");
  const [file, spec] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^github:hyperdrive-technology\/wormhole#[^&]+&path:\/packages\/sdk$/.test(pkg.dependencies["@wormhole/sdk"])) {
    throw new Error(`template must depend on the GitHub subdirectory form, got ${pkg.dependencies["@wormhole/sdk"]}`);
  }
  if (!pkg.pnpm?.onlyBuiltDependencies?.includes("@wormhole/sdk")) {
    throw new Error("template must list @wormhole/sdk in pnpm.onlyBuiltDependencies");
  }
  pkg.dependencies["@wormhole/sdk"] = spec;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$project/package.json" "git+file://$repo_root#$head_sha&path:/packages/sdk"

# The work dir is outside the repository, so pnpm cannot pick up Wormhole's
# pnpm-workspace.yaml; the project installs exactly as it would in its own repo.
cd "$project"
# A store path containing `node_modules`, like GitHub Actions' pnpm setup, so the SDK's
# prepare build is checked under the conditions that once broke it (see the comment in
# packages/sdk/tsup.config.ts).
step 'pnpm install (fetches and builds @wormhole/sdk)' env CI=true pnpm install --no-frozen-lockfile --store-dir "$work_dir/node_modules/.pnpm-store"
[[ -f node_modules/@wormhole/sdk/dist/index.js ]] || { echo 'verify-template: @wormhole/sdk was installed without dist/' >&2; exit 1; }
# contract and migrate must be bundled (JS and types): consumers cannot resolve them.
if grep -rlE "from ['\"]@wormhole/(contract|migrate)['\"]" node_modules/@wormhole/sdk/dist; then
  echo 'verify-template: @wormhole/sdk dist still imports @wormhole/contract or @wormhole/migrate' >&2
  exit 1
fi
step 'typecheck' pnpm typecheck
step 'test' pnpm test
grep -E '^ +(Test Files|Tests) ' "$log_file" || true
step 'build' pnpm build
[[ -f dist/index.js ]] || { echo 'verify-template: dist/index.js was not built' >&2; exit 1; }

# The built entry must load under plain Node and expose a valid importer.
step 'load dist/index.js' node --input-type=module -e '
  const { default: importer } = await import(process.argv[1]);
  if (importer?.manifest?.id !== "example.csv-tags-importer") throw new Error("unexpected default export");
' "$project/dist/index.js"

echo "verify-template: OK (@wormhole/sdk from ${head_sha:0:12})"
