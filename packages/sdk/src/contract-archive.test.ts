/**
 * Schema checks for `@wormhole/contract`'s archive builders. They live in the SDK package
 * because Ajv is an SDK dependency, not a contract one; the builder behaviour itself is
 * covered in `packages/contract/src/archive-builder.test.ts`.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  buildImporterArchive,
  buildImporterResultArchive,
  importerDiagnosticsSchema,
  importerResultSchema,
  type BuildImporterArchiveInput,
} from '@wormhole/contract';

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const validateResult = ajv.compile(importerResultSchema as Record<string, unknown>);
const validateDiagnostics = ajv.compile(importerDiagnosticsSchema as Record<string, unknown>);

function expectValidManifest(value: unknown): void {
  const ok = validateResult(value);
  expect(validateResult.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

const BASE: BuildImporterArchiveInput = {
  manifest: {
    importerId: 'acme-importer',
    importerVersion: '1.2.3',
    vendorFamily: 'acme',
    sourceFingerprint: 'f'.repeat(64),
  },
  sources: { 'sources/main.plc': 'PROGRAM Main\nEND_PROGRAM\n' },
  diagnostics: { schemaVersion: 'hyperdrive.importer-diagnostics.v1', diagnostics: [] },
};

describe('buildImporterArchive manifests validate against hyperdrive-importer-result.v1', () => {
  it('validates a minimal manifest', () => {
    expectValidManifest(buildImporterArchive(BASE).manifest);
  });

  it('validates a manifest with every optional field', () => {
    const built = buildImporterArchive({
      ...BASE,
      manifest: {
        ...BASE.manifest,
        unsupportedSemantics: [{ code: 'ACME_IL', message: 'IL preserved', severity: 'warning' }],
      },
      sources: { 'sources/a.plc': 'A', 'sources/nested/b.plc': 'B' },
      preservation: { 'preservation/il/a.il.txt': 'LD x', 'preservation/raw.bin': new Uint8Array([0, 1]) },
      assets: { 'assets/logo.svg': '<svg/>' },
    });
    expectValidManifest(built.manifest);
  });

  it('validates the manifest.json written into the zip', () => {
    const built = buildImporterArchive({ ...BASE, assets: { 'assets/a.png': new Uint8Array([1]) } });
    const written = JSON.parse(strFromU8(unzipSync(built.zipBytes)['manifest.json']));
    expectValidManifest(written);
  });

  it('validates when empty optional collections are omitted (schema forbids nothing extra)', () => {
    const built = buildImporterArchive({
      ...BASE,
      manifest: { ...BASE.manifest, unsupportedSemantics: [] },
      preservation: {},
      assets: {},
    });
    expectValidManifest(built.manifest);
    expect(built.manifest).not.toHaveProperty('assets');
  });

  it('writes a diagnostics.json that validates against hyperdrive-importer-diagnostics.v1', () => {
    const built = buildImporterArchive({
      ...BASE,
      diagnostics: {
        schemaVersion: 'hyperdrive.importer-diagnostics.v1',
        diagnostics: [
          { code: 'ACME_X', message: 'x', severity: 'error', source: { path: 'a.st', startLine: 1 } },
        ],
      },
    });
    const written = JSON.parse(strFromU8(unzipSync(built.zipBytes)['diagnostics.json']));
    expect(validateDiagnostics(written)).toBe(true);
  });
});

describe('buildImporterResultArchive manifests validate against hyperdrive-importer-result.v1', () => {
  it('validates the legacy builder manifest (fingerprint computed)', () => {
    const archive = buildImporterResultArchive({
      manifest: { importerId: 'iec61131-ed4-upgrade', importerVersion: '0.1.0', vendorFamily: 'iec61131-legacy' },
      sourcePath: 'legacy.st',
      sourceContent: 'PROGRAM P\nEND_PROGRAM\n',
      diagnostics: { schemaVersion: 'hyperdrive.importer-diagnostics.v1', diagnostics: [] },
      preservation: { 'preservation/il/legacy.il.txt': 'LD x' },
    });
    // JSON round trip drops `preservation: undefined`-style keys exactly as the zip does.
    expectValidManifest(JSON.parse(JSON.stringify(archive.manifest)));
  });
});
