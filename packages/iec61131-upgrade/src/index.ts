export {
  buildIec61131ImporterArchive,
  IMPORTER_ID,
  IMPORTER_VERSION,
  VENDOR_FAMILY,
  inferSourceKind,
  upgradeIec61131File,
  upgradeIec61131Source,
  upgradePath,
  unsupportedSemanticsFrom,
  upgradeSource,
} from './upgrade.js';

export { iec61131UpgradeImporter, iec61131UpgradeManifest } from './importer.js';
export { iec61131UpgradeImporter as default } from './importer.js';

export type { Iec61131UpgradeOptions, Iec61131UpgradeResult } from './upgrade.js';
