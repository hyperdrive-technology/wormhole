/**
 * Test doubles for the SDK's own tests: a small, well-behaved importer and helpers to
 * derive misbehaving variants from it. Not exported from the package.
 */
import { decodeText, normalizeNewlines } from '../text.js';
import { defineImporter, type ImportResult, type WormholeImporter } from '../importer.js';
import type { ImporterManifest } from '../manifest.js';

export const TOY_CAPABILITY_ID = 'toy.text';

export function toyManifest(overrides: Partial<ImporterManifest> = {}): ImporterManifest {
  return {
    schemaVersion: 'wormhole.importer.v1',
    id: 'toy.text-importer',
    name: 'Toy text importer',
    version: '1.2.3',
    license: 'MIT',
    sdk: '^1.0.0',
    entry: 'dist/index.js',
    capabilities: [
      {
        id: TOY_CAPABILITY_ID,
        displayName: 'Toy .txt to VAR_GLOBAL',
        vendor: 'Toy',
        vendorFamily: 'toy',
        inputs: { fileExtensions: ['.txt'], containers: ['file', 'directory', 'zip'], maxBytes: 1_000_000 },
        outputs: ['sources', 'diagnostics', 'preservation'],
      },
    ],
    ...overrides,
  };
}

/**
 * Each `.txt` line `Name` becomes `Name : BOOL;` in `sources/<path>.plc`. Lines that are not
 * identifiers become warnings and go to a preservation sidecar. Cooperative with aborts.
 */
export function toyImport(files: import('../tree.js').VirtualFileTree, throwIfAborted: () => void): ImportResult {
  throwIfAborted();
  const sources: Record<string, string> = {};
  const preservation: Record<string, string> = {};
  const diagnostics: ImportResult['diagnostics'] = [];
  const paths = files.pathsWithExtension('.txt');
  if (paths.length === 0) {
    diagnostics.push({ code: 'TOY_NO_INPUT', severity: 'error', message: 'No .txt files.' });
  }
  for (const path of paths) {
    throwIfAborted();
    const bytes = files.read(path) ?? new Uint8Array();
    const decoded = decodeText(bytes);
    if (decoded.encoding !== 'utf-8' || bytes.includes(0)) {
      diagnostics.push({ code: 'TOY_NOT_TEXT', severity: 'error', message: `${path} is not UTF-8 text.`, source: { path } });
      continue;
    }
    const lines = normalizeNewlines(decoded.text).text.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      diagnostics.push({ code: 'TOY_EMPTY', severity: 'warning', message: `${path} is empty.`, source: { path } });
      continue;
    }
    const good: string[] = [];
    const bad: string[] = [];
    lines.forEach((line, index) => {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.trim())) good.push(`  ${line.trim()} : BOOL;`);
      else {
        bad.push(line);
        diagnostics.push({ code: 'TOY_BAD_LINE', severity: 'warning', message: `Line ${index + 1} is not an identifier.`, source: { path, startLine: index + 1 } });
      }
    });
    sources[`sources/${path.replace(/\.txt$/i, '')}.plc`] = `VAR_GLOBAL\n${good.join('\n')}\nEND_VAR\n`;
    if (bad.length > 0) preservation[`preservation/${path}.rejected`] = `${bad.join('\n')}\n`;
  }
  return {
    sources,
    diagnostics,
    ...(Object.keys(preservation).length > 0 ? { preservation } : {}),
    summary: { message: `Converted ${Object.keys(sources).length} file(s).`, stats: { files: Object.keys(sources).length } },
  };
}

export function toyImporter(overrides: Partial<WormholeImporter> & { manifest?: ImporterManifest } = {}): WormholeImporter {
  return defineImporter({
    manifest: toyManifest(),
    detect({ files }) {
      const paths = files.pathsWithExtension('.txt');
      if (paths.length === 0) return null;
      return { capabilityId: TOY_CAPABILITY_ID, confidence: 0.6, reason: `${paths.length} .txt file(s)` };
    },
    import({ files }, ctx) {
      return toyImport(files, () => ctx.throwIfAborted());
    },
    ...overrides,
  });
}

export const TOY_FIXTURES = [
  { name: 'one file', files: { 'tags.txt': 'Start\nStop\n' } },
  { name: 'directory', files: { 'a/one.txt': 'Alpha\n', 'b/two.txt': 'Beta\nnot valid!\n' } },
] as const;
