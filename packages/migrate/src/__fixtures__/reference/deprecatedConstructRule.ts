import type { ImporterDiagnostic } from '@wormhole/contract';
import {
  actionBlockIndicatorMigration,
  fbTaskWithMigration,
  graphicalActionBlockMigration,
  graphicalEdgeDeclarationMigration,
} from '../../migration-helpers.js';
import {
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../../types.js';

const VAR_ACCESS = /\bVAR_ACCESS\b/gi;
const VAR_GLOBAL_IN_PROGRAM = /PROGRAM[\s\S]*?\bVAR_GLOBAL\b/gi;
const FB_WITH = /\b([A-Za-z_][A-Za-z0-9_]*)\s+WITH\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gi;
const GRAPHICAL_EDGE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*BOOL\s+(R_EDGE|F_EDGE)\b/gi;
const ACTION_BLOCK_XML = /<actionBlock\b[^>]*referenceName="([^"]+)"/gi;
const ACTION_INDICATOR = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;

export const deprecatedConstructRule: UpgradeRule = {
  id: 'deprecated-construct-hints',
  tier: 'D',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];

    for (const match of source.matchAll(VAR_ACCESS)) {
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

    for (const match of source.matchAll(VAR_GLOBAL_IN_PROGRAM)) {
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_VAR_GLOBAL',
          'VAR_GLOBAL inside PROGRAM is deprecated; hoist globals to configuration/resource scope.',
          'warning',
          options,
          undefined,
          lineNumberAt(source, match.index ?? 0),
        ),
      );
    }

    for (const match of source.matchAll(FB_WITH)) {
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

    for (const match of source.matchAll(ACTION_BLOCK_XML)) {
      const action = match[1] ?? 'Action';
      const hint = graphicalActionBlockMigration(action);
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_ACTION_BLOCK',
          hint.recommendation,
          'warning',
          options,
          hint.example,
          lineNumberAt(source, match.index ?? 0),
        ),
      );
    }

    for (const match of source.matchAll(ACTION_INDICATOR)) {
      const action = match[1] ?? 'Action';
      const indicator = match[2] ?? 'Done';
      const hint = actionBlockIndicatorMigration(action, indicator);
      diagnostics.push(
        diagnostic(
          'WORMHOLE_DEPRECATED_ACTION_INDICATOR',
          hint.recommendation,
          'warning',
          options,
          hint.example,
          lineNumberAt(source, match.index ?? 0),
        ),
      );
    }

    return { source, changed: false, diagnostics, preservation: {} };
  },
};
