import type { ImporterDiagnostic } from '@wormhole/contract';
import { matchAllInCode, replaceInCode } from './lexical.js';
import { octalToHexLiteral } from '../../migration-helpers.js';
import {
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../../types.js';

const OCTAL_TOKEN = /\b8#([0-9_]+)\b/gi;

export const octalLiteralRule: UpgradeRule = {
  id: 'octal-to-hex',
  tier: 'A',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    let changed = false;
    let next = source;

    if (options.apply) {
      // Only code is rewritten: `8#17` inside a comment, string literal or pragma is text.
      next = replaceInCode(source, OCTAL_TOKEN, (match, _groups, offset) => {
        const converted = octalToHexLiteral(match);
        if (!converted) return match;
        changed = true;
        diagnostics.push(
          diagnostic(
            'WORMHOLE_OCTAL_TO_HEX',
            `Replaced deleted octal literal ${converted.original} with ${converted.hexLiteral}`,
            'info',
            options,
            undefined,
            lineNumberAt(source, offset),
          ),
        );
        return converted.hexLiteral;
      });
    } else {
      for (const match of matchAllInCode(source, OCTAL_TOKEN)) {
        const converted = octalToHexLiteral(match.match);
        if (!converted) continue;
        diagnostics.push(
          diagnostic(
            'WORMHOLE_OCTAL_TO_HEX',
            `Octal literal ${converted.original} should become ${converted.hexLiteral}`,
            'warning',
            options,
            undefined,
            lineNumberAt(source, match.offset),
          ),
        );
      }
    }

    return { source: next, changed, diagnostics, preservation: {} };
  },
};
