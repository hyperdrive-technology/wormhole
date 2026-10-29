/**
 * `@wormhole/sdk/conformance`: a framework-agnostic conformance kit for importers.
 *
 * `runImporterConformance(importer, { fixtures })` runs every check in
 * {@link CONFORMANCE_CHECKS} and returns named results; it never throws. Use the vitest
 * helper in `@wormhole/sdk/conformance/vitest`, or assert on `report.ok` in any runner.
 */
import {
  checkRelativePath,
  type ImporterDiagnostic,
  type ImporterResultManifest,
} from '@wormhole/contract';

import { createImportContext } from '../context.js';
import { describeThrown } from '../diagnostics.js';
import { ImporterHost, type ImportRunOutcome } from '../host.js';
import type { DetectResult, ImportOptions, ImportResult, WormholeImporter } from '../importer.js';
import type { ImportLimits } from '../limits.js';
import { capabilityEntries, isSdkCompatible, validateImporterManifest } from '../manifest.js';
import { importResultShapeProblems } from '../result.js';
import { VirtualFileTree, type InputContainer } from '../tree.js';
import {
  capabilitiesDocumentProblems,
  diagnosticsReportProblems,
  resultManifestProblems,
} from '../validation.js';
import { WORMHOLE_SDK_API_VERSION } from '../version.js';
import { readZipTree } from '../zip.js';

export const CONFORMANCE_CHECKS = [
  'manifest-valid',
  'detect-deterministic',
  'detect-cheap',
  'outputs-schema-valid',
  'output-paths-safe',
  'archive-deterministic',
  'abort-honoured',
  'limits-honoured',
  'garbage-input-diagnosed',
] as const;

export type ConformanceCheckName = (typeof CONFORMANCE_CHECKS)[number];

export interface ConformanceCheckResult {
  name: ConformanceCheckName;
  status: 'pass' | 'fail' | 'skip';
  /** Why it failed or was skipped, one line per problem. Empty on a clean pass. */
  details: string[];
}

export interface ConformanceReport {
  importerId: string;
  /** True when no check failed. */
  ok: boolean;
  checks: ConformanceCheckResult[];
}

/** A known-good input the importer must import successfully. Self-authored, never customer files. */
export interface ConformanceFixture {
  name: string;
  /** Relative path → content (strings are UTF-8). */
  files: Readonly<Record<string, string | Uint8Array>>;
  /** Defaults to `file` for one-file fixtures, else `directory` (whichever the capability accepts). */
  container?: InputContainer;
  /** Defaults to what `detect()` answers, else the first capability. */
  capabilityId?: string;
  options?: ImportOptions;
}

export interface ConformanceOptions {
  fixtures: readonly ConformanceFixture[];
  /**
   * Most bytes `detect()` may read from a fixture whose largest file has been padded to
   * 2 MiB. Default 256 KiB: enough to sniff headers of many files, far less than a parse.
   */
  detectReadBudgetBytes?: number;
}

const DEFAULT_DETECT_READ_BUDGET = 256 * 1024;
const PADDED_FILE_BYTES = 2 * 1024 * 1024;

type CheckOutcome = Omit<ConformanceCheckResult, 'name'>;

const pass = (): CheckOutcome => ({ status: 'pass', details: [] });
const fromProblems = (problems: string[]): CheckOutcome =>
  problems.length === 0 ? pass() : { status: 'fail', details: problems };

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic PRNG (mulberry32) so "random" garbage is the same on every run. */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    bytes[index] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return bytes;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function summarizeDiagnostics(outcome: ImportRunOutcome): string {
  return outcome.diagnostics.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .slice(0, 5)
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join(' | ');
}

/**
 * `String()` that never throws: an object without `toString` (`Object.create(null)`) or with a
 * throwing one would otherwise crash the report itself.
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Capability ids as declared, read defensively. This runs before `manifest-valid`, on a
 * manifest nobody has checked yet, so any shape (non-array `capabilities`, `null` items, a
 * throwing getter) must give a list, never an exception: a malformed manifest has to end up
 * as a failing check in the report (wormhole#13).
 */
function declaredCapabilityIds(importer: WormholeImporter): string[] {
  try {
    const capabilities: unknown = importer?.manifest?.capabilities;
    if (!Array.isArray(capabilities)) return [];
    // Any non-null object, not just a plain record: class instances and objects from another
    // realm are valid capabilities to validateImporterManifest(), so their ids must be read too.
    return capabilities.map((capability: unknown) =>
      safeString(typeof capability === 'object' && capability !== null ? (capability as { id?: unknown }).id : undefined),
    );
  } catch {
    return [];
  }
}

/** The manifest id for the report header, or `(unknown)` when it cannot be read. */
function reportedImporterId(importer: WormholeImporter): string {
  try {
    const id: unknown = (importer as Partial<WormholeImporter> | undefined)?.manifest?.id;
    return id === undefined || id === null ? '(unknown)' : safeString(id);
  } catch {
    return '(unknown)';
  }
}

/** Captures everything the checks share: the importer, its fixtures, and helpers to run them. */
class ConformanceSubject {
  readonly importer: WormholeImporter;
  readonly fixtures: readonly ConformanceFixture[];
  readonly capabilityIds: string[];

  constructor(importer: WormholeImporter, fixtures: readonly ConformanceFixture[]) {
    this.importer = importer;
    this.fixtures = fixtures;
    this.capabilityIds = declaredCapabilityIds(importer);
  }

  capability(id: string) {
    return this.importer.manifest.capabilities.find((capability) => capability.id === id);
  }

  containerFor(fixture: ConformanceFixture, capabilityId: string): InputContainer {
    if (fixture.container) return fixture.container;
    const accepted = this.capability(capabilityId)?.inputs.containers ?? ['directory'];
    const fileCount = Object.keys(fixture.files).length;
    if (fileCount === 1 && accepted.includes('file')) return 'file';
    if (accepted.includes('directory')) return 'directory';
    return accepted[0] ?? 'directory';
  }

  /** Builds the fixture's tree; `reversed` inserts files in reverse order (must not matter). */
  tree(
    fixture: ConformanceFixture,
    container: InputContainer,
    reversed = false,
    files: Readonly<Record<string, string | Uint8Array>> = fixture.files,
  ): VirtualFileTree {
    const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
    if (reversed) entries.reverse();
    const loaded = VirtualFileTree.fromEntries(entries, { container });
    if (loaded.fatal) {
      throw new Error(
        `fixture ${fixture.name} is not a valid input tree: ${loaded.diagnostics.map((d) => d.message).join('; ')}`,
      );
    }
    return loaded.tree;
  }

  detect(tree: VirtualFileTree): DetectResult | null {
    return this.importer.detect({ files: tree });
  }

  capabilityFor(fixture: ConformanceFixture): string {
    if (fixture.capabilityId) return fixture.capabilityId;
    const firstId = this.capabilityIds[0] ?? '';
    try {
      const detected = this.detect(this.tree(fixture, this.containerFor(fixture, firstId)));
      if (detected && this.capabilityIds.includes(detected.capabilityId)) return detected.capabilityId;
    } catch {
      // detect problems are reported by the detect checks
    }
    return firstId;
  }

  host(clock?: () => number): ImporterHost {
    const host = new ImporterHost(clock ? { clock } : {});
    host.register(this.importer);
    return host;
  }

  async run(
    fixture: ConformanceFixture,
    extra: {
      reversed?: boolean;
      signal?: AbortSignal;
      limits?: Partial<ImportLimits>;
      clock?: () => number;
      files?: Readonly<Record<string, string | Uint8Array>>;
      host?: ImporterHost;
    } = {},
  ): Promise<ImportRunOutcome> {
    const capabilityId = this.capabilityFor(fixture);
    const host = extra.host ?? this.host(extra.clock);
    return host.run({
      capabilityId,
      input: this.tree(fixture, this.containerFor(fixture, capabilityId), extra.reversed, extra.files),
      ...(fixture.options ? { options: fixture.options } : {}),
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(extra.limits ? { limits: extra.limits } : {}),
    });
  }

  /** Calls `import()` directly (no host), the way the garbage and abort checks need to. */
  async importDirect(
    tree: VirtualFileTree,
    capabilityId: string,
    options: ImportOptions = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const handle = createImportContext(signal ? { signal } : {});
    try {
      return await this.importer.import(
        Object.freeze({ files: tree, capabilityId, options: Object.freeze({ ...options }) }),
        handle.context,
      );
    } finally {
      handle.dispose();
    }
  }
}

function requireFixtures(subject: ConformanceSubject): CheckOutcome | undefined {
  return subject.fixtures.length === 0
    ? { status: 'fail', details: ['no fixtures given; conformance needs at least one known-good input'] }
    : undefined;
}

// ---------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------

async function checkManifestValid(subject: ConformanceSubject): Promise<CheckOutcome> {
  const validation = validateImporterManifest(subject.importer?.manifest);
  if (!validation.ok) return fromProblems(validation.problems);
  const manifest = validation.manifest;
  const problems: string[] = [];
  if (!isSdkCompatible(manifest)) {
    problems.push(`sdk range ${manifest.sdk} does not include this SDK's API version ${WORMHOLE_SDK_API_VERSION}`);
  }
  problems.push(
    ...capabilitiesDocumentProblems({
      schemaVersion: 'hyperdrive.importer-capabilities.v1',
      importers: capabilityEntries(manifest),
    }).map((problem) => `capabilities mapping ${problem}`),
  );
  try {
    subject.host();
  } catch (error) {
    problems.push(`ImporterHost.register failed: ${describeThrown(error)}`);
  }
  for (const fixture of subject.fixtures) {
    if (fixture.capabilityId && !subject.capabilityIds.includes(fixture.capabilityId)) {
      problems.push(`fixture ${fixture.name} names unknown capability ${fixture.capabilityId}`);
    }
  }
  return fromProblems(problems);
}

function detectResultProblems(subject: ConformanceSubject, where: string, result: unknown): string[] {
  if (result === null) return [];
  if (result === undefined || typeof result !== 'object') return [`${where}: detect() must return an object or null`];
  const { capabilityId, confidence, reason } = result as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof capabilityId !== 'string' || !subject.capabilityIds.includes(capabilityId)) {
    problems.push(`${where}: capabilityId ${JSON.stringify(capabilityId)} is not declared in the manifest`);
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    problems.push(`${where}: confidence ${String(confidence)} is not within 0..1`);
  }
  if (typeof reason !== 'string' || reason.length === 0) problems.push(`${where}: reason must be a non-empty string`);
  return problems;
}

async function checkDetectDeterministic(subject: ConformanceSubject): Promise<CheckOutcome> {
  const problems: string[] = [];
  for (const fixture of subject.fixtures) {
    const where = `fixture ${fixture.name}`;
    const capabilityId = fixture.capabilityId ?? subject.capabilityIds[0] ?? '';
    const container = subject.containerFor(fixture, capabilityId);
    const answers = [
      subject.detect(subject.tree(fixture, container)),
      subject.detect(subject.tree(fixture, container)),
      subject.detect(subject.tree(fixture, container, true)),
    ];
    const serialized = answers.map((answer) => JSON.stringify(answer));
    if (new Set(serialized).size !== 1) {
      problems.push(`${where}: detect() answered differently for the same input: ${serialized.join(' vs ')}`);
    }
    const first = answers[0];
    if (first === null || first === undefined) {
      problems.push(`${where}: detect() did not recognise a known-good fixture`);
      continue;
    }
    problems.push(...detectResultProblems(subject, where, first));
    if (fixture.capabilityId && first.capabilityId !== fixture.capabilityId) {
      problems.push(`${where}: detect() chose ${first.capabilityId}, expected ${fixture.capabilityId}`);
    }
  }
  try {
    problems.push(...detectResultProblems(subject, 'empty input', subject.detect(VirtualFileTree.empty())));
  } catch (error) {
    problems.push(`empty input: detect() threw: ${describeThrown(error)}`);
  }
  return fromProblems(problems);
}

async function checkDetectCheap(subject: ConformanceSubject, budget: number): Promise<CheckOutcome> {
  const problems: string[] = [];
  for (const fixture of subject.fixtures) {
    // Pad the largest file to 2 MiB with trailing spaces: a header sniff reads the same few
    // bytes as before, a full parse reads everything.
    const [largestPath] = Object.entries(fixture.files)
      .map(([path, content]) => [path, toBytes(content).byteLength] as const)
      .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))[0] ?? [];
    if (largestPath === undefined) continue;
    const original = toBytes(fixture.files[largestPath] as string | Uint8Array);
    const padded = new Uint8Array(Math.max(PADDED_FILE_BYTES, original.byteLength)).fill(0x20);
    padded.set(original);
    const files = { ...fixture.files, [largestPath]: padded };
    const capabilityId = fixture.capabilityId ?? subject.capabilityIds[0] ?? '';
    let bytesRead = 0;
    const tree = subject
      .tree(fixture, subject.containerFor(fixture, capabilityId), false, files)
      .withReadObserver((_, bytes) => {
        bytesRead += bytes;
      });
    subject.detect(tree);
    if (bytesRead > budget) {
      problems.push(
        `fixture ${fixture.name}: detect() read ${bytesRead} bytes of a ${padded.byteLength}-byte input; the budget is ${budget}. Sniff headers with files.head() instead of reading whole files.`,
      );
    }
  }
  return fromProblems(problems);
}

async function checkOutputsSchemaValid(subject: ConformanceSubject): Promise<CheckOutcome> {
  const problems: string[] = [];
  for (const fixture of subject.fixtures) {
    const where = `fixture ${fixture.name}`;
    const outcome = await subject.run(fixture);
    if (outcome.status !== 'succeeded' || !outcome.archive) {
      problems.push(`${where}: import failed (${outcome.failure?.code}): ${summarizeDiagnostics(outcome)}`);
      continue;
    }
    problems.push(...resultManifestProblems(outcome.archive.manifest).map((p) => `${where}: result manifest ${p}`));
    problems.push(...diagnosticsReportProblems(outcome.diagnostics).map((p) => `${where}: diagnostics ${p}`));
    if (!outcome.summary?.message) problems.push(`${where}: no summary`);

    // Read the zip back and compare it with what the manifest declares.
    const reread = await readZipTree(outcome.archive.zipBytes);
    if (reread.fatal) {
      problems.push(`${where}: result archive is unreadable: ${reread.diagnostics.map((d) => d.message).join('; ')}`);
      continue;
    }
    const manifest = outcome.archive.manifest;
    const declared = [
      'manifest.json',
      manifest.diagnostics,
      ...manifest.canonicalSources,
      ...(manifest.preservation ?? []),
      ...(manifest.assets ?? []),
    ].sort(compareCodeUnits);
    const actual = [...reread.tree.paths()];
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      problems.push(`${where}: archive entries ${JSON.stringify(actual)} differ from the manifest's ${JSON.stringify(declared)}`);
    }
    const manifestText = reread.tree.readText('manifest.json')?.text ?? '';
    const diagnosticsText = reread.tree.readText(manifest.diagnostics)?.text ?? '';
    try {
      const parsedManifest = JSON.parse(manifestText) as ImporterResultManifest;
      problems.push(...resultManifestProblems(parsedManifest).map((p) => `${where}: manifest.json ${p}`));
      problems.push(...diagnosticsReportProblems(JSON.parse(diagnosticsText)).map((p) => `${where}: diagnostics.json ${p}`));
    } catch (error) {
      problems.push(`${where}: archive JSON does not parse: ${describeThrown(error)}`);
    }
  }
  return fromProblems(problems);
}

function pathProblems(where: string, result: ImportResult): string[] {
  const problems: string[] = [];
  const sections: Array<[string, Record<string, unknown> | undefined, RegExp]> = [
    ['sources', result.sources, /^sources\/.+\.plc$/],
    ['preservation', result.preservation, /^preservation\/.+/],
    ['assets', result.assets, /^assets\/.+/],
  ];
  const seen = new Map<string, string>();
  for (const [section, record, pattern] of sections) {
    for (const path of Object.keys(record ?? {})) {
      const checked = checkRelativePath(path, { portable: true });
      if (!checked.ok) problems.push(`${where}: ${section} path ${JSON.stringify(path)}: ${checked.reason}`);
      else if (checked.path !== path) problems.push(`${where}: ${section} path ${JSON.stringify(path)} is not in normal form`);
      else if (!pattern.test(path)) problems.push(`${where}: ${section} path ${JSON.stringify(path)} must match ${pattern.source}`);
      const twin = seen.get(path.toLowerCase());
      if (twin !== undefined) problems.push(`${where}: ${JSON.stringify(path)} collides with ${JSON.stringify(twin)} on case-insensitive filesystems`);
      seen.set(path.toLowerCase(), path);
    }
  }
  result.diagnostics.forEach((diagnostic: ImporterDiagnostic, index) => {
    const path = diagnostic?.source?.path;
    if (path !== undefined && !checkRelativePath(path).ok) {
      problems.push(`${where}: diagnostics[${index}].source.path ${JSON.stringify(path)} is not a safe relative path`);
    }
  });
  return problems;
}

async function checkOutputPathsSafe(subject: ConformanceSubject): Promise<CheckOutcome> {
  const problems: string[] = [];
  for (const fixture of subject.fixtures) {
    const where = `fixture ${fixture.name}`;
    const capabilityId = subject.capabilityFor(fixture);
    const tree = subject.tree(fixture, subject.containerFor(fixture, capabilityId));
    const result = await subject.importDirect(tree, capabilityId, fixture.options);
    const shape = importResultShapeProblems(result);
    if (shape.length > 0) {
      problems.push(...shape.map((problem) => `${where}: ${problem}`));
      continue;
    }
    problems.push(...pathProblems(where, result as ImportResult));
    const outcome = await subject.run(fixture);
    if (outcome.archive) {
      for (const entry of outcome.archive.entries) {
        const checked = checkRelativePath(entry.path, { portable: true });
        if (!checked.ok) problems.push(`${where}: archive entry ${JSON.stringify(entry.path)}: ${checked.reason}`);
      }
    }
  }
  return fromProblems(problems);
}

async function checkArchiveDeterministic(subject: ConformanceSubject): Promise<CheckOutcome> {
  const problems: string[] = [];
  for (const fixture of subject.fixtures) {
    const where = `fixture ${fixture.name}`;
    const first = await subject.run(fixture);
    const second = await subject.run(fixture, { reversed: true });
    if (!first.archive || !second.archive) {
      problems.push(`${where}: import failed (${first.failure?.code ?? second.failure?.code}), nothing to compare`);
      continue;
    }
    if (!bytesEqual(first.archive.zipBytes, second.archive.zipBytes)) {
      const differing = first.archive.entries
        .filter((entry, index) => {
          const other = second.archive?.entries[index];
          return !other || other.path !== entry.path || !bytesEqual(other.bytes, entry.bytes);
        })
        .map((entry) => entry.path);
      problems.push(`${where}: two runs on the same input gave different archives (differing entries: ${differing.join(', ') || 'zip framing'})`);
    }
  }
  return fromProblems(problems);
}

function isAbortLike(error: unknown, reason: unknown): boolean {
  return error === reason || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

async function checkAbortHonoured(subject: ConformanceSubject): Promise<CheckOutcome> {
  const problems: string[] = [];
  const fixture = subject.fixtures[0] as ConformanceFixture;
  const capabilityId = subject.capabilityFor(fixture);

  // 1. The importer itself: with an already-aborted signal it must stop by throwing the
  //    abort reason (ctx.throwIfAborted() does exactly that), not import anyway.
  const controller = new AbortController();
  const reason = new DOMException('conformance: cancelled before start', 'AbortError');
  controller.abort(reason);
  try {
    await subject.importDirect(subject.tree(fixture, subject.containerFor(fixture, capabilityId)), capabilityId, fixture.options, controller.signal);
    problems.push('import() ran to completion with an already-aborted signal; call ctx.throwIfAborted() before and during work');
  } catch (error) {
    if (!isAbortLike(error, reason)) {
      problems.push(`import() with an aborted signal threw something other than the abort reason: ${describeThrown(error)}`);
    }
  }

  // 2. Through the host, aborted before the run starts.
  const preAborted = await subject.run(fixture, { signal: controller.signal });
  if (preAborted.failure?.code !== 'ABORTED') {
    problems.push(`host run with an aborted signal ended as ${preAborted.status}/${preAborted.failure?.code ?? '-'} instead of ABORTED`);
  }

  // 3. Through the host, aborted while the run is in flight.
  const late = new AbortController();
  const pending = subject.run(fixture, { signal: late.signal });
  late.abort(new DOMException('conformance: cancelled mid-run', 'AbortError'));
  const midRun = await pending;
  if (midRun.failure?.code !== 'ABORTED') {
    problems.push(`host run aborted mid-flight ended as ${midRun.status}/${midRun.failure?.code ?? '-'} instead of ABORTED`);
  }
  return fromProblems(problems);
}

async function checkLimitsHonoured(subject: ConformanceSubject): Promise<CheckOutcome> {
  const problems: string[] = [];
  const fixture = subject.fixtures[0] as ConformanceFixture;
  const files = Object.values(fixture.files).map(toBytes);
  const totalBytes = files.reduce((sum, bytes) => sum + bytes.byteLength, 0);

  const expectLimit = async (
    label: string,
    run: Promise<ImportRunOutcome>,
    alsoAccepted: ReadonlyArray<string> = [],
  ): Promise<void> => {
    const outcome = await run;
    const code = outcome.failure?.code;
    if (code !== 'LIMIT_EXCEEDED' && !(code !== undefined && alsoAccepted.includes(code))) {
      problems.push(`${label}: run ended as ${outcome.status}/${outcome.failure?.code ?? '-'} instead of LIMIT_EXCEEDED`);
    }
    problems.push(...diagnosticsReportProblems(outcome.diagnostics).map((p) => `${label}: diagnostics ${p}`));
  };

  if (files.length >= 2) {
    await expectLimit('maxInputFiles', subject.run(fixture, { limits: { maxInputFiles: files.length - 1 } }));
  }
  if (totalBytes >= 2) {
    await expectLimit('maxInputBytes', subject.run(fixture, { limits: { maxInputBytes: totalBytes - 1 } }));
  }
  // The host measures output on the serialised archive, so a result that cannot become an
  // archive (unsafe paths, schema errors) fails as INVALID_RESULT before the size check.
  // outputs-schema-valid already reports that; don't report it twice here.
  await expectLimit('maxOutputBytes', subject.run(fixture, { limits: { maxOutputBytes: 1 } }), ['INVALID_RESULT']);

  // A fake clock that jumps a minute per reading: the deadline has always passed by the
  // time the importer returns (or calls ctx.throwIfAborted()), with no real waiting.
  let now = 0;
  await expectLimit(
    'maxWallTimeMs',
    subject.run(fixture, { limits: { maxWallTimeMs: 1000 }, clock: () => (now += 60_000) }),
  );
  return fromProblems(problems);
}

async function checkGarbageInputDiagnosed(subject: ConformanceSubject): Promise<CheckOutcome> {
  const problems: string[] = [];
  for (const fixture of subject.fixtures) {
    const capabilityId = subject.capabilityFor(fixture);
    const container = subject.containerFor(fixture, capabilityId);
    const [firstPath, firstContent] = Object.entries(fixture.files).sort((a, b) => compareCodeUnits(a[0], b[0]))[0] ?? [];
    if (firstPath === undefined || firstContent === undefined) continue;
    const original = toBytes(firstContent);
    const invalidUtf8 = new Uint8Array([0xc3, 0x28, 0xa0, 0xa1, 0xff, 0xfe, 0xfd, 0x0a, 0x80, 0x81]);
    const crlf = Object.fromEntries(
      Object.entries(fixture.files).map(([path, content]) => [
        path,
        typeof content === 'string' ? content.replace(/\r?\n/g, '\r\n') : content,
      ]),
    );
    const cases: Array<{ name: string; files: Record<string, string | Uint8Array>; garbage: boolean }> = [
      { name: 'empty input', files: {}, garbage: true },
      { name: 'empty file', files: { [firstPath]: new Uint8Array(0) }, garbage: true },
      { name: 'random bytes', files: { [firstPath]: pseudoRandomBytes(4096, 0x5eed) }, garbage: true },
      { name: 'NUL bytes', files: { [firstPath]: new Uint8Array(1024) }, garbage: true },
      { name: 'invalid UTF-8', files: { [firstPath]: invalidUtf8 }, garbage: true },
      { name: 'truncated', files: { ...fixture.files, [firstPath]: original.slice(0, Math.floor(original.byteLength / 2)) }, garbage: false },
      { name: 'CRLF line endings', files: crlf, garbage: false },
    ];

    for (const garbageCase of cases) {
      const where = `fixture ${fixture.name}, ${garbageCase.name}`;
      const tree = subject.tree(fixture, container, false, garbageCase.files);
      try {
        problems.push(...detectResultProblems(subject, where, subject.detect(tree)));
      } catch (error) {
        problems.push(`${where}: detect() threw: ${describeThrown(error)}`);
      }
      let result: unknown;
      try {
        result = await subject.importDirect(tree, capabilityId, fixture.options);
      } catch (error) {
        problems.push(`${where}: import() threw instead of returning diagnostics: ${describeThrown(error)}`);
        continue;
      }
      const shape = importResultShapeProblems(result);
      if (shape.length > 0) {
        problems.push(...shape.map((problem) => `${where}: ${problem}`));
        continue;
      }
      const typed = result as ImportResult;
      problems.push(
        ...diagnosticsReportProblems({ schemaVersion: 'hyperdrive.importer-diagnostics.v1', diagnostics: typed.diagnostics }).map(
          (problem) => `${where}: diagnostics ${problem}`,
        ),
      );
      if (garbageCase.garbage && !typed.diagnostics.some((d) => d.severity === 'warning' || d.severity === 'error')) {
        problems.push(`${where}: import() reported no warning or error for unusable input`);
      }
      try {
        const outcome = await subject.run(fixture, { files: garbageCase.files });
        problems.push(...diagnosticsReportProblems(outcome.diagnostics).map((p) => `${where}: host diagnostics ${p}`));
        if (outcome.failure?.code === 'IMPORTER_THREW') {
          problems.push(`${where}: host reported IMPORTER_THREW: ${summarizeDiagnostics(outcome)}`);
        }
      } catch (error) {
        problems.push(`${where}: ImporterHost.run threw: ${describeThrown(error)}`);
      }
    }
  }

  // A corrupt zip never reaches the importer, but the run must still end in diagnostics.
  const fixture = subject.fixtures[0] as ConformanceFixture;
  const capabilityId = subject.capabilityFor(fixture);
  const corruptZip = await readZipTree(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]));
  try {
    const outcome = await subject.host().run({ capabilityId, input: corruptZip });
    if (outcome.failure?.code !== 'INPUT_REJECTED') {
      problems.push(`truncated zip: run ended as ${outcome.status}/${outcome.failure?.code ?? '-'} instead of INPUT_REJECTED`);
    }
  } catch (error) {
    problems.push(`truncated zip: ImporterHost.run threw: ${describeThrown(error)}`);
  }
  return fromProblems(problems);
}

/**
 * Runs every conformance check. Never throws: a check that crashes is reported as failed
 * with the error message.
 */
export async function runImporterConformance(
  importer: WormholeImporter,
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const subject = new ConformanceSubject(importer, options.fixtures ?? []);
  const budget = options.detectReadBudgetBytes ?? DEFAULT_DETECT_READ_BUDGET;
  const manifestCheck = await guard(() => checkManifestValid(subject));
  const registrable = manifestCheck.status === 'pass';

  const runners: Record<Exclude<ConformanceCheckName, 'manifest-valid'>, () => Promise<CheckOutcome>> = {
    'detect-deterministic': () => checkDetectDeterministic(subject),
    'detect-cheap': () => checkDetectCheap(subject, budget),
    'outputs-schema-valid': () => checkOutputsSchemaValid(subject),
    'output-paths-safe': () => checkOutputPathsSafe(subject),
    'archive-deterministic': () => checkArchiveDeterministic(subject),
    'abort-honoured': () => checkAbortHonoured(subject),
    'limits-honoured': () => checkLimitsHonoured(subject),
    'garbage-input-diagnosed': () => checkGarbageInputDiagnosed(subject),
  };

  const checks: ConformanceCheckResult[] = [{ name: 'manifest-valid', ...manifestCheck }];
  for (const name of CONFORMANCE_CHECKS) {
    if (name === 'manifest-valid') continue;
    if (!registrable) {
      checks.push({ name, status: 'fail', details: ['skipped because manifest-valid failed; the importer cannot be registered'] });
      continue;
    }
    const missing = requireFixtures(subject);
    checks.push({ name, ...(missing ?? (await guard(runners[name]))) });
  }
  return { importerId: reportedImporterId(importer), ok: checks.every((check) => check.status !== 'fail'), checks };
}

async function guard(run: () => Promise<CheckOutcome>): Promise<CheckOutcome> {
  try {
    return await run();
  } catch (error) {
    return { status: 'fail', details: [`check crashed: ${describeThrown(error)}`] };
  }
}

/** Multi-line, human-readable report (for CLIs and assertion messages). */
export function formatConformanceReport(report: ConformanceReport): string {
  const lines = [`Importer ${report.importerId}: ${report.ok ? 'conformant' : 'NOT conformant'}`];
  for (const check of report.checks) {
    lines.push(`  ${check.status.toUpperCase().padEnd(4)} ${check.name}`);
    for (const detail of check.details) lines.push(`         ${detail}`);
  }
  return lines.join('\n');
}
