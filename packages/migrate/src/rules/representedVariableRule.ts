import type { ImporterDiagnostic } from '@wormhole/contract';
import { representedVariableAlias } from '../migration-helpers.js';
import { spliceRanges } from '../scan.js';
import {
  checkpointEvery,
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../types.js';

// Leading whitespace is `[ \t]*`, not `\s*`: with `m`, `^\s*` let a match start on a blank line
// above the declaration (so the replacement deleted those lines) and re-scanned every blank
// line for every line start, O(n^2) on a run of newlines (wormhole#5).
const NAMELESS_AT = /^[ \t]*AT\s+(%(?:[IQM][XBWDL]?|[XBWDL])(?:\*|[0-9][0-9._]*))\s*:\s*([A-Z][A-Z0-9_]*)\s*;/gim;
const DIRECT_ADDRESS = /(%(?:[IQM][XBWDL]?|[XBWDL])(?:\*|[0-9][0-9._]*))/gi;

export const representedVariableRule: UpgradeRule = {
  id: 'represented-variable-alias',
  tier: 'B',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    const checkpoint = checkpointEvery(options);
    const edits: Array<{ start: number; end: number; text: string }> = [];

    for (const match of source.matchAll(NAMELESS_AT)) {
      checkpoint();
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
          lineNumberAt(source, match.index),
        ),
      );

      // Replace this match where it is. The old `next.replace(match[0], ...)` rewrote the
      // first identical text instead, which for a repeated declaration was the alias the
      // previous iteration had just written (`Io_X Io_X AT ...`).
      if (options.apply) {
        edits.push({ start: match.index, end: match.index + match[0].length, text: alias.declaration });
      }
    }

    let next = spliceRanges(source, edits);
    let changed = edits.length > 0;
    const declared = declaredAliasNames(next);
    const insertedDeclarations: string[] = [];
    const seenAddresses = new Set<string>();
    for (const match of source.matchAll(DIRECT_ADDRESS)) {
      checkpoint();
      const address = match[0]?.toUpperCase();
      if (!address || seenAddresses.has(address)) continue;
      seenAddresses.add(address);
      const alias = representedVariableAlias(address);
      if (!alias) continue;

      // Already declared: `next` contains `<alias> AT` (which the full declaration starts with).
      if (declared.has(alias.variableName)) {
        continue;
      }

      diagnostics.push(
        diagnostic(
          'WORMHOLE_DIRECT_ADDRESS',
          `Direct address ${alias.originalAddress} in body should hoist ${alias.declaration}`,
          'warning',
          options,
          'Add declaration inside VAR block and replace inline address references when feasible.',
          lineNumberAt(source, match.index),
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

/**
 * Every generated alias name `Io_<BODY>` for which `text` contains `Io_<BODY> AT`, as a plain
 * substring (so `XIo_IX0_0 AT` counts too, as `text.includes` did). One pass instead of an
 * `includes` per distinct address, which was O(n^2) on many distinct addresses (wormhole#5).
 *
 * Generated names are `Io_` + a body of `[A-Z0-9_]` (see `representedVariableAlias`); the body
 * has no lowercase letters, so it cannot contain `Io_`. A name that ends right before ` AT`
 * therefore starts at the last `Io_` of the word in front of it, and that suffix is the only
 * candidate to record.
 */
function declaredAliasNames(text: string): Set<string> {
  const names = new Set<string>();
  for (let at = text.indexOf(' AT'); at !== -1; at = text.indexOf(' AT', at + 3)) {
    let wordStart = at;
    while (wordStart > 0 && /[A-Za-z0-9_]/.test(text[wordStart - 1] as string)) wordStart -= 1;
    // Search only this word: words in front of distinct ` AT`s do not overlap, so this stays
    // linear (a `lastIndexOf` on the whole text could rescan everything before it).
    const word = text.slice(wordStart, at);
    const prefix = word.lastIndexOf('Io_');
    if (prefix !== -1) names.add(word.slice(prefix));
  }
  return names;
}

function insertVarDeclarations(source: string, declarations: string[]): string {
  const varMatch = source.match(/\bVAR\b/i);
  if (!varMatch || varMatch.index === undefined) {
    return source;
  }

  const insertAt = varMatch.index + varMatch[0].length;
  const block = `\n  ${declarations.join('\n  ')}\n`;
  return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
}
