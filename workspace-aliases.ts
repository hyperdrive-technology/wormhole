import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Maps every @wormhole/* workspace package to its TypeScript source entry.
 *
 * Package `exports` point at `dist/`, which only exists after `pnpm build`. Vite/Vitest
 * configs use these aliases so a fresh clone can run `pnpm test` and `pnpm dev` without
 * building first, and tests always exercise current sibling sources rather than a stale
 * dist. Keep in sync with the `paths` blocks in each package's tsconfig.json.
 *
 * Order matters: Vite tries aliases in insertion order and a key also matches its subpaths
 * (`@wormhole/sdk` would swallow `@wormhole/sdk/conformance`), so subpath entries come
 * before their package entry.
 */
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export const wormholeSourceAliases: Record<string, string> = {
  '@wormhole/contract': path.join(repoRoot, 'packages/contract/src/index.ts'),
  '@wormhole/migrate': path.join(repoRoot, 'packages/migrate/src/index.ts'),
  '@wormhole/sdk/conformance/vitest': path.join(repoRoot, 'packages/sdk/src/conformance/vitest.ts'),
  '@wormhole/sdk/conformance': path.join(repoRoot, 'packages/sdk/src/conformance/index.ts'),
  '@wormhole/sdk/node': path.join(repoRoot, 'packages/sdk/src/node.ts'),
  '@wormhole/sdk': path.join(repoRoot, 'packages/sdk/src/index.ts'),
  '@wormhole/iec61131-upgrade': path.join(repoRoot, 'packages/iec61131-upgrade/src/index.ts'),
  '@wormhole/service': path.join(repoRoot, 'packages/service/src/index.ts'),
};
