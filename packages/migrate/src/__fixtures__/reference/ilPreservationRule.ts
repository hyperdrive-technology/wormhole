import type { ImporterDiagnostic } from '@wormhole/contract';
import { ilPreservationSidecar } from '../../migration-helpers.js';
import {
  diagnostic,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../../types.js';

const IL_INSTRUCTION = /^\s*(?:LD|LDN|ST|STN|AND|ANDN|OR|ORN|XOR|XORN|NOT|ADD|SUB|MUL|DIV|MOD|GT|GE|EQ|NE|LE|LT|JMP|JMPC|CAL|RET|S|R)\b/im;
const POU_BODY = /((?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+[A-Za-z_][A-Za-z0-9_]*[\s\S]*?)(END_(?:PROGRAM|FUNCTION_BLOCK|FUNCTION))/gi;

function extractIlBody(pouBody: string): string | undefined {
  const lines = pouBody.split('\n');
  const ilLines = lines.filter((line) => IL_INSTRUCTION.test(line));
  if (ilLines.length === 0) return undefined;
  return ilLines.join('\n').trim();
}

function pouNameFromHeader(header: string): string {
  const match = header.match(/(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  return match?.[1] ?? 'LegacyPou';
}

export const ilPreservationRule: UpgradeRule = {
  id: 'il-preservation',
  tier: 'C',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    const preservation: Record<string, string> = {};
    let changed = false;
    let next = source;
    const pouOccurrences = new Map<string, number>();

    next = source.replace(POU_BODY, (full, bodyPrefix: string, endKeyword: string, offset) => {
      const ilBody = extractIlBody(bodyPrefix);
      if (!ilBody) return full;

      const pouName = pouNameFromHeader(bodyPrefix);
      const sidecar = ilPreservationSidecar(ilBody, pouName);
      // IEC identifiers are case-insensitive, so `Dup` and `DUP` in one file are the same POU
      // declared twice (invalid, but legacy input does it). Number the repeats instead of
      // letting the second body overwrite the first.
      const pouKey = pouName.toLowerCase();
      const occurrence = (pouOccurrences.get(pouKey) ?? 0) + 1;
      pouOccurrences.set(pouKey, occurrence);
      const preservationPath = ilSidecarPath(options.fileName, pouName, occurrence);
      const startLine = lineNumberAt(source, offset);

      if (occurrence > 1) {
        diagnostics.push(
          diagnostic(
            'WORMHOLE_IL_DUPLICATE_POU',
            `${pouName} is declared more than once in this file; this copy's IL was preserved at ${preservationPath}`,
            'warning',
            options,
            'IEC 61131-3 POU names are case-insensitive and must be unique; rename or remove the duplicate.',
            startLine,
          ),
        );
      }

      preservation[preservationPath] = sidecar.preservationBlob;

      diagnostics.push(
        diagnostic(
          'WORMHOLE_IL_PRESERVATION',
          `Preserved native IL for ${pouName} at ${preservationPath}`,
          'warning',
          options,
          'Replace ST placeholder with migrated logic before canonical export.',
          startLine,
        ),
      );

      if (!options.apply) {
        return full;
      }

      changed = true;
      const headerEnd = bodyPrefix.search(/END_VAR\s*\n/i);
      const insertionPoint = headerEnd >= 0 ? headerEnd + 'END_VAR'.length + 1 : bodyPrefix.length;
      const preservedPrefix = bodyPrefix.slice(0, insertionPoint);
      const migratedBody = `${preservedPrefix}\n${sidecar.stPlaceholder}\n`;
      return `${migratedBody}${endKeyword}`;
    });

    return { source: next, changed, diagnostics, preservation };
  },
};

/**
 * The source's relative path without its `.plc`/`.st` extension, NFC-normalised, with `/`
 * separators and no empty, `.` or `..` segments: `x\\main.st` -> `x/main`. Using the whole path (not just
 * the base name) is what keeps `x/main.st` and `y/main.st` from sharing a sidecar, the same
 * way `sources/x/main.plc` and `sources/y/main.plc` stay apart.
 */
export function ilSidecarStem(fileName: string): string {
  // NFC, like checkRelativePath and the archive builder: macOS hands out decomposed (NFD)
  // names, and a sidecar named from the raw form would not match its own normalised path
  // (wormhole#9).
  const segments = fileName.normalize('NFC').split(/[/\\]+/).filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return segments.join('/').replace(/\.(plc|st)$/i, '') || 'source';
}

/**
 * `preservation/il/<stem>-<POU>[-<n>].il.txt`. Collision-free for distinct (case-insensitive)
 * source stems: POU names are identifiers (no `-`, never starting with a digit), so the last
 * `-<identifier>` and the optional `-<n>` repeat counter are unambiguous.
 */
export function ilSidecarPath(fileName: string, pouName: string, occurrence = 1): string {
  const repeat = occurrence > 1 ? `-${occurrence}` : '';
  return `preservation/il/${ilSidecarStem(fileName)}-${pouName}${repeat}.il.txt`;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}
