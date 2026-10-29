import {
  checkRelativePath,
  decodeText,
  defineImporter,
  looksBinary,
  normalizeNewlines,
  parseImporterManifest,
  type DetectResult,
  type ImportResult,
  type ImporterDiagnostic,
} from '@wormhole/sdk';

import manifestJson from '../wormhole.importer.json';
import { IMPORTER_ID, IMPORTER_VERSION, inferSourceKind, unsupportedSemanticsFrom } from './upgrade.js';

/**
 * `@wormhole/iec61131-upgrade` as a `@wormhole/sdk` importer: the same `@wormhole/migrate`
 * rule pipeline as the `wormhole upgrade` CLI and the service, behind the SDK contract.
 * The CLI and service keep calling `upgradeIec61131Source` directly; this module is how
 * an `ImporterHost` (and the conformance kit) runs the importer.
 */
export const iec61131UpgradeManifest = parseImporterManifest(manifestJson);

if (iec61131UpgradeManifest.version !== IMPORTER_VERSION) {
  throw new Error(`wormhole.importer.json version ${iec61131UpgradeManifest.version} != IMPORTER_VERSION ${IMPORTER_VERSION}`);
}

const SOURCE_EXTENSIONS = ['.plc', '.st'] as const;
/** Bytes sniffed per file in detect(): enough for a header comment and the first POU. */
const DETECT_SNIFF_BYTES = 4096;
/** Files sniffed in detect(); the rest are judged by extension. */
const DETECT_SNIFF_FILES = 8;
const POU_KEYWORD = /\b(?:PROGRAM|FUNCTION_BLOCK|FUNCTION|CONFIGURATION|TYPE|INTERFACE|CLASS|NAMESPACE)\b/i;

function diagnostic(
  code: string,
  severity: ImporterDiagnostic['severity'],
  message: string,
  path?: string,
): ImporterDiagnostic {
  return { code, severity, message, ...(path !== undefined ? { source: { path } } : {}) };
}

function stripSourceExtension(path: string): string {
  return path.replace(/\.(?:plc|st)$/i, '');
}

export const iec61131UpgradeImporter = defineImporter({
  manifest: iec61131UpgradeManifest,

  detect({ files }): DetectResult | null {
    const candidates = files.pathsWithExtension(...SOURCE_EXTENSIONS);
    if (candidates.length === 0) return null;
    for (const path of candidates.slice(0, DETECT_SNIFF_FILES)) {
      const head = files.head(path, DETECT_SNIFF_BYTES);
      if (!head || looksBinary(head)) continue;
      if (POU_KEYWORD.test(decodeText(head, { fallback: 'replace' }).text)) {
        return { capabilityId: IMPORTER_ID, confidence: 0.9, reason: `${path} declares an IEC 61131-3 POU` };
      }
    }
    return { capabilityId: IMPORTER_ID, confidence: 0.3, reason: `found ${candidates.length} .plc/.st file(s) without a recognisable POU header` };
  },

  import({ files, options }, ctx): ImportResult {
    ctx.throwIfAborted();
    const diagnostics: ImporterDiagnostic[] = [];
    const sources: Record<string, string> = {};
    const preservation: Record<string, string> = {};
    const usedOutputPaths = new Set<string>();
    /** Lower-cased sidecar path -> the sidecar and the input file that produced it. */
    const sidecarOwners = new Map<string, { path: string; source: string }>();
    let lostSidecars = 0;
    /**
     * Source files with real text that could not be written (unportable or colliding output
     * path). Binary and empty inputs are skipped instead: they hold no program logic. A lost
     * source fails the whole import, like a lost sidecar, so a "succeeded" archive never
     * silently misses a program.
     */
    let lostSources = 0;
    let apply = true;
    if (options.apply !== undefined) {
      if (typeof options.apply === 'boolean') apply = options.apply;
      else diagnostics.push(diagnostic('WORMHOLE_IEC_INVALID_OPTION', 'warning', 'Option "apply" must be a boolean; using true.'));
    }

    const paths = files.pathsWithExtension(...SOURCE_EXTENSIONS);
    let changedFiles = 0;
    let skippedFiles = 0;
    if (paths.length === 0) {
      diagnostics.push(diagnostic('WORMHOLE_IEC_NO_SOURCES', 'error', 'The input contains no .plc or .st files.'));
    }

    for (const rawPath of paths) {
      ctx.throwIfAborted();
      const bytes = files.read(rawPath) ?? new Uint8Array(0);
      // Every name this importer builds or compares (output path, sidecar path, collision
      // keys, diagnostics) uses the NFC form, the same form checkRelativePath and the archive
      // builder use. The SDK's tree already normalises, but a tree from another SDK copy may
      // not, and a raw NFD name (macOS) used to fail as an "unusable path" (wormhole#9).
      const path = rawPath.normalize('NFC');
      if (bytes.byteLength === 0) {
        diagnostics.push(diagnostic('WORMHOLE_IEC_EMPTY_SOURCE', 'warning', `${path} is empty and was skipped.`, path));
        skippedFiles += 1;
        continue;
      }
      if (looksBinary(bytes)) {
        diagnostics.push(diagnostic('WORMHOLE_IEC_BINARY_INPUT', 'error', `${path} is binary, not IEC 61131-3 source text, and was skipped.`, path));
        skippedFiles += 1;
        continue;
      }
      const outputPath = `sources/${stripSourceExtension(path)}.plc`;
      const portable = checkRelativePath(outputPath, { portable: true });
      if (!portable.ok) {
        diagnostics.push(diagnostic('WORMHOLE_IEC_UNPORTABLE_PATH', 'error', `${path} cannot be written as ${outputPath}: ${portable.reason}; the import was stopped so its logic is not lost.`, path));
        lostSources += 1;
        continue;
      }
      if (usedOutputPaths.has(outputPath.toLowerCase())) {
        diagnostics.push(diagnostic('WORMHOLE_IEC_OUTPUT_COLLISION', 'error', `${path} would overwrite another file's output ${outputPath}; the import was stopped so neither program is lost. Rename one of them.`, path));
        lostSources += 1;
        continue;
      }

      const decoded = decodeText(bytes);
      if (decoded.encoding === 'windows-1252') {
        diagnostics.push(diagnostic('WORMHOLE_IEC_ENCODING_GUESSED', 'warning', `${path} is not valid UTF-8; decoded as Windows-1252. Check non-ASCII characters in comments and strings.`, path));
      } else if (decoded.lossy) {
        diagnostics.push(diagnostic('WORMHOLE_IEC_ENCODING_LOSSY', 'warning', `${path} has bytes invalid in ${decoded.encoding}; they were replaced with U+FFFD.`, path));
      }
      const newlines = normalizeNewlines(decoded.text);
      if (newlines.changed) {
        diagnostics.push(diagnostic('WORMHOLE_IEC_LINE_ENDINGS_NORMALIZED', 'info', `${path}: CRLF/CR line endings were converted to LF.`, path));
      }
      if (!POU_KEYWORD.test(newlines.text)) {
        diagnostics.push(diagnostic('WORMHOLE_IEC_NO_POU', 'warning', `${path} declares no PROGRAM, FUNCTION_BLOCK, FUNCTION, TYPE or CONFIGURATION.`, path));
      }

      const upgraded = ctx.migrate.upgradeSource(newlines.text, {
        sourceKind: inferSourceKind(path),
        fileName: path,
        apply,
      });
      usedOutputPaths.add(outputPath.toLowerCase());
      sources[outputPath] = upgraded.source;
      if (upgraded.changed) changedFiles += 1;
      diagnostics.push(...upgraded.diagnostics);
      // By the time a sidecar exists, the IL body in `upgraded.source` has (with apply) been
      // replaced by a placeholder, so the sidecar is the only copy of that logic. Dropping one
      // would emit a "succeeded" archive that silently loses a program, so any sidecar we
      // cannot keep fails the whole import below. Sidecar names come from the full relative
      // path (see ilSidecarPath in @wormhole/migrate), so for inputs that passed the output
      // collision check above this is defensive; it still guards custom rule sets.
      for (const [sidecarPath, content] of Object.entries(upgraded.preservation)) {
        const sidecar = checkRelativePath(sidecarPath, { portable: true });
        // Case-insensitive, matching buildImporterArchive: `A.txt` and `a.txt` overwrite each
        // other when the archive is extracted on Windows or default macOS filesystems.
        const collisionKey = sidecarPath.toLowerCase();
        const previous = sidecarOwners.get(collisionKey);
        if (!sidecar.ok || sidecar.path !== sidecarPath) {
          lostSidecars += 1;
          diagnostics.push(diagnostic('WORMHOLE_IEC_UNPORTABLE_PATH', 'error', `Preservation sidecar ${JSON.stringify(sidecarPath)} for ${path} has an unusable path; the import was stopped so its IL is not lost.`, path));
        } else if (previous !== undefined) {
          lostSidecars += 1;
          diagnostics.push(diagnostic('WORMHOLE_IEC_PRESERVATION_COLLISION', 'error', `${sidecarPath} (from ${path}) collides with ${previous.path} (from ${previous.source}); the import was stopped so neither file's IL is lost.`, path));
        } else {
          sidecarOwners.set(collisionKey, { path: sidecarPath, source: path });
          preservation[sidecarPath] = content;
        }
      }
      ctx.logger.debug('upgraded file', { path, changed: upgraded.changed, diagnostics: upgraded.diagnostics.length });
    }

    if (lostSidecars > 0 || lostSources > 0) {
      // Returning no sources makes ImporterHost fail the run (NO_SOURCES) with these
      // diagnostics, instead of building an archive that is missing program logic.
      const lost = [
        ...(lostSources > 0 ? [`${lostSources} source file(s) could not be written`] : []),
        ...(lostSidecars > 0 ? [`${lostSidecars} IL preservation sidecar(s) could not be written`] : []),
      ];
      return {
        sources: {},
        diagnostics,
        unsupportedSemantics: unsupportedSemanticsFrom(diagnostics),
        summary: {
          message: `Project not imported: ${lost.join(' and ')}, so their program logic would have been lost.`,
          stats: {
            filesFound: paths.length,
            filesUpgraded: 0,
            filesChanged: 0,
            filesSkipped: paths.length,
            preservationSidecars: 0,
            preservationSidecarsLost: lostSidecars,
            sourcesLost: lostSources,
          },
        },
      };
    }

    const upgradedFiles = Object.keys(sources).length;
    const sidecars = Object.keys(preservation).length;
    return {
      sources,
      diagnostics,
      ...(sidecars > 0 ? { preservation } : {}),
      unsupportedSemantics: unsupportedSemanticsFrom(diagnostics),
      summary: {
        message:
          paths.length === 0
            ? 'No IEC 61131-3 source files found.'
            : `Upgraded ${upgradedFiles} of ${paths.length} IEC 61131-3 file(s); ${changedFiles} changed, ${skippedFiles} skipped, ${sidecars} preservation sidecar(s).`,
        stats: {
          filesFound: paths.length,
          filesUpgraded: upgradedFiles,
          filesChanged: changedFiles,
          filesSkipped: skippedFiles,
          preservationSidecars: sidecars,
        },
      },
    };
  },
});

export default iec61131UpgradeImporter;
