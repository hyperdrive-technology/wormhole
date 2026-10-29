import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOY_CAPABILITY_ID, toyImporter, toyManifest } from './__fixtures__/importers.js';
import { ImporterHostError } from './errors.js';
import { ImporterHost, MAX_RUN_LOG_ENTRIES, type ImportRunOutcome, type RunRequest } from './host.js';
import type { ImportResult, WormholeImporter } from './importer.js';
import type { ImporterManifest } from './manifest.js';
import { VirtualFileTree } from './tree.js';
import { diagnosticsReportProblems, resultManifestProblems } from './validation.js';

function tree(files: Record<string, string | Uint8Array>, container: 'file' | 'directory' | 'zip' = 'directory') {
  const loaded = VirtualFileTree.fromEntries(
    Object.entries(files).map(([path, content]) => ({ path, content })),
    { container },
  );
  expect(loaded.fatal).toBe(false);
  return loaded.tree;
}

function hostWith(...importers: WormholeImporter[]): ImporterHost {
  const host = new ImporterHost();
  for (const importer of importers) host.register(importer);
  return host;
}

function expectHostError(run: () => unknown, code: ImporterHostError['code']): ImporterHostError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ImporterHostError);
    expect((error as ImporterHostError).code).toBe(code);
    return error as ImporterHostError;
  }
  throw new Error(`expected ImporterHostError ${code}`);
}

async function runToy(
  result: Partial<ImportResult> | (() => unknown),
  request: Partial<RunRequest> = {},
  host?: ImporterHost,
): Promise<ImportRunOutcome> {
  const importer = toyImporter({
    import: typeof result === 'function' ? (result as WormholeImporter['import']) : () => ({ ...validResult(), ...result }),
  });
  return (host ?? hostWith(importer)).run({
    capabilityId: TOY_CAPABILITY_ID,
    input: tree({ 'tags.txt': 'Start\n' }),
    ...request,
  });
}

function validResult(): ImportResult {
  return {
    sources: { 'sources/tags.plc': 'VAR_GLOBAL\nEND_VAR\n' },
    diagnostics: [],
    summary: { message: 'ok' },
  };
}

/** Every outcome, whatever its status, must carry schema-valid diagnostics. */
function expectFailure(outcome: ImportRunOutcome, code: string, diagnosticCode?: string): void {
  expect(outcome.status).toBe('failed');
  expect(outcome.failure?.code).toBe(code);
  expect(outcome.archive).toBeUndefined();
  expect(diagnosticsReportProblems(outcome.diagnostics)).toEqual([]);
  if (diagnosticCode) {
    expect(outcome.diagnostics.diagnostics.map((diagnostic) => diagnostic.code)).toContain(diagnosticCode);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ImporterHost.register', () => {
  it('registers an importer and lists its manifest and capabilities', () => {
    const host = hostWith(toyImporter());
    expect(host.importers().map((manifest) => manifest.id)).toEqual(['toy.text-importer']);
    expect(host.capabilities()).toEqual({
      schemaVersion: 'hyperdrive.importer-capabilities.v1',
      importers: [
        { id: 'toy.text', vendorFamily: 'toy', displayName: 'Toy .txt to VAR_GLOBAL', fileExtensions: ['.txt'], maxUploadBytes: 1_000_000 },
      ],
    });
  });

  it.each([
    ['null', null],
    ['a string', 'importer'],
    ['missing detect', { manifest: toyManifest(), import: () => validResult() }],
    ['import not a function', { manifest: toyManifest(), detect: () => null, import: 'nope' }],
  ])('refuses %s with INVALID_IMPORTER', (_, value) => {
    expectHostError(() => new ImporterHost().register(value as unknown as WormholeImporter), 'INVALID_IMPORTER');
  });

  it('refuses an invalid manifest with every problem in details', () => {
    const error = expectHostError(
      () => new ImporterHost().register(toyImporter({ manifest: { ...toyManifest(), id: 'Bad', extra: 1 } as unknown as ImporterManifest })),
      'INVALID_MANIFEST',
    );
    expect(error.details.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses an importer whose sdk range excludes the host API version', () => {
    expectHostError(() => new ImporterHost().register(toyImporter({ manifest: toyManifest({ sdk: '^2.0.0' }) })), 'SDK_INCOMPATIBLE');
    expect(() => new ImporterHost({ apiVersion: '2.1.0' }).register(toyImporter({ manifest: toyManifest({ sdk: '^2.0.0' }) }))).not.toThrow();
    expectHostError(() => new ImporterHost({ apiVersion: '2.1.0' }).register(toyImporter()), 'SDK_INCOMPATIBLE');
  });

  it('refuses a duplicate importer id', () => {
    const host = hostWith(toyImporter());
    expectHostError(() => host.register(toyImporter()), 'DUPLICATE_IMPORTER');
  });

  it('refuses a capability id another importer already provides', () => {
    const host = hostWith(toyImporter());
    const error = expectHostError(() => host.register(toyImporter({ manifest: toyManifest({ id: 'other.importer' }) })), 'DUPLICATE_CAPABILITY');
    expect(error.details).toEqual(['toy.text (registered by toy.text-importer)']);
  });

  it('unregisters importers and frees their capability ids', () => {
    const host = hostWith(toyImporter());
    host.unregister('toy.text-importer');
    expect(host.importers()).toEqual([]);
    expect(() => host.register(toyImporter({ manifest: toyManifest({ id: 'other.importer' }) }))).not.toThrow();
    expectHostError(() => host.unregister('toy.text-importer'), 'UNKNOWN_IMPORTER');
  });

  it('keeps its own copy of the manifest', () => {
    const manifest = toyManifest();
    const host = hostWith(toyImporter({ manifest }));
    manifest.version = '9.9.9';
    expect(host.importers()[0]?.version).toBe('1.2.3');
  });

  it('rejects invalid default limits', () => {
    expectHostError(() => new ImporterHost({ defaultLimits: { maxInputFiles: 0 } }), 'INVALID_REQUEST');
  });
});

describe('ImporterHost.detectAll', () => {
  function detector(id: string, capabilityId: string, detect: WormholeImporter['detect']): WormholeImporter {
    const manifest = toyManifest({ id });
    manifest.capabilities = [{ ...manifest.capabilities[0]!, id: capabilityId }];
    return toyImporter({ manifest, detect });
  }

  it('ranks candidates by confidence, then importer id, then capability id', () => {
    const host = hostWith(
      detector('zeta.importer', 'zeta.cap', () => ({ capabilityId: 'zeta.cap', confidence: 0.5, reason: 'z' })),
      detector('alpha.importer', 'alpha.cap', () => ({ capabilityId: 'alpha.cap', confidence: 0.5, reason: 'a' })),
      detector('best.importer', 'best.cap', () => ({ capabilityId: 'best.cap', confidence: 0.95, reason: 'b' })),
    );
    expect(host.detectAll(tree({ 'x.txt': 'X' })).map((candidate) => candidate.importerId)).toEqual([
      'best.importer',
      'alpha.importer',
      'zeta.importer',
    ]);
  });

  it('is independent of registration order', () => {
    const a = detector('a.importer', 'a.cap', () => ({ capabilityId: 'a.cap', confidence: 0.4, reason: 'a' }));
    const b = detector('b.importer', 'b.cap', () => ({ capabilityId: 'b.cap', confidence: 0.4, reason: 'b' }));
    const input = tree({ 'x.txt': 'X' });
    expect(hostWith(a, b).detectAll(input)).toEqual(hostWith(b, a).detectAll(input));
  });

  it('skips and logs importers that throw or answer nonsense, without affecting others', () => {
    const logs: string[] = [];
    const host = new ImporterHost({ onLog: (entry) => logs.push(`${entry.importerId}: ${entry.message}`) });
    const bad: Array<[string, WormholeImporter['detect']]> = [
      ['throws.importer', () => { throw new Error('boom'); }],
      ['wrongcap.importer', () => ({ capabilityId: 'someone.else', confidence: 0.9, reason: 'x' })],
      ['nan.importer', () => ({ capabilityId: 'nan.cap', confidence: Number.NaN, reason: 'x' })],
      ['high.importer', () => ({ capabilityId: 'high.cap', confidence: 1.5, reason: 'x' })],
      ['negative.importer', () => ({ capabilityId: 'negative.cap', confidence: -0.1, reason: 'x' })],
      ['noreason.importer', () => ({ capabilityId: 'noreason.cap', confidence: 0.5, reason: '' })],
      ['string.importer', () => 'yes' as never],
    ];
    for (const [id, detect] of bad) host.register(detector(id, id.replace('.importer', '.cap'), detect));
    host.register(detector('good.importer', 'good.cap', () => ({ capabilityId: 'good.cap', confidence: 0.7, reason: 'ok' })));
    expect(host.detectAll(tree({ 'x.txt': 'X' }))).toEqual([
      { importerId: 'good.importer', capabilityId: 'good.cap', confidence: 0.7, reason: 'ok' },
    ]);
    expect(logs).toHaveLength(bad.length);
    expect(logs.join('\n')).toContain('throws.importer: detect() threw: boom');
  });

  it('drops null, undefined and zero-confidence answers silently', () => {
    const host = hostWith(
      detector('null.importer', 'null.cap', () => null),
      detector('undef.importer', 'undef.cap', () => undefined as never),
      detector('zero.importer', 'zero.cap', () => ({ capabilityId: 'zero.cap', confidence: 0, reason: 'no' })),
    );
    expect(host.detectAll(tree({}))).toEqual([]);
  });
});

describe('ImporterHost.run: success', () => {
  it('builds a schema-valid, deterministic result archive', async () => {
    const host = hostWith(toyImporter());
    const input = tree({ 'b/two.txt': 'Beta\nnot valid!\n', 'a/one.txt': 'Alpha\n' });
    const outcome = await host.run({ capabilityId: TOY_CAPABILITY_ID, input });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.failure).toBeUndefined();
    const archive = outcome.archive!;
    expect(archive.manifest).toEqual({
      schemaVersion: 'hyperdrive.importer-result.v1',
      importerId: 'toy.text',
      importerVersion: '1.2.3',
      vendorFamily: 'toy',
      sourceFingerprint: input.fingerprint(),
      canonicalSources: ['sources/a/one.plc', 'sources/b/two.plc'],
      preservation: ['preservation/b/two.txt.rejected'],
      diagnostics: 'diagnostics.json',
    });
    // Not in the manifest until core's closed result schema lists it (wormhole#2).
    expect(archive.manifest).not.toHaveProperty('summary');
    expect(resultManifestProblems(archive.manifest)).toEqual([]);
    expect(outcome.summary).toEqual({ message: 'Converted 2 file(s).', stats: { files: 2 } });
    expect(outcome.importerId).toBe('toy.text-importer');
    expect(outcome.importerVersion).toBe('1.2.3');
    expect(outcome.stats).toMatchObject({ inputFiles: 2, inputBytes: input.totalBytes });
    expect(outcome.stats.outputBytes).toBeGreaterThan(0);

    const unzipped = unzipSync(archive.zipBytes);
    expect(Object.keys(unzipped)).toEqual([
      'manifest.json',
      'diagnostics.json',
      'sources/a/one.plc',
      'sources/b/two.plc',
      'preservation/b/two.txt.rejected',
    ]);
    expect(new TextDecoder().decode(unzipped['sources/a/one.plc'])).toBe('VAR_GLOBAL\n  Alpha : BOOL;\nEND_VAR\n');
    expect(JSON.parse(new TextDecoder().decode(unzipped['manifest.json']))).toEqual(archive.manifest);
    expect(JSON.parse(new TextDecoder().decode(unzipped['diagnostics.json']))).toEqual(outcome.diagnostics);
  });

  it('gives byte-identical archives for identical input, however the tree was built', async () => {
    const files = { 'z.txt': 'Zed\n', 'a.txt': 'Ay\n', 'm/n.txt': 'Em\n' };
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const first = await hostWith(toyImporter()).run({ capabilityId: TOY_CAPABILITY_ID, input: tree(files) });
    const second = await hostWith(toyImporter()).run({ capabilityId: TOY_CAPABILITY_ID, input: tree(reversed) });
    expect(Buffer.from(first.archive!.zipBytes).equals(Buffer.from(second.archive!.zipBytes))).toBe(true);
  });

  it('gives byte-identical archives in different timezones and at different times', async () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utc = await runToy({});
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2031-06-15T12:34:56Z'));
      process.env.TZ = 'Pacific/Kiritimati';
      const kiritimati = await runToy({});
      vi.useRealTimers();
      process.env.TZ = 'America/St_Johns';
      const stJohns = await runToy({});
      expect(Buffer.from(utc.archive!.zipBytes).equals(Buffer.from(kiritimati.archive!.zipBytes))).toBe(true);
      expect(Buffer.from(utc.archive!.zipBytes).equals(Buffer.from(stJohns.archive!.zipBytes))).toBe(true);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('puts input diagnostics first, then the importer diagnostics, in the archive too', async () => {
    const loaded = VirtualFileTree.fromEntries([
      { path: 'Tags.txt', content: 'A\n' },
      { path: 'tags.txt', content: 'B\n' },
    ]);
    const outcome = await hostWith(toyImporter({ import: () => ({ ...validResult(), diagnostics: [{ code: 'TOY_NOTE', severity: 'info', message: 'note' }] }) })).run({
      capabilityId: TOY_CAPABILITY_ID,
      input: loaded,
    });
    expect(outcome.diagnostics.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['WORMHOLE_INPUT_CASE_COLLISION', 'TOY_NOTE']);
    const unzipped = unzipSync(outcome.archive!.zipBytes);
    expect(JSON.parse(new TextDecoder().decode(unzipped['diagnostics.json'])).diagnostics).toHaveLength(2);
  });

  it('writes binary sidecars and assets verbatim and records unsupported semantics', async () => {
    const bytes = new Uint8Array([0, 255, 1, 254]);
    const outcome = await runToy({
      preservation: { 'preservation/raw.bin': bytes },
      assets: { 'assets/logo.svg': '<svg/>' },
      unsupportedSemantics: [{ code: 'TOY_SFC', message: 'SFC not converted', severity: 'warning' }],
    });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.archive!.manifest.assets).toEqual(['assets/logo.svg']);
    expect(outcome.archive!.manifest.unsupportedSemantics).toEqual([{ code: 'TOY_SFC', message: 'SFC not converted', severity: 'warning' }]);
    expect(Array.from(unzipSync(outcome.archive!.zipBytes)['preservation/raw.bin']!)).toEqual([0, 255, 1, 254]);
  });

  it('passes frozen input and options, and gives importers the migrate toolkit', async () => {
    let seen: { frozen: boolean; options: unknown; capabilityId: string; upgraded: string } | undefined;
    const importer = toyImporter({
      import(input, ctx) {
        seen = {
          frozen: Object.isFrozen(input) && Object.isFrozen(input.options),
          options: input.options,
          capabilityId: input.capabilityId,
          upgraded: ctx.migrate.upgradeSource('X := 8#17;', { sourceKind: 'st', fileName: 'x.st', apply: true }).source,
        };
        return validResult();
      },
    });
    await hostWith(importer).run({ capabilityId: TOY_CAPABILITY_ID, input: tree({ 'a.txt': 'A' }), options: { apply: false, mode: 'fast', level: 2 } });
    expect(seen).toEqual({ frozen: true, options: { apply: false, mode: 'fast', level: 2 }, capabilityId: 'toy.text', upgraded: 'X := 16#F;' });
  });

  it('collects importer logs, tags them for onLog, and caps them', async () => {
    const tagged: string[] = [];
    const host = new ImporterHost({ onLog: (entry) => tagged.push(`${entry.importerId}/${entry.capabilityId}`) });
    host.register(
      toyImporter({
        import(_, ctx) {
          ctx.logger.info('hello', { files: 1 });
          for (let index = 0; index < MAX_RUN_LOG_ENTRIES + 5; index += 1) ctx.logger.debug('spam');
          return validResult();
        },
      }),
    );
    const outcome = await host.run({ capabilityId: TOY_CAPABILITY_ID, input: tree({ 'a.txt': 'A' }) });
    expect(outcome.logs[0]).toMatchObject({ level: 'info', message: 'hello', fields: { files: 1 } });
    expect(outcome.logs).toHaveLength(MAX_RUN_LOG_ENTRIES + 1);
    expect(outcome.logs.at(-1)?.message).toBe('6 further log entries were dropped');
    expect(tagged).toHaveLength(MAX_RUN_LOG_ENTRIES + 6);
    expect(tagged[0]).toBe('toy.text-importer/toy.text');
  });
});

describe('ImporterHost.run: input checks', () => {
  it('rejects a fatal load result without calling the importer', async () => {
    const importFn = vi.fn(() => validResult());
    const loaded = VirtualFileTree.fromEntries([{ path: '../evil.txt', content: 'x' }]);
    const outcome = await hostWith(toyImporter({ import: importFn })).run({ capabilityId: TOY_CAPABILITY_ID, input: loaded });
    expectFailure(outcome, 'INPUT_REJECTED', 'WORMHOLE_INPUT_UNSAFE_PATH');
    expect(importFn).not.toHaveBeenCalled();
  });

  it('rejects a container kind the capability does not accept', async () => {
    const manifest = toyManifest();
    manifest.capabilities[0]!.inputs.containers = ['zip'];
    const outcome = await hostWith(toyImporter({ manifest })).run({ capabilityId: TOY_CAPABILITY_ID, input: tree({ 'a.txt': 'A' }, 'file') });
    expectFailure(outcome, 'INPUT_REJECTED', 'WORMHOLE_INPUT_CONTAINER_UNSUPPORTED');
  });

  it('enforces maxInputFiles and maxInputBytes from the run limits', async () => {
    const input = tree({ 'a.txt': 'AAAA', 'b.txt': 'BBBB' });
    expectFailure(await runToy({}, { input, limits: { maxInputFiles: 1 } }), 'LIMIT_EXCEEDED', 'WORMHOLE_INPUT_TOO_MANY_FILES');
    expectFailure(await runToy({}, { input, limits: { maxInputBytes: 7 } }), 'LIMIT_EXCEEDED', 'WORMHOLE_INPUT_TOO_LARGE');
    expect((await runToy({}, { input, limits: { maxInputBytes: 8, maxInputFiles: 2 } })).status).toBe('succeeded');
  });

  it("enforces the capability's own maxBytes even under larger run limits", async () => {
    const manifest = toyManifest();
    manifest.capabilities[0]!.inputs.maxBytes = 3;
    const outcome = await hostWith(toyImporter({ manifest })).run({ capabilityId: TOY_CAPABILITY_ID, input: tree({ 'a.txt': 'AAAA' }) });
    expectFailure(outcome, 'LIMIT_EXCEEDED', 'WORMHOLE_INPUT_TOO_LARGE');
  });
});

describe('ImporterHost.run: cancellation and time', () => {
  it('does not call the importer when the signal is already aborted', async () => {
    const importFn = vi.fn(() => validResult());
    const controller = new AbortController();
    controller.abort();
    const outcome = await hostWith(toyImporter({ import: importFn })).run({ capabilityId: TOY_CAPABILITY_ID, input: tree({ 'a.txt': 'A' }), signal: controller.signal });
    expectFailure(outcome, 'ABORTED', 'WORMHOLE_RUN_ABORTED');
    expect(importFn).not.toHaveBeenCalled();
  });

  it('stops waiting for an async importer as soon as the caller aborts', async () => {
    const controller = new AbortController();
    const pending = runToy(() => new Promise(() => undefined), { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    expectFailure(await pending, 'ABORTED');
  });

  it('reports ABORTED when a synchronous importer finishes after the caller aborted', async () => {
    const controller = new AbortController();
    const pending = runToy(() => validResult(), { signal: controller.signal });
    controller.abort();
    expectFailure(await pending, 'ABORTED');
  });

  it('ignores an importer that settles (or rejects) after the run gave up on it', async () => {
    const controller = new AbortController();
    let rejectLate: (error: Error) => void = () => undefined;
    const pending = runToy(() => new Promise((_, reject) => { rejectLate = reject; }), { signal: controller.signal });
    controller.abort();
    expectFailure(await pending, 'ABORTED');
    rejectLate(new Error('late failure')); // must not surface as an unhandled rejection
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it('cuts off an async importer at the wall-time limit', async () => {
    const outcome = await runToy(() => new Promise(() => undefined), { limits: { maxWallTimeMs: 20 } });
    expectFailure(outcome, 'LIMIT_EXCEEDED', 'WORMHOLE_RUN_WALL_TIME_EXCEEDED');
  });

  it('fails a synchronous importer that overran the wall-time limit (fake clock)', async () => {
    let now = 0;
    const host = new ImporterHost({ clock: () => now });
    host.register(toyImporter({ import: () => { now += 5_000; return validResult(); } }));
    const outcome = await host.run({ capabilityId: TOY_CAPABILITY_ID, input: tree({ 'a.txt': 'A' }), limits: { maxWallTimeMs: 1_000 } });
    expectFailure(outcome, 'LIMIT_EXCEEDED', 'WORMHOLE_RUN_WALL_TIME_EXCEEDED');
  });

  it('lets a cooperative importer stop early through ctx.throwIfAborted()', async () => {
    let now = 0;
    let filesProcessed = 0;
    const host = new ImporterHost({ clock: () => now });
    host.register(
      toyImporter({
        import(_, ctx) {
          for (let index = 0; index < 100; index += 1) {
            ctx.throwIfAborted();
            filesProcessed += 1;
            now += 100;
          }
          return validResult();
        },
      }),
    );
    const outcome = await host.run({ capabilityId: TOY_CAPABILITY_ID, input: tree({ 'a.txt': 'A' }), limits: { maxWallTimeMs: 1_000 } });
    expectFailure(outcome, 'LIMIT_EXCEEDED', 'WORMHOLE_RUN_WALL_TIME_EXCEEDED');
    expect(filesProcessed).toBe(11);
  });
});

describe('ImporterHost.run: misbehaving importers', () => {
  it.each([
    ['a synchronous throw', () => { throw new Error('parse exploded'); }, 'parse exploded'],
    ['an async rejection', async () => { throw new TypeError('bad thing'); }, 'bad thing'],
    ['a thrown string', () => { throw 'just a string'; }, 'just a string'],
    ['a thrown object whose toString throws', () => { throw { toString() { throw new Error('nope'); } }; }, 'unprintable thrown value'],
  ])('turns %s into IMPORTER_THREW', async (_, importFn, message) => {
    const outcome = await runToy(importFn as () => unknown);
    expectFailure(outcome, 'IMPORTER_THREW', 'WORMHOLE_RUN_IMPORTER_THREW');
    expect(outcome.failure?.message).toContain(message);
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'done'],
    ['an array', []],
    ['no summary', { sources: {}, diagnostics: [] }],
    ['an empty summary message', { ...validResult(), summary: { message: '' } }],
    ['a negative stat', { ...validResult(), summary: { message: 'x', stats: { files: -1 } } }],
    ['a fractional stat', { ...validResult(), summary: { message: 'x', stats: { files: 1.5 } } }],
    ['a badly named stat', { ...validResult(), summary: { message: 'x', stats: { '1files': 1 } } }],
    ['an unknown summary field', { ...validResult(), summary: { message: 'x', extra: true } }],
    ['an unknown result field', { ...validResult(), warnings: [] }],
    ['non-string source content', { ...validResult(), sources: { 'sources/a.plc': new Uint8Array([65]) } }],
    ['diagnostics that are not an array', { ...validResult(), diagnostics: {} }],
    ['preservation that is a Map', { ...validResult(), preservation: new Map() }],
    ['unsupportedSemantics that is not an array', { ...validResult(), unsupportedSemantics: 'x' }],
  ])('rejects a result with %s as INVALID_RESULT', async (_, value) => {
    expectFailure(await runToy(() => value), 'INVALID_RESULT', 'WORMHOLE_RUN_INVALID_RESULT');
  });

  it.each([
    ['an unknown severity', { code: 'X', message: 'm', severity: 'fatal' }],
    ['an empty message', { code: 'X', message: '', severity: 'error' }],
    ['a code with spaces', { code: 'BAD CODE', message: 'm', severity: 'error' }],
    ['an unsafe source path', { code: 'X', message: 'm', severity: 'error', source: { path: '../outside.txt' } }],
    ['an absolute source path', { code: 'X', message: 'm', severity: 'error', source: { path: '/etc/passwd' } }],
    ['line 0', { code: 'X', message: 'm', severity: 'error', source: { path: 'a.txt', startLine: 0 } }],
    ['an extra field', { code: 'X', message: 'm', severity: 'error', fix: 'x' }],
  ])('rejects diagnostics with %s', async (_, diagnostic) => {
    const outcome = await runToy({ diagnostics: [diagnostic as never] });
    expectFailure(outcome, 'INVALID_RESULT', 'WORMHOLE_RUN_INVALID_RESULT');
  });

  it('rejects unsupportedSemantics that break the result schema', async () => {
    const outcome = await runToy({ unsupportedSemantics: [{ code: 'X' } as never] });
    expectFailure(outcome, 'INVALID_RESULT', 'WORMHOLE_RUN_INVALID_RESULT');
  });

  // wormhole#7: these used to escape run() as a rejection from JSON.stringify.
  it.each([
    ['a circular array', () => { const cycle: unknown[] = []; cycle.push(cycle); return cycle; }],
    ['a circular entry', () => { const entry: Record<string, unknown> = { code: 'X', message: 'm' }; entry.self = entry; return [entry]; }],
    ['a BigInt field', () => [{ code: 'X', message: 'm', count: 1n }]],
    ['a BigInt message', () => [{ code: 'X', message: 1n }]],
    ['a getter that throws', () => [Object.defineProperty({ code: 'X' }, 'message', { enumerable: true, get: () => { throw new Error('boom'); } })]],
  ])('returns INVALID_RESULT (never rejects) for unsupportedSemantics with %s', async (_, make) => {
    const outcome = await runToy({ unsupportedSemantics: make() as never });
    expectFailure(outcome, 'INVALID_RESULT', 'WORMHOLE_RUN_INVALID_RESULT');
  });

  it('returns INVALID_RESULT for unserialisable unsupportedSemantics even when the output limit is tiny', async () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const outcome = await runToy({ unsupportedSemantics: cycle as never }, { limits: { maxOutputBytes: 1 } });
    expectFailure(outcome, 'INVALID_RESULT', 'WORMHOLE_RUN_INVALID_RESULT');
  });

  it('lists every unsafe output path', async () => {
    const outcome = await runToy({
      sources: {
        'sources/../escape.plc': 'x',
        'src/wrong-prefix.plc': 'x',
        'sources/ok.plc': 'x',
        'sources/OK.plc': 'x',
        'sources/CON.plc': 'x',
      },
      preservation: { 'notes.txt': 'x' },
      assets: { 'assets/a\\b.png': 'x' },
    });
    expectFailure(outcome, 'INVALID_RESULT', 'WORMHOLE_RUN_UNSAFE_OUTPUT_PATH');
    const unsafe = outcome.diagnostics.diagnostics.filter((diagnostic) => diagnostic.code === 'WORMHOLE_RUN_UNSAFE_OUTPUT_PATH');
    expect(unsafe).toHaveLength(6);
  });

  it('reports NO_SOURCES with the importer diagnostics and summary when nothing was produced', async () => {
    const outcome = await runToy({ sources: {}, diagnostics: [{ code: 'TOY_GARBAGE', severity: 'error', message: 'not a toy file' }], summary: { message: 'Nothing converted.' } });
    expectFailure(outcome, 'NO_SOURCES', 'WORMHOLE_RUN_NO_SOURCES');
    expect(outcome.diagnostics.diagnostics[0]?.code).toBe('TOY_GARBAGE');
    expect(outcome.summary).toEqual({ message: 'Nothing converted.' });
  });

  it('enforces maxOutputBytes', async () => {
    const outcome = await runToy({ sources: { 'sources/big.plc': 'x'.repeat(5_000) } }, { limits: { maxOutputBytes: 4_096 } });
    expectFailure(outcome, 'LIMIT_EXCEEDED', 'WORMHOLE_RUN_OUTPUT_TOO_LARGE');
    expect(outcome.stats.outputBytes).toBeGreaterThan(4_096);
  });

  // wormhole#3: summary and unsupportedSemantics land in manifest.json, so they count too.
  it('counts a large summary message toward maxOutputBytes', async () => {
    const outcome = await runToy({ summary: { message: 'x'.repeat(5_000) } }, { limits: { maxOutputBytes: 4_096 } });
    expectFailure(outcome, 'LIMIT_EXCEEDED', 'WORMHOLE_RUN_OUTPUT_TOO_LARGE');
    expect(outcome.stats.outputBytes).toBeGreaterThan(5_000);
  });

  it('counts summary stats toward maxOutputBytes', async () => {
    const stats = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`stat_${index}`, index]));
    const outcome = await runToy({ summary: { message: 'ok', stats } }, { limits: { maxOutputBytes: 4_096 } });
    expectFailure(outcome, 'LIMIT_EXCEEDED', 'WORMHOLE_RUN_OUTPUT_TOO_LARGE');
  });

  it('counts unsupportedSemantics toward maxOutputBytes', async () => {
    const unsupportedSemantics = Array.from({ length: 100 }, (_, index) => ({ code: `TOY_GAP_${index}`, message: 'y'.repeat(50) }));
    const outcome = await runToy({ unsupportedSemantics }, { limits: { maxOutputBytes: 4_096 } });
    expectFailure(outcome, 'LIMIT_EXCEEDED', 'WORMHOLE_RUN_OUTPUT_TOO_LARGE');
  });

  it('reports outputBytes that cover the manifest metadata on success', async () => {
    const small = await runToy({});
    const withMetadata = await runToy({ summary: { message: 'z'.repeat(1_000) } });
    expect(withMetadata.status).toBe('succeeded');
    expect(withMetadata.stats.outputBytes - small.stats.outputBytes).toBeGreaterThanOrEqual(1_000 - 'ok'.length);
  });
});

// wormhole#11 (and #3): maxOutputBytes measures the bytes actually serialised into the
// archive entries (pretty-printed manifest.json and diagnostics.json included), plus the
// outcome summary, not a compact-JSON estimate.
describe('ImporterHost.run: maxOutputBytes counts serialised bytes', () => {
  const rich = (): Partial<ImportResult> => ({
    sources: { 'sources/a.plc': 'VAR_GLOBAL\nEND_VAR\n', 'sources/b.plc': 'PROGRAM B\nEND_PROGRAM\n' },
    preservation: { 'preservation/a.txt': 'original', 'preservation/raw.bin': new Uint8Array([0, 1, 2, 255]) },
    assets: { 'assets/icon.svg': '<svg/>' },
    diagnostics: Array.from({ length: 12 }, (_, index) => ({ code: `TOY_NOTE_${index}`, message: `note ${index}`, severity: 'info' as const })),
    unsupportedSemantics: Array.from({ length: 8 }, (_, index) => ({ code: `TOY_GAP_${index}`, message: `gap ${index}`, severity: 'warning' as const })),
    summary: { message: 'converted', stats: { files: 2, gaps: 8 } },
  });

  function serialisedBytes(outcome: ImportRunOutcome): number {
    const entries = outcome.archive!.entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
    return entries + Buffer.byteLength(JSON.stringify(outcome.summary), 'utf8');
  }

  it('reports exactly the serialised entry bytes plus the summary', async () => {
    const outcome = await runToy(rich());
    expect(outcome.status).toBe('succeeded');
    expect(outcome.stats.outputBytes).toBe(serialisedBytes(outcome));
  });

  it('succeeds at the exact limit and fails one byte below it', async () => {
    const exact = serialisedBytes(await runToy(rich()));
    const atLimit = await runToy(rich(), { limits: { maxOutputBytes: exact } });
    expect(atLimit.status).toBe('succeeded');
    const below = await runToy(rich(), { limits: { maxOutputBytes: exact - 1 } });
    expectFailure(below, 'LIMIT_EXCEEDED', 'WORMHOLE_RUN_OUTPUT_TOO_LARGE');
    expect(below.stats.outputBytes).toBe(exact);
  });

  it('reports an invalid result before the output limit', async () => {
    const outcome = await runToy({ sources: { 'sources/../x.plc': 'x' } }, { limits: { maxOutputBytes: 1 } });
    expectFailure(outcome, 'INVALID_RESULT', 'WORMHOLE_RUN_UNSAFE_OUTPUT_PATH');
  });

  it('counts the multi-byte UTF-8 size of text, not its length', async () => {
    const plain = await runToy({ sources: { 'sources/a.plc': 'a'.repeat(100) } });
    const wide = await runToy({ sources: { 'sources/a.plc': '\u00e9'.repeat(100) } });
    expect(wide.stats.outputBytes - plain.stats.outputBytes).toBe(100);
  });
});

describe('ImporterHost.run: misuse throws', () => {
  it('throws UNKNOWN_CAPABILITY', async () => {
    await expect(hostWith(toyImporter()).run({ capabilityId: 'nope', input: tree({}) })).rejects.toMatchObject({ code: 'UNKNOWN_CAPABILITY' });
  });

  it('throws INVALID_REQUEST for the reserved narratives field', async () => {
    const request = { capabilityId: TOY_CAPABILITY_ID, input: tree({}), narratives: [{ path: 'narrative.md' }] } as unknown as RunRequest;
    await expect(hostWith(toyImporter()).run(request)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it.each([
    ['an object option', { nested: { a: 1 } }],
    ['a null option', { value: null }],
    ['options that are an array', ['a']],
  ])('throws INVALID_REQUEST for %s', async (_, options) => {
    await expect(
      hostWith(toyImporter()).run({ capabilityId: TOY_CAPABILITY_ID, input: tree({}), options: options as never }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('throws INVALID_REQUEST for invalid limits', async () => {
    await expect(
      hostWith(toyImporter()).run({ capabilityId: TOY_CAPABILITY_ID, input: tree({}), limits: { maxWallTimeMs: -1 } }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
