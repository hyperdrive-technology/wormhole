/**
 * Filesystem loaders (`@wormhole/sdk/node`). Hosts use these to turn a path into a
 * {@link VirtualFileTree}; importers never import this module, they only see the tree.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
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

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Which inode a path named when it was walked. A read must open this same file: a path can be
 * swapped for a symbolic link (or another file, or its directory for a symlinked one) between
 * the walk and the read, and following it would load something outside the input
 * (wormhole#15). `bigint` stats so large inode numbers compare exactly.
 *
 * Residual gap: Node has no openat()/O_DIRECTORY-relative walk, so a directory swapped for a
 * symlink and swapped back between the before/after checks in loadInputFromDirectory could
 * still plan files from elsewhere. Closing that needs fd-relative traversal (a native addon
 * or a future Node API).
 */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/** Thrown inside the loaders when a walked path no longer names the walked file. */
class InputChangedError extends Error {}

async function identityOf(path: string): Promise<{ identity: FileIdentity; size: number; isFile: boolean; isSymbolicLink: boolean; isDirectory: boolean }> {
  const info = await lstat(path, { bigint: true });
  return {
    identity: { dev: info.dev, ino: info.ino },
    size: Number(info.size),
    isFile: info.isFile(),
    isSymbolicLink: info.isSymbolicLink(),
    isDirectory: info.isDirectory(),
  };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// O_NOFOLLOW makes open() fail on a symlink in the last path component (ELOOP; EMLINK on
// FreeBSD). Windows has no O_NOFOLLOW (undefined here); the dev+ino check below still applies.
const OPEN_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

async function readBounded(path: string, maxBytes: number, expected: FileIdentity): Promise<Uint8Array | 'too-large'> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, OPEN_NO_FOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new InputChangedError(path);
    throw error;
  }
  try {
    // O_NOFOLLOW does not cover directories higher up the path; the inode check does, since
    // only the walked file has the walked dev+ino.
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(opened, expected)) throw new InputChangedError(path);
    // Read until EOF, but never more than maxBytes + 1 bytes in total, so a file that grows
    // after lstat() can neither blow the limit nor be silently truncated. (An earlier version
    // sized one buffer from stat().size and stopped when it filled, dropping the grown tail:
    // GPT review round 4 on PR #1.)
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return total > maxBytes ? 'too-large' : new Uint8Array(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

function changed(container: InputContainer, what: string, diagnostics: ImporterDiagnostic[] = []): TreeLoadResult {
  return fatal(container, [
    ...diagnostics,
    sdkDiagnostic(
      SdkDiagnosticCode.INPUT_CHANGED,
      'error',
      `${what} changed while it was being loaded (replaced, or swapped for a symbolic link); nothing was loaded. Load it again once it is stable.`,
    ),
  ]);
}

/** One file → a one-entry tree named after the file's base name (container `file`). */
export async function loadInputFromFile(path: string, options: LoadInputOptions = {}): Promise<TreeLoadResult> {
  const limits = resolveLimits(options.limits);
  try {
    const info = await identityOf(path);
    if (info.isSymbolicLink) {
      return fatal('file', [sdkDiagnostic(SdkDiagnosticCode.INPUT_SYMLINK_SKIPPED, 'error', 'Input file is a symbolic link; pass the target instead.')]);
    }
    if (!info.isFile) {
      return fatal('file', [sdkDiagnostic(SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED, 'error', 'Input is not a regular file.')]);
    }
    if (info.size > limits.maxInputBytes) {
      return fatal('file', [sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Input file is larger than ${limits.maxInputBytes} bytes.`)]);
    }
    const bytes = await readBounded(path, limits.maxInputBytes, info.identity);
    if (bytes === 'too-large') {
      return fatal('file', [sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Input file is larger than ${limits.maxInputBytes} bytes.`)]);
    }
    return VirtualFileTree.fromFile(basename(path), bytes, { limits });
  } catch (error) {
    if (error instanceof InputChangedError) return changed('file', 'Input file');
    return unreadable('file', 'input file', error);
  }
}

/** A zip file on disk → its entries (container `zip`). See `readZipTree` for the rules. */
export async function loadInputFromZipFile(path: string, options: LoadInputOptions = {}): Promise<TreeLoadResult> {
  const limits = resolveLimits(options.limits);
  try {
    const info = await identityOf(path);
    if (!info.isFile) {
      return fatal('zip', [sdkDiagnostic(SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED, 'error', 'Zip input is not a regular file.')]);
    }
    const bytes = await readBounded(path, limits.maxInputBytes, info.identity);
    if (bytes === 'too-large') {
      return fatal('zip', [sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Zip archive is larger than ${limits.maxInputBytes} bytes.`)]);
    }
    return await readZipTree(bytes, { limits, signal: options.signal });
  } catch (error) {
    if (error instanceof InputChangedError) return changed('zip', 'Zip archive');
    return unreadable('zip', 'zip archive', error);
  }
}

/**
 * A directory, recursively (container `directory`). Symbolic links are skipped with a
 * warning (they could point outside the directory), as are sockets, FIFOs and devices.
 * Sizes are checked against the limits before any file content is read, and each read is
 * bounded by the remaining byte budget in case a file grew after the walk.
 */
export async function loadInputFromDirectory(path: string, options: LoadInputOptions = {}): Promise<TreeLoadResult> {
  const limits = resolveLimits(options.limits);
  const diagnostics: ImporterDiagnostic[] = [];
  const planned: Array<{ relative: string; absolute: string; identity: FileIdentity }> = [];
  let plannedBytes = 0;
  const tooLarge = (): TreeLoadResult =>
    fatal('directory', [...diagnostics, sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Input directory is larger than ${limits.maxInputBytes} bytes.`)]);
  try {
    const rootInfo = await identityOf(path);
    if (!rootInfo.isDirectory) {
      return fatal('directory', [sdkDiagnostic(SdkDiagnosticCode.INPUT_UNREADABLE, 'error', 'Input is not a directory.')]);
    }
    // Iterative depth-first walk with an explicit stack (no recursion depth limit to hit). Each
    // directory carries the identity it had when its parent listed it; it must still be that
    // directory (not a symlink swapped in) before and after it is listed, so the files planned
    // from it really are inside the input (wormhole#15).
    const stack: Array<{ relative: string; identity: FileIdentity }> = [{ relative: '', identity: rootInfo.identity }];
    while (stack.length > 0) {
      options.signal?.throwIfAborted();
      const { relative: relativeDir, identity: dirIdentity } = stack.pop() as { relative: string; identity: FileIdentity };
      const absoluteDir = join(path, relativeDir);
      const stillSameDirectory = async (): Promise<boolean> => {
        const now = await identityOf(absoluteDir);
        return now.isDirectory && sameIdentity(now.identity, dirIdentity);
      };
      if (!(await stillSameDirectory())) return changed('directory', `Input directory ${JSON.stringify(relativeDir || '.')}`, diagnostics);
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // reversed: stack pops in order
      for (const entry of entries) {
        const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          diagnostics.push(sdkDiagnostic(SdkDiagnosticCode.INPUT_SYMLINK_SKIPPED, 'warning', `Skipped symbolic link ${JSON.stringify(relative)}.`));
        } else if (entry.isDirectory()) {
          const info = await identityOf(join(path, relative));
          if (!info.isDirectory) return changed('directory', `Input directory ${JSON.stringify(relative)}`, diagnostics);
          stack.push({ relative, identity: info.identity });
        } else if (entry.isFile()) {
          const absolute = join(path, relative);
          const info = await identityOf(absolute);
          if (!info.isFile) return changed('directory', `Input file ${JSON.stringify(relative)}`, diagnostics);
          plannedBytes += info.size;
          planned.push({ relative, absolute, identity: info.identity });
          if (planned.length > limits.maxInputFiles) {
            return fatal('directory', [...diagnostics, sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_MANY_FILES, 'error', `Input directory has more than ${limits.maxInputFiles} files.`)]);
          }
          if (plannedBytes > limits.maxInputBytes) return tooLarge();
        } else {
          diagnostics.push(sdkDiagnostic(SdkDiagnosticCode.INPUT_SPECIAL_FILE_SKIPPED, 'warning', `Skipped special file ${JSON.stringify(relative)}.`));
        }
      }
      // The entries above were listed and lstat'ed through this directory's path; if it was
      // swapped while that happened, they may come from somewhere else.
      if (!(await stillSameDirectory())) return changed('directory', `Input directory ${JSON.stringify(relativeDir || '.')}`, diagnostics);
    }
    // The walk's sizes are only a plan: a file can grow before it is read. Each read is
    // therefore bounded by what is left of the cumulative budget, so the loader never holds
    // more than maxInputBytes + 1 bytes however the files change underneath it (wormhole#10).
    const files: VirtualFileEntryInput[] = [];
    let readBytes = 0;
    for (const item of planned) {
      options.signal?.throwIfAborted();
      let content: Uint8Array | 'too-large';
      try {
        content = await readBounded(item.absolute, limits.maxInputBytes - readBytes, item.identity);
      } catch (error) {
        if (error instanceof InputChangedError) return changed('directory', `Input file ${JSON.stringify(item.relative)}`, diagnostics);
        throw error;
      }
      if (content === 'too-large') return tooLarge();
      readBytes += content.byteLength;
      files.push({ path: item.relative, content });
    }
    const loaded = VirtualFileTree.fromEntries(files, { limits, container: 'directory' });
    return { ...loaded, diagnostics: [...diagnostics, ...loaded.diagnostics] };
  } catch (error) {
    return unreadable('directory', 'input directory', error);
  }
}

export { readZipTree } from './zip.js';
