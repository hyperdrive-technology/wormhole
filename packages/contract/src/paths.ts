/**
 * Path validation shared by every place Wormhole handles a path it did not choose itself:
 * entries of an uploaded zip, files of an input directory, and the paths an importer asks
 * to write into a result archive.
 *
 * The rules are deliberately stricter than the JSON schemas' `not: { pattern }` guards
 * (which only reject a leading `/`, `..` segments and backslashes): an archive written by
 * Wormhole must extract safely on Linux, macOS and Windows, so `portable` mode also rejects
 * names Windows cannot create.
 */

/** Longest path accepted, in UTF-16 code units, after normalisation. */
export const MAX_RELATIVE_PATH_LENGTH = 1024;
/** Longest single path segment accepted (most filesystems cap a name at 255 bytes). */
export const MAX_PATH_SEGMENT_LENGTH = 255;

export interface RelativePathOptions {
  /**
   * Also reject names that cannot be created on Windows: `<>:"|?*`, segments ending in a dot
   * or space, and reserved device names (`CON`, `NUL`, `COM1`, `lpt9.txt`, ...). Use this for
   * paths written into result archives. Input trees accept these names because they come
   * from systems that allow them, and they never touch the host filesystem.
   */
  portable?: boolean;
}

export type RelativePathCheck =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Normalises and validates a relative, `/`-separated path.
 *
 * Normalisation is limited to things that cannot change which file is meant: Unicode NFC
 * (macOS writes NFD names) and stripping leading `./` segments. Everything else that is
 * odd is rejected rather than "fixed", so two different inputs can never normalise to the
 * same path by accident.
 */
export function checkRelativePath(
  path: unknown,
  options: RelativePathOptions = {},
): RelativePathCheck {
  if (typeof path !== 'string') {
    return { ok: false, path: String(path), reason: 'path is not a string' };
  }
  const original = path;
  const fail = (reason: string): RelativePathCheck => ({ ok: false, path: original, reason });

  let normalized = path.normalize('NFC');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);

  if (normalized.length === 0) return fail('path is empty');
  if (normalized.length > MAX_RELATIVE_PATH_LENGTH) {
    return fail(`path is longer than ${MAX_RELATIVE_PATH_LENGTH} characters`);
  }
  if (CONTROL_CHARS.test(normalized)) return fail('path contains a control character');
  if (normalized.includes('\\')) return fail('path contains a backslash');
  if (normalized.startsWith('/')) return fail('path is absolute');
  if (DRIVE_PREFIX.test(normalized)) return fail('path starts with a drive letter');
  if (normalized.endsWith('/')) return fail('path ends with a separator');

  for (const segment of normalized.split('/')) {
    if (segment.length === 0) return fail('path contains an empty segment');
    if (segment === '.' || segment === '..') return fail(`path contains a "${segment}" segment`);
    if (segment.length > MAX_PATH_SEGMENT_LENGTH) {
      return fail(`path segment is longer than ${MAX_PATH_SEGMENT_LENGTH} characters`);
    }
    if (options.portable) {
      if (WINDOWS_FORBIDDEN_CHARS.test(segment)) {
        return fail(`path segment "${segment}" contains a character Windows does not allow`);
      }
      if (/[. ]$/.test(segment)) {
        return fail(`path segment "${segment}" ends with a dot or space`);
      }
      if (WINDOWS_RESERVED_NAME.test(segment)) {
        return fail(`path segment "${segment}" is a reserved Windows device name`);
      }
    }
  }

  return { ok: true, path: normalized };
}

/** Like {@link checkRelativePath} but throws `InvalidPathError` instead of returning a result. */
export function assertRelativePath(path: unknown, options: RelativePathOptions = {}): string {
  const result = checkRelativePath(path, options);
  if (!result.ok) throw new InvalidPathError(result.path, result.reason);
  return result.path;
}

export class InvalidPathError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`Invalid path ${JSON.stringify(path)}: ${reason}`);
    this.name = 'InvalidPathError';
    this.path = path;
    this.reason = reason;
  }
}
