/**
 * Resource limits for one import. The host enforces input limits before the importer
 * runs, output limits after it returns, and wall time with a timer plus the `ctx.signal`
 * (cooperative importers stop early; others are cut off when they return or yield).
 */
export interface ImportLimits {
  /** Total bytes of all input files (after unzipping). */
  maxInputBytes: number;
  /** Number of input files (directories are not counted). */
  maxInputFiles: number;
  /** Total bytes of sources, sidecars, assets and diagnostics the importer may produce. */
  maxOutputBytes: number;
  /** Wall-clock budget for `import()`, in milliseconds. */
  maxWallTimeMs: number;
}

export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxInputFiles: 10_000,
  maxOutputBytes: 128 * 1024 * 1024,
  maxWallTimeMs: 120_000,
});

/** The subset of limits that apply while building an input tree. */
export type InputLimits = Pick<ImportLimits, 'maxInputBytes' | 'maxInputFiles'>;

const LIMIT_KEYS = ['maxInputBytes', 'maxInputFiles', 'maxOutputBytes', 'maxWallTimeMs'] as const;

/**
 * Merges overrides onto `base` and checks every value is a positive safe integer.
 * Throws `RangeError` listing every bad value (limits come from the caller, not the input).
 */
export function resolveImportLimits(
  overrides: Partial<ImportLimits> = {},
  base: Readonly<ImportLimits> = DEFAULT_IMPORT_LIMITS,
): Readonly<ImportLimits> {
  const merged: ImportLimits = { ...base };
  const problems: string[] = [];
  for (const key of Object.keys(overrides)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown limit "${key}"`);
    }
  }
  for (const key of LIMIT_KEYS) {
    const value = overrides[key] ?? base[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      problems.push(`${key} must be a positive integer (got ${String(value)})`);
    }
    merged[key] = value;
  }
  if (problems.length > 0) throw new RangeError(`Invalid import limits: ${problems.join('; ')}`);
  return Object.freeze(merged);
}
