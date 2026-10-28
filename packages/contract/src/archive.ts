import { createHash } from 'node:crypto';
import { strToU8, zipSync, type Zippable } from 'fflate';

import { checkRelativePath } from './paths.js';
import type {
  ArchiveContent,
  BuildImporterArchiveInput,
  BuildImporterResultArchiveInput,
  BuiltImporterArchive,
  ImporterArchiveEntry,
  ImporterArchiveFile,
  ImporterResultArchive,
  ImporterResultManifest,
} from './types.js';

export function fingerprintSource(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function buildDiagnosticsReport(
  diagnostics: BuildImporterResultArchiveInput['diagnostics']['diagnostics'],
): BuildImporterResultArchiveInput['diagnostics'] {
  return {
    schemaVersion: 'hyperdrive.importer-diagnostics.v1',
    diagnostics,
  };
}

/**
 * Modification time stamped on every zip entry. Zip stores local "DOS" time and fflate
 * reads it with the local-time getters (`getFullYear()`, `getHours()`, ...), so the date is
 * built from local-time components: that makes the stored bytes identical in every
 * timezone. 1980-01-01 is the earliest DOS date.
 */
function fixedZipModificationTime(): Date {
  return new Date(1980, 0, 1, 0, 0, 0, 0);
}

/** Deflate level used for every archive. Changing it changes archive bytes, so treat it as part of the format. */
export const ARCHIVE_DEFLATE_LEVEL = 6;

/**
 * Zips entries in the given order with fixed timestamps and compression, so identical
 * entries always give byte-identical archives.
 */
export function zipDeterministic(entries: readonly ImporterArchiveEntry[]): Uint8Array {
  const zippable: Zippable = {};
  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(zippable, entry.path)) {
      throw new ImporterArchiveError([`duplicate archive path ${entry.path}`]);
    }
    zippable[entry.path] = entry.bytes;
  }
  return zipSync(zippable, { level: ARCHIVE_DEFLATE_LEVEL, mtime: fixedZipModificationTime() });
}

/** Thrown by the archive builders; `problems` lists every reason, not just the first. */
export class ImporterArchiveError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid importer archive: ${problems.join('; ')}`);
    this.name = 'ImporterArchiveError';
    this.problems = problems;
  }
}

function normalizeArchivePath(path: string): string {
  const trimmed = path.replace(/^\.\/+/, '');
  if (/[\0\r\n\\]/.test(trimmed) || trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new Error(`Invalid archive path: ${path}`);
  }
  return trimmed;
}

function canonicalSourcePath(fileName: string): string {
  const base = fileName.replace(/^.*[/\\]/, '').replace(/\.(plc|st)$/i, '') || 'upgraded';
  return normalizeArchivePath(`sources/${base}.plc`);
}

/**
 * Single-source archive builder used by the `wormhole upgrade` CLI, the service and the UI.
 * New importers should go through `@wormhole/sdk`'s `ImporterHost`, which uses
 * {@link buildImporterArchive}.
 */
export function buildImporterResultArchive(
  input: BuildImporterResultArchiveInput,
): ImporterResultArchive {
  const sourceArchivePath = canonicalSourcePath(input.sourcePath);
  const diagnosticsPath = 'diagnostics.json';
  const preservationPaths = Object.keys(input.preservation ?? {})
    .map((key) => normalizeArchivePath(key))
    .sort();

  const manifest: ImporterResultManifest = {
    schemaVersion: 'hyperdrive.importer-result.v1',
    ...input.manifest,
    sourceFingerprint: input.manifest.sourceFingerprint || fingerprintSource(input.sourceContent),
    canonicalSources: [sourceArchivePath],
    preservation: preservationPaths.length > 0 ? preservationPaths : undefined,
    diagnostics: diagnosticsPath,
  };

  const files: ImporterArchiveFile[] = [
    { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: sourceArchivePath, content: input.sourceContent },
    {
      path: diagnosticsPath,
      content: `${JSON.stringify(input.diagnostics, null, 2)}\n`,
    },
  ];

  for (const path of preservationPaths) {
    const content = input.preservation?.[path];
    if (content === undefined) {
      throw new Error(`Missing preservation content for ${path}`);
    }
    files.push({ path, content });
  }

  return {
    manifest,
    files,
    zipBytes: zipDeterministic(
      files.map((file) => ({ path: file.path, bytes: strToU8(file.content) })),
    ),
  };
}

const SOURCE_PATH = /^sources\/.+\.plc$/;
const PRESERVATION_PATH = /^preservation\/.+/;
const ASSET_PATH = /^assets\/.+/;

function toBytes(content: ArchiveContent): Uint8Array {
  return typeof content === 'string' ? strToU8(content) : content;
}

/** Plain-code-unit order, so sorting never depends on the runtime's locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Collects one archive section (sources, preservation or assets), checking every path for
 * safety, the section prefix, and collisions after normalisation.
 */
function collectSection(
  section: string,
  record: Readonly<Record<string, ArchiveContent>> | undefined,
  pattern: RegExp,
  seen: Map<string, string>,
  problems: string[],
): ImporterArchiveEntry[] {
  const entries: ImporterArchiveEntry[] = [];
  if (record === undefined) return entries;
  for (const rawPath of Object.keys(record)) {
    const checked = checkRelativePath(rawPath, { portable: true });
    if (!checked.ok) {
      problems.push(`${section} path ${JSON.stringify(rawPath)}: ${checked.reason}`);
      continue;
    }
    if (!pattern.test(checked.path)) {
      problems.push(`${section} path ${JSON.stringify(rawPath)} must match ${pattern.source}`);
      continue;
    }
    // Windows and default macOS filesystems are case-insensitive, so `A.plc` and `a.plc`
    // would overwrite each other when the archive is extracted there.
    const collisionKey = checked.path.toLowerCase();
    const previous = seen.get(collisionKey);
    if (previous !== undefined) {
      problems.push(
        `${section} path ${JSON.stringify(rawPath)} collides with ${JSON.stringify(previous)}`,
      );
      continue;
    }
    seen.set(collisionKey, rawPath);
    const content = record[rawPath];
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
      problems.push(`${section} path ${JSON.stringify(rawPath)} has non-text, non-byte content`);
      continue;
    }
    entries.push({ path: checked.path, bytes: toBytes(content) });
  }
  return entries.sort((a, b) => compareCodeUnits(a.path, b.path));
}

/**
 * Builds a `hyperdrive.importer-result.v1` archive with any number of canonical sources,
 * preservation sidecars and assets. Archive bytes depend only on the input: entries are
 * sorted, timestamps fixed, compression level fixed.
 *
 * Throws {@link ImporterArchiveError} listing every invalid or colliding path.
 */
export function buildImporterArchive(input: BuildImporterArchiveInput): BuiltImporterArchive {
  const problems: string[] = [];
  const seen = new Map<string, string>([
    ['manifest.json', 'manifest.json'],
    ['diagnostics.json', 'diagnostics.json'],
  ]);
  const sources = collectSection('sources', input.sources, SOURCE_PATH, seen, problems);
  const preservation = collectSection(
    'preservation',
    input.preservation,
    PRESERVATION_PATH,
    seen,
    problems,
  );
  const assets = collectSection('assets', input.assets, ASSET_PATH, seen, problems);
  if (sources.length === 0 && problems.length === 0) {
    problems.push('at least one canonical source (sources/<path>.plc) is required');
  }
  if (problems.length > 0) throw new ImporterArchiveError(problems);

  const manifest: ImporterResultManifest = {
    schemaVersion: 'hyperdrive.importer-result.v1',
    importerId: input.manifest.importerId,
    importerVersion: input.manifest.importerVersion,
    vendorFamily: input.manifest.vendorFamily,
    sourceFingerprint: input.manifest.sourceFingerprint,
    canonicalSources: sources.map((entry) => entry.path),
    ...(assets.length > 0 ? { assets: assets.map((entry) => entry.path) } : {}),
    ...(preservation.length > 0 ? { preservation: preservation.map((entry) => entry.path) } : {}),
    diagnostics: 'diagnostics.json',
    ...(input.manifest.unsupportedSemantics && input.manifest.unsupportedSemantics.length > 0
      ? { unsupportedSemantics: input.manifest.unsupportedSemantics }
      : {}),
    ...(input.manifest.summary ? { summary: input.manifest.summary } : {}),
  };

  const entries: ImporterArchiveEntry[] = [
    { path: 'manifest.json', bytes: strToU8(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: 'diagnostics.json', bytes: strToU8(`${JSON.stringify(input.diagnostics, null, 2)}\n`) },
    ...sources,
    ...preservation,
    ...assets,
  ];

  return { manifest, entries, zipBytes: zipDeterministic(entries) };
}

export * from './types.js';
