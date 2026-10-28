import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
 * What pnpm 10.33.2 actually does with that (verified 2026-10-29; scripts/verify-template.sh
 * re-checks it in CI):
 * - It fetches the whole repository, finds pnpm-workspace.yaml at its root and runs
 *   `pnpm install` for the workspace there, so `workspace:*` dependencies resolve inside
 *   the fetched copy.
 * - It then runs this package's `prepare` script (`pnpm run build`) and packs
 *   `packages/sdk` with the freshly built `dist/`.
 * - pnpm 10 refuses to run a git-hosted dependency's build scripts unless the consumer
 *   lists the package in `onlyBuiltDependencies` (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED).
 * - The consumer's lockfile pins the resolved commit.
 *
 * Gotcha (found in CI 2026-10-29): pnpm builds git dependencies inside its store. On GitHub
 * Actions that store is below a `node_modules` directory, and esbuild ignores tsconfig.json
 * files there, so tsconfig `paths` stop working ("Could not resolve @wormhole/contract").
 * The explicit esbuild `alias` below does not depend on tsconfig. Types have a similar
 * problem, handled in rollup.dts.config.mjs. scripts/verify-template.sh builds under such a
 * store path on purpose.
 *
 * Side effect: `prepare` also runs on every `pnpm install` inside this repository.
 */
const sourceOf = {
  '@wormhole/contract': fileURLToPath(new URL('../contract/src/index.ts', import.meta.url)),
  '@wormhole/migrate': fileURLToPath(new URL('../migrate/src/index.ts', import.meta.url)),
};

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
  esbuildOptions(options) {
    options.alias = { ...options.alias, ...sourceOf };
  },
  external: ['vitest'],
  // Types are bundled by rollup.dts.config.mjs (see there for why not tsup's dts).
  dts: false,
  // Ship the contract's JSON schemas too (`@wormhole/sdk/schemas/<name>.schema.json`), so an
  // importer repo can point its manifest's `$schema` or its own validators at them.
  onSuccess: async () => {
    await cp('../contract/schemas', 'dist/schemas', { recursive: true });
  },
});
