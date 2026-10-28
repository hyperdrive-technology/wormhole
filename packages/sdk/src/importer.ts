import type {
  ArchiveContent,
  ImporterDiagnostic,
  ImporterUnsupportedSemantic,
} from '@wormhole/contract';
import type { UpgradeOptions, UpgradeResult, UpgradeRule } from '@wormhole/migrate';

import type { ImportLimits } from './limits.js';
import type { ImporterManifest } from './manifest.js';
import type { VirtualFileTree } from './tree.js';

/** Input to `detect()`: just the files. */
export interface DetectInput {
  readonly files: VirtualFileTree;
}

/** "This input looks like capability X, with confidence 0..1, because ...". */
export interface DetectResult {
  /** One of the importer's own capability ids. */
  capabilityId: string;
  /** 0 (no idea) to 1 (certain). Hosts rank candidates by it. */
  confidence: number;
  /** Short, human-readable reason, e.g. "found .L5X with RSLogix5000Content root". */
  reason: string;
}

export type ImportOptionValue = string | number | boolean;
/** Importer-specific switches (for example `{ apply: false }` for report-only runs). */
export type ImportOptions = Readonly<Record<string, ImportOptionValue>>;

/**
 * RESERVED for lane F3 (control narratives, cause-and-effect matrices, loop sheets as
 * input next to code). Not implemented in API 1.0: the type is `never`, so TypeScript
 * callers cannot set it, and `ImporterHost.run` rejects JavaScript callers that do. F3 will
 * replace `never` with a real type in a minor API version; importers written against 1.0
 * simply ignore it.
 */
export type ReservedNarrativeInput = never;

export interface ImportInput {
  readonly files: VirtualFileTree;
  /** The capability the host chose (from `detectAll` or the user). */
  readonly capabilityId: string;
  readonly options: ImportOptions;
  /** @reserved Lane F3; see {@link ReservedNarrativeInput}. Always absent in API 1.0. */
  readonly narratives?: ReservedNarrativeInput;
}

/** A short human summary; stored in the result manifest. */
export interface ImportSummary {
  message: string;
  /** Named non-negative integer counters, e.g. `{ filesUpgraded: 3 }`. Keys: `^[A-Za-z][A-Za-z0-9_.-]*$`. */
  stats?: Record<string, number>;
}

/**
 * What `import()` returns. Every key is a full archive path.
 *
 * Return diagnostics for anything wrong with the input (garbage, truncation, unsupported
 * constructs) instead of throwing: a throw is reported as an importer crash.
 */
export interface ImportResult {
  /** `sources/<path>.plc` → Edition 4–oriented IEC 61131-3 source text. */
  sources: Record<string, string>;
  /** `hyperdrive.importer-diagnostics.v1` entries, in the order they should be shown. */
  diagnostics: ImporterDiagnostic[];
  /** `preservation/<path>` → anything that could not be converted losslessly. */
  preservation?: Record<string, ArchiveContent>;
  /** `assets/<path>` → images, HMI resources and other non-source files. */
  assets?: Record<string, ArchiveContent>;
  unsupportedSemantics?: ImporterUnsupportedSemantic[];
  summary: ImportSummary;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface LogEntry {
  level: LogLevel;
  message: string;
  fields?: LogFields;
  /** Milliseconds since the import started. */
  elapsedMs: number;
}

/** Structured logger. Logs are for operators; anything the user must see is a diagnostic. */
export interface ImporterLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * `@wormhole/migrate`'s Edition 4 legacy rule pipeline, so every importer that produces
 * IEC 61131-3 text can run the same octal/TRUNC/BCD/IL/... upgrades on it for free.
 */
export interface MigrateToolkit {
  upgradeSource(content: string, options: UpgradeOptions, rules?: UpgradeRule[]): UpgradeResult;
  readonly defaultRules: readonly UpgradeRule[];
}

export interface ImportContext {
  /** Aborted when the caller cancels or the wall-time limit passes. Pass it to async work. */
  readonly signal: AbortSignal;
  readonly limits: Readonly<ImportLimits>;
  readonly logger: ImporterLogger;
  readonly migrate: MigrateToolkit;
  /**
   * Throws the abort reason if the import was cancelled or ran out of time. Call it between
   * files and inside long loops: a synchronous importer cannot be interrupted otherwise.
   */
  throwIfAborted(): void;
  /** Milliseconds left before the wall-time limit (never negative). */
  remainingMs(): number;
}

/**
 * The importer contract. An importer package's entry module default-exports one of these
 * (see `defineImporter`).
 *
 * - `detect` must be deterministic and cheap: look at paths, extensions and a few header
 *   bytes (`files.head()`), never parse the whole project. Return `null` when the input is
 *   not yours. It must not throw.
 * - `import` turns the input into sources, diagnostics, preservation sidecars and a
 *   summary. It must be deterministic (same input, same output), must not throw for bad
 *   input, and should call `ctx.throwIfAborted()` regularly.
 */
export interface WormholeImporter {
  readonly manifest: ImporterManifest;
  detect(input: DetectInput): DetectResult | null;
  import(input: ImportInput, ctx: ImportContext): ImportResult | Promise<ImportResult>;
}

/** Identity helper that gives an importer object literal its type. */
export function defineImporter<T extends WormholeImporter>(importer: T): T {
  return importer;
}
