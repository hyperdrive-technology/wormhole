import { defineConfig } from 'vitest/config';

import { wormholeSourceAliases } from '../../workspace-aliases';

export default defineConfig({
  resolve: { alias: wormholeSourceAliases },
});
