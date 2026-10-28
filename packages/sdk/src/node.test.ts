import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SdkDiagnosticCode } from './diagnostics.js';
import {
  loadInputFromDirectory,
  loadInputFromFile,
  loadInputFromPath,
  loadInputFromZipFile,
} from './node.js';
import type { TreeLoadResult } from './tree.js';
import { diagnosticsReportProblems } from './validation.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wormhole-sdk-node-'));
});

afterEach(async () => {
  // Restore permissions first so cleanup can recurse into directories made unreadable.
  await chmod(join(root, 'locked'), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function put(relative: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}

function codes(result: TreeLoadResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function text(result: TreeLoadResult, path: string): string | undefined {
  return result.tree.readText(path)?.text;
}

/** Every load result, fatal or not, carries schema-valid diagnostics. */
function expectValid(result: TreeLoadResult): TreeLoadResult {
  expect(diagnosticsReportProblems({ schemaVersion: 'hyperdrive.importer-diagnostics.v1', diagnostics: result.diagnostics })).toEqual([]);
  return result;
}

function expectFatal(result: TreeLoadResult, code: string): void {
  expectValid(result);
  expect(result.fatal).toBe(true);
  expect(result.tree.fileCount).toBe(0);
  expect(codes(result)).toContain(code);
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('loadInputFromFile', () => {
  it('loads one file named by its base name (container file)', async () => {
    const path = await put('nested/dir/main.st', 'PROGRAM P\nEND_PROGRAM\n');
    const result = expectValid(await loadInputFromFile(path));
    expect(result.fatal).toBe(false);
    expect(result.tree.container).toBe('file');
    expect(result.tree.paths()).toEqual(['main.st']);
    expect(text(result, 'main.st')).toBe('PROGRAM P\nEND_PROGRAM\n');
  });

  it('keeps binary bytes exactly', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    const result = await loadInputFromFile(await put('raw.bin', bytes));
    expect(Array.from(result.tree.read('raw.bin') ?? [])).toEqual([0, 255, 13, 10, 128]);
  });

  it('loads an empty file', async () => {
    const result = expectValid(await loadInputFromFile(await put('empty.st', '')));
    expect(result.fatal).toBe(false);
    expect(result.tree.size('empty.st')).toBe(0);
  });

  it('rejects a file over maxInputBytes and accepts one exactly at it', async () => {
    const path = await put('big.st', 'x'.repeat(100));
    expectFatal(await loadInputFromFile(path, { limits: { maxInputBytes: 99 } }), SdkDiagnosticCode.INPUT_TOO_LARGE);
    expect((await loadInputFromFile(path, { limits: { maxInputBytes: 100 } })).fatal).toBe(false);
  });

  it('rejects a huge sparse file by its size without reading it', async () => {
    const path = join(root, 'huge.st');
    await writeFile(path, '');
    // A 1 TiB sparse file: reading it would take forever, so passing proves the size check
    // happens before any read.
    execFileSync('truncate', ['-s', '1T', path]);
    expectFatal(await loadInputFromFile(path), SdkDiagnosticCode.INPUT_TOO_LARGE);
  });

  it('reports a missing path without throwing', async () => {
    expectFatal(await loadInputFromFile(join(root, 'nope.st')), SdkDiagnosticCode.INPUT_UNREADABLE);
  });

  it('refuses a directory', async () => {
    await mkdir(join(root, 'dir'));
    expectFatal(await loadInputFromFile(join(root, 'dir')), SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED);
  });

  it('refuses a symbolic link (the caller must pass the target)', async () => {
    const target = await put('real.st', 'x');
    await symlink(target, join(root, 'link.st'));
    expectFatal(await loadInputFromFile(join(root, 'link.st')), SdkDiagnosticCode.INPUT_SYMLINK_SKIPPED);
  });

  it.skipIf(isRoot)('reports an unreadable file without throwing', async () => {
    const path = await put('secret.st', 'x');
    await chmod(path, 0o000);
    expectFatal(await loadInputFromFile(path), SdkDiagnosticCode.INPUT_UNREADABLE);
  });
});

describe('loadInputFromDirectory', () => {
  it('walks recursively, sorted, including dotfiles (container directory)', async () => {
    await put('b/two.st', '2');
    await put('a/deep/er/one.st', '1');
    await put('.hidden', 'h');
    await put('top.plc', 't');
    const result = expectValid(await loadInputFromDirectory(root));
    expect(result.fatal).toBe(false);
    expect(result.tree.container).toBe('directory');
    expect(result.tree.paths()).toEqual(['.hidden', 'a/deep/er/one.st', 'b/two.st', 'top.plc']);
    expect(text(result, 'a/deep/er/one.st')).toBe('1');
  });

  it('gives an empty tree with a warning for an empty directory', async () => {
    const result = expectValid(await loadInputFromDirectory(root));
    expect(result.fatal).toBe(false);
    expect(result.tree.fileCount).toBe(0);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_EMPTY]);
  });

  it('skips symbolic links to files and directories without reading their targets', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'wormhole-sdk-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'do not read');
      await put('real.st', 'ok');
      await symlink(join(outside, 'secret.txt'), join(root, 'file-link.txt'));
      await symlink(outside, join(root, 'dir-link'));
      const result = expectValid(await loadInputFromDirectory(root));
      expect(result.fatal).toBe(false);
      expect(result.tree.paths()).toEqual(['real.st']);
      expect(codes(result).filter((code) => code === SdkDiagnosticCode.INPUT_SYMLINK_SKIPPED)).toHaveLength(2);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('skips a FIFO with a special-file warning', async () => {
    await put('real.st', 'ok');
    try {
      execFileSync('mkfifo', [join(root, 'pipe')]);
    } catch {
      return; // mkfifo unavailable on this platform
    }
    const result = expectValid(await loadInputFromDirectory(root));
    expect(result.tree.paths()).toEqual(['real.st']);
    expect(codes(result)).toContain(SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED);
  });

  it('rejects more files than maxInputFiles, and accepts exactly the limit', async () => {
    await put('a.st', 'a');
    await put('b.st', 'b');
    await put('c/d.st', 'd');
    expectFatal(await loadInputFromDirectory(root, { limits: { maxInputFiles: 2 } }), SdkDiagnosticCode.INPUT_TOO_MANY_FILES);
    expect((await loadInputFromDirectory(root, { limits: { maxInputFiles: 3 } })).fatal).toBe(false);
  });

  it('rejects more bytes than maxInputBytes before reading contents', async () => {
    await put('a.st', 'x'.repeat(60));
    await put('b.st', 'y'.repeat(60));
    expectFatal(await loadInputFromDirectory(root, { limits: { maxInputBytes: 100 } }), SdkDiagnosticCode.INPUT_TOO_LARGE);
    expect((await loadInputFromDirectory(root, { limits: { maxInputBytes: 120 } })).fatal).toBe(false);
  });

  it('rejects a huge sparse file in the directory by size', async () => {
    const path = await put('huge.bin', '');
    execFileSync('truncate', ['-s', '1T', path]);
    expectFatal(await loadInputFromDirectory(root), SdkDiagnosticCode.INPUT_TOO_LARGE);
  });

  it('rejects names that are unsafe as input paths (backslash) instead of guessing', async () => {
    await put('dir\\name.st', 'x');
    expectFatal(await loadInputFromDirectory(root), SdkDiagnosticCode.INPUT_UNSAFE_PATH);
  });

  it('reports a missing directory and a file passed as a directory without throwing', async () => {
    expectFatal(await loadInputFromDirectory(join(root, 'missing')), SdkDiagnosticCode.INPUT_UNREADABLE);
    expectFatal(await loadInputFromDirectory(await put('file.st', 'x')), SdkDiagnosticCode.INPUT_UNREADABLE);
  });

  it.skipIf(isRoot)('reports an unreadable sub-directory without throwing', async () => {
    await put('locked/inner.st', 'x');
    await chmod(join(root, 'locked'), 0o000);
    expectFatal(await loadInputFromDirectory(root), SdkDiagnosticCode.INPUT_UNREADABLE);
  });

  it('stops when the signal is aborted', async () => {
    await put('a.st', 'a');
    const controller = new AbortController();
    controller.abort();
    expectFatal(await loadInputFromDirectory(root, { signal: controller.signal }), SdkDiagnosticCode.INPUT_UNREADABLE);
  });
});

describe('loadInputFromZipFile', () => {
  it('reads a zip on disk (container zip)', async () => {
    const path = await put('upload.zip', zipSync({ 'src/main.st': strToU8('PROGRAM P\nEND_PROGRAM\n'), 'README.md': strToU8('r') }));
    const result = expectValid(await loadInputFromZipFile(path));
    expect(result.fatal).toBe(false);
    expect(result.tree.container).toBe('zip');
    expect(result.tree.paths()).toEqual(['README.md', 'src/main.st']);
  });

  it('rejects a zip file larger than maxInputBytes', async () => {
    const path = await put('upload.zip', zipSync({ 'a.st': strToU8('x'.repeat(500)) }, { level: 0 }));
    expectFatal(await loadInputFromZipFile(path, { limits: { maxInputBytes: 100 } }), SdkDiagnosticCode.INPUT_TOO_LARGE);
  });

  it('reports a corrupt zip without throwing', async () => {
    expectFatal(await loadInputFromZipFile(await put('bad.zip', 'not a zip at all')), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('reports a missing zip without throwing', async () => {
    expectFatal(await loadInputFromZipFile(join(root, 'missing.zip')), SdkDiagnosticCode.INPUT_UNREADABLE);
  });

  it('refuses a directory passed as a zip', async () => {
    await mkdir(join(root, 'dir.zip'));
    expectFatal(await loadInputFromZipFile(join(root, 'dir.zip')), SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED);
  });
});

describe('loadInputFromPath', () => {
  it('auto-detects a directory, a .zip (any case) and a plain file', async () => {
    await put('project/a.st', 'a');
    const zipBytes = zipSync({ 'z.st': strToU8('z') });
    await put('upper.ZIP', zipBytes);
    await put('lower.zip', zipBytes);
    await put('single.st', 's');
    expect((await loadInputFromPath(join(root, 'project'))).tree.container).toBe('directory');
    expect((await loadInputFromPath(join(root, 'upper.ZIP'))).tree.paths()).toEqual(['z.st']);
    expect((await loadInputFromPath(join(root, 'lower.zip'))).tree.container).toBe('zip');
    expect((await loadInputFromPath(join(root, 'single.st'))).tree.container).toBe('file');
  });

  it('honours an explicit kind (a .zip loaded as one opaque file)', async () => {
    await put('upload.zip', zipSync({ 'z.st': strToU8('z') }));
    const result = await loadInputFromPath(join(root, 'upload.zip'), { kind: 'file' });
    expect(result.tree.container).toBe('file');
    expect(result.tree.paths()).toEqual(['upload.zip']);
  });

  it('treats other zip-based formats as plain files', async () => {
    await put('project.axp', zipSync({ 'inner.xml': strToU8('<x/>') }));
    const result = await loadInputFromPath(join(root, 'project.axp'));
    expect(result.tree.paths()).toEqual(['project.axp']);
  });

  it('reports a missing path without throwing', async () => {
    expectFatal(await loadInputFromPath(join(root, 'missing')), SdkDiagnosticCode.INPUT_UNREADABLE);
  });

  it('passes limits through to every loader', async () => {
    await put('dir/a.st', 'x'.repeat(10));
    expectFatal(await loadInputFromPath(join(root, 'dir'), { limits: { maxInputBytes: 5 } }), SdkDiagnosticCode.INPUT_TOO_LARGE);
  });
});
