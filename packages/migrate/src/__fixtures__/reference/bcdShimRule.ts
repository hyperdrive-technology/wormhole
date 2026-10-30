import type { ImporterDiagnostic } from '@wormhole/contract';
import { bcdMigrationShim } from '../../migration-helpers.js';
import {
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../../types.js';

const BCD_CALL =
  /\b((?:IS_VALID_BCD)|(?:[A-Z][A-Z0-9_]*_BCD_TO_[A-Z][A-Z0-9_]*)|(?:[A-Z][A-Z0-9_]*_TO_BCD))\s*\([^)]*\)/gi;

export const bcdShimRule: UpgradeRule = {
  id: 'bcd-shim',
  tier: 'A',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    let changed = false;
    let next = source;
    let headerNeeded = false;

    if (options.apply) {
      next = source.replace(BCD_CALL, (match, _name, offset) => {
        const converted = bcdMigrationShim(match);
        if (!converted) return match;
        changed = true;
        headerNeeded = true;
        diagnostics.push(
          diagnostic(
            'WORMHOLE_BCD_SHIM',
            `Routed deprecated BCD helper ${converted.helperName} through ${converted.shimCall}`,
            'info',
            options,
            converted.note,
            lineNumberAt(source, offset),
          ),
        );
        return converted.shimCall;
      });

      if (headerNeeded && !next.includes('HD_BCD migration shim')) {
        next = `(* HD_BCD migration shim: replace with domain logic or explicit import before canonical export. *)\n${next}`;
      }
    } else {
      for (const match of source.matchAll(BCD_CALL)) {
        const converted = bcdMigrationShim(match[0]);
        if (!converted) continue;
        diagnostics.push(
          diagnostic(
            'WORMHOLE_BCD_SHIM',
            `Deprecated BCD helper ${converted.helperName} should route through ${converted.shimCall}`,
            'warning',
            options,
            converted.note,
            lineNumberAt(source, match.index ?? 0),
          ),
        );
      }
    }

    return { source: next, changed, diagnostics, preservation: {} };
  },
};
