import { describe, expect, it } from 'vitest';

import { DEFAULT_IMPORT_LIMITS, resolveImportLimits, type ImportLimits } from './limits.js';

function rangeError(fn: () => unknown): RangeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    return error as RangeError;
  }
  throw new Error('expected a RangeError');
}

describe('resolveImportLimits', () => {
  it('returns the defaults with no overrides', () => {
    expect(resolveImportLimits()).toEqual(DEFAULT_IMPORT_LIMITS);
    expect(resolveImportLimits({})).toEqual(DEFAULT_IMPORT_LIMITS);
  });

  it('has sane default values', () => {
    expect(DEFAULT_IMPORT_LIMITS).toEqual({
      maxInputBytes: 64 * 1024 * 1024,
      maxInputFiles: 10_000,
      maxOutputBytes: 128 * 1024 * 1024,
      maxWallTimeMs: 120_000,
    });
    expect(Object.isFrozen(DEFAULT_IMPORT_LIMITS)).toBe(true);
  });

  it('merges overrides onto the defaults', () => {
    expect(resolveImportLimits({ maxInputFiles: 5, maxWallTimeMs: 1 })).toEqual({
      ...DEFAULT_IMPORT_LIMITS,
      maxInputFiles: 5,
      maxWallTimeMs: 1,
    });
  });

  it('merges overrides onto a custom base', () => {
    const base: ImportLimits = { maxInputBytes: 10, maxInputFiles: 2, maxOutputBytes: 20, maxWallTimeMs: 30 };
    expect(resolveImportLimits({ maxInputBytes: 11 }, base)).toEqual({ ...base, maxInputBytes: 11 });
  });

  it('treats an explicit undefined override as "use the base"', () => {
    expect(resolveImportLimits({ maxInputBytes: undefined })).toEqual(DEFAULT_IMPORT_LIMITS);
  });

  it('accepts Number.MAX_SAFE_INTEGER', () => {
    expect(resolveImportLimits({ maxInputBytes: Number.MAX_SAFE_INTEGER }).maxInputBytes).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('returns a frozen object', () => {
    const limits = resolveImportLimits({ maxInputFiles: 3 });
    expect(Object.isFrozen(limits)).toBe(true);
    expect(() => {
      (limits as ImportLimits).maxInputFiles = 4;
    }).toThrow(TypeError);
  });

  it('does not mutate the base', () => {
    const base: ImportLimits = { maxInputBytes: 10, maxInputFiles: 2, maxOutputBytes: 20, maxWallTimeMs: 30 };
    resolveImportLimits({ maxInputBytes: 99 }, base);
    expect(base.maxInputBytes).toBe(10);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['string', '5' as unknown as number],
  ])('rejects a %s value with RangeError', (_label, value) => {
    const error = rangeError(() => resolveImportLimits({ maxInputBytes: value }));
    expect(error.message).toContain('maxInputBytes must be a positive integer');
  });

  it('rejects an unknown key', () => {
    const error = rangeError(() =>
      resolveImportLimits({ maxBananas: 3 } as unknown as Partial<ImportLimits>),
    );
    expect(error.message).toContain('unknown limit "maxBananas"');
  });

  it('lists every problem in one error', () => {
    const error = rangeError(() =>
      resolveImportLimits({
        maxInputBytes: 0,
        maxInputFiles: -1,
        maxOutputBytes: 1.5,
        maxWallTimeMs: Number.NaN,
        typo: 1,
      } as unknown as Partial<ImportLimits>),
    );
    expect(error.message).toContain('unknown limit "typo"');
    expect(error.message).toContain('maxInputBytes must be a positive integer (got 0)');
    expect(error.message).toContain('maxInputFiles must be a positive integer (got -1)');
    expect(error.message).toContain('maxOutputBytes must be a positive integer (got 1.5)');
    expect(error.message).toContain('maxWallTimeMs must be a positive integer (got NaN)');
  });

  it('validates the base too', () => {
    const base = { ...DEFAULT_IMPORT_LIMITS, maxWallTimeMs: 0 };
    const error = rangeError(() => resolveImportLimits({}, base));
    expect(error.message).toContain('maxWallTimeMs');
  });
});
