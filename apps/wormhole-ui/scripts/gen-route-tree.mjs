import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Generator, getConfig } from '@tanstack/router-generator';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = getConfig(
  {
    target: 'react',
    routesDirectory: 'app/routes',
    generatedRouteTree: 'app/routeTree.gen.ts',
  },
  root,
);

const generator = new Generator({ root, config });
await generator.run({ type: 'rerun' });
