import semver from 'semver';
import {
  checkRelativePath,
  type ImporterCapabilitiesDocument,
  type ImporterCapabilityEntry,
} from '@wormhole/contract';

import { SCHEMAS, schemaProblems } from './validation.js';
import { WORMHOLE_SDK_API_VERSION } from './version.js';

export const IMPORTER_MANIFEST_SCHEMA_VERSION = 'wormhole.importer.v1';
/** Conventional file name of the manifest at the root of an importer package. */
export const IMPORTER_MANIFEST_FILE_NAME = 'wormhole.importer.json';

export type InputContainerKind = 'file' | 'directory' | 'zip';
export type ImporterOutputKind = 'sources' | 'diagnostics' | 'preservation' | 'assets';

/** One import capability: a source format the importer understands. */
export interface ImporterCapability {
  /** Becomes `importerId` in `hyperdrive.importer-*.v1` documents; unique per host. */
  id: string;
  displayName: string;
  /** Who makes the source system, for people. */
  vendor: string;
  /** Machine id of the source family, e.g. `iec61131-legacy`. */
  vendorFamily: string;
  product?: string;
  productVersions?: string[];
  inputs: {
    /** Lowercase, with the dot. */
    fileExtensions: string[];
    mediaTypes?: string[];
    containers: InputContainerKind[];
    /** Maps to `maxUploadBytes`; the host never runs the capability on more input than this. */
    maxBytes: number;
  };
  outputs: ImporterOutputKind[];
  coverageNotes?: string[];
}

/** `wormhole.importer.json`. See `packages/contract/schemas/wormhole-importer.v1.schema.json`. */
export interface ImporterManifest {
  $schema?: string;
  schemaVersion: typeof IMPORTER_MANIFEST_SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  version: string;
  license: string;
  /** Semver range of the importer API (`WORMHOLE_SDK_API_VERSION`) this importer supports. */
  sdk: string;
  /** Package-relative entry module whose default export is the importer. */
  entry?: string;
  capabilities: ImporterCapability[];
}

export type ManifestValidation =
  | { ok: true; manifest: Readonly<ImporterManifest> }
  | { ok: false; problems: string[] };

export class ImporterManifestError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid importer manifest: ${problems.join('; ')}`);
    this.name = 'ImporterManifestError';
    this.problems = problems;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Rejects URL-ish and escaping entry paths, mirroring Holodeck's package-relative path rule. */
function entryPathProblem(entry: string): string | undefined {
  if (entry.trim() !== entry) return 'has surrounding whitespace';
  if (/^[a-z][a-z0-9+.-]*:/i.test(entry)) return 'is a URL';
  if (/[%?#]/.test(entry)) return 'contains %, ? or #';
  const checked = checkRelativePath(entry, { portable: true });
  if (!checked.ok) return checked.reason;
  if (checked.path !== entry) return 'is not in normal form (leading ./ or non-NFC)';
  return undefined;
}

/**
 * Validates a manifest value: the JSON schema (unknown fields are errors), then rules a
 * schema cannot express. Returns every problem, not just the first. On success the
 * manifest is a frozen deep copy, so later mutation of the input has no effect.
 */
export function validateImporterManifest(value: unknown): ManifestValidation {
  let problems: string[];
  try {
    problems = schemaProblems(SCHEMAS.manifest, value);
  } catch (error) {
    return { ok: false, problems: [`manifest could not be validated: ${String(error)}`] };
  }
  if (problems.length > 0) return { ok: false, problems };

  const manifest = value as ImporterManifest;
  if (semver.valid(manifest.version) === null) {
    problems.push(`/version "${manifest.version}" is not valid semver`);
  }
  if (semver.validRange(manifest.sdk) === null) {
    problems.push(`/sdk "${manifest.sdk}" is not a valid semver range`);
  }
  if (manifest.entry !== undefined) {
    const problem = entryPathProblem(manifest.entry);
    if (problem) problems.push(`/entry "${manifest.entry}" ${problem}`);
  }
  const seen = new Set<string>();
  manifest.capabilities.forEach((capability, index) => {
    if (seen.has(capability.id)) {
      problems.push(`/capabilities/${index}/id "${capability.id}" is declared twice`);
    }
    seen.add(capability.id);
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, manifest: deepFreeze(structuredClone(manifest)) };
}

/** Like {@link validateImporterManifest} but throws {@link ImporterManifestError}. */
export function parseImporterManifest(value: unknown): Readonly<ImporterManifest> {
  const result = validateImporterManifest(value);
  if (!result.ok) throw new ImporterManifestError(result.problems);
  return result.manifest;
}

/** Whether the manifest's `sdk` range accepts `apiVersion` (default: this SDK's API version). */
export function isSdkCompatible(
  manifest: Pick<ImporterManifest, 'sdk'>,
  apiVersion: string = WORMHOLE_SDK_API_VERSION,
): boolean {
  return semver.satisfies(apiVersion, manifest.sdk);
}

/** Maps each capability onto a `hyperdrive.importer-capabilities.v1` entry. */
export function capabilityEntries(manifest: ImporterManifest): ImporterCapabilityEntry[] {
  return manifest.capabilities.map((capability) => ({
    id: capability.id,
    vendorFamily: capability.vendorFamily,
    displayName: capability.displayName,
    fileExtensions: [...capability.inputs.fileExtensions],
    maxUploadBytes: capability.inputs.maxBytes,
    ...(capability.coverageNotes && capability.coverageNotes.length > 0
      ? { coverageNotes: [...capability.coverageNotes] }
      : {}),
  }));
}

/** A `hyperdrive.importer-capabilities.v1` document listing every capability, sorted by id. */
export function toCapabilitiesDocument(
  manifests: Iterable<ImporterManifest>,
): ImporterCapabilitiesDocument {
  const importers = [...manifests]
    .flatMap((manifest) => capabilityEntries(manifest))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schemaVersion: 'hyperdrive.importer-capabilities.v1', importers };
}
