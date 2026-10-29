import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AGENTS.md: packages/contract/schemas/hyperdrive-importer-*.v1 must stay identical to
// Hyperdrive core's docs/schemas/ copy until core consumes this package. Core is a separate
// (private) repo, so this guard only runs when HYPERDRIVE_CORE_DIR points at a checkout:
//   HYPERDRIVE_CORE_DIR=../core pnpm test:schema-sync
// It is opt-in (not defaulted to ../core) so a pending additive change on this side, such as
// `summary` (wormhole#2), does not turn every local `pnpm test` red before core catches up.
const coreDir = process.env.HYPERDRIVE_CORE_DIR;
const coreSchemas = coreDir ? join(coreDir, 'docs/schemas') : undefined;
const ownSchemas = join(dirname(fileURLToPath(import.meta.url)), '../schemas');
const shared = readdirSync(ownSchemas).filter((name) => /^hyperdrive-importer-.*\.v1\.schema\.json$/.test(name)).sort();

describe.skipIf(!coreSchemas || !existsSync(coreSchemas))('contract schemas match Hyperdrive core', () => {
  it('covers every hyperdrive.importer-*.v1 schema', () => {
    expect(shared.length).toBeGreaterThanOrEqual(4);
  });

  it.each(shared)('%s is identical to core', (name) => {
    const core = join(coreSchemas!, name);
    expect(existsSync(core), `${core} is missing`).toBe(true);
    expect(JSON.parse(readFileSync(core, 'utf8'))).toEqual(JSON.parse(readFileSync(join(ownSchemas, name), 'utf8')));
  });
});
