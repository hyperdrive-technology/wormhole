import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';

import type {
  BuildImporterResultArchiveInput,
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

  const zipEntries: Record<string, Uint8Array> = {};
  for (const file of files) {
    zipEntries[file.path] = strToU8(file.content);
  }

  return {
    manifest,
    files,
    zipBytes: zipSync(zipEntries),
  };
}

export * from './types.js';
