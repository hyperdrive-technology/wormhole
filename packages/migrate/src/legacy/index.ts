/**
 * Legacy IEC 61131-3 construct migrations (octal literals, untyped TRUNC, BCD helpers,
 * IL preservation, represented-variable aliases, deprecated-construct hints).
 *
 * Canonical home since 2026-10-28. Moved here from Hyperdrive core's compiler worker
 * (`hyperdrive-ui/app/workers/hyperdrive-compiler/migration/`) so Wormhole builds standalone
 * as a public repo. Hyperdrive's compiler targets IEC 61131-3 Edition 4 and keeps legacy
 * constructs (IL, octal literals, untyped TRUNC, BCD helpers) out of its core language; they
 * are rewritten here, on the import path, instead.
 */
export {
  octalToHexLiteral,
  type OctalToHexLiteralResult,
} from './octalToHexLiteral';
export { truncToTyped, type TruncToTypedResult } from './truncToTyped';
export {
  ilPreservationSidecar,
  type IlPreservationSidecar,
} from './ilPreservationSidecar';
export {
  bcdMigrationShim,
  type BcdMigrationShimResult,
} from './bcdMigrationShim';
export {
  representedVariableAlias,
  type RepresentedVariableAliasResult,
} from './representedVariableAlias';
export {
  actionBlockIndicatorMigration,
  fbTaskWithMigration,
  graphicalActionBlockMigration,
  graphicalEdgeDeclarationMigration,
  type LegacyMigrationHint,
} from './legacyConstructMigrationHints';
