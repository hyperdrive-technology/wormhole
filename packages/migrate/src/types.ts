import type { ImporterDiagnostic } from '@wormhole/contract';

export interface UpgradeOptions {
  sourceKind: 'plc' | 'st';
  fileName: string;
  /** When false, emit diagnostics without mutating source text. */
  apply: boolean;
}

export interface UpgradeRuleResult {
  source: string;
  changed: boolean;
  diagnostics: ImporterDiagnostic[];
  preservation: Record<string, string>;
}

export interface UpgradeRule {
  id: string;
  tier: 'A' | 'B' | 'C' | 'D';
  run: (source: string, options: UpgradeOptions) => UpgradeRuleResult;
}

export interface UpgradeResult {
  source: string;
  changed: boolean;
  diagnostics: ImporterDiagnostic[];
  preservation: Record<string, string>;
}

export function mergeUpgradeResults(
  initialSource: string,
  ruleResults: UpgradeRuleResult[],
): UpgradeResult {
  let source = initialSource;
  let changed = false;
  const diagnostics: ImporterDiagnostic[] = [];
  const preservation: Record<string, string> = {};

  for (const result of ruleResults) {
    source = result.source;
    changed ||= result.changed;
    diagnostics.push(...result.diagnostics);
    Object.assign(preservation, result.preservation);
  }

  return { source, changed, diagnostics, preservation };
}

export function diagnostic(
  code: string,
  message: string,
  severity: ImporterDiagnostic['severity'],
  options: UpgradeOptions,
  details?: string,
  startLine?: number,
): ImporterDiagnostic {
  return {
    code,
    message,
    severity,
    ...(details ? { details } : {}),
    source: {
      path: options.fileName,
      ...(startLine ? { startLine } : {}),
    },
  };
}

export function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}
