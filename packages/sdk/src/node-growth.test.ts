// A file that grows between lstat()/fstat() and the read must be read in full, or rejected once it
// exceeds maxInputBytes. Never silently truncated (GPT review round 4 on PR #1). Separate file
// because it replaces lstat and FileHandle.stat for the whole module: they report a stale, smaller size, which
// is exactly what a concurrent writer looks like.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every byte any read in node.ts pulls off disk, through readFile() or a FileHandle. Lets the
// tests check that a grown file is never loaded far past maxInputBytes (wormhole#10).
const loaded = vi.hoisted(() => ({ bytes: 0, opened: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const content = await actual.readFile(...args);
      loaded.bytes += typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
      return content;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args);
      if (info.isFile()) Object.defineProperty(info, 'size', { value: 1 });
      return info;
    },
    // fstat on the open handle too: an older readBounded sized its buffer from it.
    open: async (...args: Parameters<typeof actual.open>) => {
      loaded.opened.push(String(args[0]));
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
        const info = await stat(...statArgs);
        if (info.isFile()) Object.defineProperty(info, 'size', { value: 1 });
        return info;
      }) as typeof handle.stat;
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        loaded.bytes += result.bytesRead;
        return result;
      }) as typeof handle.read;
      return handle;
    },
  };
});

const { loadInputFromDirectory, loadInputFromFile } = await import('./node.js');
const { SdkDiagnosticCode } = await import('./diagnostics.js');

let root: string;
beforeEach(async () => {
  loaded.bytes = 0;
  loaded.opened = [];
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

  // wormhole#10: the directory loader used to readFile() every planned file in full and
  // only check the total afterwards, so a file that grew after the walk was loaded whole.
  it('loadInputFromDirectory stops reading a grown file at the remaining budget', async () => {
    await writeFile(join(root, 'grown.st'), BIG);
    const result = await loadInputFromDirectory(root, { limits: { maxInputBytes: 1_000 } });
    expect(result.fatal).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain(SdkDiagnosticCode.INPUT_TOO_LARGE);
    expect(loaded.bytes).toBeLessThanOrEqual(1_001);
  });

  it('loadInputFromDirectory bounds later files by what earlier files used', async () => {
    // One file (600 bytes) fits; the other grew to 200 kB but was planned as 1 byte. Whichever
    // the loader reads first, the small one must be read before the big one for this to test
    // the remaining budget: with only 400 bytes left, reading the big file must stop just past
    // that. If every read got the full budget, 600 + 1001 bytes would be loaded.
    // Both orders are tried so the test does not depend on the loader's read order.
    for (const [small, big] of [['a.st', 'b.st'], ['b.st', 'a.st']] as const) {
      await rm(join(root, small), { force: true });
      await rm(join(root, big), { force: true });
      await writeFile(join(root, small), 's'.repeat(600));
      await writeFile(join(root, big), BIG);
      loaded.bytes = 0;
      loaded.opened = [];
      const result = await loadInputFromDirectory(root, { limits: { maxInputBytes: 1_000 } });
      expect(result.fatal).toBe(true);
      expect(result.diagnostics.map((d) => d.code)).toContain(SdkDiagnosticCode.INPUT_TOO_LARGE);
      const order = loaded.opened.map((path) => path.split('/').pop());
      if (order.includes(small) && order.includes(big) && order.indexOf(small) < order.indexOf(big)) {
        expect(loaded.bytes).toBeLessThanOrEqual(1_001);
        return;
      }
    }
    throw new Error('the loader never read the small file before the big one in either layout');
  });

  it('loadInputFromDirectory accepts grown files that still fit the budget exactly', async () => {
    await writeFile(join(root, 'a.st'), 'a'.repeat(600));
    await writeFile(join(root, 'b.st'), 'b'.repeat(400));
    const result = await loadInputFromDirectory(root, { limits: { maxInputBytes: 1_000 } });
    expect(result.fatal).toBe(false);
    expect(result.tree.totalBytes).toBe(1_000);
  });
});
