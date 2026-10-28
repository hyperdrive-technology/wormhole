import Ajv2020 from 'ajv/dist/2020.js';
import { importerDiagnosticsSchema, type ImporterDiagnostic } from '@wormhole/contract';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';

import { SdkDiagnosticCode } from './diagnostics.js';
import type { TreeLoadResult } from './tree.js';
import { readZipTree, type ReadZipOptions } from './zip.js';

// ---------------------------------------------------------------------------------------
// Zip fixture helpers
//
// Fixtures are built with fflate's `zipSync` and then byte-patched to produce malicious or
// malformed variants. fflate writes no archive comment and no zip64 records, so the layout
// is simple:
//
//   [local header 0][data 0] [local header 1][data 1] ... [central header 0] ... [EOCD]
//
// End of central directory (EOCD), last 22 bytes, signature PK\x05\x06 (0x06054b50):
//   +10 u16 total entries   +12 u32 central directory size   +16 u32 central directory offset
//
// Central directory header, signature PK\x01\x02 (0x02014b50), 46 bytes + name + extra + comment:
//   +8  u16 general-purpose flag (bit 0 = encrypted, bit 11 = UTF-8 name)
//   +10 u16 compression method (0 = store, 8 = deflate)
//   +16 u32 CRC-32    +20 u32 compressed size    +24 u32 uncompressed size
//   +28 u16 name length   +30 u16 extra length   +32 u16 comment length
//   +42 u32 offset of the entry's local header   +46 file name
//
// Local file header, signature PK\x03\x04 (0x04034b50), 30 bytes + name + extra:
//   +6  u16 flag   +8 u16 method   +14 u32 CRC-32   +18 u32 compressed size
//   +22 u32 uncompressed size   +26 u16 name length   +28 u16 extra length   +30 file name
//
// yauzl trusts the central directory for flags, method, sizes and CRC, and only reads the
// local header's name/extra lengths to find where the data starts. Patches still update
// both headers so a fixture is self-consistent, like a deliberately crafted archive would be.
// We walk the structure from the EOCD instead of scanning for signatures, because the
// signature bytes can also occur inside compressed data.
// ---------------------------------------------------------------------------------------

const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIGNATURE = 0x06054b50;

/** Fixed mtime so fixtures are deterministic (fflate uses Date.now() by default). */
const MTIME = new Date(1980, 0, 1);

function makeZip(files: Zippable, level: 0 | 6 = 6): Uint8Array {
  return zipSync(files, { level, mtime: MTIME });
}

function view(zip: Uint8Array): DataView {
  return new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
}

interface EntryHeaders {
  /** Offset of this entry's central directory header. */
  central: number;
  /** Offset of this entry's local file header. */
  local: number;
  name: string;
}

/** Walks the central directory from the EOCD and returns every entry's header offsets. */
function entryHeaders(zip: Uint8Array): EntryHeaders[] {
  const dv = view(zip);
  const eocd = zip.byteLength - 22;
  expect(dv.getUint32(eocd, true)).toBe(EOCD_SIGNATURE);
  const count = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  const headers: EntryHeaders[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(dv.getUint32(offset, true)).toBe(CENTRAL_SIGNATURE);
    const nameLength = dv.getUint16(offset + 28, true);
    const extraLength = dv.getUint16(offset + 30, true);
    const commentLength = dv.getUint16(offset + 32, true);
    const local = dv.getUint32(offset + 42, true);
    expect(dv.getUint32(local, true)).toBe(LOCAL_SIGNATURE);
    const name = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    headers.push({ central: offset, local, name });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return headers;
}

function headersFor(zip: Uint8Array, name: string): EntryHeaders {
  const found = entryHeaders(zip).find((entry) => entry.name === name);
  if (!found) throw new Error(`no entry ${name} in fixture`);
  return found;
}

/** Field offsets inside the central / local header for each patchable field. */
const FIELDS = {
  flag: { central: 8, local: 6, size: 2 },
  method: { central: 10, local: 8, size: 2 },
  crc: { central: 16, local: 14, size: 4 },
  compressedSize: { central: 20, local: 18, size: 4 },
  uncompressedSize: { central: 24, local: 22, size: 4 },
} as const;

type Field = keyof typeof FIELDS;

function readField(zip: Uint8Array, name: string, field: Field): number {
  const { central } = headersFor(zip, name);
  const spec = FIELDS[field];
  return spec.size === 2 ? view(zip).getUint16(central + spec.central, true) : view(zip).getUint32(central + spec.central, true);
}

/**
 * Returns a copy of `zip` with `field` of entry `name` set to `value`, in the central
 * header and (unless `centralOnly`) the local header.
 */
function patchField(zip: Uint8Array, name: string, field: Field, value: number, centralOnly = false): Uint8Array {
  const out = zip.slice();
  const { central, local } = headersFor(zip, name);
  const spec = FIELDS[field];
  const dv = view(out);
  const offsets = centralOnly ? [central + spec.central] : [central + spec.central, local + spec.local];
  for (const offset of offsets) {
    if (spec.size === 2) dv.setUint16(offset, value, true);
    else dv.setUint32(offset, value >>> 0, true);
  }
  return out;
}

/** Overwrites the raw name bytes of entry `name` in both headers (same length required). */
function patchNameBytes(zip: Uint8Array, name: string, newName: Uint8Array): Uint8Array {
  const out = zip.slice();
  const { central, local } = headersFor(zip, name);
  expect(newName.byteLength).toBe(view(zip).getUint16(central + 28, true));
  out.set(newName, central + 46);
  out.set(newName, local + 30);
  return out;
}

/** Overwrites the compressed data of entry `name` with `fill` bytes (sizes unchanged). */
function corruptData(zip: Uint8Array, name: string, fill = 0xff): Uint8Array {
  const out = zip.slice();
  const { local, central } = headersFor(zip, name);
  const dv = view(zip);
  const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
  const compressed = dv.getUint32(central + 20, true);
  out.fill(fill, dataStart, dataStart + compressed);
  return out;
}

// ---------------------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------------------

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const validateReport = ajv.compile(importerDiagnosticsSchema as Record<string, unknown>);

function expectSchemaValid(diagnostics: readonly ImporterDiagnostic[]): void {
  const ok = validateReport({ schemaVersion: 'hyperdrive.importer-diagnostics.v1', diagnostics });
  expect(validateReport.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

/**
 * Reads a zip, asserting it never rejects (every problem must be a diagnostic) and that
 * the result holds the general invariants.
 */
async function read(bytes: Uint8Array, options?: ReadZipOptions): Promise<TreeLoadResult> {
  const promise = readZipTree(bytes, options);
  await expect(promise).resolves.toBeDefined();
  const result = await promise;
  expect(result.tree.container).toBe('zip');
  expectSchemaValid(result.diagnostics);
  if (result.fatal) {
    expect(result.tree.fileCount).toBe(0);
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  }
  return result;
}

async function expectFatal(bytes: Uint8Array, code: string, options?: ReadZipOptions): Promise<TreeLoadResult> {
  const result = await read(bytes, options);
  expect(result.fatal).toBe(true);
  expect(result.tree.paths()).toEqual([]);
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
  return result;
}

const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

// ---------------------------------------------------------------------------------------

describe('readZipTree: well-formed archives', () => {
  it('reads nested directories with explicit directory entries', async () => {
    // A nested Zippable makes fflate write explicit `dir/` and `dir/sub/` entries.
    const zip = makeZip({
      'top.st': strToU8('TOP'),
      dir: { 'a.st': strToU8('A'), sub: { 'b.st': strToU8('B') } },
    });
    expect(entryHeaders(zip).map((entry) => entry.name)).toEqual(['top.st', 'dir/', 'dir/a.st', 'dir/sub/', 'dir/sub/b.st']);
    const result = await read(zip);
    expect(result.fatal).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.tree.paths()).toEqual(['dir/a.st', 'dir/sub/b.st', 'top.st']);
    expect(text(result.tree.read('dir/sub/b.st'))).toBe('B');
    expect(result.tree.container).toBe('zip');
  });

  it('reads stored (uncompressed) entries', async () => {
    const result = await read(makeZip({ 'a.txt': strToU8('stored') }, 0));
    expect(result.fatal).toBe(false);
    expect(text(result.tree.read('a.txt'))).toBe('stored');
  });

  it('reads empty files', async () => {
    const result = await read(makeZip({ 'empty.txt': new Uint8Array(0) }));
    expect(result.fatal).toBe(false);
    expect(result.tree.size('empty.txt')).toBe(0);
  });

  it('round-trips binary content', async () => {
    const binary = new Uint8Array(1024).map((_, i) => (i * 37) & 0xff);
    const result = await read(makeZip({ 'blob.bin': binary }));
    expect(Array.from(result.tree.read('blob.bin') as Uint8Array)).toEqual(Array.from(binary));
  });

  it('reads a zip held in a Uint8Array view with a non-zero byteOffset', async () => {
    const zip = makeZip({ 'a.txt': strToU8('offset') });
    const padded = new Uint8Array(zip.byteLength + 16);
    padded.set(zip, 7);
    const result = await read(padded.subarray(7, 7 + zip.byteLength));
    expect(text(result.tree.read('a.txt'))).toBe('offset');
  });

  it('returns an empty tree with an INPUT_EMPTY warning for an empty zip (EOCD only)', async () => {
    const zip = makeZip({});
    expect(zip.byteLength).toBe(22);
    const result = await read(zip);
    expect(result.fatal).toBe(false);
    expect(result.tree.fileCount).toBe(0);
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([[SdkDiagnosticCode.INPUT_EMPTY, 'warning']]);
  });

  it('treats a zip with only directory entries as empty', async () => {
    const result = await read(makeZip({ dir: { sub: {} } }));
    expect(result.fatal).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual([SdkDiagnosticCode.INPUT_EMPTY]);
  });

  it('keeps a nested .zip entry as an opaque file with the inner bytes', async () => {
    const inner = makeZip({ 'inner.st': strToU8('INNER') });
    const result = await read(makeZip({ 'outer.st': strToU8('OUTER'), 'nested/inner.zip': inner }));
    expect(result.tree.paths()).toEqual(['nested/inner.zip', 'outer.st']);
    expect(Buffer.from(result.tree.read('nested/inner.zip') as Uint8Array).equals(Buffer.from(inner))).toBe(true);
    expect(result.tree.has('inner.st')).toBe(false);
  });

  it('normalises backslash separators written by old Windows tools', async () => {
    const result = await read(makeZip({ 'dir\\file.st': strToU8('x'), 'a\\b\\c.st': strToU8('y') }));
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['a/b/c.st', 'dir/file.st']);
  });

  it('normalises NFD names to NFC', async () => {
    const result = await read(makeZip({ 'caf\u0065\u0301.st': strToU8('x') }));
    expect(result.tree.paths()).toEqual(['caf\u00e9.st']);
  });

  it('decodes non-UTF-8 (CP437) names without crashing', async () => {
    // fflate leaves the UTF-8 flag (bit 11) clear for ASCII names; patch "X" to 0x82, which
    // is "é" in CP437, the zip default code page.
    const zip = makeZip({ 'cafX.txt': strToU8('x') });
    expect(readField(zip, 'cafX.txt', 'flag') & 0x800).toBe(0);
    const patched = patchNameBytes(zip, 'cafX.txt', new Uint8Array([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]));
    const result = await read(patched);
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['caf\u00e9.txt']);
  });

  it('decodes invalid UTF-8 bytes in a UTF-8-flagged name with replacement characters', async () => {
    let zip = makeZip({ 'cafX.txt': strToU8('x') });
    zip = patchField(zip, 'cafX.txt', 'flag', 0x800);
    zip = patchNameBytes(zip, 'cafX.txt', new Uint8Array([0x63, 0x61, 0x66, 0xff, 0x2e, 0x74, 0x78, 0x74]));
    const result = await read(zip);
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['caf\ufffd.txt']);
  });

  it('keeps case twins with a case-collision warning', async () => {
    const result = await read(makeZip({ 'A.st': strToU8('1'), 'a.st': strToU8('2') }));
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['A.st', 'a.st']);
    expect(result.diagnostics.map((d) => d.code)).toEqual([SdkDiagnosticCode.INPUT_CASE_COLLISION]);
  });

  it('accepts exactly maxInputFiles files and maxInputBytes bytes', async () => {
    const zip = makeZip({ a: strToU8('12345'), b: strToU8('67890') });
    const result = await read(zip, { limits: { maxInputFiles: 2, maxInputBytes: Math.max(10, zip.byteLength) } });
    expect(result.fatal).toBe(false);
    expect(result.tree.fileCount).toBe(2);
  });
});

describe('readZipTree: unreadable archives', () => {
  it('is fatal for garbage bytes', async () => {
    await expectFatal(strToU8('this is definitely not a zip archive, just text'), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('is fatal for zero bytes', async () => {
    await expectFatal(new Uint8Array(0), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('is fatal for a zip cut in half', async () => {
    const zip = makeZip({ 'a.txt': strToU8('a'.repeat(500)), 'b.txt': strToU8('b'.repeat(500)) });
    await expectFatal(zip.subarray(0, Math.floor(zip.byteLength / 2)), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('is fatal for a zip with its EOCD cut off', async () => {
    const zip = makeZip({ 'a.txt': strToU8('a') });
    await expectFatal(zip.subarray(0, zip.byteLength - 10), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('is fatal when the central directory is cut but the EOCD kept', async () => {
    const zip = makeZip({ 'a.txt': strToU8('a'), 'b.txt': strToU8('b') });
    const { central } = headersFor(zip, 'b.txt');
    // Drop the second central header but keep the EOCD (which still claims 2 entries).
    const cut = new Uint8Array([...zip.subarray(0, central), ...zip.subarray(zip.byteLength - 22)]);
    await expectFatal(cut, SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('is fatal when the compressed data is corrupt', async () => {
    const zip = makeZip({ 'a.txt': strToU8('hello hello hello hello') });
    await expectFatal(corruptData(zip, 'a.txt'), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });
});

describe('readZipTree: unsafe names', () => {
  it.each(['../evil.txt', 'a/../../evil', '/etc/passwd', 'C:/x', 'C:x', 'ok/./x'])(
    'rejects zip-slip name %j as fatal and returns nothing',
    async (name) => {
      const zip = makeZip({ 'good.st': strToU8('good'), [name]: strToU8('evil') });
      const result = await expectFatal(zip, SdkDiagnosticCode.INPUT_UNSAFE_PATH);
      expect(result.tree.fileCount).toBe(0);
    },
  );

  it('rejects a backslash zip-slip name ("..\\\\evil") after separator normalisation', async () => {
    await expectFatal(makeZip({ '..\\evil.txt': strToU8('x') }), SdkDiagnosticCode.INPUT_UNSAFE_PATH);
  });

  // Without general-purpose flag bit 11 (UTF-8 names) yauzl decodes names as CP437, where
  // byte 0x01 is the printable "\u263a". Set the flag so 0x01 stays U+0001.
  it('rejects names with control characters', async () => {
    const plain = makeZip({ 'a_b': strToU8('x') });
    const utf8 = patchField(plain, 'a_b', 'flag', readField(plain, 'a_b', 'flag') | 0x800);
    const zip = patchNameBytes(utf8, 'a_b', new Uint8Array([0x61, 0x01, 0x62]));
    await expectFatal(zip, SdkDiagnosticCode.INPUT_UNSAFE_PATH);
  });

  it('rejects duplicate entry names as fatal', async () => {
    // fflate cannot write two entries with the same name, so write a.txt + b.txt and
    // rename b.txt to a.txt in both its headers.
    const zip = makeZip({ 'a.txt': strToU8('first'), 'b.txt': strToU8('second') });
    const patched = patchNameBytes(zip, 'b.txt', strToU8('a.txt'));
    expect(entryHeaders(patched).map((entry) => entry.name)).toEqual(['a.txt', 'a.txt']);
    await expectFatal(patched, SdkDiagnosticCode.INPUT_DUPLICATE_PATH);
  });

  it('rejects names that collide after backslash normalisation', async () => {
    await expectFatal(
      makeZip({ 'dir/a.st': strToU8('1'), 'dir\\a.st': strToU8('2') }),
      SdkDiagnosticCode.INPUT_DUPLICATE_PATH,
    );
  });

  it('rejects names that collide after NFC normalisation', async () => {
    await expectFatal(
      makeZip({ '\u00e9.st': strToU8('1'), 'e\u0301.st': strToU8('2') }),
      SdkDiagnosticCode.INPUT_DUPLICATE_PATH,
    );
  });
});

describe('readZipTree: limits and zip bombs', () => {
  it('is fatal when the zip itself is larger than maxInputBytes', async () => {
    const zip = makeZip({ 'a.txt': strToU8('a') });
    const result = await expectFatal(zip, SdkDiagnosticCode.INPUT_TOO_LARGE, { limits: { maxInputBytes: zip.byteLength - 1 } });
    expect(result.diagnostics).toHaveLength(1);
  });

  it('is fatal with more files than maxInputFiles', async () => {
    const zip = makeZip({ a: strToU8('1'), b: strToU8('2'), c: strToU8('3') });
    await expectFatal(zip, SdkDiagnosticCode.INPUT_TOO_MANY_FILES, { limits: { maxInputFiles: 2 } });
  });

  it('does not count directory entries towards maxInputFiles', async () => {
    const result = await read(makeZip({ d: { e: { 'f.txt': strToU8('x') } } }), { limits: { maxInputFiles: 1 } });
    expect(result.fatal).toBe(false);
  });

  it('is fatal when declared uncompressed sizes exceed maxInputBytes, before inflating', async () => {
    // 10 000 "a"s deflate to a few dozen bytes: the archive is small, its content is not.
    const zip = makeZip({ 'bomb.txt': strToU8('a'.repeat(10_000)) });
    expect(zip.byteLength).toBeLessThan(500);
    // Corrupt the deflate stream: if the reader inflated before checking the declared size
    // it would fail with ZIP_INVALID instead of TOO_LARGE.
    const corrupt = corruptData(zip, 'bomb.txt');
    const result = await expectFatal(corrupt, SdkDiagnosticCode.INPUT_TOO_LARGE, { limits: { maxInputBytes: 5_000 } });
    expect(result.diagnostics.map((d) => d.code)).not.toContain(SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('sums declared sizes across entries', async () => {
    const zip = makeZip({ a: strToU8('a'.repeat(3_000)), b: strToU8('b'.repeat(3_000)) });
    await expectFatal(zip, SdkDiagnosticCode.INPUT_TOO_LARGE, { limits: { maxInputBytes: 5_000 } });
  });

  it('is fatal when an entry inflates to more than its declared (lying) size', async () => {
    // A zip bomb that under-declares its size to pass the pre-check: real 10 000 bytes,
    // declared 10. yauzl's validateEntrySizes stops the stream at the declared size.
    const zip = makeZip({ 'liar.txt': strToU8('a'.repeat(10_000)) });
    const patched = patchField(zip, 'liar.txt', 'uncompressedSize', 10);
    await expectFatal(patched, SdkDiagnosticCode.INPUT_ZIP_INVALID, { limits: { maxInputBytes: 5_000 } });
  });

  it('is fatal when an entry inflates to less than its declared size', async () => {
    const zip = makeZip({ 'short.txt': strToU8('a'.repeat(100)) });
    await expectFatal(patchField(zip, 'short.txt', 'uncompressedSize', 200), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('is fatal when a stored entry declares inconsistent sizes', async () => {
    const zip = makeZip({ 'stored.txt': strToU8('hello') }, 0);
    await expectFatal(patchField(zip, 'stored.txt', 'uncompressedSize', 2), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });

  it('is fatal on a CRC-32 mismatch', async () => {
    const zip = makeZip({ 'a.txt': strToU8('payload') });
    const crc = readField(zip, 'a.txt', 'crc');
    const result = await expectFatal(patchField(zip, 'a.txt', 'crc', crc ^ 1), SdkDiagnosticCode.INPUT_ZIP_INVALID);
    expect(result.diagnostics.at(-1)?.message).toMatch(/CRC-32 mismatch/);
  });

  it('is fatal on a CRC-32 mismatch in the central header only (the one yauzl reports)', async () => {
    const zip = makeZip({ 'a.txt': strToU8('payload') });
    const crc = readField(zip, 'a.txt', 'crc');
    await expectFatal(patchField(zip, 'a.txt', 'crc', crc ^ 0xffffffff, true), SdkDiagnosticCode.INPUT_ZIP_INVALID);
  });
});

describe('readZipTree: unsupported entries are skipped', () => {
  it('skips an encrypted (flag bit 0) deflated entry and keeps the others', async () => {
    const zip = makeZip({ 'secret.txt': strToU8('secret secret'), 'plain.txt': strToU8('plain') });
    const patched = patchField(zip, 'secret.txt', 'flag', readField(zip, 'secret.txt', 'flag') | 0x1);
    const result = await read(patched);
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['plain.txt']);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: SdkDiagnosticCode.INPUT_ZIP_ENTRY_UNSUPPORTED,
        severity: 'error',
        message: expect.stringMatching(/"secret.txt".*encrypted/),
      }),
    ]);
  });

  it('skips an encrypted stored entry whose sizes include the 12-byte encryption header', async () => {
    // Traditional PKWARE encryption prefixes stored data with a 12-byte header, so a real
    // encrypted stored entry has compressedSize = uncompressedSize + 12. yauzl checks that
    // relation, so patch it too.
    const zip = makeZip({ 'secret.txt': strToU8('secret'), 'plain.txt': strToU8('plain') }, 0);
    let patched = patchField(zip, 'secret.txt', 'flag', 0x1);
    patched = patchField(patched, 'secret.txt', 'compressedSize', readField(zip, 'secret.txt', 'uncompressedSize') + 12);
    const result = await read(patched);
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['plain.txt']);
    expect(result.diagnostics.map((d) => d.code)).toEqual([SdkDiagnosticCode.INPUT_ZIP_ENTRY_UNSUPPORTED]);
  });

  it('skips an entry with an unsupported compression method (99) and keeps the others', async () => {
    const zip = makeZip({ 'weird.bin': strToU8('weird data'), 'plain.txt': strToU8('plain') });
    const result = await read(patchField(zip, 'weird.bin', 'method', 99));
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['plain.txt']);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: SdkDiagnosticCode.INPUT_ZIP_ENTRY_UNSUPPORTED,
        message: expect.stringMatching(/compression method 99/),
      }),
    ]);
  });

  it('warns INPUT_EMPTY as well when every entry was skipped', async () => {
    const zip = makeZip({ 'only.bin': strToU8('x') });
    const result = await read(patchField(zip, 'only.bin', 'method', 12));
    expect(result.fatal).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      SdkDiagnosticCode.INPUT_ZIP_ENTRY_UNSUPPORTED,
      SdkDiagnosticCode.INPUT_EMPTY,
    ]);
  });

  it('keeps skipped-entry diagnostics when the archive is later rejected', async () => {
    const zip = makeZip({ 'a.bin': strToU8('x'), '../evil': strToU8('y') });
    const result = await expectFatal(patchField(zip, 'a.bin', 'method', 99), SdkDiagnosticCode.INPUT_UNSAFE_PATH);
    expect(result.diagnostics.map((d) => d.code)).toContain(SdkDiagnosticCode.INPUT_ZIP_ENTRY_UNSUPPORTED);
  });
});

describe('readZipTree: cancellation', () => {
  it('is fatal with a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await expectFatal(makeZip({ 'a.txt': strToU8('a') }), SdkDiagnosticCode.INPUT_ZIP_INVALID, {
      signal: controller.signal,
    });
    expect(result.diagnostics.at(-1)?.message).toMatch(/aborted/);
  });

  it('is fatal when aborted while reading', async () => {
    const files: Zippable = {};
    for (let i = 0; i < 200; i += 1) files[`f${i}.txt`] = strToU8(`file ${i}`);
    const controller = new AbortController();
    const promise = readZipTree(makeZip(files), { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.fatal).toBe(true);
    expect(result.tree.fileCount).toBe(0);
    expect(result.tree.container).toBe('zip');
  });

  it('is unaffected by a signal that is never aborted', async () => {
    const result = await read(makeZip({ 'a.txt': strToU8('a') }), { signal: new AbortController().signal });
    expect(result.fatal).toBe(false);
  });
});
