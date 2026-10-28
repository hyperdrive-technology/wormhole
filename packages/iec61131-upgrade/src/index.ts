export {
  buildIec61131ImporterArchive,
  IMPORTER_ID,
  IMPORTER_VERSION,
  VENDOR_FAMILY,
  inferSourceKind,
  upgradeIec61131File,
  upgradeIec61131Source,
  upgradePath,
  upgradeSource,
} from './upgrade.js';

export type { Iec61131UpgradeOptions, Iec61131UpgradeResult } from './upgrade.js';
