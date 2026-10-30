import type { ImporterDiagnostic, ImporterDiagnosticSeverity } from '@wormhole/contract';

/**
 * Diagnostics codes the SDK itself emits, while loading input or running an importer.
 * Importers use their own codes (convention: `<VENDOR>_<TOPIC>`), never these.
 */
export const SdkDiagnosticCode = {
  /** An input path is absolute, contains `..`, a backslash, a control character, ... */
  INPUT_UNSAFE_PATH: 'WORMHOLE_INPUT_UNSAFE_PATH',
  /** Two input entries normalise to the same path. */
  INPUT_DUPLICATE_PATH: 'WORMHOLE_INPUT_DUPLICATE_PATH',
  /** Two input paths differ only by letter case (both are kept). */
  INPUT_CASE_COLLISION: 'WORMHOLE_INPUT_CASE_COLLISION',
  INPUT_TOO_MANY_FILES: 'WORMHOLE_INPUT_TOO_MANY_FILES',
  INPUT_TOO_LARGE: 'WORMHOLE_INPUT_TOO_LARGE',
  INPUT_EMPTY: 'WORMHOLE_INPUT_EMPTY',
  /** The zip could not be read: truncated, not a zip, bad sizes or CRC. */
  INPUT_ZIP_INVALID: 'WORMHOLE_INPUT_ZIP_INVALID',
  /** A zip entry is encrypted or uses a compression method other than store/deflate; it is skipped. */
  INPUT_ZIP_ENTRY_UNSUPPORTED: 'WORMHOLE_INPUT_ZIP_ENTRY_UNSUPPORTED',
  INPUT_SYMLINK_SKIPPED: 'WORMHOLE_INPUT_SYMLINK_SKIPPED',
  INPUT_SPECIAL_FILE_SKIPPED: 'WORMHOLE_INPUT_SPECIAL_FILE_SKIPPED',
  INPUT_UNREADABLE: 'WORMHOLE_INPUT_UNREADABLE',
  /**
   * A file or directory was replaced (or swapped for a symbolic link) between the walk and the
   * read. The load fails instead of reading something other than what was walked.
   */
  INPUT_CHANGED: 'WORMHOLE_INPUT_CHANGED',
  /** The capability does not accept this container kind (file, directory or zip). */
  INPUT_CONTAINER_UNSUPPORTED: 'WORMHOLE_INPUT_CONTAINER_UNSUPPORTED',
  RUN_ABORTED: 'WORMHOLE_RUN_ABORTED',
  RUN_WALL_TIME_EXCEEDED: 'WORMHOLE_RUN_WALL_TIME_EXCEEDED',
  RUN_OUTPUT_TOO_LARGE: 'WORMHOLE_RUN_OUTPUT_TOO_LARGE',
  RUN_IMPORTER_THREW: 'WORMHOLE_RUN_IMPORTER_THREW',
  RUN_INVALID_RESULT: 'WORMHOLE_RUN_INVALID_RESULT',
  RUN_UNSAFE_OUTPUT_PATH: 'WORMHOLE_RUN_UNSAFE_OUTPUT_PATH',
  RUN_NO_SOURCES: 'WORMHOLE_RUN_NO_SOURCES',
} as const;

export type SdkDiagnosticCode = (typeof SdkDiagnosticCode)[keyof typeof SdkDiagnosticCode];

/** Longest message the SDK copies from an untrusted value (exception text, file names). */
const MAX_UNTRUSTED_TEXT = 2000;

export function truncateUntrusted(text: string): string {
  return text.length > MAX_UNTRUSTED_TEXT ? `${text.slice(0, MAX_UNTRUSTED_TEXT)}…` : text;
}

export function sdkDiagnostic(
  code: SdkDiagnosticCode,
  severity: ImporterDiagnosticSeverity,
  message: string,
  extra: { path?: string; details?: string } = {},
): ImporterDiagnostic {
  return {
    code,
    message: truncateUntrusted(message) || code,
    severity,
    ...(extra.path !== undefined ? { source: { path: extra.path } } : {}),
    ...(extra.details !== undefined ? { details: truncateUntrusted(extra.details) } : {}),
  };
}

/** Best-effort, never-throwing string form of an unknown thrown value. */
export function describeThrown(value: unknown): string {
  try {
    if (value instanceof Error) return value.message || value.name || 'Error';
    return String(value);
  } catch {
    return 'unprintable thrown value';
  }
}
