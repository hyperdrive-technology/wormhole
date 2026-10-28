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

export const IEC61131_ED4_UPGRADE_CAPABILITY = {
  id: 'iec61131-ed4-upgrade',
  vendorFamily: 'iec61131-legacy',
  displayName: 'IEC 61131 Edition 3 → Edition 4 source upgrade',
  fileExtensions: ['.plc', '.st'],
  maxUploadBytes: 10_485_760,
} as const;
