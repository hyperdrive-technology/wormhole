// wormhole#15: a path that is swapped between the walk (lstat/readdir) and the read must not be
// followed. Separate file because it wraps `open` for the whole module: the wrapper performs
// the swap right before the loader opens the file, which is exactly the window an attacker
// with write access to the input directory would race.
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Runs once, just before `open(path)` for a path ending in `target`. */
const swap = vi.hoisted(() => ({ target: '', action: undefined as undefined | (() => Promise<void>) }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const action = swap.action;
      if (action && String(args[0]).endsWith(swap.target)) {
        swap.action = undefined;
        await action();
      }
      return actual.open(...args);
    },
  };
});

const { loadInputFromDirectory, loadInputFromFile, loadInputFromZipFile } = await import('./node.js');
const { SdkDiagnosticCode } = await import('./diagnostics.js');

const SECRET = 'outside the input: must never be loaded';

let root: string;
let input: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wormhole-swap-'));
  input = join(root, 'input');
  outside = join(root, 'outside');
  await mkdir(join(input, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.st'), SECRET);
  await writeFile(join(outside, 'main.st'), SECRET);
  await writeFile(join(input, 'main.st'), 'PROGRAM Main\nEND_PROGRAM\n');
  await writeFile(join(input, 'sub', 'main.st'), 'PROGRAM Sub\nEND_PROGRAM\n');
  swap.target = '';
  swap.action = undefined;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function loadedText(result: Awaited<ReturnType<typeof loadInputFromDirectory>>): string {
  return result.tree.paths().map((path) => new TextDecoder().decode(result.tree.read(path)!)).join('\n');
}

function expectChanged(result: Awaited<ReturnType<typeof loadInputFromDirectory>>): void {
  expect(loadedText(result)).not.toContain(SECRET);
  expect(result.fatal).toBe(true);
  expect(result.tree.fileCount).toBe(0);
  expect(result.diagnostics.map((item) => item.code)).toContain(SdkDiagnosticCode.INPUT_CHANGED);
}

describe('a directory entry swapped between walk and read', () => {
  it('does not follow a file replaced by a symlink', async () => {
    swap.target = join('input', 'main.st');
    swap.action = async () => {
      await unlink(join(input, 'main.st'));
      await symlink(join(outside, 'secret.st'), join(input, 'main.st'));
    };
    expectChanged(await loadInputFromDirectory(input));
  });

  it('does not read a different file moved into its place', async () => {
    swap.target = join('input', 'main.st');
    swap.action = async () => {
      await rename(join(outside, 'secret.st'), join(input, 'main.st'));
    };
    expectChanged(await loadInputFromDirectory(input));
  });

  it('does not follow a parent directory replaced by a symlink (O_NOFOLLOW alone would)', async () => {
    swap.target = join('sub', 'main.st');
    swap.action = async () => {
      await rm(join(input, 'sub'), { recursive: true });
      await symlink(outside, join(input, 'sub'));
    };
    expectChanged(await loadInputFromDirectory(input));
  });

  it('still loads an unchanged directory', async () => {
    const result = await loadInputFromDirectory(input);
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['main.st', 'sub/main.st']);
  });
});

describe('a single input file swapped between lstat and read', () => {
  it('loadInputFromFile does not follow a symlink swapped in', async () => {
    swap.target = join('input', 'main.st');
    swap.action = async () => {
      await unlink(join(input, 'main.st'));
      await symlink(join(outside, 'secret.st'), join(input, 'main.st'));
    };
    expectChanged(await loadInputFromFile(join(input, 'main.st')));
  });

  it('loadInputFromZipFile does not follow a symlink swapped in', async () => {
    await writeFile(join(input, 'a.zip'), 'not really a zip');
    swap.target = join('input', 'a.zip');
    swap.action = async () => {
      await unlink(join(input, 'a.zip'));
      await symlink(join(outside, 'secret.st'), join(input, 'a.zip'));
    };
    const result = await loadInputFromZipFile(join(input, 'a.zip'));
    expect(result.fatal).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toContain(SdkDiagnosticCode.INPUT_CHANGED);
  });
});
