/**
 * Filesystem loaders (`@wormhole/sdk/node`). Hosts use these to turn a path into a
 * {@link VirtualFileTree}; importers never import this module, they only see the tree.
 */
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type { ImporterDiagnostic } from '@wormhole/contract';

import { describeThrown, SdkDiagnosticCode, sdkDiagnostic } from './diagnostics.js';
import { DEFAULT_IMPORT_LIMITS, type InputLimits } from './limits.js';
import {
  VirtualFileTree,
  type InputContainer,
  type TreeLoadResult,
  type VirtualFileEntryInput,
} from './tree.js';
import { readZipTree } from './zip.js';

export interface LoadInputOptions {
  limits?: Partial<InputLimits>;
  signal?: AbortSignal;
  /**
   * `auto` (default): a directory loads as `directory`, a `.zip` file (any case) as `zip`,
   * anything else as `file`. Other zip-based vendor formats load as `file`; their importer
   * opens them with `readZipTree`.
   */
  kind?: 'auto' | InputContainer;
}

function resolveLimits(limits: Partial<InputLimits> | undefined): InputLimits {
  return {
    maxInputBytes: limits?.maxInputBytes ?? DEFAULT_IMPORT_LIMITS.maxInputBytes,
    maxInputFiles: limits?.maxInputFiles ?? DEFAULT_IMPORT_LIMITS.maxInputFiles,
  };
}

function fatal(container: InputContainer, diagnostics: ImporterDiagnostic[]): TreeLoadResult {
  return { tree: VirtualFileTree.empty(container), diagnostics, fatal: true };
}

function unreadable(container: InputContainer, what: string, error: unknown): TreeLoadResult {
  return fatal(container, [
    sdkDiagnostic(SdkDiagnosticCode.INPUT_UNREADABLE, 'error', `Could not read ${what}: ${describeThrown(error)}`),
  ]);
}

/** Loads a file, directory or zip into a tree. Never throws for bad input. */
export async function loadInputFromPath(path: string, options: LoadInputOptions = {}): Promise<TreeLoadResult> {
  let kind = options.kind ?? 'auto';
  if (kind === 'auto') {
    try {
      const info = await lstat(path);
      kind = info.isDirectory() ? 'directory' : extname(path).toLowerCase() === '.zip' ? 'zip' : 'file';
    } catch (error) {
      return unreadable('file', 'input path', error);
    }
  }
  if (kind === 'directory') return loadInputFromDirectory(path, options);
  if (kind === 'zip') return loadInputFromZipFile(path, options);
  return loadInputFromFile(path, options);
}

async function readBounded(path: string, maxBytes: number): Promise<Uint8Array | 'too-large'> {
  // Read at most maxBytes + 1 bytes, so a file that grows after lstat() cannot blow the limit.
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, (await handle.stat()).size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > maxBytes ? 'too-large' : new Uint8Array(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

/** One file → a one-entry tree named after the file's base name (container `file`). */
export async function loadInputFromFile(path: string, options: LoadInputOptions = {}): Promise<TreeLoadResult> {
  const limits = resolveLimits(options.limits);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return fatal('file', [sdkDiagnostic(SdkDiagnosticCode.INPUT_SYMLINK_SKIPPED, 'error', 'Input file is a symbolic link; pass the target instead.')]);
    }
    if (!info.isFile()) {
      return fatal('file', [sdkDiagnostic(SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED, 'error', 'Input is not a regular file.')]);
    }
    if (info.size > limits.maxInputBytes) {
      return fatal('file', [sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Input file is larger than ${limits.maxInputBytes} bytes.`)]);
    }
    const bytes = await readBounded(path, limits.maxInputBytes);
    if (bytes === 'too-large') {
      return fatal('file', [sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Input file is larger than ${limits.maxInputBytes} bytes.`)]);
    }
    return VirtualFileTree.fromFile(basename(path), bytes, { limits });
  } catch (error) {
    return unreadable('file', 'input file', error);
  }
}

/** A zip file on disk → its entries (container `zip`). See `readZipTree` for the rules. */
export async function loadInputFromZipFile(path: string, options: LoadInputOptions = {}): Promise<TreeLoadResult> {
  const limits = resolveLimits(options.limits);
  try {
    const info = await lstat(path);
    if (!info.isFile()) {
      return fatal('zip', [sdkDiagnostic(SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED, 'error', 'Zip input is not a regular file.')]);
    }
    const bytes = await readBounded(path, limits.maxInputBytes);
    if (bytes === 'too-large') {
      return fatal('zip', [sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Zip archive is larger than ${limits.maxInputBytes} bytes.`)]);
    }
    return await readZipTree(bytes, { limits, signal: options.signal });
  } catch (error) {
    return unreadable('zip', 'zip archive', error);
  }
}

/**
 * A directory, recursively (container `directory`). Symbolic links are skipped with a
 * warning (they could point outside the directory), as are sockets, FIFOs and devices.
 * Sizes are checked against the limits before any file content is read.
 */
export async function loadInputFromDirectory(path: string, options: LoadInputOptions = {}): Promise<TreeLoadResult> {
  const limits = resolveLimits(options.limits);
  const diagnostics: ImporterDiagnostic[] = [];
  const planned: Array<{ relative: string; absolute: string }> = [];
  let plannedBytes = 0;
  try {
    const rootInfo = await lstat(path);
    if (!rootInfo.isDirectory()) {
      return fatal('directory', [sdkDiagnostic(SdkDiagnosticCode.INPUT_UNREADABLE, 'error', 'Input is not a directory.')]);
    }
    // Iterative depth-first walk with an explicit stack (no recursion depth limit to hit).
    const stack: string[] = [''];
    while (stack.length > 0) {
      options.signal?.throwIfAborted();
      const relativeDir = stack.pop() as string;
      const entries = await readdir(join(path, relativeDir), { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // reversed: stack pops in order
      for (const entry of entries) {
        const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          diagnostics.push(sdkDiagnostic(SdkDiagnosticCode.INPUT_SYMLINK_SKIPPED, 'warning', `Skipped symbolic link ${JSON.stringify(relative)}.`));
        } else if (entry.isDirectory()) {
          stack.push(relative);
        } else if (entry.isFile()) {
          const absolute = join(path, relative);
          plannedBytes += (await lstat(absolute)).size;
          planned.push({ relative, absolute });
          if (planned.length > limits.maxInputFiles) {
            return fatal('directory', [...diagnostics, sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_MANY_FILES, 'error', `Input directory has more than ${limits.maxInputFiles} files.`)]);
          }
          if (plannedBytes > limits.maxInputBytes) {
            return fatal('directory', [...diagnostics, sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Input directory is larger than ${limits.maxInputBytes} bytes.`)]);
          }
        } else {
          diagnostics.push(sdkDiagnostic(SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED, 'warning', `Skipped special file ${JSON.stringify(relative)}.`));
        }
      }
    }
    const files: VirtualFileEntryInput[] = [];
    for (const item of planned) {
      options.signal?.throwIfAborted();
      files.push({ path: item.relative, content: await readFile(item.absolute) });
    }
    const loaded = VirtualFileTree.fromEntries(files, { limits, container: 'directory' });
    return { ...loaded, diagnostics: [...diagnostics, ...loaded.diagnostics] };
  } catch (error) {
    return unreadable('directory', 'input directory', error);
  }
}

export { readZipTree } from './zip.js';
