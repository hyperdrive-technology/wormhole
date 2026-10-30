import type { ImporterDiagnostic } from '@wormhole/contract';
import { truncToTyped } from '../migration-helpers.js';
import { findCallSites, spliceRanges } from '../scan.js';
import {
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../types.js';

/**
 * `TRUNC(<operand>)` call sites: what `/\bTRUNC\s*\(\s*([^)]+?)\s*\)/gi` matches (at least
 * one character before the first `)`), found in linear time (wormhole#5).
 */
function untypedTruncCalls(source: string, options: UpgradeOptions) {
  return findCallSites(
    source,
    (site) => site.name.toUpperCase() === 'TRUNC' && site.close > site.argsStart,
    options.checkpoint,
  );
}

export const truncTypedRule: UpgradeRule = {
  id: 'trunc-to-typed',
  tier: 'A',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    const edits: Array<{ start: number; end: number; text: string }> = [];

    for (const site of untypedTruncCalls(source, options)) {
      const converted = truncToTyped(site.text);
      if (!converted) continue;
      if (options.apply) {
        edits.push({ start: site.start, end: site.close + 1, text: converted.typedCall });
        diagnostics.push(
          diagnostic(
            'WORMHOLE_TRUNC_TYPED',
            `Replaced deleted TRUNC overload with ${converted.typedCall}`,
            'info',
            options,
            `Target type default: ${converted.targetType}`,
            lineNumberAt(source, site.start),
          ),
        );
      } else {
        diagnostics.push(
          diagnostic(
            'WORMHOLE_TRUNC_TYPED',
            `Untyped TRUNC should become ${converted.typedCall}`,
            'warning',
            options,
            undefined,
            lineNumberAt(source, site.start),
          ),
        );
      }
    }

    return { source: spliceRanges(source, edits), changed: edits.length > 0, diagnostics, preservation: {} };
  },
};
