# Testing Wormhole

One entry point, the same ladder as every Hyperdrive repo
(`~/dev/hyperdrive/AGENTS.md` § *Dev loop & shift-left*):

```bash
scripts/install-hooks.sh                 # once per clone: pre-push runs `dev-check.sh fast`
scripts/dev-check.sh                     # fast (L1): touched packages + their dependents
scripts/dev-check.sh push                # L2: before opening a PR / asking for review
scripts/dev-check.sh full                # L3: everything ci.yml runs; before merging a minor PR
scripts/dev-check.sh full --list         # print the steps and why each was selected; run nothing
scripts/dev-check.sh fast --base <ref>   # diff against another base
HYPERDRIVE_CORE_DIR=~/dev/hyperdrive/core scripts/dev-check.sh full   # + schema-sync, compile-gate
HYPERDRIVE_SKIP_HOOKS=1 git push         # WIP / lockout checkpoint: skip the hook once
```

The diff is HEAD + staged + unstaged + untracked files against the merge-base with
`origin/main`. The last line is always
`dev-check: <mode> PASS|FAIL in <N>s — <step>=<passed or ok>; …`, and each run writes
`.dev-check/last.json` (gitignored), which `~/dev/hyperdrive/scripts/ci-local-status.sh`
posts as `ci/local`. `pnpm install` runs only when `node_modules` is missing or older than
`pnpm-lock.yaml`.

## Ladder

| Tier | When | Runs here | Budget | Measured (warm, M1 Pro) |
|---|---|---|---|---|
| L0 edit | every save | `pnpm --filter <pkg> exec vitest <file>` (watch) | seconds | < 1–4 s per package |
| L1 `fast` | every push (hook) | typecheck + test of the touched packages and their dependents (`pnpm --filter … --parallel`), plus selected extras | ≤ 60 s | 3–9 s |
| L2 `push` | before a PR / review | `pnpm typecheck`, `pnpm test`, dev-check self-tests | ≤ 5 min | ~9 s |
| L3 `full` | before merging a minor PR | L2 + `pnpm build` + `scripts/verify-template.sh` (= every `ci.yml` command) | — | ~15–20 s |
| L4 heavy CI | once, on the final reviewed head of a major PR | `ci.yml` on boat | — | — |
| L5 release | release prep | L3 with `HYPERDRIVE_CORE_DIR` (schema-sync, compile-gate) | — | — |

## What a change selects (`fast`)

| Changed path | Steps |
|---|---|
| `packages/<p>/**`, `apps/<p>/**` | typecheck + test of `<p>` and every package that depends on it (graph read from the `workspace:` deps in each `package.json`) |
| `packages/contract/schemas/**` | also schema-sync (when `HYPERDRIVE_CORE_DIR` is set) |
| `templates/importer/**` | typecheck + test of `@wormhole/sdk` (its configs include the template), verify-template |
| `fixtures/**` | `@wormhole/iec61131-upgrade` and its dependents |
| `scripts/verify-template.sh` | verify-template |
| `scripts/**`, `.githooks/**` | dev-check self-tests |
| top-level `*.md`, `docs/**`, `LICENSE`, `.gitignore`, CODEOWNERS/dependabot/actionlint config | nothing |
| `.github/workflows/**`, `.node-version`, root `package.json`, lockfile, `pnpm-workspace.yaml`, `workspace-aliases.ts` | **full** |
| anything else (incl. a dir under `packages/` without a `package.json`) | **push** (fail closed) |

Dependents by package: `contract` → all six; `migrate` → migrate, sdk, iec61131-upgrade,
service, ui; `sdk` → sdk, iec61131-upgrade, service, ui; `iec61131-upgrade` → itself,
service, ui; `service`, `ui` → themselves. `scripts/dev-check.test.mjs` fails if a package
imports a `@wormhole/*` package it does not declare, so the graph cannot silently miss a
dependent.

## Steps (`full` = `ci.yml`, pinned)

| Step | Command | Notes |
|---|---|---|
| typecheck | `pnpm typecheck` = `pnpm -r --parallel run typecheck` | |
| test | `pnpm test` = `pnpm -r --parallel run test` | compile-gate excluded; schema-sync skips without `HYPERDRIVE_CORE_DIR` |
| dev-check-selftest | `node --test "scripts/*.test.mjs"` | |
| build | `pnpm build` = `pnpm -r --parallel run build` | |
| verify-template | `scripts/verify-template.sh` | tests the **committed** HEAD (warns on uncommitted changes) |
| schema-sync | `pnpm test:schema-sync` | local only, needs `HYPERDRIVE_CORE_DIR` |
| compile-gate | `pnpm test:compile-gate` | local only, `full`, needs `HYPERDRIVE_CORE_DIR` (regenerates core's Langium output) |

`scripts/dev-check.test.mjs` fails if a `run:` command in `ci.yml` (other than the install
and the Markdown-only `scope` step) is not a `full` step, or the other way round, and pins
the `types: [labeled]` trigger and the parallel root scripts. Change them together.

Parallel, not topological: typecheck, tests and builds resolve sibling packages from source
(tsconfig `paths`, `workspace-aliases.ts`, the SDK's tsup aliases), never from a sibling's
`dist/`. With every `dist/` deleted, the parallel typecheck and tests pass, and a parallel
build produced byte-identical `dist/` to the topological build (55 files, 2026-11-11). If a
build ever needs a sibling's `dist/`, go back to `pnpm -r run build`.

## Timings

TIMINGS_PLACEHOLDER

## Notes

- `packages/sdk/src/node.test.ts` skips its two unreadable-file tests when `chmod 000`
  does not stop reads (root on boat runners, wormhole#25). They run in every local
  `dev-check` on a Mac, which is where they are covered until CI gets a non-root job.
- `verify-template.sh` keeps its pnpm store in
  `node_modules/.cache/verify-template/node_modules/.pnpm-store` (gitignored, ~140 MB;
  `WORMHOLE_TEMPLATE_STORE` overrides). The path contains `node_modules` on purpose (see
  `packages/sdk/tsup.config.ts`).
- Shift-left rules for this repo: a failure first seen in CI that a lower tier could have
  caught gets a `dev-check` rule or a test in the same PR, and the PR body says so.
