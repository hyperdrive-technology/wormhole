import { cp } from 'node:fs/promises';

import { defineConfig } from 'tsup';

/**
 * `@wormhole/sdk` is the one package an external importer depends on, so its build is
 * self-contained: `@wormhole/contract` and `@wormhole/migrate` (workspace packages that are
 * not published) are bundled into `dist/`, JS and type declarations alike. The result can
 * be packed with `pnpm pack` and installed from a tarball or release asset anywhere.
 */
const bundled = ['@wormhole/contract', '@wormhole/migrate'];

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
