import type { ImporterDiagnostic } from '@wormhole/contract';
import { truncToTyped } from '../migration-helpers.js';
import {
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../types.js';

const UNtypedTruncCall = /\bTRUNC\s*\(\s*([^)]+?)\s*\)/gi;

export const truncTypedRule: UpgradeRule = {
  id: 'trunc-to-typed',
  tier: 'A',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    let changed = false;
    let next = source;

    if (options.apply) {
      next = source.replace(UNtypedTruncCall, (match, _operand, offset) => {
        const converted = truncToTyped(match);
        if (!converted) return match;
        changed = true;
        diagnostics.push(
          diagnostic(
            'WORMHOLE_TRUNC_TYPED',
            `Replaced deleted TRUNC overload with ${converted.typedCall}`,
            'info',
            options,
            `Target type default: ${converted.targetType}`,
            lineNumberAt(source, offset),
          ),
        );
        return converted.typedCall;
      });
    } else {
      for (const match of source.matchAll(UNtypedTruncCall)) {
        const converted = truncToTyped(match[0]);
        if (!converted) continue;
        diagnostics.push(
          diagnostic(
            'WORMHOLE_TRUNC_TYPED',
            `Untyped TRUNC should become ${converted.typedCall}`,
            'warning',
            options,
            undefined,
            lineNumberAt(source, match.index ?? 0),
          ),
        );
      }
    }

    return { source: next, changed, diagnostics, preservation: {} };
  },
};
