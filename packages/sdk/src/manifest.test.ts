import { describe, expect, it } from 'vitest';

import { toyManifest } from './__fixtures__/importers.js';
import {
  capabilityEntries,
  ImporterManifestError,
  isSdkCompatible,
  parseImporterManifest,
  toCapabilitiesDocument,
  validateImporterManifest,
  type ImporterManifest,
} from './manifest.js';
import { capabilitiesDocumentProblems } from './validation.js';

function problemsOf(value: unknown): string[] {
  const result = validateImporterManifest(value);
  return result.ok ? [] : result.problems;
}

function withCapability(patch: Record<string, unknown>): unknown {
  const manifest = toyManifest();
  return { ...manifest, capabilities: [{ ...manifest.capabilities[0], ...patch }] };
}

function withInputs(patch: Record<string, unknown>): unknown {
  const capability = toyManifest().capabilities[0]!;
  return withCapability({ inputs: { ...capability.inputs, ...patch } });
}

describe('validateImporterManifest', () => {
  it('accepts a complete manifest and returns a frozen deep copy', () => {
    const input = toyManifest();
    const result = validateImporterManifest(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual(input);
    expect(result.manifest).not.toBe(input);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.capabilities[0]!.inputs.fileExtensions)).toBe(true);
    input.name = 'changed later';
    expect(result.manifest.name).toBe('Toy text importer');
  });

  it('accepts the optional $schema, description, product and coverage fields', () => {
    expect(
      problemsOf({
        ...(withCapability({ product: 'Toy Studio', productVersions: ['v1', 'v2'], coverageNotes: ['no SFC'] }) as object),
        $schema: './node_modules/@wormhole/sdk/dist/schemas/wormhole-importer.v1.schema.json',
        description: 'Toy',
      }),
    ).toEqual([]);
  });

  it('treats unknown fields as errors, at the top level and inside capabilities', () => {
    expect(problemsOf({ ...toyManifest(), signature: 'abc' })).toEqual([expect.stringContaining('"signature"')]);
    expect(problemsOf(withCapability({ vendorr: 'typo' }))).toEqual([expect.stringContaining('"vendorr"')]);
    expect(problemsOf(withInputs({ maxbytes: 1 }))).toEqual([expect.stringContaining('"maxbytes"')]);
  });

  it('reports every missing required field', () => {
    const problems = problemsOf({ schemaVersion: 'wormhole.importer.v1' });
    for (const field of ['id', 'name', 'version', 'license', 'sdk', 'capabilities']) {
      expect(problems.join('\n')).toContain(`'${field}'`);
    }
  });

  it.each([
    ['not an object', 42],
    ['null', null],
    ['an array', []],
    ['wrong schemaVersion', { ...toyManifest(), schemaVersion: 'wormhole.importer.v2' }],
  ])('rejects %s', (_, value) => {
    expect(problemsOf(value).length).toBeGreaterThan(0);
  });

  it.each(['toy', 'Toy.text', 'toy..text', 'toy.text-', '-toy.text', 'toy_text.x', 'toy.text.'])(
    'rejects id %j (dotted, lowercase, at least two segments)',
    (id) => {
      expect(problemsOf({ ...toyManifest(), id })).not.toEqual([]);
    },
  );

  it.each(['toy.text', 'acme.l5x', 'a1.b2.c3', 'acme-corp.rs-logix'])('accepts id %j', (id) => {
    expect(problemsOf({ ...toyManifest(), id })).toEqual([]);
  });

  it.each(['1.0', 'v1.0.0', '01.0.0', '1.0.0.0', ''])('rejects version %j', (version) => {
    expect(problemsOf({ ...toyManifest(), version })).not.toEqual([]);
  });

  it.each(['1.0.0-beta.1', '2.3.4+build.5'])('accepts version %j', (version) => {
    expect(problemsOf({ ...toyManifest(), version })).toEqual([]);
  });

  it.each(['not a range', '^^1', '>=1 <'])('rejects sdk range %j', (sdk) => {
    expect(problemsOf({ ...toyManifest(), sdk })).toEqual([expect.stringContaining('/sdk')]);
  });

  it.each(['../dist/index.js', '/abs/index.js', 'https://cdn.example/x.js', 'dist\\index.js', ' dist/index.js', 'dist/index.js?x', 'dist/%2e%2e/x.js', './dist/index.js', 'dist//index.js'])(
    'rejects entry %j',
    (entry) => {
      expect(problemsOf({ ...toyManifest(), entry })).toEqual([expect.stringContaining('/entry')]);
    },
  );

  it('rejects duplicate capability ids', () => {
    const manifest = toyManifest();
    const capability = manifest.capabilities[0]!;
    expect(problemsOf({ ...manifest, capabilities: [capability, capability] })).toEqual([
      expect.stringContaining('declared twice'),
    ]);
  });

  it('requires at least one capability', () => {
    expect(problemsOf({ ...toyManifest(), capabilities: [] })).not.toEqual([]);
  });

  it.each([
    ['uppercase extension', { fileExtensions: ['.TXT'] }],
    ['extension without dot', { fileExtensions: ['txt'] }],
    ['empty extensions', { fileExtensions: [] }],
    ['duplicate extensions', { fileExtensions: ['.txt', '.txt'] }],
    ['unknown container', { containers: ['tarball'] }],
    ['no containers', { containers: [] }],
    ['zero maxBytes', { maxBytes: 0 }],
    ['fractional maxBytes', { maxBytes: 1.5 }],
    ['bad media type', { mediaTypes: ['text'] }],
  ])('rejects capability inputs with %s', (_, patch) => {
    expect(problemsOf(withInputs(patch))).not.toEqual([]);
  });

  it.each([
    ['without sources', ['diagnostics']],
    ['without diagnostics', ['sources']],
    ['with an unknown kind', ['sources', 'diagnostics', 'binaries']],
  ])('rejects outputs %s', (_, outputs) => {
    expect(problemsOf(withCapability({ outputs }))).not.toEqual([]);
  });

  it('rejects an uppercase capability id', () => {
    expect(problemsOf(withCapability({ id: 'Toy.Text' }))).not.toEqual([]);
  });

  it('parseImporterManifest throws ImporterManifestError listing every problem', () => {
    const bad = { ...toyManifest(), version: 'x', sdk: 'nope' };
    try {
      parseImporterManifest(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImporterManifestError);
      expect((error as ImporterManifestError).problems.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('isSdkCompatible', () => {
  it.each([
    ['^1.0.0', '1.0.0', true],
    ['^1.0.0', '1.4.0', true],
    ['^1.2.0', '1.0.0', false],
    ['^1.0.0', '2.0.0', false],
    ['>=1.0.0 <3', '2.1.0', true],
    ['*', '9.9.9', true],
  ])('range %s with API %s → %s', (sdk, api, expected) => {
    expect(isSdkCompatible({ sdk }, api)).toBe(expected);
  });

  it('defaults to this SDK API version (1.x)', () => {
    expect(isSdkCompatible({ sdk: '^1.0.0' })).toBe(true);
    expect(isSdkCompatible({ sdk: '^2.0.0' })).toBe(false);
  });
});

describe('capabilities mapping', () => {
  it('maps a capability onto hyperdrive.importer-capabilities.v1', () => {
    const manifest: ImporterManifest = {
      ...toyManifest(),
      capabilities: [{ ...toyManifest().capabilities[0]!, coverageNotes: ['no SFC'] }],
    };
    expect(capabilityEntries(manifest)).toEqual([
      {
        id: 'toy.text',
        vendorFamily: 'toy',
        displayName: 'Toy .txt to VAR_GLOBAL',
        fileExtensions: ['.txt'],
        maxUploadBytes: 1_000_000,
        coverageNotes: ['no SFC'],
      },
    ]);
  });

  it('omits empty coverage notes and sorts capabilities across manifests', () => {
    const other = toyManifest({ id: 'aaa.first' });
    other.capabilities = [{ ...other.capabilities[0]!, id: 'aaa.cap' }];
    const document = toCapabilitiesDocument([toyManifest(), other]);
    expect(document.importers.map((entry) => entry.id)).toEqual(['aaa.cap', 'toy.text']);
    expect(document.importers[1]).not.toHaveProperty('coverageNotes');
    expect(capabilitiesDocumentProblems(document)).toEqual([]);
  });

  it('produces an empty but valid document for no importers', () => {
    const document = toCapabilitiesDocument([]);
    expect(document).toEqual({ schemaVersion: 'hyperdrive.importer-capabilities.v1', importers: [] });
    expect(capabilitiesDocumentProblems(document)).toEqual([]);
  });
});
