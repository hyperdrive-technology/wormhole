import { crc32 } from 'node:zlib';

import yauzl from 'yauzl';
import type { ImporterDiagnostic } from '@wormhole/contract';

import { describeThrown, SdkDiagnosticCode, sdkDiagnostic } from './diagnostics.js';
import { DEFAULT_IMPORT_LIMITS, type InputLimits } from './limits.js';
import {
  VirtualFileTree,
  type TreeLoadResult,
  type VirtualFileEntryInput,
} from './tree.js';

export interface ReadZipOptions {
  limits?: Partial<InputLimits>;
  /** Stops reading; the result is then fatal. */
  signal?: AbortSignal;
}

/**
 * Reads a zip archive into a {@link VirtualFileTree} (container `zip`). Never throws for bad
 * input; every problem becomes a diagnostic.
 *
 * Safety rules:
 * - Entry names go through the same `checkRelativePath` rules as every other input path
 *   (no absolute paths, `..`, drive letters, control characters). Backslashes written by
 *   old Windows zip tools are converted to `/` first, as yauzl does by default.
 * - Zip bombs: the declared uncompressed sizes are summed and checked against
 *   `maxInputBytes` *before* anything is inflated, and yauzl's `validateEntrySizes` stops
 *   an entry whose real size differs from its declared size. The archive itself may not be
 *   larger than `maxInputBytes` either.
 * - Every entry's CRC-32 is checked (yauzl leaves that to the caller).
 * - Duplicate names make the archive fatal: different tools would extract different files.
 * - Encrypted entries and compression methods other than store/deflate are skipped with an
 *   error diagnostic.
 * - Nested archives are **not** expanded; a `.zip` inside a zip is an ordinary file. An
 *   importer that needs one can call `readZipTree` on its bytes with its remaining budget.
 */
export async function readZipTree(
  bytes: Uint8Array,
  options: ReadZipOptions = {},
): Promise<TreeLoadResult> {
  const limits: InputLimits = {
    maxInputBytes: options.limits?.maxInputBytes ?? DEFAULT_IMPORT_LIMITS.maxInputBytes,
    maxInputFiles: options.limits?.maxInputFiles ?? DEFAULT_IMPORT_LIMITS.maxInputFiles,
  };
  const fatal = (diagnostic: ImporterDiagnostic, more: ImporterDiagnostic[] = []): TreeLoadResult => ({
    tree: VirtualFileTree.empty('zip'),
    diagnostics: [...more, diagnostic],
    fatal: true,
  });

  if (bytes.byteLength > limits.maxInputBytes) {
    return fatal(
      sdkDiagnostic(
        SdkDiagnosticCode.INPUT_TOO_LARGE,
        'error',
        `Zip archive is larger than ${limits.maxInputBytes} bytes.`,
      ),
    );
  }

  const skipped: ImporterDiagnostic[] = [];
  try {
    const entries = await collectZipEntries(bytes, limits, skipped, options.signal);
    if ('fatal' in entries) return fatal(entries.fatal, skipped);
    const loaded = VirtualFileTree.fromEntries(entries.files, { limits, container: 'zip' });
    return { ...loaded, diagnostics: [...skipped, ...loaded.diagnostics] };
  } catch (error) {
    return fatal(
      sdkDiagnostic(
        SdkDiagnosticCode.INPUT_ZIP_INVALID,
        'error',
        `Could not read zip archive: ${describeThrown(error)}`,
      ),
      skipped,
    );
  }
}

type CollectedEntries = { files: VirtualFileEntryInput[] } | { fatal: ImporterDiagnostic };

/**
 * Walks the central directory with yauzl. yauzl is callback/event based; this wraps it in a
 * single Promise. (Go analogy: like `archive/zip.NewReader`, but async because yauzl
 * streams each entry through zlib.)
 */
function collectZipEntries(
  bytes: Uint8Array,
  limits: InputLimits,
  skipped: ImporterDiagnostic[],
  signal: AbortSignal | undefined,
): Promise<CollectedEntries> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Promise((resolve, reject) => {
    // decodeStrings: false so a bad name becomes our diagnostic instead of a fatal yauzl
    // error; names are decoded with getFileNameLowLevel and validated by fromEntries.
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: false, validateEntrySizes: true },
      (openError, zipfile) => {
        if (openError || !zipfile) {
          reject(openError ?? new Error('zip could not be opened'));
          return;
        }
        const files: VirtualFileEntryInput[] = [];
        let declaredBytes = 0;
        let settled = false;
        const finish = (result: CollectedEntries | Error): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          zipfile.close();
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const onAbort = (): void =>
          finish({
            fatal: sdkDiagnostic(SdkDiagnosticCode.INPUT_ZIP_INVALID, 'error', 'Reading the zip archive was aborted.'),
          });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        zipfile.on('error', (error: Error) => finish(error));
        zipfile.on('end', () => finish({ files }));
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (settled) return;
          const name = yauzl.getFileNameLowLevel(
            entry.generalPurposeBitFlag,
            entry.fileNameRaw,
            entry.extraFields,
            false,
          );
          if (name.endsWith('/')) {
            // Directory entry: nothing to read. Its children carry their own full paths.
            zipfile.readEntry();
            return;
          }
          if (files.length + 1 > limits.maxInputFiles) {
            finish({
              fatal: sdkDiagnostic(
                SdkDiagnosticCode.INPUT_TOO_MANY_FILES,
                'error',
                `Zip archive has more than ${limits.maxInputFiles} files.`,
              ),
            });
            return;
          }
          declaredBytes += entry.uncompressedSize;
          if (declaredBytes > limits.maxInputBytes) {
            finish({
              fatal: sdkDiagnostic(
                SdkDiagnosticCode.INPUT_TOO_LARGE,
                'error',
                `Zip archive expands to more than ${limits.maxInputBytes} bytes.`,
              ),
            });
            return;
          }
          if (!entry.canDecodeFileData()) {
            skipped.push(
              sdkDiagnostic(
                SdkDiagnosticCode.INPUT_ZIP_ENTRY_UNSUPPORTED,
                'error',
                `Skipped zip entry ${JSON.stringify(name)}: ${entry.isEncrypted() ? 'it is encrypted' : `compression method ${entry.compressionMethod} is not supported`}.`,
              ),
            );
            zipfile.readEntry();
            return;
          }
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              finish(streamError ?? new Error(`could not open ${name}`));
              return;
            }
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', (error: Error) => finish(error));
            stream.on('end', () => {
              if (settled) return;
              const content = new Uint8Array(Buffer.concat(chunks));
              if (crc32(content) !== entry.crc32) {
                finish(new Error(`CRC-32 mismatch in entry ${JSON.stringify(name)}`));
                return;
              }
              files.push({ path: name, content });
              zipfile.readEntry();
            });
          });
        });
        zipfile.readEntry();
      },
    );
  });
}
