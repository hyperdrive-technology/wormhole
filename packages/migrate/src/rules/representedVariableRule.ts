import type { ImporterDiagnostic } from '@wormhole/contract';
import { representedVariableAlias } from '../migration-helpers.js';
import {
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../types.js';

const NAMELESS_AT = /^\s*AT\s+(%(?:[IQM][XBWDL]?|[XBWDL])(?:\*|[0-9][0-9._]*))\s*:\s*([A-Z][A-Z0-9_]*)\s*;/gim;
const DIRECT_ADDRESS = /(%(?:[IQM][XBWDL]?|[XBWDL])(?:\*|[0-9][0-9._]*))/gi;

export const representedVariableRule: UpgradeRule = {
  id: 'represented-variable-alias',
  tier: 'B',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    let changed = false;
    let next = source;
    const insertedDeclarations: string[] = [];

    for (const match of source.matchAll(NAMELESS_AT)) {
      const address = match[1];
      const dataType = match[2];
      if (!address || !dataType) continue;
      const alias = representedVariableAlias(address, dataType);
      if (!alias) continue;

      diagnostics.push(
        diagnostic(
          'WORMHOLE_NAMELESS_AT',
          `Nameless direct address ${alias.originalAddress} should use ${alias.declaration}`,
          options.apply ? 'info' : 'warning',
          options,
          undefined,
          lineNumberAt(source, match.index ?? 0),
        ),
      );

      if (options.apply) {
        next = next.replace(match[0], alias.declaration);
        changed = true;
      }
    }

    const seenAddresses = new Set<string>();
    for (const match of source.matchAll(DIRECT_ADDRESS)) {
      const address = match[0]?.toUpperCase();
      if (!address || seenAddresses.has(address)) continue;
      seenAddresses.add(address);
      const alias = representedVariableAlias(address);
      if (!alias) continue;

      if (NAMELESS_AT.test(source)) {
        NAMELESS_AT.lastIndex = 0;
      }

      if (next.includes(alias.declaration) || next.includes(`${alias.variableName} AT`)) {
        continue;
      }

      diagnostics.push(
        diagnostic(
          'WORMHOLE_DIRECT_ADDRESS',
          `Direct address ${alias.originalAddress} in body should hoist ${alias.declaration}`,
          'warning',
          options,
          'Add declaration inside VAR block and replace inline address references when feasible.',
          lineNumberAt(source, match.index ?? 0),
        ),
      );

      if (options.apply) {
        insertedDeclarations.push(alias.declaration);
      }
    }

    if (options.apply && insertedDeclarations.length > 0) {
      const unique = [...new Set(insertedDeclarations)];
      next = insertVarDeclarations(next, unique);
      changed = true;
    }

    return { source: next, changed, diagnostics, preservation: {} };
  },
};

function insertVarDeclarations(source: string, declarations: string[]): string {
  const varMatch = source.match(/\bVAR\b/i);
  if (!varMatch || varMatch.index === undefined) {
    return source;
  }

  const insertAt = varMatch.index + varMatch[0].length;
  const block = `\n  ${declarations.join('\n  ')}\n`;
  return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
}
