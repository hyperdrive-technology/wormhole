import type { ImporterDiagnostic } from '@wormhole/contract';
import {
  actionBlockIndicatorMigration,
  fbTaskWithMigration,
  graphicalActionBlockMigration,
  graphicalEdgeDeclarationMigration,
} from '../migration-helpers.js';
import { findCallSites, ForwardIndexOf, ForwardSearch, LastIndexBefore } from '../scan.js';
import {
  checkpointEvery,
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../types.js';

const VAR_ACCESS = /\bVAR_ACCESS\b/gi;
const FB_WITH = /\b([A-Za-z_][A-Za-z0-9_]*)\s+WITH\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gi;
const GRAPHICAL_EDGE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*BOOL\s+(R_EDGE|F_EDGE)\b/gi;
const ACTION_INDICATOR_TAIL = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/**
 * Offsets of every `PROGRAM` that `/PROGRAM[\s\S]*?\bVAR_GLOBAL\b/gi` would match: the `PROGRAM`
 * is reported if a `VAR_GLOBAL` word follows it, and the scan resumes after that `VAR_GLOBAL`.
 * The lazy regex rescanned to the end for every `PROGRAM` with no `VAR_GLOBAL` after it,
 * O(n^2) (wormhole#5); the `VAR_GLOBAL` search here is forward-only and cached.
 */
function varGlobalInProgram(source: string, step: () => void): number[] {
  const found: number[] = [];
  const program = /PROGRAM/gi;
  const varGlobal = new ForwardSearch(source, /\bVAR_GLOBAL\b/gi);
  for (let match = program.exec(source); match !== null; match = program.exec(source)) {
    step();
    const global = varGlobal.from(match.index + match[0].length);
    if (global === null) break;
    found.push(match.index);
    program.lastIndex = global.index + global[0].length;
  }
  return found;
}

/**
 * What `/<actionBlock\b[^>]*referenceName="([^"]+)"/gi` matches, in linear time. For each
 * `<actionBlock` head, `[^>]*` reaches the first `>` and then backtracks, so the match uses the
 * *last* `referenceName="` before that `>` whose value is non-empty and closed (the value may run
 * past the `>`). Candidates are found once up front and picked by binary search, instead of the
 * regex rescanning to the next `>` (or the end) for every head (wormhole#5).
 */
function actionBlockReferences(source: string, step: () => void): Array<{ index: number; name: string }> {
  const LITERAL = 'referenceName="';
  const lastQuote = source.lastIndexOf('"');
  const candidates: number[] = [];
  const literal = /referenceName="/gi;
  for (let match = literal.exec(source); match !== null; match = literal.exec(source)) {
    step();
    const valueStart = match.index + LITERAL.length;
    if (valueStart < source.length && source[valueStart] !== '"' && lastQuote > valueStart) {
      candidates.push(match.index);
    }
  }

  const found: Array<{ index: number; name: string }> = [];
  const head = /<actionBlock\b/gi;
  const closeAngle = new ForwardIndexOf(source, '>');
  const quote = new ForwardIndexOf(source, '"');
  for (let match = head.exec(source); match !== null; match = head.exec(source)) {
    step();
    const regionStart = head.lastIndex;
    const angle = closeAngle.from(regionStart);
    const regionEnd = angle === -1 ? source.length : angle;
    const candidate = lastBelow(candidates, regionEnd);
    if (candidate === undefined || candidate < regionStart) continue;
    const valueStart = candidate + LITERAL.length;
    const valueEnd = quote.from(valueStart);
    found.push({ index: match.index, name: source.slice(valueStart, valueEnd) });
    head.lastIndex = valueEnd + 1;
  }
  return found;
}

/** The largest value in sorted `values` that is below `limit`. */
function lastBelow(values: number[], limit: number): number | undefined {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((values[mid] as number) < limit) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? undefined : values[low - 1];
}

export const deprecatedConstructRule: UpgradeRule = {
  id: 'deprecated-construct-hints',
  tier: 'D',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    const step = checkpointEvery(options);

    for (const match of source.matchAll(VAR_ACCESS)) {
      step();
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_VAR_ACCESS',
          'VAR_ACCESS is deprecated in Edition 4; replace with explicit aliasing or migration metadata.',
          'warning',
          options,
          undefined,
          lineNumberAt(source, match.index ?? 0),
        ),
      );
    }

    for (const index of varGlobalInProgram(source, step)) {
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_VAR_GLOBAL',
          'VAR_GLOBAL inside PROGRAM is deprecated; hoist globals to configuration/resource scope.',
          'warning',
          options,
          undefined,
          lineNumberAt(source, index),
        ),
      );
    }

    for (const match of source.matchAll(FB_WITH)) {
      step();
      const instance = match[1] ?? 'Instance';
      const task = match[2] ?? 'Task';
      const hint = fbTaskWithMigration(instance, task);
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_FB_WITH',
          hint.recommendation,
          'warning',
          options,
          hint.example,
          lineNumberAt(source, match.index ?? 0),
        ),
      );
    }

    for (const match of source.matchAll(GRAPHICAL_EDGE)) {
      step();
      const signal = match[1] ?? 'Signal';
      const edge = (match[2] ?? 'R_EDGE') as 'R_EDGE' | 'F_EDGE';
      const hint = graphicalEdgeDeclarationMigration(signal, edge);
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_GRAPHICAL_EDGE',
          hint.recommendation,
          'warning',
          options,
          hint.example,
          lineNumberAt(source, match.index ?? 0),
        ),
      );
    }

    for (const match of actionBlockReferences(source, step)) {
      const action = match.name;
      const hint = graphicalActionBlockMigration(action);
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_ACTION_BLOCK',
          hint.recommendation,
          'warning',
          options,
          hint.example,
          lineNumberAt(source, match.index),
        ),
      );
    }

    // `/\b(ident)\s*\([^)]*,\s*(ident)\s*\)/g`: a call whose arguments end in `, <ident>`.
    // `[^)]*` is greedy, so only the text after the last comma can be the indicator. Every head
    // that shares a `)` shares that comma and tail, so both are worked out once per `)`.
    const indicators: Array<{ start: number; action: string; indicator: string }> = [];
    const lastComma = new LastIndexBefore(source, ',');
    let tailClose = -1;
    let tail: { comma: number; indicator: string | undefined } = { comma: -1, indicator: undefined };
    findCallSites(
      source,
      (site) => {
        if (site.close !== tailClose) {
          tailClose = site.close;
          const comma = lastComma.before(site.close);
          const match = comma === -1 ? null : ACTION_INDICATOR_TAIL.exec(source.slice(comma + 1, site.close));
          tail = { comma, indicator: match?.[1] };
        }
        if (tail.indicator === undefined || tail.comma < site.argsStart) return false;
        indicators.push({ start: site.start, action: site.name, indicator: tail.indicator });
        return true;
      },
      options.checkpoint,
    );
    for (const match of indicators) {
      const action = match.action;
      const indicator = match.indicator;
      const hint = actionBlockIndicatorMigration(action, indicator);
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_ACTION_INDICATOR',
          hint.recommendation,
          'warning',
          options,
          hint.example,
          lineNumberAt(source, match.start),
        ),
      );
    }

    return { source, changed: false, diagnostics, preservation: {} };
  },
};
