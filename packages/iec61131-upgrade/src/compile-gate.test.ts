import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { upgradeIec61131Source } from './upgrade.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/legacy');
// The compile gate needs a checkout of Hyperdrive core next to this repo (or at
// HYPERDRIVE_CORE_DIR). Public CI has no core checkout, so the gate skips there and
// runs in core-aware environments via `pnpm test:compile-gate`.
const coreDir =
  process.env.HYPERDRIVE_CORE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '../../../../core');
const compilerEntry = join(
  coreDir,
  'src/typescript/packages/hyperdrive-ui/app/workers/hyperdrive-compiler/index.ts',
);

describe.skipIf(!existsSync(compilerEntry))('@wormhole/iec61131-upgrade compile gate', () => {
  it('compiles upgraded legacy source in import mode', async () => {
    const { compileHyperdriveProgram } = await import(compilerEntry);
    const content = readFileSync(join(fixturesDir, 'tier-a-legacy.plc'), 'utf8');
    const upgraded = upgradeIec61131Source(content, {
      sourceKind: 'st',
      fileName: 'tier-a-legacy.st',
      apply: true,
    });

    const result = compileHyperdriveProgram({
      fileName: 'tier-a-legacy.st',
      content: upgraded.source,
    });

    expect(result.success).toBe(true);
  });
});
