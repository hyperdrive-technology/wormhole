import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IEC61131_ED4_UPGRADE_CAPABILITY } from '@wormhole/contract';
import {
  capabilityEntries,
  createImportContext,
  ImporterHost,
  readZipTree,
  VirtualFileTree,
  type ImportResult,
  type ImportOptions,
} from '@wormhole/sdk';
import Ajv2020 from 'ajv/dist/2020.js';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import defaultExport, { iec61131UpgradeImporter, iec61131UpgradeManifest } from './index.js';
import { IMPORTER_ID, IMPORTER_VERSION, upgradeIec61131Source } from './upgrade.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/legacy');
const contractSchemasDir = join(dirname(fileURLToPath(import.meta.url)), '../../contract/schemas');
const tierA = readFileSync(join(fixturesDir, 'tier-a-legacy.plc'), 'utf8');
const il = readFileSync(join(fixturesDir, 'il-legacy.st'), 'utf8');
/** Same POU name as `il`, different logic, so a dropped sidecar is detectable. */
const ilOther = il.replace('LD Start', 'LDN Start');

function treeOf(files: Record<string, string | Uint8Array>) {
  const loaded = VirtualFileTree.fromEntries(Object.entries(files).map(([path, content]) => ({ path, content })));
  expect(loaded.fatal).toBe(false);
  return loaded.tree;
}

async function importFiles(files: Record<string, string | Uint8Array>, options: ImportOptions = {}): Promise<ImportResult> {
  const handle = createImportContext();
  try {
    return await iec61131UpgradeImporter.import({ files: treeOf(files), capabilityId: IMPORTER_ID, options }, handle.context);
  } finally {
    handle.dispose();
  }
}

function codes(result: ImportResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe('iec61131 importer manifest', () => {
  it('is the package default export and matches IMPORTER_VERSION', () => {
    expect(defaultExport).toBe(iec61131UpgradeImporter);
    expect(iec61131UpgradeManifest.version).toBe(IMPORTER_VERSION);
    expect(iec61131UpgradeManifest.capabilities.map((capability) => capability.id)).toEqual([IMPORTER_ID]);
  });

  it('maps onto exactly the capability the service already advertises', () => {
    expect(capabilityEntries(iec61131UpgradeManifest)).toEqual([{ ...IEC61131_ED4_UPGRADE_CAPABILITY, fileExtensions: [...IEC61131_ED4_UPGRADE_CAPABILITY.fileExtensions] }]);
  });
});

describe('iec61131 importer detect()', () => {
  it.each([
    [{ 'main.st': 'PROGRAM Main\nEND_PROGRAM\n' }, 0.9],
    [{ 'MAIN.ST': 'function_block Fb\nEND_FUNCTION_BLOCK\n' }, 0.9],
    [{ 'notes.plc': 'just text' }, 0.3],
    [{ 'a.st': new Uint8Array([0, 1, 2, 3]) }, 0.3],
  ])('recognises %j with confidence %s', (files, confidence) => {
    expect(iec61131UpgradeImporter.detect({ files: treeOf(files) })).toMatchObject({ capabilityId: IMPORTER_ID, confidence });
  });

  it('returns null without .plc/.st files', () => {
    expect(iec61131UpgradeImporter.detect({ files: treeOf({ 'readme.md': 'PROGRAM' }) })).toBeNull();
    expect(iec61131UpgradeImporter.detect({ files: VirtualFileTree.empty() })).toBeNull();
  });

  it('only sniffs the head of each file', () => {
    let bytesRead = 0;
    const big = `PROGRAM P\n${' '.repeat(5_000_000)}END_PROGRAM\n`;
    const files = treeOf({ 'big.st': big }).withReadObserver((_, bytes) => {
      bytesRead += bytes;
    });
    iec61131UpgradeImporter.detect({ files });
    expect(bytesRead).toBeLessThanOrEqual(4096);
  });
});

describe('iec61131 importer import()', () => {
  it('produces the same source and diagnostics as the CLI path', async () => {
    for (const [fileName, content] of [['tier-a-legacy.plc', tierA], ['il-legacy.st', il]] as const) {
      const viaSdk = await importFiles({ [fileName]: content });
      const viaCli = upgradeIec61131Source(content, { fileName, sourceKind: fileName.endsWith('.st') ? 'st' : 'plc', apply: true });
      expect(Object.values(viaSdk.sources)).toEqual([viaCli.source]);
      expect(viaSdk.diagnostics).toEqual(viaCli.diagnostics);
      expect(viaSdk.preservation ?? {}).toEqual(viaCli.preservation);
    }
  });

  it('keeps the directory layout and renames to .plc', async () => {
    const result = await importFiles({ 'src/legacy/il-legacy.st': il, 'src/tier-a.plc': tierA, 'README.md': '# not source' });
    expect(Object.keys(result.sources).sort()).toEqual(['sources/src/legacy/il-legacy.plc', 'sources/src/tier-a.plc']);
    expect(result.summary.stats).toMatchObject({ filesFound: 2, filesUpgraded: 2, filesSkipped: 0, preservationSidecars: 1 });
  });

  it('normalises CRLF to LF, notes it, and upgrades exactly like LF input', async () => {
    const crlf = await importFiles({ 'a.plc': tierA.replace(/\n/g, '\r\n') });
    const lf = await importFiles({ 'a.plc': tierA });
    expect(crlf.sources).toEqual(lf.sources);
    expect(codes(crlf)).toContain('WORMHOLE_IEC_LINE_ENDINGS_NORMALIZED');
    expect(Object.values(crlf.sources)[0]).not.toContain('\r');
  });

  it('strips a UTF-8 BOM', async () => {
    const result = await importFiles({ 'a.st': new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('PROGRAM P\nEND_PROGRAM\n')]) });
    expect(Object.values(result.sources)[0]?.startsWith('PROGRAM')).toBe(true);
  });

  it('decodes non-UTF-8 input as Windows-1252 with a warning', async () => {
    const latin1 = new Uint8Array([...strToU8('PROGRAM P (* Temp'), 0xe9, 0x72, 0x61, 0x74, 0x75, 0x72, ...strToU8(' *)\nEND_PROGRAM\n')]);
    const result = await importFiles({ 'a.st': latin1 });
    expect(codes(result)).toContain('WORMHOLE_IEC_ENCODING_GUESSED');
    expect(Object.values(result.sources)[0]).toContain('Températur');
  });

  it('skips binary and empty files with diagnostics', async () => {
    const result = await importFiles({ 'bin.st': new Uint8Array([0x50, 0, 0, 1]), 'empty.plc': '', 'ok.st': 'PROGRAM P\nEND_PROGRAM\n' });
    expect(codes(result)).toEqual(expect.arrayContaining(['WORMHOLE_IEC_BINARY_INPUT', 'WORMHOLE_IEC_EMPTY_SOURCE']));
    expect(Object.keys(result.sources)).toEqual(['sources/ok.plc']);
    expect(result.summary.stats).toMatchObject({ filesFound: 3, filesUpgraded: 1, filesSkipped: 2 });
  });

  it('warns about text without any POU but still upgrades it', async () => {
    const result = await importFiles({ 'fragment.st': 'X := 8#17;\n' });
    expect(codes(result)).toContain('WORMHOLE_IEC_NO_POU');
    expect(result.sources['sources/fragment.plc']).toBe('X := 16#F;\n');
  });

  it('reports an error and no sources when there is nothing to import', async () => {
    const result = await importFiles({ 'readme.md': 'hello' });
    expect(result.sources).toEqual({});
    expect(codes(result)).toEqual(['WORMHOLE_IEC_NO_SOURCES']);
    expect(result.summary.message).toBe('No IEC 61131-3 source files found.');
  });

  it('honours apply:false (report only) and warns about a non-boolean apply', async () => {
    const reportOnly = await importFiles({ 'a.plc': tierA }, { apply: false });
    expect(reportOnly.sources['sources/a.plc']).toBe(tierA);
    const badOption = await importFiles({ 'a.plc': tierA }, { apply: 'yes' });
    expect(codes(badOption)).toContain('WORMHOLE_IEC_INVALID_OPTION');
    expect(badOption.sources['sources/a.plc']).not.toBe(tierA);
  });

  it('reports every colliding input and imports none of them', async () => {
    const result = await importFiles({ 'a.plc': 'PROGRAM A\nEND_PROGRAM\n', 'a.st': 'PROGRAM B\nEND_PROGRAM\n', 'A.st': 'PROGRAM C\nEND_PROGRAM\n' });
    expect(result.sources).toEqual({});
    expect(codes(result).filter((code) => code === 'WORMHOLE_IEC_OUTPUT_COLLISION')).toHaveLength(2);
    expect(result.summary.stats).toMatchObject({ sourcesLost: 2 });
  });

  // PR #1 review P1: x/main.st and y/main.st used to share preservation/il/main-<POU>.il.txt,
  // so the second file's IL was replaced by a placeholder and then dropped.
  it('preserves both IL bodies when files in different folders share a base name and POU name', async () => {
    const result = await importFiles({ 'x/il-legacy.st': il, 'y/il-legacy.st': ilOther });
    expect(result.preservation).toEqual({
      'preservation/il/x/il-legacy-Legacy.il.txt': expect.stringContaining('LD Start'),
      'preservation/il/y/il-legacy-Legacy.il.txt': expect.stringContaining('LDN Start'),
    });
    expect(result.preservation?.['preservation/il/x/il-legacy-Legacy.il.txt']).not.toContain('LDN');
    expect(codes(result)).not.toContain('WORMHOLE_IEC_PRESERVATION_COLLISION');
    expect(result.summary.stats).toMatchObject({ filesUpgraded: 2, preservationSidecars: 2 });
  });

  // PR #1 review P1: case-only differences used to pass the importer's case-sensitive check
  // and then fail the whole run in buildImporterArchive's case-insensitive one.
  it('imports files whose paths differ only by case in different folders', async () => {
    const result = await importFiles({ 'x/Main.st': il, 'y/main.st': ilOther });
    expect(Object.keys(result.preservation ?? {}).sort()).toEqual([
      'preservation/il/x/Main-Legacy.il.txt',
      'preservation/il/y/main-Legacy.il.txt',
    ]);
    expect(codes(result)).not.toContain('WORMHOLE_IEC_PRESERVATION_COLLISION');
  });

  it('keeps both bodies of a POU declared twice in one file (wormhole#4)', async () => {
    const result = await importFiles({ 'dup.st': `${il}${ilOther}` });
    expect(Object.keys(result.preservation ?? {})).toEqual(['preservation/il/dup-Legacy.il.txt', 'preservation/il/dup-Legacy-2.il.txt']);
    expect(codes(result)).toContain('WORMHOLE_IL_DUPLICATE_POU');
  });

  describe('when a sidecar would still be lost', () => {
    /** A context whose migrate toolkit returns fixed preservation paths, to force collisions. */
    async function importWithSidecars(
      files: Record<string, string>,
      sidecarsFor: (fileName: string) => Record<string, string>,
    ): Promise<ImportResult> {
      const handle = createImportContext();
      const real = handle.context.migrate;
      const context = {
        ...handle.context,
        migrate: {
          ...real,
          upgradeSource: (content: string, options: Parameters<typeof real.upgradeSource>[1]) => ({
            ...real.upgradeSource(content, options),
            preservation: sidecarsFor(options.fileName),
          }),
        },
      };
      try {
        return await iec61131UpgradeImporter.import({ files: treeOf(files), capabilityId: IMPORTER_ID, options: {} }, context);
      } finally {
        handle.dispose();
      }
    }

    it.each([
      ['an exact', (fileName: string) => ({ 'preservation/il/shared.il.txt': fileName })],
      ['a case-only', (fileName: string) => ({ [fileName.startsWith('x') ? 'preservation/il/Shared.il.txt' : 'preservation/il/shared.il.txt']: fileName })],
    ])('fails instead of emitting a lossy archive on %s sidecar collision', async (_, sidecarsFor) => {
      const result = await importWithSidecars({ 'x/a.st': il, 'y/b.st': il }, sidecarsFor);
      expect(result.sources).toEqual({});
      expect(result.preservation).toBeUndefined();
      expect(codes(result)).toContain('WORMHOLE_IEC_PRESERVATION_COLLISION');
      expect(result.diagnostics.find((diagnostic) => diagnostic.code === 'WORMHOLE_IEC_PRESERVATION_COLLISION')?.severity).toBe('error');
      expect(result.summary.message).toMatch(/not imported/);
    });

    it('fails instead of emitting a lossy archive when a sidecar path is unusable', async () => {
      const result = await importWithSidecars({ 'a.st': il }, () => ({ 'preservation/il/a:b.il.txt': 'x' }));
      expect(result.sources).toEqual({});
      expect(codes(result)).toContain('WORMHOLE_IEC_UNPORTABLE_PATH');
    });

    it('fails through ImporterHost with NO_SOURCES rather than succeeding', async () => {
      const result = await importWithSidecars({ 'x/a.st': il, 'y/b.st': il }, () => ({ 'preservation/il/shared.il.txt': 'x' }));
      const host = new ImporterHost();
      host.register({ ...iec61131UpgradeImporter, import: () => result });
      const outcome = await host.run({ capabilityId: IMPORTER_ID, input: treeOf({ 'x/a.st': il }) });
      expect(outcome.status).toBe('failed');
      expect(outcome.failure?.code).toBe('NO_SOURCES');
      expect(outcome.archive).toBeUndefined();
    });
  });

  it('fails instead of dropping inputs whose output path would not be portable', async () => {
    const result = await importFiles({ 'dir/a:b.st': 'PROGRAM P\nEND_PROGRAM\n', 'CON.st': 'PROGRAM Q\nEND_PROGRAM\n' });
    expect(result.sources).toEqual({});
    expect(codes(result).filter((code) => code === 'WORMHOLE_IEC_UNPORTABLE_PATH')).toHaveLength(2);
  });

  // GPT review on wormhole#1: `a.plc` and `a.st` both map to sources/a.plc. Skipping one used
  // to return a "succeeded" result holding only the other program.
  describe('when two inputs map to the same output', () => {
    it.each([
      ['extension variants', { 'a.plc': 'PROGRAM B\nEND_PROGRAM\n', 'a.st': 'PROGRAM A\nEND_PROGRAM\n' }],
      ['case variants of the same stem', { 'x/A.plc': 'PROGRAM B\nEND_PROGRAM\n', 'x/a.st': 'PROGRAM A\nEND_PROGRAM\n' }],
    ])('returns no sources on %s', async (_, files) => {
      const result = await importFiles(files);
      expect(result.sources).toEqual({});
      expect(codes(result)).toContain('WORMHOLE_IEC_OUTPUT_COLLISION');
      expect(result.summary.message).toMatch(/^Project not imported/);
      expect(result.summary.stats).toMatchObject({ filesUpgraded: 0, sourcesLost: 1 });
    });

    it('fails through ImporterHost with NO_SOURCES and no archive', async () => {
      const host = new ImporterHost();
      host.register(iec61131UpgradeImporter);
      const outcome = await host.run({
        capabilityId: IMPORTER_ID,
        input: treeOf({ 'a.plc': 'PROGRAM B\nEND_PROGRAM\n', 'a.st': 'PROGRAM A\nEND_PROGRAM\n' }),
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.failure?.code).toBe('NO_SOURCES');
      expect(outcome.archive).toBeUndefined();
      expect(outcome.diagnostics.diagnostics.map((diagnostic) => diagnostic.code)).toContain('WORMHOLE_IEC_OUTPUT_COLLISION');
    });

    it('still succeeds when a binary or empty file is skipped (no logic is lost)', async () => {
      const result = await importFiles({ 'a.plc': '', 'a.st': 'PROGRAM A\nEND_PROGRAM\n' });
      expect(Object.keys(result.sources)).toEqual(['sources/a.plc']);
    });
  });

  // wormhole#9: macOS writes decomposed (NFD) names. The sidecar path was built from the raw
  // name but checked against its NFC form, so a valid file with native IL stopped the import
  // as an "unusable path"; and NFC/NFD twins passed the importer's raw-path collision check
  // only to fail later in the archive builder.
  describe('Unicode-normalised paths (wormhole#9)', () => {
    const nfd = 'cafe\u0301';
    const nfc = 'caf\u00e9';

    it('imports an NFD-named file with native IL under NFC output and sidecar paths', async () => {
      const result = await importFiles({ [`dir/${nfd}.st`]: il });
      expect(codes(result)).not.toContain('WORMHOLE_IEC_UNPORTABLE_PATH');
      expect(Object.keys(result.sources)).toEqual([`sources/dir/${nfc}.plc`]);
      expect(Object.keys(result.preservation ?? {})).toEqual([`preservation/il/dir/${nfc}-Legacy.il.txt`]);
      expect(result.preservation?.[`preservation/il/dir/${nfc}-Legacy.il.txt`]).toContain('LD Start');
    });

    it('succeeds through ImporterHost for an NFD-named file with native IL', async () => {
      const host = new ImporterHost();
      host.register(iec61131UpgradeImporter);
      const outcome = await host.run({ capabilityId: IMPORTER_ID, input: treeOf({ [`${nfd}.st`]: il }) });
      expect(outcome.status).toBe('succeeded');
      const entries = unzipSync(outcome.archive!.zipBytes);
      expect(Object.keys(entries)).toContain(`sources/${nfc}.plc`);
      expect(strFromU8(entries[`preservation/il/${nfc}-Legacy.il.txt`]!)).toContain('LD Start');
    });

    /**
     * The SDK's VirtualFileTree NFC-normalises on intake, but the importer accepts any tree
     * that satisfies the interface (a host may load its own copy of the SDK). This stub hands
     * paths through untouched, which is what exposed wormhole#9.
     */
    function rawTree(files: Record<string, string>): VirtualFileTree {
      const bytes = new Map(Object.entries(files).map(([path, text]) => [path, strToU8(text)]));
      const paths = [...bytes.keys()].sort();
      return {
        container: 'directory',
        fileCount: paths.length,
        totalBytes: [...bytes.values()].reduce((total, value) => total + value.byteLength, 0),
        paths: () => paths,
        has: (path: string) => bytes.has(path),
        read: (path: string) => bytes.get(path)?.slice(),
        head: (path: string, max: number) => bytes.get(path)?.slice(0, max),
        pathsWithExtension: (...extensions: string[]) => paths.filter((path) => extensions.some((ext) => path.toLowerCase().endsWith(ext))),
      } as unknown as VirtualFileTree;
    }

    async function importRaw(files: Record<string, string>): Promise<ImportResult> {
      const handle = createImportContext();
      try {
        return await iec61131UpgradeImporter.import({ files: rawTree(files), capabilityId: IMPORTER_ID, options: {} }, handle.context);
      } finally {
        handle.dispose();
      }
    }

    it('does not reject an NFD path handed through un-normalised by the tree', async () => {
      const result = await importRaw({ [`${nfd}.st`]: il });
      expect(codes(result)).not.toContain('WORMHOLE_IEC_UNPORTABLE_PATH');
      expect(Object.keys(result.sources)).toEqual([`sources/${nfc}.plc`]);
      expect(Object.keys(result.preservation ?? {})).toEqual([`preservation/il/${nfc}-Legacy.il.txt`]);
    });

    it('catches un-normalised NFC/NFD twins in its own collision check', async () => {
      const result = await importRaw({ [`${nfc}.st`]: il, [`${nfd}.st`]: ilOther });
      expect(result.sources).toEqual({});
      expect(codes(result)).toContain('WORMHOLE_IEC_OUTPUT_COLLISION');
    });

    it('reports NFC/NFD twins as an output collision in the importer, not as an invalid result later', async () => {
      const result = await importFiles({ [`${nfc}.st`]: il, [`${nfd}.plc`]: ilOther });
      expect(result.sources).toEqual({});
      expect(codes(result)).toContain('WORMHOLE_IEC_OUTPUT_COLLISION');
      expect(result.summary.stats).toMatchObject({ sourcesLost: 1 });

      const host = new ImporterHost();
      host.register(iec61131UpgradeImporter);
      const outcome = await host.run({ capabilityId: IMPORTER_ID, input: treeOf({ [`${nfc}.st`]: il, [`${nfd}.plc`]: ilOther }) });
      expect(outcome.failure?.code).toBe('NO_SOURCES');
      expect(outcome.diagnostics.diagnostics.map((diagnostic) => diagnostic.code)).toContain('WORMHOLE_IEC_OUTPUT_COLLISION');
    });

    it('treats NFD twins in different folders as different files', async () => {
      const result = await importFiles({ [`x/${nfd}.st`]: il, [`y/${nfc}.st`]: ilOther });
      expect(Object.keys(result.sources).sort()).toEqual([`sources/x/${nfc}.plc`, `sources/y/${nfc}.plc`]);
      expect(Object.keys(result.preservation ?? {}).sort()).toEqual([
        `preservation/il/x/${nfc}-Legacy.il.txt`,
        `preservation/il/y/${nfc}-Legacy.il.txt`,
      ]);
    });
  });

  it('stops with the abort reason when cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    const handle = createImportContext({ signal: controller.signal });
    expect(() => iec61131UpgradeImporter.import({ files: treeOf({ 'a.st': il }), capabilityId: IMPORTER_ID, options: {} }, handle.context)).toThrow('stop');
    handle.dispose();
  });
});

describe('iec61131 importer through ImporterHost', () => {
  const host = new ImporterHost();
  host.register(iec61131UpgradeImporter);

  it('runs on a zip upload and produces the result archive', async () => {
    const zip = zipSync({ 'project/main.st': strToU8(il), 'project/lib/tier-a.plc': strToU8(tierA), 'project/notes.txt': strToU8('x') });
    const loaded = await readZipTree(zip);
    expect(host.detectAll(loaded.tree)[0]).toMatchObject({ importerId: 'wormhole.iec61131-upgrade', capabilityId: IMPORTER_ID });
    const outcome = await host.run({ capabilityId: IMPORTER_ID, input: loaded });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.archive?.manifest).toMatchObject({
      importerId: IMPORTER_ID,
      importerVersion: IMPORTER_VERSION,
      vendorFamily: 'iec61131-legacy',
      canonicalSources: ['sources/project/lib/tier-a.plc', 'sources/project/main.plc'],
      preservation: ['preservation/il/project/main-Legacy.il.txt'],
    });
  });

  it('succeeds for case-variant paths and emits one sidecar per file', async () => {
    const outcome = await host.run({ capabilityId: IMPORTER_ID, input: treeOf({ 'x/Main.st': il, 'y/main.st': ilOther }) });
    expect(outcome.failure).toBeUndefined();
    expect(outcome.status).toBe('succeeded');
    expect(outcome.archive?.manifest.preservation).toEqual(['preservation/il/x/Main-Legacy.il.txt', 'preservation/il/y/main-Legacy.il.txt']);
    const unzipped = unzipSync(outcome.archive!.zipBytes);
    expect(strFromU8(unzipped['preservation/il/x/Main-Legacy.il.txt']!)).toContain('LD Start');
    expect(strFromU8(unzipped['preservation/il/y/main-Legacy.il.txt']!)).toContain('LDN Start');
  });

  // wormhole#2: the emitted manifest must validate against the result schema file on disk,
  // which is identical to core's. `summary` stays on the outcome until core's schema has it.
  it('emits a manifest.json that validates against hyperdrive-importer-result.v1.schema.json', async () => {
    const outcome = await host.run({ capabilityId: IMPORTER_ID, input: treeOf({ 'main.st': il }) });
    expect(outcome.status).toBe('succeeded');
    const manifest = JSON.parse(strFromU8(unzipSync(outcome.archive!.zipBytes)['manifest.json']!)) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('summary');
    expect(outcome.summary).toMatchObject({ message: expect.stringContaining('Upgraded 1 of 1'), stats: { preservationSidecars: 1 } });
    const schema = JSON.parse(readFileSync(join(contractSchemasDir, 'hyperdrive-importer-result.v1.schema.json'), 'utf8')) as Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: true, strictTypes: false }).compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(schema.additionalProperties).toBe(false);
  });

  it('fails cleanly with NO_SOURCES for garbage', async () => {
    const outcome = await host.run({ capabilityId: IMPORTER_ID, input: VirtualFileTree.fromFile('x.st', new Uint8Array([0, 0, 0])) });
    expect(outcome.failure?.code).toBe('NO_SOURCES');
    expect(outcome.diagnostics.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['WORMHOLE_IEC_BINARY_INPUT', 'WORMHOLE_RUN_NO_SOURCES']);
  });
});
