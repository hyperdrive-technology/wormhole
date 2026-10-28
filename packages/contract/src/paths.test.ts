import { describe, expect, it } from 'vitest';

import {
  assertRelativePath,
  checkRelativePath,
  InvalidPathError,
  MAX_PATH_SEGMENT_LENGTH,
  MAX_RELATIVE_PATH_LENGTH,
  type RelativePathCheck,
} from './paths.js';

/** A valid path of exactly `length` code units: 100-char segments joined by `/`, never ending in `/`. */
function pathOfLength(length: number): string {
  let path = '';
  while (path.length < length) {
    const remaining = length - path.length;
    path += path.length === 0 ? 'a'.repeat(Math.min(100, remaining)) : remaining === 1 ? 'b' : `/${'a'.repeat(Math.min(100, remaining - 1))}`;
  }
  return path;
}

/** Asserts the path is accepted and returns the normalised form. */
function accepted(path: unknown, portable = false): string {
  const result = checkRelativePath(path, { portable });
  if (!result.ok) throw new Error(`expected ${JSON.stringify(path)} to be accepted: ${result.reason}`);
  return result.path;
}

/** Asserts the path is rejected and returns the reason. */
function rejected(path: unknown, portable = false): string {
  const result: RelativePathCheck = checkRelativePath(path, { portable });
  if (result.ok) throw new Error(`expected ${JSON.stringify(path)} to be rejected`);
  return result.reason;
}

describe('checkRelativePath: accepted paths', () => {
  it('accepts a simple file name unchanged', () => {
    expect(accepted('main.st')).toBe('main.st');
  });

  it('accepts a nested path unchanged', () => {
    expect(accepted('src/plc/main.st')).toBe('src/plc/main.st');
  });

  it('allows ".." inside a segment name (a..b is not a parent reference)', () => {
    expect(accepted('a..b')).toBe('a..b');
    expect(accepted('dir/a..b.st')).toBe('dir/a..b.st');
    expect(accepted('...')).toBe('...');
  });

  it('strips one leading "./"', () => {
    expect(accepted('./a.st')).toBe('a.st');
  });

  it('strips repeated leading "./" segments', () => {
    expect(accepted('././a.st')).toBe('a.st');
    expect(accepted('./././dir/a.st')).toBe('dir/a.st');
  });

  it('normalises NFD input to NFC', () => {
    const nfd = 'e\u0301.st';
    const path = accepted(nfd);
    expect(path).toBe('\u00e9.st');
    expect(path).toBe(path.normalize('NFC'));
  });

  it('normalises NFD segments inside nested paths', () => {
    expect(accepted('caf\u0065\u0301/A\u030a.st')).toBe('caf\u00e9/\u00c5.st');
  });

  it('accepts a path of exactly the maximum length', () => {
    const path = pathOfLength(MAX_RELATIVE_PATH_LENGTH);
    expect(path.length).toBe(MAX_RELATIVE_PATH_LENGTH);
    expect(accepted(path)).toBe(path);
  });

  it('accepts a segment of exactly the maximum length', () => {
    const segment = 'x'.repeat(MAX_PATH_SEGMENT_LENGTH);
    expect(accepted(`dir/${segment}`)).toBe(`dir/${segment}`);
  });

  it('accepts a colon that is not a drive prefix in non-portable mode', () => {
    expect(accepted('dir/a:b.st')).toBe('dir/a:b.st');
    expect(accepted('ab:c')).toBe('ab:c');
  });
});

describe('checkRelativePath: rejected paths', () => {
  it('rejects the empty string', () => {
    expect(rejected('')).toMatch(/empty/);
  });

  it('rejects a path that is only "./" (empty after stripping)', () => {
    expect(rejected('./')).toMatch(/empty/);
  });

  it.each([undefined, null, 42, {}, ['a'], Symbol.iterator] as unknown[])(
    'rejects a non-string (%s)',
    (value) => {
      const result = checkRelativePath(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('path is not a string');
        expect(typeof result.path).toBe('string');
      }
    },
  );

  it('rejects an absolute path with a leading slash', () => {
    expect(rejected('/etc/passwd')).toMatch(/absolute/);
  });

  it('rejects "./" followed by an absolute path', () => {
    expect(rejected('.//etc/passwd')).toMatch(/absolute/);
  });

  it.each(['C:', 'C:/Windows/system32', 'c:foo', 'z:\u00e9'])('rejects drive prefix %j', (path) => {
    expect(rejected(path)).toMatch(/drive/);
  });

  it.each(['..', '../a', 'a/..', 'a/../b', 'a/b/../../..'])('rejects ".." segment in %j', (path) => {
    expect(rejected(path)).toMatch(/"\.\."/);
  });

  it.each(['.', 'a/./b', 'a/.'])('rejects "." segment in %j', (path) => {
    expect(rejected(path)).toMatch(/"\."/);
  });

  it.each(['a\\b', '..\\evil', 'dir\\file.st', '\\abs'])('rejects backslash in %j', (path) => {
    expect(rejected(path)).toMatch(/backslash/);
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['\\x01', 'a\u0001b'],
    ['\\x1f', 'a\u001fb'],
    ['DEL \\x7f', 'a\u007fb'],
    ['LF', 'a\nb'],
    ['CR', 'a\rb'],
    ['TAB', 'a\tb'],
  ])('rejects control character %s', (_label, path) => {
    expect(rejected(path)).toMatch(/control/);
  });

  it('rejects a trailing separator', () => {
    expect(rejected('dir/')).toMatch(/ends with a separator/);
    expect(rejected('a/b/')).toMatch(/ends with a separator/);
  });

  it('rejects an empty segment ("//")', () => {
    expect(rejected('a//b')).toMatch(/empty segment/);
  });

  it('rejects a path longer than the maximum', () => {
    const path = pathOfLength(MAX_RELATIVE_PATH_LENGTH + 1);
    expect(path.length).toBe(MAX_RELATIVE_PATH_LENGTH + 1);
    expect(rejected(path)).toMatch(/longer than 1024/);
  });

  it('rejects a segment longer than the maximum', () => {
    expect(rejected(`dir/${'x'.repeat(MAX_PATH_SEGMENT_LENGTH + 1)}`)).toMatch(/segment is longer than 255/);
  });

  it('measures length after NFC normalisation (NFD input that shrinks to the limit passes)', () => {
    // 255 NFD "é" (2 code units each) normalise to 255 NFC code units.
    const nfdSegment = 'e\u0301'.repeat(MAX_PATH_SEGMENT_LENGTH);
    expect(nfdSegment.length).toBe(MAX_PATH_SEGMENT_LENGTH * 2);
    expect(accepted(nfdSegment)).toBe('\u00e9'.repeat(MAX_PATH_SEGMENT_LENGTH));
  });

  it('reports the original (un-normalised) path on failure', () => {
    const result = checkRelativePath('./a/../b');
    expect(result).toEqual({ ok: false, path: './a/../b', reason: expect.any(String) });
  });
});

describe('checkRelativePath: portable mode', () => {
  it.each(['<', '>', ':', '"', '|', '?', '*'])('rejects Windows-forbidden character %j', (char) => {
    expect(rejected(`dir/a${char}b.st`, true)).toMatch(/Windows does not allow/);
  });

  it.each(['a.', 'a ', 'dir./x.st', 'dir /x.st', 'x/y.st.'])(
    'rejects segment ending in a dot or space (%j)',
    (path) => {
      expect(rejected(path, true)).toMatch(/ends with a dot or space/);
    },
  );

  it.each(['CON', 'con', 'nul', 'NUL.txt', 'com1', 'COM9.st', 'LPT9.txt', 'lpt1', 'aux.tar.gz', 'Prn', 'dir/Aux.st', 'com\u00b9'])(
    'rejects reserved device name %j (case-insensitive)',
    (path) => {
      expect(rejected(path, true)).toMatch(/reserved Windows device name/);
    },
  );

  it.each(['console.st', 'con1.st', 'nullable.st', 'auxiliary/a.st', 'com10.st', 'lpt.st', 'prn_x.st'])(
    'allows names that merely start like a device name (%j)',
    (path) => {
      expect(accepted(path, true)).toBe(path);
    },
  );

  it.each(['dir/a:b.st', 'a<b', 'a.', 'a ', 'CON', 'nul.txt', 'LPT9.txt', 'aux.tar.gz', 'a|b?c*'])(
    'non-portable mode accepts %j',
    (path) => {
      expect(accepted(path, false)).toBe(path);
    },
  );

  it('portable mode still applies the base rules', () => {
    expect(rejected('../a.st', true)).toMatch(/"\.\."/);
    expect(rejected('a\\b', true)).toMatch(/backslash/);
  });

  it('portable mode still NFC-normalises and strips "./"', () => {
    expect(accepted('./e\u0301.st', true)).toBe('\u00e9.st');
  });
});

describe('assertRelativePath', () => {
  it('returns the normalised path when valid', () => {
    expect(assertRelativePath('./e\u0301/a.st')).toBe('\u00e9/a.st');
  });

  it('throws InvalidPathError with path and reason', () => {
    let caught: unknown;
    try {
      assertRelativePath('../evil');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidPathError);
    expect(caught).toBeInstanceOf(Error);
    const error = caught as InvalidPathError;
    expect(error.name).toBe('InvalidPathError');
    expect(error.path).toBe('../evil');
    expect(error.reason).toMatch(/"\.\."/);
    expect(error.message).toContain('"../evil"');
    expect(error.message).toContain(error.reason);
  });

  it('honours portable mode', () => {
    expect(assertRelativePath('CON')).toBe('CON');
    expect(() => assertRelativePath('CON', { portable: true })).toThrow(InvalidPathError);
  });

  it('throws for a non-string', () => {
    expect(() => assertRelativePath(7)).toThrow(/path is not a string/);
  });
});
