export { WORMHOLE_SDK_API_VERSION } from './version.js';
export { SdkDiagnosticCode } from './diagnostics.js';
export { ImporterHostError, type ImporterHostErrorCode } from './errors.js';
export {
  DEFAULT_IMPORT_LIMITS,
  resolveImportLimits,
  type ImportLimits,
  type InputLimits,
} from './limits.js';
export {
  decodeText,
  looksBinary,
  normalizeNewlines,
  type DecodeTextOptions,
  type DecodedText,
  type TextEncodingName,
} from './text.js';
export {
  VirtualFileTree,
  type InputContainer,
  type TreeLoadOptions,
  type TreeLoadResult,
  type TreeReadObserver,
  type VirtualFileEntryInput,
} from './tree.js';
export { readZipTree, type ReadZipOptions } from './zip.js';
export {
  IMPORTER_MANIFEST_FILE_NAME,
  IMPORTER_MANIFEST_SCHEMA_VERSION,
  ImporterManifestError,
  capabilityEntries,
  isSdkCompatible,
  parseImporterManifest,
  toCapabilitiesDocument,
  validateImporterManifest,
  type ImporterCapability,
  type ImporterManifest,
  type ImporterOutputKind,
  type InputContainerKind,
  type ManifestValidation,
} from './manifest.js';
export {
  defineImporter,
  type DetectInput,
  type DetectResult,
  type ImportContext,
  type ImportInput,
  type ImportOptionValue,
  type ImportOptions,
  type ImportResult,
  type ImportSummary,
  type ImporterLogger,
  type LogEntry,
  type LogFields,
  type LogLevel,
  type MigrateToolkit,
  type ReservedNarrativeInput,
  type WormholeImporter,
} from './importer.js';
export {
  createImportContext,
  type CreateImportContextOptions,
  type ImportContextHandle,
} from './context.js';
export {
  ImporterHost,
  MAX_RUN_LOG_ENTRIES,
  type DetectCandidate,
  type HostLogEntry,
  type ImportRunOutcome,
  type ImporterHostOptions,
  type RunFailureCode,
  type RunRequest,
} from './host.js';
export {
  capabilitiesDocumentProblems,
  diagnosticsReportProblems,
  resultManifestProblems,
} from './validation.js';

// Contract types importers handle directly, re-exported so an importer can depend on
// `@wormhole/sdk` alone.
export type {
  ArchiveContent,
  BuiltImporterArchive,
  ImporterCapabilitiesDocument,
  ImporterCapabilityEntry,
  ImporterDiagnostic,
  ImporterDiagnosticSeverity,
  ImporterDiagnosticSource,
  ImporterDiagnosticsReport,
  ImporterResultManifest,
  ImporterResultSummary,
  ImporterUnsupportedSemantic,
} from '@wormhole/contract';
export { checkRelativePath, type RelativePathCheck, type RelativePathOptions } from '@wormhole/contract';
export type { UpgradeOptions, UpgradeResult, UpgradeRule } from '@wormhole/migrate';
