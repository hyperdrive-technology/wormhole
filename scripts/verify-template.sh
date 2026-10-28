#!/usr/bin/env bash
# Proves the out-of-repo path for third-party importers: templates/importer, copied outside
# this repository, installs @wormhole/sdk from a packed tarball (no workspace, no source
# aliases) and passes typecheck, unit + conformance tests and build.
#
# Assumes `pnpm install` already ran at the repository root. @wormhole/contract and
# @wormhole/migrate are bundled into the SDK's dist, so only the SDK is built.
#
# Usage: scripts/verify-template.sh   (from anywhere; exits non-zero on any failure)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template_dir="$repo_root/templates/importer"

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

step 'build @wormhole/sdk' pnpm --dir "$repo_root" --filter @wormhole/sdk build
step 'pack @wormhole/sdk' pnpm --dir "$repo_root" --filter @wormhole/sdk pack --pack-destination "$work_dir/vendor"

tarballs=("$work_dir"/vendor/*.tgz)
if [[ ${#tarballs[@]} -ne 1 || ! -f "${tarballs[0]}" ]]; then
  echo "verify-template: expected exactly one SDK tarball in $work_dir/vendor" >&2
  exit 1
fi
tarball_name="$(basename "${tarballs[0]}")"

# Copy the template without build output or installed modules, then move the tarball in.
project="$work_dir/importer"
mkdir -p "$project/vendor"
tar -C "$template_dir" --exclude ./node_modules --exclude ./dist --exclude './vendor/*.tgz' -cf - . | tar -C "$project" -xf -
mv "${tarballs[0]}" "$project/vendor/"

# Point the dependency at the tarball actually packed (the template names a fixed version).
node -e '
  const fs = require("node:fs");
  const [file, tarball] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.dependencies["@wormhole/sdk"] = `file:vendor/${tarball}`;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$project/package.json" "$tarball_name"

# The work dir is outside the repository, so pnpm cannot pick up Wormhole's
# pnpm-workspace.yaml; the project installs exactly as it would in its own repo.
cd "$project"
step 'pnpm install' env CI=true pnpm install --no-frozen-lockfile
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

echo "verify-template: OK ($tarball_name)"
