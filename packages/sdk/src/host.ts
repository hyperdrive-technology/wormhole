import {
  buildImporterArchive,
  ImporterArchiveError,
  type BuiltImporterArchive,
  type ImporterCapabilitiesDocument,
  type ImporterDiagnostic,
  type ImporterDiagnosticsReport,
} from '@wormhole/contract';

import { createImportContext } from './context.js';
import { describeThrown, SdkDiagnosticCode, sdkDiagnostic } from './diagnostics.js';
import { ImporterHostError } from './errors.js';
import type {
  ImportOptions,
  ImportResult,
  ImportSummary,
  LogEntry,
  ReservedNarrativeInput,
  WormholeImporter,
} from './importer.js';
import { resolveImportLimits, type ImportLimits } from './limits.js';
import {
  isSdkCompatible,
  toCapabilitiesDocument,
  validateImporterManifest,
  type ImporterCapability,
  type ImporterManifest,
} from './manifest.js';
import type { TreeLoadResult, VirtualFileTree } from './tree.js';
import { importResultShapeProblems, isPlainRecord } from './result.js';
import { diagnosticsReportProblems, resultManifestProblems } from './validation.js';
import { WORMHOLE_SDK_API_VERSION } from './version.js';

export interface ImporterHostOptions {
  /** API version to check `sdk` ranges against. Only override in tests. */
  apiVersion?: string;
  /** Defaults for every run; each `run()` may override them. */
  defaultLimits?: Partial<ImportLimits>;
  /** Receives every importer log entry, tagged with the importer and capability. */
  onLog?: (entry: HostLogEntry) => void;
  /** Millisecond clock; inject a fake one in tests. Defaults to `performance.now()`. */
  clock?: () => number;
}

export interface HostLogEntry extends LogEntry {
  importerId: string;
  capabilityId?: string;
}

export interface DetectCandidate {
  importerId: string;
  capabilityId: string;
  confidence: number;
  reason: string;
}

export interface RunRequest {
  capabilityId: string;
  /** A tree, or the result of loading one (its diagnostics are carried into the result). */
  input: VirtualFileTree | TreeLoadResult;
  options?: ImportOptions;
  signal?: AbortSignal;
  limits?: Partial<ImportLimits>;
  /** @reserved Lane F3. Must be absent in API 1.0. */
  narratives?: ReservedNarrativeInput;
}

export type RunFailureCode =
  /** Input was fatal to load, or its container kind is not accepted. */
  | 'INPUT_REJECTED'
  /** Input, output or wall-time limit exceeded. */
  | 'LIMIT_EXCEEDED'
  | 'ABORTED'
  | 'IMPORTER_THREW'
  /** The importer returned something that breaks the contract (shape, schema, paths). */
  | 'INVALID_RESULT'
  /** The importer produced no canonical source, usually because the input was unusable. */
  | 'NO_SOURCES';

export interface ImportRunOutcome {
  status: 'succeeded' | 'failed';
  failure?: { code: RunFailureCode; message: string };
  importerId: string;
  importerVersion: string;
  capabilityId: string;
  /** Always schema-valid: input diagnostics, then the importer's, then the host's. */
  diagnostics: ImporterDiagnosticsReport;
  summary?: ImportSummary;
  /** Present only when `status` is `succeeded`. Byte-identical for identical input. */
  archive?: BuiltImporterArchive;
  /** Importer log entries (at most {@link MAX_RUN_LOG_ENTRIES}). Not part of the archive. */
  logs: readonly LogEntry[];
  stats: { inputFiles: number; inputBytes: number; outputBytes: number; elapsedMs: number };
}

export const MAX_RUN_LOG_ENTRIES = 1000;

interface Registration {
  manifest: Readonly<ImporterManifest>;
  importer: WormholeImporter;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isTreeLoadResult(input: VirtualFileTree | TreeLoadResult): input is TreeLoadResult {
  return typeof input === 'object' && input !== null && 'tree' in input && 'fatal' in input;
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
}

/**
 * Bytes the run produces, before compression: every output file, the diagnostics report,
 * `unsupportedSemantics` (serialised into `manifest.json`) and the `summary` returned on the
 * outcome. All are importer-supplied and so just as unbounded as file content.
 */
function outputBytes(result: ImportResult, diagnostics: ImporterDiagnosticsReport, summary: ImportSummary): number {
  let total = Buffer.byteLength(JSON.stringify(diagnostics), 'utf8');
  total += Buffer.byteLength(JSON.stringify(summary), 'utf8');
  if (result.unsupportedSemantics !== undefined) {
    total += Buffer.byteLength(JSON.stringify(result.unsupportedSemantics), 'utf8');
  }
  for (const record of [result.sources, result.preservation ?? {}, result.assets ?? {}]) {
    for (const [path, content] of Object.entries(record)) {
      total += Buffer.byteLength(path, 'utf8') + byteLength(content);
    }
  }
  return total;
}

function validateOptions(options: unknown): string[] {
  if (options === undefined) return [];
  if (!isPlainRecord(options)) return ['options must be a plain object'];
  return Object.entries(options)
    .filter(([, value]) => !['string', 'number', 'boolean'].includes(typeof value))
    .map(([key]) => `options.${key} must be a string, number or boolean`);
}

/**
 * Loads importers and runs them safely.
 *
 * - `register` validates the manifest, checks the `sdk` range against this SDK's API
 *   version, and refuses duplicate importer or capability ids.
 * - `detectAll` asks every importer about an input and ranks the answers.
 * - `run` enforces limits and cancellation, validates what the importer returns, and
 *   builds the deterministic `hyperdrive.importer-result.v1` archive.
 *
 * Trust model: importers run in-process, like any npm dependency. The host protects
 * against *buggy* importers and hostile *input*, not against hostile importer code; run
 * untrusted importers in a worker or separate process.
 */
export class ImporterHost {
  readonly apiVersion: string;
  readonly #registrations = new Map<string, Registration>();
  readonly #capabilityOwners = new Map<string, string>();
  readonly #defaultLimits: Readonly<ImportLimits>;
  readonly #onLog: ((entry: HostLogEntry) => void) | undefined;
  readonly #clock: () => number;

  constructor(options: ImporterHostOptions = {}) {
    this.apiVersion = options.apiVersion ?? WORMHOLE_SDK_API_VERSION;
    try {
      this.#defaultLimits = resolveImportLimits(options.defaultLimits);
    } catch (error) {
      throw new ImporterHostError('INVALID_REQUEST', 'Invalid default limits', [describeThrown(error)]);
    }
    this.#onLog = options.onLog;
    this.#clock = options.clock ?? (() => performance.now());
  }

  register(importer: WormholeImporter): void {
    const shape = importer as Partial<Record<keyof WormholeImporter, unknown>> | null | undefined;
    if (
      shape === null ||
      typeof shape !== 'object' ||
      typeof shape.detect !== 'function' ||
      typeof shape.import !== 'function'
    ) {
      throw new ImporterHostError('INVALID_IMPORTER', 'An importer must be an object with manifest, detect() and import()');
    }
    const validation = validateImporterManifest(shape.manifest);
    if (!validation.ok) {
      throw new ImporterHostError('INVALID_MANIFEST', 'Importer manifest is invalid', validation.problems);
    }
    const manifest = validation.manifest;
    if (!isSdkCompatible(manifest, this.apiVersion)) {
      throw new ImporterHostError(
        'SDK_INCOMPATIBLE',
        `Importer ${manifest.id} requires SDK API ${manifest.sdk}, but this host provides ${this.apiVersion}`,
      );
    }
    if (this.#registrations.has(manifest.id)) {
      throw new ImporterHostError('DUPLICATE_IMPORTER', `Importer ${manifest.id} is already registered`);
    }
    const clashes = manifest.capabilities
      .filter((capability) => this.#capabilityOwners.has(capability.id))
      .map((capability) => `${capability.id} (registered by ${this.#capabilityOwners.get(capability.id)})`);
    if (clashes.length > 0) {
      throw new ImporterHostError('DUPLICATE_CAPABILITY', `Importer ${manifest.id} declares capability ids already in use`, clashes);
    }
    this.#registrations.set(manifest.id, { manifest, importer });
    for (const capability of manifest.capabilities) {
      this.#capabilityOwners.set(capability.id, manifest.id);
    }
  }

  unregister(importerId: string): void {
    const registration = this.#registrations.get(importerId);
    if (!registration) {
      throw new ImporterHostError('UNKNOWN_IMPORTER', `Importer ${importerId} is not registered`);
    }
    this.#registrations.delete(importerId);
    for (const capability of registration.manifest.capabilities) {
      this.#capabilityOwners.delete(capability.id);
    }
  }

  /** Registered manifests, sorted by id. */
  importers(): Readonly<ImporterManifest>[] {
    return [...this.#registrations.values()]
      .map((registration) => registration.manifest)
      .sort((a, b) => compareCodeUnits(a.id, b.id));
  }

  /** The `hyperdrive.importer-capabilities.v1` document for every registered capability. */
  capabilities(): ImporterCapabilitiesDocument {
    return toCapabilitiesDocument(this.importers());
  }

  /**
   * Asks every importer whether it recognises the input. Returns candidates with
   * confidence > 0, best first (ties broken by importer id, then capability id, so the
   * order is deterministic). An importer whose `detect` throws or returns something
   * malformed is skipped and logged; it never breaks detection for the others.
   */
  detectAll(files: VirtualFileTree): DetectCandidate[] {
    const candidates: DetectCandidate[] = [];
    for (const { manifest, importer } of this.#sortedRegistrations()) {
      let result: unknown;
      try {
        result = importer.detect({ files });
      } catch (error) {
        this.#hostLog(manifest.id, 'warn', `detect() threw: ${describeThrown(error)}`);
        continue;
      }
      if (result === null || result === undefined) continue;
      const problem = this.#detectResultProblem(manifest, result);
      if (problem) {
        this.#hostLog(manifest.id, 'warn', `detect() returned an invalid result: ${problem}`);
        continue;
      }
      const detected = result as DetectCandidate;
      if (detected.confidence === 0) continue;
      candidates.push({
        importerId: manifest.id,
        capabilityId: detected.capabilityId,
        confidence: detected.confidence,
        reason: detected.reason,
      });
    }
    return candidates.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        compareCodeUnits(a.importerId, b.importerId) ||
        compareCodeUnits(a.capabilityId, b.capabilityId),
    );
  }

  /**
   * Runs one capability on an input. Throws {@link ImporterHostError} only for misuse
   * (unknown capability, bad limits/options, the reserved `narratives` field). Everything
   * else, including garbage input and misbehaving importers, gives a failed outcome with
   * diagnostics.
   */
  async run(request: RunRequest): Promise<ImportRunOutcome> {
    const ownerId = this.#capabilityOwners.get(request.capabilityId);
    const registration = ownerId === undefined ? undefined : this.#registrations.get(ownerId);
    if (!registration) {
      throw new ImporterHostError('UNKNOWN_CAPABILITY', `No registered importer provides capability ${request.capabilityId}`);
    }
    if ((request as { narratives?: unknown }).narratives !== undefined) {
      throw new ImporterHostError('INVALID_REQUEST', 'narratives is reserved for a future SDK API version (lane F3) and must be absent');
    }
    const optionProblems = validateOptions(request.options);
    if (optionProblems.length > 0) {
      throw new ImporterHostError('INVALID_REQUEST', 'Invalid import options', optionProblems);
    }
    let limits: Readonly<ImportLimits>;
    try {
      limits = resolveImportLimits(request.limits, this.#defaultLimits);
    } catch (error) {
      throw new ImporterHostError('INVALID_REQUEST', 'Invalid import limits', [describeThrown(error)]);
    }

    const { manifest, importer } = registration;
    const capability = manifest.capabilities.find((item) => item.id === request.capabilityId) as ImporterCapability;
    // Structural check rather than `instanceof`: a host and an importer repo may each load
    // their own copy of @wormhole/sdk, and a tree from one copy must still be accepted.
    const loaded: TreeLoadResult = isTreeLoadResult(request.input)
      ? request.input
      : { tree: request.input, diagnostics: [], fatal: false };
    const tree = loaded.tree;
    const startedAt = this.#clock();
    const logs: LogEntry[] = [];
    let droppedLogs = 0;

    const outcome = (
      status: ImportRunOutcome['status'],
      diagnostics: ImporterDiagnostic[],
      extra: Partial<Pick<ImportRunOutcome, 'failure' | 'summary' | 'archive'>> & { outputBytes?: number } = {},
    ): ImportRunOutcome => {
      if (droppedLogs > 0) {
        logs.push({ level: 'warn', message: `${droppedLogs} further log entries were dropped`, elapsedMs: this.#clock() - startedAt });
      }
      return {
        status,
        ...(extra.failure ? { failure: extra.failure } : {}),
        importerId: manifest.id,
        importerVersion: manifest.version,
        capabilityId: capability.id,
        diagnostics: { schemaVersion: 'hyperdrive.importer-diagnostics.v1', diagnostics },
        ...(extra.summary ? { summary: extra.summary } : {}),
        ...(extra.archive ? { archive: extra.archive } : {}),
        logs,
        stats: {
          inputFiles: tree.fileCount,
          inputBytes: tree.totalBytes,
          outputBytes: extra.outputBytes ?? 0,
          elapsedMs: this.#clock() - startedAt,
        },
      };
    };
    const fail = (code: RunFailureCode, diagnostics: ImporterDiagnostic[], extra: { summary?: ImportSummary; outputBytes?: number } = {}) => {
      const last = diagnostics[diagnostics.length - 1];
      return outcome('failed', diagnostics, { ...extra, failure: { code, message: last?.message ?? code } });
    };

    // 1. Input checks, before any importer code runs.
    const inputDiagnostics = [...loaded.diagnostics];
    if (loaded.fatal) {
      const reason = sdkDiagnostic(SdkDiagnosticCode.INPUT_UNREADABLE, 'error', 'Input was rejected while loading; see the diagnostics above.');
      return fail('INPUT_REJECTED', [...inputDiagnostics, reason]);
    }
    if (!capability.inputs.containers.includes(tree.container)) {
      return fail('INPUT_REJECTED', [
        ...inputDiagnostics,
        sdkDiagnostic(
          SdkDiagnosticCode.INPUT_CONTAINER_UNSUPPORTED,
          'error',
          `Capability ${capability.id} does not accept ${tree.container} input (accepts: ${capability.inputs.containers.join(', ')}).`,
        ),
      ]);
    }
    if (tree.fileCount > limits.maxInputFiles) {
      return fail('LIMIT_EXCEEDED', [
        ...inputDiagnostics,
        sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_MANY_FILES, 'error', `Input has ${tree.fileCount} files; the limit is ${limits.maxInputFiles}.`),
      ]);
    }
    const maxInputBytes = Math.min(limits.maxInputBytes, capability.inputs.maxBytes);
    if (tree.totalBytes > maxInputBytes) {
      return fail('LIMIT_EXCEEDED', [
        ...inputDiagnostics,
        sdkDiagnostic(SdkDiagnosticCode.INPUT_TOO_LARGE, 'error', `Input is ${tree.totalBytes} bytes; the limit for ${capability.id} is ${maxInputBytes}.`),
      ]);
    }

    // 2. Run the importer under a context that carries the abort signal and deadline.
    const handle = createImportContext({
      signal: request.signal,
      limits,
      clock: this.#clock,
      onLog: (entry) => {
        if (logs.length < MAX_RUN_LOG_ENTRIES) logs.push(entry);
        else droppedLogs += 1;
        this.#onLog?.({ ...entry, importerId: manifest.id, capabilityId: capability.id });
      },
    });
    const abortedOutcome = (): ImportRunOutcome =>
      handle.timedOut()
        ? fail('LIMIT_EXCEEDED', [
            ...inputDiagnostics,
            sdkDiagnostic(SdkDiagnosticCode.RUN_WALL_TIME_EXCEEDED, 'error', `Import exceeded its ${limits.maxWallTimeMs} ms wall-time limit.`),
          ])
        : fail('ABORTED', [...inputDiagnostics, sdkDiagnostic(SdkDiagnosticCode.RUN_ABORTED, 'error', 'Import was cancelled.')]);

    let raw: unknown;
    try {
      if (handle.context.signal.aborted) return abortedOutcome();
      const signal = handle.context.signal;
      const importPromise = Promise.resolve().then(() =>
        importer.import(
          Object.freeze({ files: tree, capabilityId: capability.id, options: Object.freeze({ ...(request.options ?? {}) }) }),
          handle.context,
        ),
      );
      // If we stop waiting (abort/timeout), the importer may still settle later; swallow
      // that so it never becomes an unhandled rejection.
      importPromise.catch(() => undefined);
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      aborted.catch(() => undefined);
      raw = await Promise.race([importPromise, aborted]);
      handle.checkDeadline();
      if (signal.aborted) return abortedOutcome();
    } catch (error) {
      handle.checkDeadline();
      if (handle.context.signal.aborted) return abortedOutcome();
      return fail('IMPORTER_THREW', [
        ...inputDiagnostics,
        sdkDiagnostic(SdkDiagnosticCode.RUN_IMPORTER_THREW, 'error', `Importer ${manifest.id} threw: ${describeThrown(error)}`, {
          details: 'Importers must report bad input as diagnostics instead of throwing.',
        }),
      ]);
    } finally {
      handle.dispose();
    }

    // 3. Validate what came back.
    const invalid = (problems: string[], code: SdkDiagnosticCode = SdkDiagnosticCode.RUN_INVALID_RESULT) =>
      fail('INVALID_RESULT', [
        ...inputDiagnostics,
        ...problems.map((problem) =>
          sdkDiagnostic(code, 'error', `Importer ${manifest.id} returned an invalid result: ${problem}`),
        ),
      ]);
    let shapeProblems: string[];
    try {
      shapeProblems = importResultShapeProblems(raw);
    } catch (error) {
      shapeProblems = [`result could not be inspected: ${describeThrown(error)}`];
    }
    if (shapeProblems.length > 0) return invalid(shapeProblems);
    const result = raw as ImportResult;

    const report: ImporterDiagnosticsReport = {
      schemaVersion: 'hyperdrive.importer-diagnostics.v1',
      diagnostics: [...inputDiagnostics, ...result.diagnostics],
    };
    const diagnosticProblems = diagnosticsReportProblems(report);
    if (diagnosticProblems.length > 0) return invalid(diagnosticProblems.map((problem) => `diagnostics ${problem}`));

    const summary: ImportSummary = {
      message: result.summary.message,
      ...(result.summary.stats !== undefined ? { stats: { ...result.summary.stats } } : {}),
    };
    if (Object.keys(result.sources).length === 0) {
      return fail(
        'NO_SOURCES',
        [
          ...report.diagnostics,
          sdkDiagnostic(SdkDiagnosticCode.RUN_NO_SOURCES, 'error', `Importer ${manifest.id} produced no canonical sources.`),
        ],
        { summary },
      );
    }

    const totalOutput = outputBytes(result, report, summary);
    if (totalOutput > limits.maxOutputBytes) {
      return fail(
        'LIMIT_EXCEEDED',
        [
          ...report.diagnostics,
          sdkDiagnostic(SdkDiagnosticCode.RUN_OUTPUT_TOO_LARGE, 'error', `Importer output is ${totalOutput} bytes; the limit is ${limits.maxOutputBytes}.`),
        ],
        { summary, outputBytes: totalOutput },
      );
    }

    // 4. Build the deterministic archive and re-check it against the result schema.
    let archive: BuiltImporterArchive;
    try {
      archive = buildImporterArchive({
        manifest: {
          importerId: capability.id,
          importerVersion: manifest.version,
          vendorFamily: capability.vendorFamily,
          sourceFingerprint: tree.fingerprint(),
          ...(result.unsupportedSemantics ? { unsupportedSemantics: result.unsupportedSemantics } : {}),
          // `summary` stays on the run outcome only until core's result schema accepts it (wormhole#2).
        },
        sources: result.sources,
        diagnostics: report,
        ...(result.preservation ? { preservation: result.preservation } : {}),
        ...(result.assets ? { assets: result.assets } : {}),
      });
    } catch (error) {
      if (error instanceof ImporterArchiveError) {
        return invalid([...error.problems], SdkDiagnosticCode.RUN_UNSAFE_OUTPUT_PATH);
      }
      return invalid([`archive could not be built: ${describeThrown(error)}`]);
    }
    const manifestProblems = resultManifestProblems(archive.manifest);
    if (manifestProblems.length > 0) return invalid(manifestProblems.map((problem) => `result manifest ${problem}`));

    return outcome('succeeded', report.diagnostics, { summary, archive, outputBytes: totalOutput });
  }

  #sortedRegistrations(): Registration[] {
    return [...this.#registrations.values()].sort((a, b) => compareCodeUnits(a.manifest.id, b.manifest.id));
  }

  #detectResultProblem(manifest: Readonly<ImporterManifest>, result: unknown): string | undefined {
    if (!isPlainRecord(result)) return 'not an object';
    const { capabilityId, confidence, reason } = result;
    if (typeof capabilityId !== 'string' || !manifest.capabilities.some((capability) => capability.id === capabilityId)) {
      return `capabilityId ${JSON.stringify(capabilityId)} is not one of the importer's capabilities`;
    }
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return `confidence ${String(confidence)} is not a number from 0 to 1`;
    }
    if (typeof reason !== 'string' || reason.length === 0) return 'reason must be a non-empty string';
    return undefined;
  }

  #hostLog(importerId: string, level: LogEntry['level'], message: string): void {
    this.#onLog?.({ level, message, importerId, elapsedMs: 0 });
  }
}
