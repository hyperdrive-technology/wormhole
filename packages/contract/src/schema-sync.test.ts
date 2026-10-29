import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AGENTS.md: packages/contract/schemas/hyperdrive-importer-*.v1 must stay identical to
// Hyperdrive core's docs/schemas/ copy until core consumes this package. Core is a separate
// (private) repo, so this guard only runs when HYPERDRIVE_CORE_DIR points at a checkout:
//   HYPERDRIVE_CORE_DIR=../core pnpm test:schema-sync
// It is opt-in (not defaulted to ../core) so a pending additive change on either side (e.g.
// adding `summary`, wormhole#2) does not turn every local `pnpm test` red mid-sync.
//
// A relative HYPERDRIVE_CORE_DIR is resolved against the repository root, not the cwd: the
// pnpm script runs vitest inside packages/contract, where `../core` would silently miss.
// Only an unset variable skips; a set-but-wrong path fails, so the gate cannot pass vacuously
// (GPT review round 4 on PR #1).
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const coreDirEnv = process.env.HYPERDRIVE_CORE_DIR;
const coreSchemas = coreDirEnv ? join(resolve(repoRoot, coreDirEnv), 'docs/schemas') : undefined;
const ownSchemas = join(here, '../schemas');
const shared = readdirSync(ownSchemas).filter((name) => /^hyperdrive-importer-.*\.v1\.schema\.json$/.test(name)).sort();

describe.skipIf(!coreSchemas)('contract schemas match Hyperdrive core', () => {
  it('finds the core checkout named by HYPERDRIVE_CORE_DIR', () => {
    expect(existsSync(coreSchemas!), `${coreSchemas} does not exist; check HYPERDRIVE_CORE_DIR=${coreDirEnv}`).toBe(true);
  });

  it('covers every hyperdrive.importer-*.v1 schema', () => {
    expect(shared.length).toBeGreaterThanOrEqual(4);
  });

  it.each(shared)('%s is identical to core', (name) => {
    const core = join(coreSchemas!, name);
    expect(existsSync(core), `${core} is missing`).toBe(true);
    expect(JSON.parse(readFileSync(core, 'utf8'))).toEqual(JSON.parse(readFileSync(join(ownSchemas, name), 'utf8')));
  });
});
