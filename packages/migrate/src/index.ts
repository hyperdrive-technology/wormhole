import { bcdShimRule } from './rules/bcdShimRule.js';
import { deprecatedConstructRule } from './rules/deprecatedConstructRule.js';
import { ilPreservationRule } from './rules/ilPreservationRule.js';
import { octalLiteralRule } from './rules/octalLiteralRule.js';
import { representedVariableRule } from './rules/representedVariableRule.js';
import { truncTypedRule } from './rules/truncTypedRule.js';
import {
  PreservationMerger,
  type UpgradeOptions,
  type UpgradeResult,
  type UpgradeRule,
} from './types.js';

export const DEFAULT_UPGRADE_RULES: UpgradeRule[] = [
  octalLiteralRule,
  truncTypedRule,
  bcdShimRule,
  representedVariableRule,
  ilPreservationRule,
  deprecatedConstructRule,
];

export function upgradeSource(
  content: string,
  options: UpgradeOptions,
  rules: UpgradeRule[] = DEFAULT_UPGRADE_RULES,
): UpgradeResult {
  let source = content;
  let changed = false;
  const diagnostics: UpgradeResult['diagnostics'] = [];
  const preservation = new PreservationMerger(options.fileName);

  for (const rule of rules) {
    options.checkpoint?.();
    const result = rule.run(source, options);
    source = result.source;
    changed ||= result.changed;
    diagnostics.push(...result.diagnostics);
    diagnostics.push(...preservation.add(result.preservation));
  }

  return { source, changed, diagnostics, preservation: preservation.entries };
}

export * from './types.js';
export * from './migration-helpers.js';
export {
  bcdShimRule,
  deprecatedConstructRule,
  ilPreservationRule,
  octalLiteralRule,
  representedVariableRule,
  truncTypedRule,
};
export { matchAllInCode, replaceInCode, scanSourceSpans, type SourceSpan } from './lexical.js';
