import { cp } from 'node:fs/promises';

import { defineConfig } from 'tsup';

/**
 * `@wormhole/sdk` is the one package an external importer depends on, so its build is
 * self-contained: `@wormhole/contract` and `@wormhole/migrate` (workspace packages that are
 * not published) are bundled into `dist/`, JS and type declarations alike. The result can
 * be packed with `pnpm pack` and installed from a tarball or release asset anywhere.
 */
const bundled = ['@wormhole/contract', '@wormhole/migrate'];

/*
 * Installing straight from GitHub (no npm publish yet, Des 2026-10-29):
 *
 *   "@wormhole/sdk": "github:hyperdrive-technology/wormhole#<ref>&path:/packages/sdk"
 *   "pnpm": { "onlyBuiltDependencies": ["@wormhole/sdk"] }
 *
 * What pnpm 10.33.2 actually does with that (verified 2026-10-29 in a scratch project; see
 * scripts/verify-template.sh, which re-checks it in CI):
 * - It fetches the whole repository, finds pnpm-workspace.yaml at its root and runs
 *   `pnpm install` for the workspace there, so `workspace:*` dependencies resolve inside
 *   the fetched copy.
 * - It then runs this package's `prepare` script and packs `packages/sdk` with the freshly
 *   built `dist/`. `prepare` first builds @wormhole/contract and @wormhole/migrate
 *   (`build:deps`), so bundling them goes through their built `dist/` and does not depend
 *   on tsconfig `paths`: pnpm extracts git dependencies under its store, and when that path
 *   contains a `node_modules` directory (GitHub Actions' pnpm/action-setup puts the store
 *   under `setup-pnpm/node_modules/.bin/store`), esbuild ignores the tsconfig.json there,
 *   so `paths` silently stop working ("Could not resolve @wormhole/contract", found in CI
 *   2026-10-29). scripts/verify-template.sh uses such a store path on purpose.
 * - pnpm 10 refuses to run a git-hosted dependency's build scripts unless the consumer
 *   lists the package in `onlyBuiltDependencies` (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED).
 * - The consumer's lockfile pins the resolved commit, so `#main` or a tag is reproducible
 *   once locked.
 * Side effect: `prepare` also runs on every `pnpm install` inside this repository (pnpm
 * runs workspace projects' `prepare`), which costs a couple of seconds.
 */

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    node: 'src/node.ts',
    'conformance/index': 'src/conformance/index.ts',
    'conformance/vitest': 'src/conformance/vitest.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: true,
  noExternal: bundled,
  external: ['vitest'],
  dts: { resolve: bundled },
  // Ship the contract's JSON schemas too (`@wormhole/sdk/schemas/<name>.schema.json`), so an
  // importer repo can point its manifest's `$schema` or its own validators at them.
  onSuccess: async () => {
    await cp('../contract/schemas', 'dist/schemas', { recursive: true });
  },
});
