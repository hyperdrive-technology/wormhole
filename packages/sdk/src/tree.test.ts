import Ajv2020 from 'ajv/dist/2020.js';
import { importerDiagnosticsSchema, type ImporterDiagnostic } from '@wormhole/contract';
import { describe, expect, it } from 'vitest';

import { SdkDiagnosticCode } from './diagnostics.js';
import { VirtualFileTree, type TreeLoadResult, type VirtualFileEntryInput } from './tree.js';

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const validateReport = ajv.compile(importerDiagnosticsSchema as Record<string, unknown>);

/** Every diagnostic must be valid in a `hyperdrive.importer-diagnostics.v1` report. */
function expectSchemaValid(diagnostics: readonly ImporterDiagnostic[]): void {
  const report = { schemaVersion: 'hyperdrive.importer-diagnostics.v1', diagnostics };
  const ok = validateReport(report);
  expect(validateReport.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

/** Loads entries and checks the invariants every load result must hold. */
function load(entries: Iterable<VirtualFileEntryInput>, options?: Parameters<typeof VirtualFileTree.fromEntries>[1]): TreeLoadResult {
  const result = VirtualFileTree.fromEntries(entries, options);
  expectSchemaValid(result.diagnostics);
  if (result.fatal) {
    expect(result.tree.fileCount).toBe(0);
    expect(result.tree.totalBytes).toBe(0);
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  }
  return result;
}

function codes(result: TreeLoadResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function treeOf(entries: Record<string, string | Uint8Array>): VirtualFileTree {
  const result = load(Object.entries(entries).map(([path, content]) => ({ path, content })));
  expect(result.fatal).toBe(false);
  return result.tree;
}

const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

describe('VirtualFileTree.fromEntries: content and order', () => {
  it('sorts paths by UTF-16 code unit regardless of insertion order', () => {
    const forward = treeOf({ 'b.st': '', 'B.st': '', 'a/z.st': '', 'a.st': '', '\u00e9.st': '', 'Z.st': '' });
    const backward = treeOf({ 'Z.st': '', '\u00e9.st': '', 'a.st': '', 'a/z.st': '', 'B.st': '', 'b.st': '' });
    const expected = ['B.st', 'Z.st', 'a.st', 'a/z.st', 'b.st', '\u00e9.st'];
    expect(forward.paths()).toEqual(expected);
    expect(backward.paths()).toEqual(expected);
  });

  it('returns a frozen paths array', () => {
    const tree = treeOf({ 'a.st': 'x' });
    expect(Object.isFrozen(tree.paths())).toBe(true);
  });

  it('encodes string content as UTF-8', () => {
    const tree = treeOf({ 'a.st': 'caf\u00e9 \u{1f37a}' });
    expect(Array.from(tree.read('a.st') as Uint8Array)).toEqual(Array.from(new TextEncoder().encode('caf\u00e9 \u{1f37a}')));
    expect(tree.size('a.st')).toBe(10);
    expect(tree.totalBytes).toBe(10);
  });

  it('keeps Uint8Array content byte-for-byte', () => {
    const tree = treeOf({ 'a.bin': new Uint8Array([0, 255, 128]) });
    expect(Array.from(tree.read('a.bin') as Uint8Array)).toEqual([0, 255, 128]);
  });

  it('copies content on intake: mutating the caller array later does not change the tree', () => {
    const input = new Uint8Array([1, 2, 3]);
    const tree = treeOf({ 'a.bin': input });
    input[0] = 99;
    expect(Array.from(tree.read('a.bin') as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('copies only the view of a subarray input, not its whole backing buffer', () => {
    const backing = new Uint8Array([9, 1, 2, 9]);
    const tree = treeOf({ 'a.bin': backing.subarray(1, 3) });
    expect(Array.from(tree.read('a.bin') as Uint8Array)).toEqual([1, 2]);
    expect(tree.totalBytes).toBe(2);
  });

  it('read() returns a copy: mutating it does not change the tree', () => {
    const tree = treeOf({ 'a.bin': new Uint8Array([1, 2, 3]) });
    const first = tree.read('a.bin') as Uint8Array;
    first[0] = 42;
    expect(Array.from(tree.read('a.bin') as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('head() returns a copy: mutating it does not change the tree', () => {
    const tree = treeOf({ 'a.bin': new Uint8Array([1, 2, 3]) });
    const head = tree.head('a.bin', 2) as Uint8Array;
    head[0] = 42;
    expect(Array.from(tree.read('a.bin') as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('entries() returns copies in path order', () => {
    const tree = treeOf({ 'b.st': 'B', 'a.st': 'A' });
    const entries = tree.entries();
    expect(entries.map((entry) => entry.path)).toEqual(['a.st', 'b.st']);
    entries[0].content[0] = 0x5a;
    expect(text(tree.read('a.st'))).toBe('A');
  });

  it('normalises "./" and NFD paths on intake', () => {
    const tree = treeOf({ './dir/e\u0301.st': 'x' });
    expect(tree.paths()).toEqual(['dir/\u00e9.st']);
    expect(tree.has('dir/\u00e9.st')).toBe(true);
  });

  it('accepts an iterable (generator) of entries', () => {
    function* entries(): Generator<VirtualFileEntryInput> {
      yield { path: 'b.st', content: 'b' };
      yield { path: 'a.st', content: 'a' };
    }
    const result = load(entries());
    expect(result.tree.paths()).toEqual(['a.st', 'b.st']);
  });

  it('allows a file and a directory of the same name prefix ("a" and "a/b") in memory', () => {
    expect(treeOf({ a: '1', 'a/b': '2' }).paths()).toEqual(['a', 'a/b']);
  });
});

describe('VirtualFileTree: lookups', () => {
  const tree = treeOf({ 'a.st': 'hello', 'dir/B.ST': 'x', 'c.txt': '' });

  it('head() caps at maxBytes', () => {
    expect(text(tree.head('a.st', 2))).toBe('he');
  });

  it('head() returns the whole file when maxBytes exceeds its size', () => {
    expect(text(tree.head('a.st', 1000))).toBe('hello');
    expect(text(tree.head('a.st', Number.POSITIVE_INFINITY))).toBe('hello');
  });

  it('head() floors fractional maxBytes', () => {
    expect(text(tree.head('a.st', 2.9))).toBe('he');
  });

  it.each([-1, -100, 0, Number.NaN, Number.NEGATIVE_INFINITY])('head() with %s returns 0 bytes', (max) => {
    expect(tree.head('a.st', max)?.byteLength).toBe(0);
  });

  it('read/head/size/readText return undefined for a missing path', () => {
    expect(tree.read('missing')).toBeUndefined();
    expect(tree.head('missing', 10)).toBeUndefined();
    expect(tree.size('missing')).toBeUndefined();
    expect(tree.readText('missing')).toBeUndefined();
    expect(tree.has('missing')).toBe(false);
  });

  it('lookups are exact: they do not normalise the query path', () => {
    expect(tree.has('./a.st')).toBe(false);
    expect(tree.has('A.st')).toBe(false);
  });

  it('size() of an empty file is 0, not undefined', () => {
    expect(tree.size('c.txt')).toBe(0);
  });

  it('readText() decodes through decodeText', () => {
    const latin = treeOf({ 'l.st': new Uint8Array([0x63, 0xe9]) });
    expect(latin.readText('l.st')).toEqual({ text: 'c\u00e9', encoding: 'windows-1252', bom: false, lossy: false });
    expect(latin.readText('l.st', { fallback: 'replace' })).toMatchObject({ text: 'c\ufffd', lossy: true });
  });

  it('pathsWithExtension() is case-insensitive in both directions', () => {
    expect(tree.pathsWithExtension('.st')).toEqual(['a.st', 'dir/B.ST']);
    expect(tree.pathsWithExtension('.ST')).toEqual(['a.st', 'dir/B.ST']);
    expect(tree.pathsWithExtension('.txt', '.st')).toEqual(['a.st', 'c.txt', 'dir/B.ST']);
    expect(tree.pathsWithExtension('.zip')).toEqual([]);
    expect(tree.pathsWithExtension()).toEqual([]);
  });

  it('fileCount and totalBytes reflect the content', () => {
    expect(tree.fileCount).toBe(3);
    expect(tree.totalBytes).toBe(6);
  });
});

describe('VirtualFileTree: rejected input', () => {
  it.each(['../evil', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', 'dir/', '', 'a\u0000b'])(
    'rejects unsafe path %j as fatal with an empty tree',
    (path) => {
      const result = load([
        { path: 'ok.st', content: 'fine' },
        { path, content: 'bad' },
      ]);
      expect(result.fatal).toBe(true);
      expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_UNSAFE_PATH]);
      expect(result.tree.paths()).toEqual([]);
    },
  );

  it('rejects a non-string path as unsafe without throwing', () => {
    const result = load([{ path: 42 as unknown as string, content: 'x' }]);
    expect(result.fatal).toBe(true);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_UNSAFE_PATH]);
  });

  it('rejects "a.st" and "./a.st" as duplicates', () => {
    const result = load([
      { path: 'a.st', content: '1' },
      { path: './a.st', content: '2' },
    ]);
    expect(result.fatal).toBe(true);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_DUPLICATE_PATH]);
    expect(result.diagnostics[0].source).toEqual({ path: 'a.st' });
  });

  it('rejects NFC and NFD spellings of the same name as duplicates', () => {
    const result = load([
      { path: '\u00e9.st', content: '1' },
      { path: 'e\u0301.st', content: '2' },
    ]);
    expect(result.fatal).toBe(true);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_DUPLICATE_PATH]);
  });

  it('rejects the exact same path twice', () => {
    const result = load([
      { path: 'a.st', content: '1' },
      { path: 'a.st', content: '1' },
    ]);
    expect(result.fatal).toBe(true);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_DUPLICATE_PATH]);
  });

  it('keeps case twins and warns with INPUT_CASE_COLLISION', () => {
    const result = load([
      { path: 'Main.st', content: '1' },
      { path: 'main.st', content: '2' },
      { path: 'MAIN.ST', content: '3' },
    ]);
    expect(result.fatal).toBe(false);
    expect(result.tree.paths()).toEqual(['MAIN.ST', 'Main.st', 'main.st']);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_CASE_COLLISION, SdkDiagnosticCode.INPUT_CASE_COLLISION]);
    expect(result.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    expect(result.diagnostics[0].message).toContain('"Main.st"');
    expect(result.diagnostics[0].message).toContain('"main.st"');
  });

  it('is fatal with more than maxInputFiles files', () => {
    const result = load(
      [
        { path: 'a', content: '' },
        { path: 'b', content: '' },
        { path: 'c', content: '' },
      ],
      { limits: { maxInputFiles: 2 } },
    );
    expect(result.fatal).toBe(true);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_TOO_MANY_FILES]);
  });

  it('accepts exactly maxInputFiles files', () => {
    const result = load(
      [
        { path: 'a', content: '' },
        { path: 'b', content: '' },
      ],
      { limits: { maxInputFiles: 2 } },
    );
    expect(result.fatal).toBe(false);
    expect(result.tree.fileCount).toBe(2);
  });

  it('is fatal with more than maxInputBytes bytes', () => {
    const result = load(
      [
        { path: 'a', content: '12345' },
        { path: 'b', content: '678901' },
      ],
      { limits: { maxInputBytes: 10 } },
    );
    expect(result.fatal).toBe(true);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_TOO_LARGE]);
  });

  it('counts UTF-8 bytes, not characters, against maxInputBytes', () => {
    // 3 characters, 6 bytes.
    const result = load([{ path: 'a', content: '\u00e9\u00e9\u00e9' }], { limits: { maxInputBytes: 5 } });
    expect(result.fatal).toBe(true);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_TOO_LARGE]);
  });

  it('accepts exactly maxInputBytes bytes', () => {
    const result = load(
      [
        { path: 'a', content: '12345' },
        { path: 'b', content: '67890' },
      ],
      { limits: { maxInputBytes: 10 } },
    );
    expect(result.fatal).toBe(false);
    expect(result.tree.totalBytes).toBe(10);
  });

  it('accepts exactly both limits at once', () => {
    const result = load([{ path: 'a', content: 'x' }], { limits: { maxInputBytes: 1, maxInputFiles: 1 } });
    expect(result.fatal).toBe(false);
  });

  it('reports up to 20 bad paths individually', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ path: `../bad${i}`, content: '' }));
    const result = load(entries);
    expect(result.fatal).toBe(true);
    expect(result.diagnostics).toHaveLength(20);
    expect(result.diagnostics.every((d) => !d.message.startsWith('Stopped after'))).toBe(true);
  });

  it('stops after 20 bad paths with a summary diagnostic', () => {
    let consumed = 0;
    function* entries(): Generator<VirtualFileEntryInput> {
      for (let i = 0; i < 1000; i += 1) {
        consumed += 1;
        yield { path: `../bad${i}`, content: '' };
      }
    }
    const result = load(entries());
    expect(result.fatal).toBe(true);
    expect(result.diagnostics).toHaveLength(21);
    expect(result.diagnostics[20]).toMatchObject({
      code: SdkDiagnosticCode.INPUT_UNSAFE_PATH,
      severity: 'error',
      message: expect.stringMatching(/^Stopped after 20 path problems/),
    });
    // Loading stops early instead of walking the whole input.
    expect(consumed).toBe(21);
  });

  it('counts duplicates towards the 20-problem cap', () => {
    const entries = [{ path: 'a', content: '' }, ...Array.from({ length: 25 }, () => ({ path: 'a', content: '' }))];
    const result = load(entries);
    expect(result.diagnostics).toHaveLength(21);
    expect(codes(result).slice(0, 20).every((code) => code === SdkDiagnosticCode.INPUT_DUPLICATE_PATH)).toBe(true);
  });

  it('truncates very long untrusted paths in diagnostic messages', () => {
    const result = load([{ path: `${'x'.repeat(5000)}/..`, content: '' }]);
    expect(result.fatal).toBe(true);
    expect(result.diagnostics[0].message.length).toBeLessThanOrEqual(2001);
  });

  it('escapes control characters of rejected paths in messages', () => {
    const result = load([{ path: 'a\nb', content: '' }]);
    expect(result.diagnostics[0].message).toContain('"a\\nb"');
    expect(result.diagnostics[0].message).not.toContain('\n');
  });

  it('warns INPUT_EMPTY (not fatal) for empty input', () => {
    const result = load([]);
    expect(result.fatal).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: SdkDiagnosticCode.INPUT_EMPTY, severity: 'warning' }),
    ]);
    expect(result.tree.fileCount).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('throws RangeError for invalid limit %s', (value) => {
    expect(() => VirtualFileTree.fromEntries([], { limits: { maxInputFiles: value } })).toThrow(RangeError);
    expect(() => VirtualFileTree.fromEntries([], { limits: { maxInputBytes: value } })).toThrow(RangeError);
  });
});

describe('VirtualFileTree: container', () => {
  it('defaults to "directory"', () => {
    expect(load([{ path: 'a', content: '' }]).tree.container).toBe('directory');
  });

  it('records the given container', () => {
    expect(load([{ path: 'a', content: '' }], { container: 'zip' }).tree.container).toBe('zip');
  });

  it('records the container on a fatal (empty) tree too', () => {
    const result = load([{ path: '../a', content: '' }], { container: 'zip' });
    expect(result.tree.container).toBe('zip');
  });

  it('fromFile() builds a one-file tree with container "file"', () => {
    const result = VirtualFileTree.fromFile('main.st', 'PROGRAM');
    expectSchemaValid(result.diagnostics);
    expect(result.fatal).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.tree.container).toBe('file');
    expect(result.tree.paths()).toEqual(['main.st']);
    expect(text(result.tree.read('main.st'))).toBe('PROGRAM');
  });

  it('fromFile() rejects an unsafe name', () => {
    const result = VirtualFileTree.fromFile('../main.st', 'x');
    expectSchemaValid(result.diagnostics);
    expect(result.fatal).toBe(true);
    expect(result.tree.container).toBe('file');
  });

  it('fromFile() enforces limits', () => {
    const result = VirtualFileTree.fromFile('a', '12345', { limits: { maxInputBytes: 4 } });
    expect(result.fatal).toBe(true);
    expect(codes(result)).toEqual([SdkDiagnosticCode.INPUT_TOO_LARGE]);
  });

  it('empty() defaults to "directory" and accepts a container', () => {
    expect(VirtualFileTree.empty().container).toBe('directory');
    expect(VirtualFileTree.empty('zip').container).toBe('zip');
    expect(VirtualFileTree.empty().fileCount).toBe(0);
    expect(VirtualFileTree.empty().totalBytes).toBe(0);
  });
});

describe('VirtualFileTree.fingerprint()', () => {
  it('is a 64-char hex SHA-256', () => {
    expect(treeOf({ a: 'x' }).fingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of insertion order', () => {
    expect(treeOf({ a: '1', b: '2', 'c/d': '3' }).fingerprint()).toBe(
      treeOf({ 'c/d': '3', b: '2', a: '1' }).fingerprint(),
    );
  });

  it('is independent of the container and of how paths were spelled', () => {
    const a = load([{ path: './e\u0301', content: 'x' }], { container: 'zip' }).tree;
    const b = load([{ path: '\u00e9', content: 'x' }], { container: 'directory' }).tree;
    expect(a.fingerprint()).toBe(b.fingerprint());
  });

  it('changes when a single byte changes', () => {
    expect(treeOf({ a: new Uint8Array([1, 2, 3]) }).fingerprint()).not.toBe(
      treeOf({ a: new Uint8Array([1, 2, 4]) }).fingerprint(),
    );
  });

  it('changes when a path changes', () => {
    expect(treeOf({ a: 'x' }).fingerprint()).not.toBe(treeOf({ b: 'x' }).fingerprint());
  });

  it('changes when a file is added (even an empty one)', () => {
    expect(treeOf({ a: 'x' }).fingerprint()).not.toBe(treeOf({ a: 'x', b: '' }).fingerprint());
  });

  it('distinguishes path/content boundary shifts ({a:"bc"} vs {ab:"c"})', () => {
    expect(treeOf({ a: 'bc' }).fingerprint()).not.toBe(treeOf({ ab: 'c' }).fingerprint());
  });

  it('distinguishes file-boundary shifts ({a:"xy", b:""} vs {a:"x", b:"y"})', () => {
    expect(treeOf({ a: 'xy', b: '' }).fingerprint()).not.toBe(treeOf({ a: 'x', b: 'y' }).fingerprint());
  });

  it('distinguishes content that looks like a length prefix', () => {
    // Without the length field, "a\01\0" + "x" could be confused with other layouts.
    expect(treeOf({ a: '1\u0000x' }).fingerprint()).not.toBe(treeOf({ a: 'x' }).fingerprint());
  });

  it('of an empty tree is the SHA-256 of nothing', () => {
    expect(VirtualFileTree.empty().fingerprint()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('VirtualFileTree.withReadObserver()', () => {
  it('reports bytes handed out by read, head and readText', () => {
    const tree = treeOf({ 'a.st': 'hello', 'b.st': 'x' });
    const seen: Array<[string, number]> = [];
    const view = tree.withReadObserver((path, bytes) => seen.push([path, bytes]));
    view.read('a.st');
    view.head('a.st', 2);
    view.head('a.st', 100);
    view.readText('b.st');
    expect(seen).toEqual([
      ['a.st', 5],
      ['a.st', 2],
      ['a.st', 5],
      ['b.st', 1],
    ]);
  });

  it('does not report reads of missing paths', () => {
    const seen: string[] = [];
    const view = treeOf({ a: 'x' }).withReadObserver((path) => seen.push(path));
    view.read('missing');
    view.head('missing', 1);
    view.readText('missing');
    expect(seen).toEqual([]);
  });

  it('does not report size/has/paths/fingerprint (metadata is free)', () => {
    const seen: string[] = [];
    const view = treeOf({ a: 'x' }).withReadObserver((path) => seen.push(path));
    view.size('a');
    view.has('a');
    view.paths();
    view.fingerprint();
    expect(seen).toEqual([]);
  });

  it('shares data with the original tree', () => {
    const tree = treeOf({ 'b.st': 'B', 'a.st': 'A' });
    const view = tree.withReadObserver(() => {});
    expect(view.paths()).toEqual(tree.paths());
    expect(view.container).toBe(tree.container);
    expect(view.totalBytes).toBe(tree.totalBytes);
    expect(view.fingerprint()).toBe(tree.fingerprint());
    expect(text(view.read('a.st'))).toBe('A');
  });

  it('leaves the original tree unobserved', () => {
    const seen: string[] = [];
    const tree = treeOf({ a: 'x' });
    tree.withReadObserver((path) => seen.push(path));
    tree.read('a');
    expect(seen).toEqual([]);
  });

  it('reports entries() reads', () => {
    const seen: string[] = [];
    treeOf({ a: 'x', b: 'y' })
      .withReadObserver((path) => seen.push(path))
      .entries();
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('diagnostic schema conformance', () => {
  it('every diagnostic kind the tree emits validates against the diagnostics schema', () => {
    const all: ImporterDiagnostic[] = [
      ...load([{ path: '../x', content: '' }]).diagnostics,
      ...load([
        { path: 'a', content: '' },
        { path: 'a', content: '' },
      ]).diagnostics,
      ...load([
        { path: 'A', content: '' },
        { path: 'a', content: '' },
      ]).diagnostics,
      ...load(
        [
          { path: 'a', content: '' },
          { path: 'b', content: '' },
        ],
        { limits: { maxInputFiles: 1 } },
      ).diagnostics,
      ...load([{ path: 'a', content: 'xx' }], { limits: { maxInputBytes: 1 } }).diagnostics,
      ...load([]).diagnostics,
      ...load(Array.from({ length: 25 }, (_, i) => ({ path: `/abs${i}`, content: '' }))).diagnostics,
    ];
    expect(new Set(all.map((d) => d.code))).toEqual(
      new Set([
        SdkDiagnosticCode.INPUT_UNSAFE_PATH,
        SdkDiagnosticCode.INPUT_DUPLICATE_PATH,
        SdkDiagnosticCode.INPUT_CASE_COLLISION,
        SdkDiagnosticCode.INPUT_TOO_MANY_FILES,
        SdkDiagnosticCode.INPUT_TOO_LARGE,
        SdkDiagnosticCode.INPUT_EMPTY,
      ]),
    );
    expectSchemaValid(all);
  });
});
