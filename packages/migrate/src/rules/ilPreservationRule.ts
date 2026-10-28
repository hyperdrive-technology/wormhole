import type { ImporterDiagnostic } from '@wormhole/contract';
import { ilPreservationSidecar } from '../migration-helpers.js';
import {
  diagnostic,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../types.js';

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

    next = source.replace(POU_BODY, (full, bodyPrefix: string, endKeyword: string, offset) => {
      const ilBody = extractIlBody(bodyPrefix);
      if (!ilBody) return full;

      const pouName = pouNameFromHeader(bodyPrefix);
      const sidecar = ilPreservationSidecar(ilBody, pouName);
      const preservationPath = `preservation/il/${sanitizeFileStem(options.fileName)}-${pouName}.il.txt`;

      preservation[preservationPath] = sidecar.preservationBlob;

      diagnostics.push(
        diagnostic(
          'WORMHOLE_IL_PRESERVATION',
          `Preserved native IL for ${pouName} at ${preservationPath}`,
          'warning',
          options,
          'Replace ST placeholder with migrated logic before canonical export.',
          lineNumberAt(source, offset),
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

function sanitizeFileStem(fileName: string): string {
  return fileName.replace(/^.*[/\\]/, '').replace(/\.(plc|st)$/i, '') || 'source';
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}
