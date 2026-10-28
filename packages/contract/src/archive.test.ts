import { describe, expect, it } from 'vitest';

import { buildImporterResultArchive, fingerprintSource } from './archive.js';

describe('@wormhole/contract archive builder', () => {
  it('builds a manifest-aligned zip archive', () => {
    const archive = buildImporterResultArchive({
      manifest: {
        importerId: 'iec61131-ed4-upgrade',
        importerVersion: '0.1.0',
        vendorFamily: 'iec61131-legacy',
        sourceFingerprint: fingerprintSource('PROGRAM P\nEND_PROGRAM\n'),
        unsupportedSemantics: [],
      },
      sourcePath: 'legacy.plc',
      sourceContent: 'PROGRAM P\nEND_PROGRAM\n',
      diagnostics: {
        schemaVersion: 'hyperdrive.importer-diagnostics.v1',
        diagnostics: [],
      },
      preservation: {
        'preservation/il/legacy.il.txt': 'LD Start\nST Motor\n',
      },
    });

    expect(archive.manifest.schemaVersion).toBe('hyperdrive.importer-result.v1');
    expect(archive.manifest.canonicalSources).toEqual(['sources/legacy.plc']);
    expect(archive.manifest.preservation).toEqual(['preservation/il/legacy.il.txt']);
    expect(archive.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['manifest.json', 'sources/legacy.plc', 'diagnostics.json']),
    );
    expect(archive.zipBytes.byteLength).toBeGreaterThan(0);
  });
});
