export type ImporterDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ImporterDiagnosticSource {
  path: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface ImporterDiagnostic {
  code: string;
  message: string;
  severity: ImporterDiagnosticSeverity;
  source?: ImporterDiagnosticSource;
  details?: string;
}

export interface ImporterDiagnosticsReport {
  schemaVersion: 'hyperdrive.importer-diagnostics.v1';
  diagnostics: ImporterDiagnostic[];
}

export interface ImporterUnsupportedSemantic {
  code: string;
  message: string;
  severity?: ImporterDiagnosticSeverity;
}

export interface ImporterResultManifest {
  schemaVersion: 'hyperdrive.importer-result.v1';
  importerId: string;
  importerVersion: string;
  vendorFamily: string;
  sourceFingerprint: string;
  canonicalSources: string[];
  assets?: string[];
  preservation?: string[];
  diagnostics: string;
  unsupportedSemantics?: ImporterUnsupportedSemantic[];
  // No `summary` here yet: core's hyperdrive-importer-result.v1 schema is closed
  // (additionalProperties: false) and does not list it, so writing it would make every archive
  // fail core's validation (GPT review on PR #1). Add it back once core's schema has it (wormhole#2).
}

/** Human-readable outcome of an import, returned on the SDK run outcome (not yet in the manifest, wormhole#2). */
export interface ImporterResultSummary {
  /** One or two sentences, e.g. "Upgraded 3 files; 1 IL body preserved." */
  message: string;
  /** Named non-negative integer counters, e.g. `{ "filesUpgraded": 3 }`. */
  stats?: Record<string, number>;
}

/** One entry of a `hyperdrive.importer-capabilities.v1` document. */
export interface ImporterCapabilityEntry {
  id: string;
  vendorFamily: string;
  displayName: string;
  fileExtensions: string[];
  maxUploadBytes: number;
  coverageNotes?: string[];
}

export interface ImporterCapabilitiesDocument {
  schemaVersion: 'hyperdrive.importer-capabilities.v1';
  importers: ImporterCapabilityEntry[];
}

export interface ImporterArchiveFile {
  path: string;
  content: string;
}

export interface BuildImporterResultArchiveInput {
  manifest: {
    importerId: string;
    importerVersion: string;
    vendorFamily: string;
    sourceFingerprint?: string;
    unsupportedSemantics?: ImporterUnsupportedSemantic[];
  };
  sourcePath: string;
  sourceContent: string;
  diagnostics: ImporterDiagnosticsReport;
  preservation?: Record<string, string>;
}

export interface ImporterResultArchive {
  manifest: ImporterResultManifest;
  files: ImporterArchiveFile[];
  zipBytes: Uint8Array;
}

/** Text is written as UTF-8; bytes are written as-is. */
export type ArchiveContent = string | Uint8Array;

/**
 * Input of {@link buildImporterArchive}: a multi-source result. Every key is a full archive
 * path: `sources/<path>.plc`, `preservation/<path>`, `assets/<path>`.
 */
export interface BuildImporterArchiveInput {
  manifest: {
    importerId: string;
    importerVersion: string;
    vendorFamily: string;
    sourceFingerprint: string;
    unsupportedSemantics?: ImporterUnsupportedSemantic[];
  };
  sources: Readonly<Record<string, string>>;
  diagnostics: ImporterDiagnosticsReport;
  preservation?: Readonly<Record<string, ArchiveContent>>;
  assets?: Readonly<Record<string, ArchiveContent>>;
}

export interface ImporterArchiveEntry {
  path: string;
  bytes: Uint8Array;
}

export interface BuiltImporterArchive {
  manifest: ImporterResultManifest;
  /** Entries in archive order: manifest.json, diagnostics.json, then sources, preservation, assets (each sorted). */
  entries: ImporterArchiveEntry[];
  zipBytes: Uint8Array;
}

export const IEC61131_ED4_UPGRADE_CAPABILITY = {
  id: 'iec61131-ed4-upgrade',
  vendorFamily: 'iec61131-legacy',
  displayName: 'IEC 61131 Edition 3 → Edition 4 source upgrade',
  fileExtensions: ['.plc', '.st'],
  maxUploadBytes: 10_485_760,
} as const;
