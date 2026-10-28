import { defineConfig } from 'vitest/config';

import { wormholeSourceAliases } from '../../workspace-aliases';

export default defineConfig({
  resolve: { alias: wormholeSourceAliases },
  // The importer template is not a workspace package; its tests run here against SDK sources.
  test: { include: ['src/**/*.test.ts', '../../templates/importer/src/**/*.test.ts'] },
});
