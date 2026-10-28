// Bundles the SDK's type declarations (tsup builds the JS; see tsup.config.ts).
//
// Why not tsup's own `dts`: when the package is built inside pnpm's store (a GitHub
// install), every path is below a `node_modules` directory. TypeScript then flags each
// resolved module as `isExternalLibraryImport`, and rollup-plugin-dts leaves such imports
// external unless `respectExternal` is set, which tsup does not expose. The result was a
// .d.ts that still said `from '@wormhole/contract'`, which consumers cannot resolve.
// With `respectExternal: true`, Rollup's own `external` list below decides instead.
import { builtinModules } from 'node:module';

import { dts } from 'rollup-plugin-dts';

const external = ['ajv', 'fflate', 'semver', 'yauzl', 'vitest'];

export default {
  input: {
    index: 'src/index.ts',
    node: 'src/node.ts',
    'conformance/index': 'src/conformance/index.ts',
    'conformance/vitest': 'src/conformance/vitest.ts',
  },
  output: { dir: 'dist', format: 'es', entryFileNames: '[name].d.ts', chunkFileNames: '[name]-[hash].d.ts' },
  external: (id) =>
    builtinModules.includes(id) ||
    id.startsWith('node:') ||
    external.some((name) => id === name || id.startsWith(`${name}/`)),
  plugins: [dts({ tsconfig: 'tsconfig.json', respectExternal: true })],
};
