import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeImporterConformance } from '@wormhole/sdk/conformance/vitest';

import { iec61131UpgradeImporter } from './importer.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/legacy');
const tierA = readFileSync(join(fixturesDir, 'tier-a-legacy.plc'), 'utf8');
const il = readFileSync(join(fixturesDir, 'il-legacy.st'), 'utf8');

describeImporterConformance(iec61131UpgradeImporter, {
  fixtures: [
    { name: 'tier-a single file', files: { 'tier-a-legacy.plc': tierA } },
    { name: 'IL single file', files: { 'il-legacy.st': il } },
    {
      name: 'project directory',
      files: { 'src/tier-a-legacy.plc': tierA, 'src/il/il-legacy.st': il, 'README.txt': 'not source\n' },
      capabilityId: 'iec61131-ed4-upgrade',
    },
  ],
});
