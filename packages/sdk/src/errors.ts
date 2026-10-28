/** Codes of {@link ImporterHostError}. Hosts switch on `code`; messages are for people. */
export type ImporterHostErrorCode =
  /** The registered object lacks `manifest`, `detect` or `import`. */
  | 'INVALID_IMPORTER'
  | 'INVALID_MANIFEST'
  /** The manifest's `sdk` range does not include this SDK's API version. */
  | 'SDK_INCOMPATIBLE'
  | 'DUPLICATE_IMPORTER'
  /** A capability id is already provided by another registered importer. */
  | 'DUPLICATE_CAPABILITY'
  | 'UNKNOWN_IMPORTER'
  | 'UNKNOWN_CAPABILITY'
  /** `run()` was called with invalid limits, options, or the reserved `narratives` field. */
  | 'INVALID_REQUEST';

/**
 * Thrown for host *misuse* (registration problems, unknown ids, malformed requests).
 * Problems with the input or the importer's behaviour never throw: `run()` reports them
 * as a failed outcome with diagnostics.
 */
export class ImporterHostError extends Error {
  readonly code: ImporterHostErrorCode;
  readonly details: readonly string[];

  constructor(code: ImporterHostErrorCode, message: string, details: readonly string[] = []) {
    super(details.length > 0 ? `${message}: ${details.join('; ')}` : message);
    this.name = 'ImporterHostError';
    this.code = code;
    this.details = details;
  }
}
