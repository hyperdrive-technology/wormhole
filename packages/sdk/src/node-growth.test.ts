// A file that grows between lstat()/fstat() and the read must be read in full, or rejected once it
// exceeds maxInputBytes. Never silently truncated (GPT review round 4 on PR #1). Separate file
// because it replaces lstat and FileHandle.stat for the whole module: they report a stale, smaller size, which
// is exactly what a concurrent writer looks like.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args);
      if (info.isFile()) Object.defineProperty(info, 'size', { value: 1 });
      return info;
    },
    // fstat on the open handle too: an older readBounded sized its buffer from it.
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
        const info = await stat(...statArgs);
        if (info.isFile()) Object.defineProperty(info, 'size', { value: 1 });
        return info;
      }) as typeof handle.stat;
      return handle;
    },
  };
});

const { loadInputFromDirectory, loadInputFromFile } = await import('./node.js');
const { SdkDiagnosticCode } = await import('./diagnostics.js');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wormhole-growth-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const GROWN = 'PROGRAM P\nEND_PROGRAM (* grew after lstat *)\n';
// Larger than one 64 KiB read chunk, so the multi-chunk path is exercised too.
const BIG = 'x'.repeat(200_000);

describe('reading a file that grew after lstat()', () => {
  it.each([['small', GROWN], ['multi-chunk', BIG]])('loadInputFromFile returns every byte (%s)', async (_, content) => {
    const path = join(root, 'grown.st');
    await writeFile(path, content);
    const result = await loadInputFromFile(path);
    expect(result.fatal).toBe(false);
    expect(new TextDecoder().decode(result.tree.read('grown.st')!)).toBe(content);
  });

  it('loadInputFromDirectory returns every byte', async () => {
    await writeFile(join(root, 'grown.st'), GROWN);
    const result = await loadInputFromDirectory(root);
    expect(result.fatal).toBe(false);
    expect(new TextDecoder().decode(result.tree.read('grown.st')!)).toBe(GROWN);
  });

  it('rejects instead of truncating once the grown file passes maxInputBytes', async () => {
    const path = join(root, 'grown.st');
    await writeFile(path, GROWN);
    const result = await loadInputFromFile(path, { limits: { maxInputBytes: 10 } });
    expect(result.fatal).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain(SdkDiagnosticCode.INPUT_TOO_LARGE);
  });
});
