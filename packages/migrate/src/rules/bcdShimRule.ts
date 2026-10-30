import type { ImporterDiagnostic } from '@wormhole/contract';
import { bcdMigrationShim } from '../migration-helpers.js';
import { findCallSites, spliceRanges, type CallSite } from '../scan.js';
import {
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../types.js';

/**
 * Whether a whole identifier is a BCD helper name: `IS_VALID_BCD`, `<X>_BCD_TO_<Y>` or
 * `<X>_TO_BCD`, case-insensitive. Same set as the old
 * `\b(IS_VALID_BCD|[A-Z][A-Z0-9_]*_BCD_TO_[A-Z][A-Z0-9_]*|[A-Z][A-Z0-9_]*_TO_BCD)\s*\(`, whose
 * nested `[A-Z0-9_]*` backtracked quadratically on long identifiers (wormhole#5).
 */
function isBcdHelperName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === 'IS_VALID_BCD') return true;
  if (!/^[A-Z]/.test(upper)) return false;
  if (upper.length >= 8 && upper.endsWith('_TO_BCD')) return true;
  return /_BCD_TO_[A-Z]/.test(upper.slice(1));
}

/**
 * `bcdMigrationShim` matches its arguments with `.`, which stops at line terminators, so a
 * call whose arguments span lines is never converted. Skipping those here keeps that answer
 * without running the helper's regex (which backtracks on long names when it fails).
 */
function convertibleCall(site: CallSite): boolean {
  return !/[\n\r\u2028\u2029]/.test(site.text.slice(site.argsStart - site.start));
}

export const bcdShimRule: UpgradeRule = {
  id: 'bcd-shim',
  tier: 'A',
  run(source, options: UpgradeOptions): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const calls = findCallSites(source, (site) => isBcdHelperName(site.name), options.checkpoint);

    for (const site of calls) {
      const converted = convertibleCall(site) ? bcdMigrationShim(site.text) : undefined;
      if (!converted) continue;
      if (options.apply) {
        edits.push({ start: site.start, end: site.close + 1, text: converted.shimCall });
      }
      diagnostics.push(
        diagnostic(
          'WORMHOLE_BCD_SHIM',
          options.apply
            ? `Routed deprecated BCD helper ${converted.helperName} through ${converted.shimCall}`
            : `Deprecated BCD helper ${converted.helperName} should route through ${converted.shimCall}`,
          options.apply ? 'info' : 'warning',
          options,
          converted.note,
          lineNumberAt(source, site.start),
        ),
      );
    }

    let next = spliceRanges(source, edits);
    if (edits.length > 0 && !next.includes('HD_BCD migration shim')) {
      next = `(* HD_BCD migration shim: replace with domain logic or explicit import before canonical export. *)\n${next}`;
    }
    return { source: next, changed: edits.length > 0, diagnostics, preservation: {} };
  },
};
