import type { ImporterDiagnostic } from '@wormhole/contract';

import { lineNumberAt as cachedLineNumberAt } from './scan.js';

export interface UpgradeOptions {
  sourceKind: 'plc' | 'st';
  fileName: string;
  /** When false, emit diagnostics without mutating source text. */
  apply: boolean;
  /**
   * Called between rules and regularly inside long scans. Throw from it to stop the upgrade:
   * `upgradeSource` is synchronous, so this is the only way a wall-time limit or an abort can
   * interrupt it (wormhole#5). `ImportContext.migrate` passes `ctx.throwIfAborted`.
   */
  checkpoint?: () => void;
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
  fileName?: string,
): UpgradeResult {
  let source = initialSource;
  let changed = false;
  const diagnostics: ImporterDiagnostic[] = [];
  const preservation = new PreservationMerger(fileName);

  for (const result of ruleResults) {
    source = result.source;
    changed ||= result.changed;
    diagnostics.push(...result.diagnostics);
    diagnostics.push(...preservation.add(result.preservation));
  }

  return { source, changed, diagnostics, preservation: preservation.entries };
}

/**
 * Collects rule sidecars without letting one replace another (wormhole#4). A sidecar holds
 * logic a rule moved out of the source (IL bodies replaced by placeholders), so silently
 * overwriting one loses that logic. Keys are compared NFC-normalised and case-folded, the
 * same way the archive builder detects collisions, and a colliding sidecar is kept under
 * `<name>.collision-<n><ext>` with a warning instead.
 */
export class PreservationMerger {
  readonly entries: Record<string, string> = {};
  readonly #taken = new Set<string>();
  readonly #fileName: string | undefined;

  constructor(fileName?: string) {
    this.#fileName = fileName;
  }

  /** Adds every sidecar in `preservation`; returns a warning for each one that was renamed. */
  add(preservation: Record<string, string>): ImporterDiagnostic[] {
    const warnings: ImporterDiagnostic[] = [];
    for (const [path, content] of Object.entries(preservation)) {
      let kept = path;
      for (let attempt = 2; this.#taken.has(collisionKey(kept)); attempt += 1) {
        kept = withCollisionSuffix(path, attempt);
      }
      this.#taken.add(collisionKey(kept));
      this.entries[kept] = content;
      if (kept !== path) {
        warnings.push({
          code: 'WORMHOLE_PRESERVATION_COLLISION',
          message: `Two upgrade rules produced the preservation sidecar ${path}; the later one was kept as ${kept} so neither is lost.`,
          severity: 'warning',
          details: 'Sidecar paths are compared case-insensitively after NFC normalisation, like archive entries.',
          ...(this.#fileName !== undefined ? { source: { path: this.#fileName } } : {}),
        });
      }
    }
    return warnings;
  }
}

function collisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * `dir/name.ext.ext2` -> `dir/name.collision-<n>.ext.ext2`. The suffix goes before the first
 * dot of the last segment (ignoring a leading dot) so `x.il.txt` keeps its `.il.txt`.
 */
function withCollisionSuffix(path: string, attempt: number): string {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.indexOf('.', 1);
  const stem = dot === -1 ? base : base.slice(0, dot);
  const ext = dot === -1 ? '' : base.slice(dot);
  return `${dir}${stem}.collision-${attempt}${ext}`;
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

/**
 * 1-based line of `index`: `source.slice(0, index).split('\n').length`, but amortised
 * O(log lines) per call, so a rule that reports a diagnostic per match stays linear (wormhole#5).
 */
export function lineNumberAt(source: string, index: number): number {
  return cachedLineNumberAt(source, index);
}

/**
 * Wraps `options.checkpoint` so a loop can call it on every step but it only runs every
 * `every` steps (checkpoints read the clock, which is not free).
 */
export function checkpointEvery(options: UpgradeOptions, every = 1024): () => void {
  const checkpoint = options.checkpoint;
  if (!checkpoint) return () => {};
  let steps = 0;
  return () => {
    if (++steps % every === 0) checkpoint();
  };
}
