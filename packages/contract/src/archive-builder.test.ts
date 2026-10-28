import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildImporterArchive,
  buildImporterResultArchive,
  ImporterArchiveError,
  zipDeterministic,
} from './archive.js';
import type { BuildImporterArchiveInput, BuildImporterResultArchiveInput } from './types.js';

const MANIFEST: BuildImporterArchiveInput['manifest'] = {
  importerId: 'acme-importer',
  importerVersion: '1.2.3',
  vendorFamily: 'acme',
  sourceFingerprint: 'f'.repeat(64),
};

const DIAGNOSTICS: BuildImporterArchiveInput['diagnostics'] = {
  schemaVersion: 'hyperdrive.importer-diagnostics.v1',
  diagnostics: [{ code: 'ACME_NOTE', message: 'hello', severity: 'info' }],
};

function input(overrides: Partial<BuildImporterArchiveInput> = {}): BuildImporterArchiveInput {
  return {
    manifest: MANIFEST,
    sources: { 'sources/main.plc': 'PROGRAM Main\nEND_PROGRAM\n' },
    diagnostics: DIAGNOSTICS,
    ...overrides,
  };
}

/** Builds and returns the thrown ImporterArchiveError (fails the test if none is thrown). */
function archiveError(value: BuildImporterArchiveInput): ImporterArchiveError {
  try {
    buildImporterArchive(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ImporterArchiveError);
    return error as ImporterArchiveError;
  }
  throw new Error('expected buildImporterArchive to throw');
}

/** Entry names in central-directory order, as written. */
/** Entry names in central-directory order (not via an object, whose key order is not insertion order). */
function zipEntryNames(zip: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(zip, {
    filter: (file) => {
      names.push(file.name);
      return false;
    },
  });
  return names;
}

const BINARY = new Uint8Array([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x1a, 0xfe, 0x00, 0x7f]);

describe('buildImporterArchive: layout and manifest', () => {
  it('lists sorted sources, preservation and assets in the manifest', () => {
    const built = buildImporterArchive(
      input({
        sources: {
          'sources/z.plc': 'Z',
          'sources/a/b.plc': 'AB',
          'sources/A.plc': 'upper A',
        },
        preservation: { 'preservation/z.txt': 'z', 'preservation/a.txt': 'a' },
        assets: { 'assets/y.bin': BINARY, 'assets/b.png': new Uint8Array([1]) },
      }),
    );
    // Code-unit order: uppercase sorts before lowercase.
    expect(built.manifest.canonicalSources).toEqual(['sources/A.plc', 'sources/a/b.plc', 'sources/z.plc']);
    expect(built.manifest.preservation).toEqual(['preservation/a.txt', 'preservation/z.txt']);
    expect(built.manifest.assets).toEqual(['assets/b.png', 'assets/y.bin']);
    expect(built.manifest.diagnostics).toBe('diagnostics.json');
    expect(built.manifest.schemaVersion).toBe('hyperdrive.importer-result.v1');
  });

  it('writes manifest.json then diagnostics.json first, then sources, preservation, assets', () => {
    const built = buildImporterArchive(
      input({
        sources: { 'sources/b.plc': 'B', 'sources/a.plc': 'A' },
        preservation: { 'preservation/p.txt': 'p' },
        assets: { 'assets/a.bin': BINARY },
      }),
    );
    const expected = [
      'manifest.json',
      'diagnostics.json',
      'sources/a.plc',
      'sources/b.plc',
      'preservation/p.txt',
      'assets/a.bin',
    ];
    expect(built.entries.map((entry) => entry.path)).toEqual(expected);
    expect(zipEntryNames(built.zipBytes)).toEqual(expected);
  });

  it('writes manifest.json matching the returned manifest, with a trailing newline', () => {
    const built = buildImporterArchive(input());
    const files = unzipSync(built.zipBytes);
    const text = strFromU8(files['manifest.json']);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(built.manifest);
  });

  it('writes diagnostics.json verbatim from the input report', () => {
    const built = buildImporterArchive(input());
    expect(JSON.parse(strFromU8(unzipSync(built.zipBytes)['diagnostics.json']))).toEqual(DIAGNOSTICS);
  });

  it('omits optional manifest fields when empty', () => {
    const built = buildImporterArchive(
      input({
        manifest: { ...MANIFEST, unsupportedSemantics: [] },
        preservation: {},
        assets: {},
      }),
    );
    expect(Object.keys(built.manifest)).toEqual([
      'schemaVersion',
      'importerId',
      'importerVersion',
      'vendorFamily',
      'sourceFingerprint',
      'canonicalSources',
      'diagnostics',
    ]);
    const written = JSON.parse(strFromU8(unzipSync(built.zipBytes)['manifest.json']));
    for (const key of ['assets', 'preservation', 'unsupportedSemantics', 'summary']) {
      expect(written).not.toHaveProperty(key);
    }
  });

  it('includes unsupportedSemantics and summary when given', () => {
    const built = buildImporterArchive(
      input({
        manifest: {
          ...MANIFEST,
          unsupportedSemantics: [{ code: 'ACME_IL', message: 'IL preserved', severity: 'warning' }],
          summary: { message: 'Imported 1 file.', stats: { files: 1 } },
        },
      }),
    );
    expect(built.manifest.unsupportedSemantics).toEqual([
      { code: 'ACME_IL', message: 'IL preserved', severity: 'warning' },
    ]);
    expect(built.manifest.summary).toEqual({ message: 'Imported 1 file.', stats: { files: 1 } });
  });

  it('does not copy unknown manifest fields from the input', () => {
    const built = buildImporterArchive(
      input({ manifest: { ...MANIFEST, extra: 'nope' } as BuildImporterArchiveInput['manifest'] }),
    );
    expect(built.manifest).not.toHaveProperty('extra');
  });

  it('normalises a leading "./" and NFD in source paths', () => {
    const built = buildImporterArchive(input({ sources: { './sources/e\u0301.plc': 'x' } }));
    expect(built.manifest.canonicalSources).toEqual(['sources/\u00e9.plc']);
    expect(zipEntryNames(built.zipBytes)).toContain('sources/\u00e9.plc');
  });

  it('keeps the same tail in different sections (no cross-section collision)', () => {
    const built = buildImporterArchive(
      input({
        sources: { 'sources/x.plc': 's' },
        preservation: { 'preservation/sources/x.plc': 'p' },
        assets: { 'assets/sources/x.plc': 'a' },
      }),
    );
    expect(built.entries).toHaveLength(5);
  });
});

describe('buildImporterArchive: content', () => {
  it('writes UTF-8 text', () => {
    const text = 'PROGRAM Main // caf\u00e9 \u2192 \u{1f37a}\nEND_PROGRAM\n';
    const built = buildImporterArchive(input({ sources: { 'sources/main.plc': text } }));
    const bytes = unzipSync(built.zipBytes)['sources/main.plc'];
    expect(bytes).toEqual(new TextEncoder().encode(text));
    expect(strFromU8(bytes)).toBe(text);
  });

  it('writes Uint8Array content verbatim (binary sidecar round-trips)', () => {
    const built = buildImporterArchive(
      input({ preservation: { 'preservation/blob.bin': BINARY }, assets: { 'assets/raw.bin': BINARY } }),
    );
    const files = unzipSync(built.zipBytes);
    expect(Array.from(files['preservation/blob.bin'])).toEqual(Array.from(BINARY));
    expect(Array.from(files['assets/raw.bin'])).toEqual(Array.from(BINARY));
  });

  it('writes a Uint8Array subarray view (not its whole backing buffer)', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);
    const built = buildImporterArchive(input({ assets: { 'assets/view.bin': view } }));
    expect(Array.from(unzipSync(built.zipBytes)['assets/view.bin'])).toEqual([1, 2, 3]);
  });

  it('writes an empty source and an empty binary asset', () => {
    const built = buildImporterArchive(
      input({ sources: { 'sources/empty.plc': '' }, assets: { 'assets/empty.bin': new Uint8Array(0) } }),
    );
    const files = unzipSync(built.zipBytes);
    expect(files['sources/empty.plc'].byteLength).toBe(0);
    expect(files['assets/empty.bin'].byteLength).toBe(0);
  });
});

describe('buildImporterArchive: determinism', () => {
  const RICH: BuildImporterArchiveInput = input({
    sources: { 'sources/b.plc': 'B', 'sources/a.plc': 'A', 'sources/n/c.plc': 'C' },
    preservation: { 'preservation/x.txt': 'x', 'preservation/bin.dat': BINARY },
    assets: { 'assets/z.svg': '<svg/>', 'assets/a.png': BINARY },
    manifest: { ...MANIFEST, summary: { message: 'ok', stats: { a: 1 } } },
  });

  it('produces byte-identical zips for identical input', () => {
    const first = buildImporterArchive(RICH).zipBytes;
    const second = buildImporterArchive(RICH).zipBytes;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('produces byte-identical zips when record keys are inserted in a different order', () => {
    const reordered: BuildImporterArchiveInput = {
      diagnostics: RICH.diagnostics,
      assets: { 'assets/a.png': BINARY, 'assets/z.svg': '<svg/>' },
      preservation: { 'preservation/bin.dat': BINARY, 'preservation/x.txt': 'x' },
      sources: { 'sources/n/c.plc': 'C', 'sources/a.plc': 'A', 'sources/b.plc': 'B' },
      manifest: {
        summary: { message: 'ok', stats: { a: 1 } },
        sourceFingerprint: MANIFEST.sourceFingerprint,
        vendorFamily: MANIFEST.vendorFamily,
        importerVersion: MANIFEST.importerVersion,
        importerId: MANIFEST.importerId,
      },
    };
    const first = buildImporterArchive(RICH).zipBytes;
    const second = buildImporterArchive(reordered).zipBytes;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  describe('across timezones', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('produces byte-identical zips in UTC, Pacific/Kiritimati and America/St_Johns', () => {
      const builds: Buffer[] = [];
      const localHours: number[] = [];
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/St_Johns']) {
        // Node re-reads TZ when process.env.TZ is assigned.
        process.env.TZ = tz;
        localHours.push(new Date(Date.UTC(2000, 0, 1, 12)).getHours());
        builds.push(Buffer.from(buildImporterArchive(RICH).zipBytes));
      }
      // Guard: the timezone switch really took effect (UTC+0, UTC+14, UTC-3:30).
      expect(localHours).toEqual([12, 2, 8]);
      expect(builds[0].equals(builds[1])).toBe(true);
      expect(builds[0].equals(builds[2])).toBe(true);
    });

    it('stores the 1980-01-01 00:00 DOS timestamp in every header regardless of timezone', () => {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/St_Johns']) {
        process.env.TZ = tz;
        const zip = buildImporterArchive(RICH).zipBytes;
        const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
        // Local header: time at +10, date at +12. DOS date 1980-01-01 = (0<<9)|(1<<5)|1 = 0x21.
        expect(view.getUint16(10, true)).toBe(0);
        expect(view.getUint16(12, true)).toBe(0x21);
      }
    });
  });
});

describe('buildImporterArchive: rejections', () => {
  it('rejects zero sources', () => {
    const error = archiveError(input({ sources: {} }));
    expect(error.problems).toEqual(['at least one canonical source (sources/<path>.plc) is required']);
  });

  it.each(['src/a.plc', 'sources/a.st', 'sources/.plc', 'a.plc', 'sources/a.plc.txt'])(
    'rejects source path with the wrong prefix or extension (%j)',
    (path) => {
      const error = archiveError(input({ sources: { 'sources/ok.plc': 'x', [path]: 'y' } }));
      expect(error.problems).toHaveLength(1);
      expect(error.problems[0]).toContain(JSON.stringify(path));
      expect(error.problems[0]).toMatch(/must match/);
    },
  );

  it('rejects preservation and asset paths outside their prefix', () => {
    const error = archiveError(
      input({ preservation: { 'notes/p.txt': 'p' }, assets: { 'preservation/a.png': 'a' } }),
    );
    expect(error.problems).toHaveLength(2);
    expect(error.problems[0]).toMatch(/^preservation path "notes\/p.txt" must match/);
    expect(error.problems[1]).toMatch(/^assets path "preservation\/a.png" must match/);
  });

  it.each([
    ['parent segment', 'sources/../x.plc'],
    ['backslash', 'sources\\x.plc'],
    ['absolute', '/sources/x.plc'],
    ['drive', 'C:/sources/x.plc'],
    ['control char', 'sources/a\nb.plc'],
    ['empty segment', 'sources//x.plc'],
  ])('rejects unsafe source path (%s)', (_label, path) => {
    const error = archiveError(input({ sources: { 'sources/ok.plc': 'x', [path]: 'y' } }));
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain(`sources path ${JSON.stringify(path)}`);
  });

  it.each(['sources/a:b.plc', 'sources/CON.plc', 'sources/nul.plc', 'sources/a?.plc', 'sources/dir./a.plc'])(
    'rejects unportable path %j',
    (path) => {
      const error = archiveError(input({ sources: { 'sources/ok.plc': 'x', [path]: 'y' } }));
      expect(error.problems).toHaveLength(1);
      expect(error.problems[0]).toMatch(/Windows|dot or space/);
    },
  );

  it('rejects case collisions within a section', () => {
    const error = archiveError(input({ sources: { 'sources/A.plc': 'a', 'sources/a.plc': 'b' } }));
    expect(error.problems).toEqual(['sources path "sources/a.plc" collides with "sources/A.plc"']);
  });

  it('rejects NFC/NFD twins as collisions', () => {
    const error = archiveError(
      input({ sources: { 'sources/\u00e9.plc': 'nfc', 'sources/e\u0301.plc': 'nfd' } }),
    );
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toMatch(/collides with/);
  });

  it('rejects "./" twins as collisions', () => {
    const error = archiveError(input({ assets: { 'assets/a.png': 'x', './assets/a.png': 'y' } }));
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toMatch(/collides with/);
  });

  it('rejects case collisions in preservation and assets', () => {
    const error = archiveError(
      input({
        preservation: { 'preservation/Notes.txt': 'a', 'preservation/notes.TXT': 'b' },
        assets: { 'assets/Logo.png': 'a', 'assets/logo.png': 'b' },
      }),
    );
    expect(error.problems).toHaveLength(2);
    expect(error.problems[0]).toMatch(/^preservation path .* collides with/);
    expect(error.problems[1]).toMatch(/^assets path .* collides with/);
  });

  // Every section has its own case-sensitive prefix pattern (`sources/`, `preservation/`,
  // `assets/`), so a path differing only by case in its first segment fails the prefix
  // check before the collision check: a true cross-section case collision cannot reach
  // the archive. This test pins that behaviour.
  it('reports a cross-section case twin as a prefix problem', () => {
    const error = archiveError(
      input({ preservation: { 'preservation/x.txt': 'a' }, assets: { 'Preservation/x.txt': 'b' } }),
    );
    expect(error.problems).toEqual([expect.stringMatching(/^assets path "Preservation\/x.txt" must match/)]);
  });

  it('rejects non-string, non-bytes content', () => {
    const error = archiveError(
      input({
        sources: { 'sources/ok.plc': 'x', 'sources/num.plc': 42 as unknown as string },
        preservation: { 'preservation/obj.txt': { a: 1 } as unknown as string },
        assets: {
          'assets/null.bin': null as unknown as string,
          'assets/arr.bin': [1, 2] as unknown as Uint8Array,
          'assets/buf.bin': new ArrayBuffer(2) as unknown as Uint8Array,
        },
      }),
    );
    expect(error.problems).toHaveLength(5);
    for (const problem of error.problems) expect(problem).toMatch(/non-text, non-byte content/);
  });

  it('accepts Uint8Array content in sources at runtime', () => {
    const built = buildImporterArchive(
      input({ sources: { 'sources/b.plc': new Uint8Array([0x41]) as unknown as string } }),
    );
    expect(strFromU8(unzipSync(built.zipBytes)['sources/b.plc'])).toBe('A');
  });

  it('lists EVERY problem across all sections, not just the first', () => {
    const error = archiveError(
      input({
        sources: {
          'sources/ok.plc': 'x',
          'src/a.plc': 'wrong prefix',
          'sources/../x.plc': 'unsafe',
          'sources/CON.plc': 'reserved',
          'sources/OK.plc': 'case twin',
          'sources/bad.plc': 7 as unknown as string,
        },
        preservation: { 'preservation/a\\b': 'backslash', '/abs': 'absolute' },
        assets: { 'assets/a:b': 'colon', 'other/x': 'prefix' },
      }),
    );
    expect(error.problems).toHaveLength(9);
    expect(error.message).toContain(error.problems.join('; '));
    const joined = error.problems.join('\n');
    for (const path of [
      'src/a.plc',
      'sources/../x.plc',
      'sources/CON.plc',
      'sources/OK.plc',
      'sources/bad.plc',
      'preservation/a\\\\b',
      '/abs',
      'assets/a:b',
      'other/x',
    ]) {
      expect(joined).toContain(path);
    }
  });

  it('is an Error with name ImporterArchiveError', () => {
    const error = archiveError(input({ sources: {} }));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ImporterArchiveError');
  });

  // Regression: an archive with both a file `assets/a` and a file `assets/a/b` cannot be
  // extracted on any filesystem (`assets/a` would have to be a file and a directory).
  it('rejects a file path that is also a directory prefix of another path', () => {
    const error = archiveError(input({ assets: { 'assets/a': 'file', 'assets/a/b': 'nested' } }));
    expect(error.problems).toEqual([expect.stringContaining('"assets/a" is a file')]);
  });

  it('rejects file/directory clashes case-insensitively and across sections', () => {
    expect(archiveError(input({ assets: { 'assets/A': 'file', 'assets/a/b': 'nested' } })).problems).toHaveLength(1);
    expect(
      archiveError(input({ sources: { 'sources/x.plc': 'x', 'sources/x.plc/y.plc': 'y' } })).problems,
    ).toHaveLength(1);
  });

  it('allows sibling paths that merely share a name prefix', () => {
    expect(() => buildImporterArchive(input({ assets: { 'assets/a': 'file', 'assets/ab/c': 'x', 'assets/a.png': 'y' } }))).not.toThrow();
  });
});

describe('zipDeterministic', () => {
  it('zips entries in the given order', () => {
    const zip = zipDeterministic([
      { path: 'b.txt', bytes: new Uint8Array([1]) },
      { path: 'a.txt', bytes: new Uint8Array([2]) },
      { path: 'dir/c.txt', bytes: new Uint8Array([3]) },
    ]);
    expect(zipEntryNames(zip)).toEqual(['b.txt', 'a.txt', 'dir/c.txt']);
  });

  it('is byte-identical for identical entries', () => {
    const entries = [{ path: 'a.txt', bytes: new TextEncoder().encode('hello') }];
    expect(Buffer.from(zipDeterministic(entries)).equals(Buffer.from(zipDeterministic(entries)))).toBe(true);
  });

  it('throws ImporterArchiveError on a duplicate path', () => {
    expect(() =>
      zipDeterministic([
        { path: 'a.txt', bytes: new Uint8Array([1]) },
        { path: 'a.txt', bytes: new Uint8Array([2]) },
      ]),
    ).toThrow(ImporterArchiveError);
  });

  it('produces an empty (EOCD-only) zip for no entries', () => {
    const zip = zipDeterministic([]);
    expect(zip.byteLength).toBe(22);
    expect(Object.keys(unzipSync(zip))).toEqual([]);
  });

  // Regression: zipSync walked a plain object with `for...in`, which enumerates integer-like
  // keys ("2", "10") first, so such paths were written out of order.
  it('keeps the given order for integer-like paths', () => {
    const zip = zipDeterministic([
      { path: 'b.txt', bytes: new Uint8Array([1]) },
      { path: '10', bytes: new Uint8Array([2]) },
      { path: '2', bytes: new Uint8Array([3]) },
    ]);
    expect(zipEntryNames(zip)).toEqual(['b.txt', '10', '2']);
  });

  // Regression: `zippable['__proto__'] = bytes` on a plain object swapped its prototype
  // instead of adding an entry, so the file was dropped. `__proto__` passes checkRelativePath.
  it('writes an entry named "__proto__"', () => {
    const zip = zipDeterministic([
      { path: 'a.txt', bytes: new Uint8Array([1]) },
      { path: '__proto__', bytes: new Uint8Array([2, 3]) },
    ]);
    expect(zipEntryNames(zip)).toEqual(['a.txt', '__proto__']);
  });
});

describe('buildImporterResultArchive (legacy single-source builder)', () => {
  const LEGACY: BuildImporterResultArchiveInput = {
    manifest: { importerId: 'iec61131-ed4-upgrade', importerVersion: '0.1.0', vendorFamily: 'iec61131-legacy' },
    sourcePath: 'legacy.st',
    sourceContent: 'PROGRAM P\nEND_PROGRAM\n',
    diagnostics: { schemaVersion: 'hyperdrive.importer-diagnostics.v1', diagnostics: [] },
    preservation: { 'preservation/il/b.txt': 'b', 'preservation/il/a.txt': 'a' },
  };

  it('produces byte-identical zips for identical input', () => {
    const first = buildImporterResultArchive(LEGACY).zipBytes;
    const second = buildImporterResultArchive(LEGACY).zipBytes;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('produces byte-identical zips across timezones', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utc = Buffer.from(buildImporterResultArchive(LEGACY).zipBytes);
      process.env.TZ = 'Pacific/Kiritimati';
      const kiritimati = Buffer.from(buildImporterResultArchive(LEGACY).zipBytes);
      process.env.TZ = 'America/St_Johns';
      const stJohns = Buffer.from(buildImporterResultArchive(LEGACY).zipBytes);
      expect(utc.equals(kiritimati)).toBe(true);
      expect(utc.equals(stJohns)).toBe(true);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('renames the source to sources/<base>.plc and sorts preservation', () => {
    const archive = buildImporterResultArchive(LEGACY);
    expect(archive.manifest.canonicalSources).toEqual(['sources/legacy.plc']);
    expect(archive.manifest.preservation).toEqual(['preservation/il/a.txt', 'preservation/il/b.txt']);
    expect(zipEntryNames(archive.zipBytes)).toEqual([
      'manifest.json',
      'sources/legacy.plc',
      'diagnostics.json',
      'preservation/il/a.txt',
      'preservation/il/b.txt',
    ]);
  });
});
