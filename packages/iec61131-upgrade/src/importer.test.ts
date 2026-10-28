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
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import defaultExport, { iec61131UpgradeImporter, iec61131UpgradeManifest } from './index.js';
import { IMPORTER_ID, IMPORTER_VERSION, upgradeIec61131Source } from './upgrade.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/legacy');
const tierA = readFileSync(join(fixturesDir, 'tier-a-legacy.plc'), 'utf8');
const il = readFileSync(join(fixturesDir, 'il-legacy.st'), 'utf8');

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

  it('refuses two inputs that map to the same output', async () => {
    const result = await importFiles({ 'a.plc': 'PROGRAM A\nEND_PROGRAM\n', 'a.st': 'PROGRAM B\nEND_PROGRAM\n', 'A.st': 'PROGRAM C\nEND_PROGRAM\n' });
    expect(Object.keys(result.sources)).toEqual(['sources/A.plc']);
    expect(codes(result).filter((code) => code === 'WORMHOLE_IEC_OUTPUT_COLLISION')).toHaveLength(2);
  });

  it('keeps the first of two colliding preservation sidecars and reports the second', async () => {
    const result = await importFiles({ 'x/il-legacy.st': il, 'y/il-legacy.st': il });
    expect(Object.keys(result.preservation ?? {})).toHaveLength(1);
    expect(codes(result)).toContain('WORMHOLE_IEC_PRESERVATION_COLLISION');
  });

  it('skips inputs whose output path would not be portable', async () => {
    const result = await importFiles({ 'dir/a:b.st': 'PROGRAM P\nEND_PROGRAM\n', 'CON.st': 'PROGRAM Q\nEND_PROGRAM\n' });
    expect(result.sources).toEqual({});
    expect(codes(result).filter((code) => code === 'WORMHOLE_IEC_UNPORTABLE_PATH')).toHaveLength(2);
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
      preservation: ['preservation/il/main-Legacy.il.txt'],
    });
  });

  it('fails cleanly with NO_SOURCES for garbage', async () => {
    const outcome = await host.run({ capabilityId: IMPORTER_ID, input: VirtualFileTree.fromFile('x.st', new Uint8Array([0, 0, 0])) });
    expect(outcome.failure?.code).toBe('NO_SOURCES');
    expect(outcome.diagnostics.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['WORMHOLE_IEC_BINARY_INPUT', 'WORMHOLE_RUN_NO_SOURCES']);
  });
});
