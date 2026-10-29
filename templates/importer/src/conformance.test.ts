/**
 * The Wormhole conformance kit: one vitest test per check (manifest valid, detect cheap and
 * deterministic, outputs schema-valid, safe paths, byte-identical archives, abort and
 * limits honoured, garbage input diagnosed). Keep it green in CI; a host may refuse an
 * importer that fails it.
 *
 * Fixtures must be self-authored. Never put customer or vendor project files here, even in
 * a private repository: they end up in test logs, CI caches and every clone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeImporterConformance } from '@wormhole/sdk/conformance/vitest';

import importer, { CAPABILITY_ID } from './index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const fixture = (path: string): string => readFileSync(join(fixturesDir, path), 'utf8');

describeImporterConformance(importer, {
  fixtures: [
    { name: 'single tag list', files: { 'plant-tags.csv': fixture('plant-tags.csv') } },
    { name: 'legacy octal values', files: { 'legacy-tags.csv': fixture('legacy-tags.csv') } },
    {
      name: 'project directory',
      files: {
        'area1/pumps.csv': fixture('project/area1/pumps.csv'),
        'area2/valves.csv': fixture('project/area2/valves.csv'),
        'README.txt': fixture('project/README.txt'),
      },
      capabilityId: CAPABILITY_ID,
    },
  ],
});
