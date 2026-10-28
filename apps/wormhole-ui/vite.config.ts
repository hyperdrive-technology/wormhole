import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

import { wormholeSourceAliases } from '../../workspace-aliases';

export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    alias: wormholeSourceAliases,
  },
  plugins: [
    tsConfigPaths({ projects: ['./tsconfig.json'] }),
    tanstackStart({
      srcDirectory: 'app',
      router: {
        routesDirectory: 'routes',
        generatedRouteTree: 'routeTree.gen.ts',
      },
    }),
  ],
});
