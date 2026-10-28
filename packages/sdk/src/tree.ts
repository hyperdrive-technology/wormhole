import { createHash } from 'node:crypto';

import { checkRelativePath, type ImporterDiagnostic } from '@wormhole/contract';

import { SdkDiagnosticCode, sdkDiagnostic } from './diagnostics.js';
import { DEFAULT_IMPORT_LIMITS, type InputLimits } from './limits.js';
import { decodeText, type DecodeTextOptions, type DecodedText } from './text.js';

/** How the input arrived. Capabilities declare which containers they accept. */
export type InputContainer = 'file' | 'directory' | 'zip';

export interface VirtualFileEntryInput {
  path: string;
  /** Strings are encoded as UTF-8. */
  content: Uint8Array | string;
}

export interface TreeLoadOptions {
  /** Input limits enforced while building; defaults to `DEFAULT_IMPORT_LIMITS`. */
  limits?: Partial<InputLimits>;
  /** Recorded on the tree; defaults to `directory`. */
  container?: InputContainer;
}

/**
 * Result of building an input tree. Loading never throws for bad input: problems become
 * diagnostics. `fatal` means the input was rejected (unsafe or duplicate paths, limits
 * exceeded, unreadable archive); `tree` is then empty and the host refuses to run.
 */
export interface TreeLoadResult {
  tree: VirtualFileTree;
  diagnostics: ImporterDiagnostic[];
  fatal: boolean;
}

/** Called for every read through a tree view, with the number of bytes handed out. */
export type TreeReadObserver = (path: string, bytes: number) => void;

/** At most this many path problems are reported individually before loading stops. */
const MAX_REPORTED_PATH_PROBLEMS = 20;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveInputLimits(limits: Partial<InputLimits> | undefined): InputLimits {
  const resolved = {
    maxInputBytes: limits?.maxInputBytes ?? DEFAULT_IMPORT_LIMITS.maxInputBytes,
    maxInputFiles: limits?.maxInputFiles ?? DEFAULT_IMPORT_LIMITS.maxInputFiles,
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${key} must be a positive integer (got ${String(value)})`);
    }
  }
  return resolved;
}

/**
 * An immutable, in-memory, read-only file tree: relative `/`-separated path → bytes.
 *
 * Importers receive this instead of filesystem access, so the same importer runs on an
 * uploaded file, a directory or a zip, in a server or a test, and can never read outside
 * its input. Paths are validated and NFC-normalised on the way in; reads return copies,
 * so an importer cannot change what the host (or a second run) sees.
 */
export class VirtualFileTree {
  readonly container: InputContainer;
  readonly totalBytes: number;
  readonly #files: ReadonlyMap<string, Uint8Array>;
  readonly #paths: readonly string[];
  readonly #observer: TreeReadObserver | undefined;

  private constructor(
    container: InputContainer,
    files: ReadonlyMap<string, Uint8Array>,
    paths: readonly string[],
    totalBytes: number,
    observer?: TreeReadObserver,
  ) {
    this.container = container;
    this.#files = files;
    this.#paths = paths;
    this.totalBytes = totalBytes;
    this.#observer = observer;
  }

  /** An empty tree. */
  static empty(container: InputContainer = 'directory'): VirtualFileTree {
    return new VirtualFileTree(container, new Map(), Object.freeze([]), 0);
  }

  /**
   * Builds a tree from entries (in any order). Entries are validated with the shared
   * `checkRelativePath` rules; unsafe or duplicate paths and exceeded limits make the load
   * fatal. Paths that differ only by case are kept, with a warning.
   */
  static fromEntries(
    entries: Iterable<VirtualFileEntryInput>,
    options: TreeLoadOptions = {},
  ): TreeLoadResult {
    const container = options.container ?? 'directory';
    const limits = resolveInputLimits(options.limits);
    const diagnostics: ImporterDiagnostic[] = [];
    const files = new Map<string, Uint8Array>();
    const byLowerCase = new Map<string, string>();
    const encoder = new TextEncoder();
    let totalBytes = 0;
    let pathProblems = 0;
    let fatal = false;

    const reject = (diagnostic: ImporterDiagnostic): void => {
      diagnostics.push(diagnostic);
      fatal = true;
    };

    for (const entry of entries) {
      if (pathProblems >= MAX_REPORTED_PATH_PROBLEMS) {
        reject(
          sdkDiagnostic(
            SdkDiagnosticCode.INPUT_UNSAFE_PATH,
            'error',
            `Stopped after ${MAX_REPORTED_PATH_PROBLEMS} path problems; the input was rejected.`,
          ),
        );
        break;
      }
      const checked = checkRelativePath(entry.path);
      if (!checked.ok) {
        pathProblems += 1;
        reject(
          sdkDiagnostic(
            SdkDiagnosticCode.INPUT_UNSAFE_PATH,
            'error',
            `Rejected input entry ${JSON.stringify(checked.path)}: ${checked.reason}.`,
          ),
        );
        continue;
      }
      if (files.has(checked.path)) {
        pathProblems += 1;
        reject(
          sdkDiagnostic(
            SdkDiagnosticCode.INPUT_DUPLICATE_PATH,
            'error',
            `Input contains ${JSON.stringify(checked.path)} more than once; the input was rejected because it is ambiguous.`,
            { path: checked.path },
          ),
        );
        continue;
      }
      if (files.size + 1 > limits.maxInputFiles) {
        reject(
          sdkDiagnostic(
            SdkDiagnosticCode.INPUT_TOO_MANY_FILES,
            'error',
            `Input has more than ${limits.maxInputFiles} files.`,
          ),
        );
        break;
      }
      const bytes =
        typeof entry.content === 'string'
          ? encoder.encode(entry.content)
          : new Uint8Array(entry.content); // copy: later caller mutations must not leak in
      if (totalBytes + bytes.byteLength > limits.maxInputBytes) {
        reject(
          sdkDiagnostic(
            SdkDiagnosticCode.INPUT_TOO_LARGE,
            'error',
            `Input is larger than ${limits.maxInputBytes} bytes.`,
          ),
        );
        break;
      }
      const lower = checked.path.toLowerCase();
      const caseTwin = byLowerCase.get(lower);
      if (caseTwin !== undefined) {
        diagnostics.push(
          sdkDiagnostic(
            SdkDiagnosticCode.INPUT_CASE_COLLISION,
            'warning',
            `Input paths ${JSON.stringify(caseTwin)} and ${JSON.stringify(checked.path)} differ only by case; they would overwrite each other on Windows or macOS.`,
            { path: checked.path },
          ),
        );
      } else {
        byLowerCase.set(lower, checked.path);
      }
      files.set(checked.path, bytes);
      totalBytes += bytes.byteLength;
    }

    if (fatal) {
      return { tree: VirtualFileTree.empty(container), diagnostics, fatal };
    }
    if (files.size === 0) {
      diagnostics.push(
        sdkDiagnostic(SdkDiagnosticCode.INPUT_EMPTY, 'warning', 'Input contains no files.'),
      );
    }
    const paths = Object.freeze([...files.keys()].sort(compareCodeUnits));
    return {
      tree: new VirtualFileTree(container, files, paths, totalBytes),
      diagnostics,
      fatal: false,
    };
  }

  /** A one-file tree (container `file`). `name` is usually the upload's file name. */
  static fromFile(
    name: string,
    content: Uint8Array | string,
    options: Omit<TreeLoadOptions, 'container'> = {},
  ): TreeLoadResult {
    return VirtualFileTree.fromEntries([{ path: name, content }], {
      ...options,
      container: 'file',
    });
  }

  get fileCount(): number {
    return this.#paths.length;
  }

  /** Every file path, sorted by UTF-16 code unit (locale-independent). */
  paths(): readonly string[] {
    return this.#paths;
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  /** Size in bytes, or `undefined` if there is no such file. */
  size(path: string): number | undefined {
    return this.#files.get(path)?.byteLength;
  }

  /** A copy of the file's bytes, or `undefined` if there is no such file. */
  read(path: string): Uint8Array | undefined {
    const bytes = this.#files.get(path);
    if (bytes === undefined) return undefined;
    this.#observer?.(path, bytes.byteLength);
    return bytes.slice();
  }

  /**
   * A copy of at most the first `maxBytes` bytes. Use this in `detect()`: sniffing a
   * header is cheap, reading a whole project is not.
   */
  head(path: string, maxBytes: number): Uint8Array | undefined {
    const bytes = this.#files.get(path);
    if (bytes === undefined) return undefined;
    const slice = bytes.slice(0, Math.max(0, Math.floor(maxBytes)));
    this.#observer?.(path, slice.byteLength);
    return slice;
  }

  /** Decodes the file as text (see `decodeText`), or `undefined` if there is no such file. */
  readText(path: string, options?: DecodeTextOptions): DecodedText | undefined {
    const bytes = this.read(path);
    return bytes === undefined ? undefined : decodeText(bytes, options);
  }

  /** Paths whose extension matches one of `extensions` (case-insensitive, with the dot). */
  pathsWithExtension(...extensions: string[]): string[] {
    const wanted = extensions.map((extension) => extension.toLowerCase());
    return this.#paths.filter((path) => {
      const lower = path.toLowerCase();
      return wanted.some((extension) => lower.endsWith(extension));
    });
  }

  /** Entries in path order. Bytes are copies. Useful for re-zipping or for tests. */
  entries(): Array<{ path: string; content: Uint8Array }> {
    return this.#paths.map((path) => ({ path, content: this.read(path) as Uint8Array }));
  }

  /**
   * SHA-256 over every file in path order, as `path NUL byteLength NUL bytes`. Used as the
   * result manifest's `sourceFingerprint`; independent of how the tree was built.
   */
  fingerprint(): string {
    const hash = createHash('sha256');
    for (const path of this.#paths) {
      const bytes = this.#files.get(path) as Uint8Array;
      hash.update(path, 'utf8');
      hash.update('\0');
      hash.update(String(bytes.byteLength));
      hash.update('\0');
      hash.update(bytes);
    }
    return hash.digest('hex');
  }

  /** A view of the same files that reports every read; used to check `detect()` is cheap. */
  withReadObserver(observer: TreeReadObserver): VirtualFileTree {
    return new VirtualFileTree(this.container, this.#files, this.#paths, this.totalBytes, observer);
  }
}
