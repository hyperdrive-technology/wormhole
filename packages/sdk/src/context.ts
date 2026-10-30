import { DEFAULT_UPGRADE_RULES, upgradeSource, type UpgradeOptions, type UpgradeRule } from '@wormhole/migrate';

import type {
  ImportContext,
  ImporterLogger,
  LogEntry,
  LogFields,
  LogLevel,
  MigrateToolkit,
} from './importer.js';
import { resolveImportLimits, type ImportLimits } from './limits.js';

export const migrateToolkit: MigrateToolkit = Object.freeze({
  upgradeSource,
  defaultRules: Object.freeze([...DEFAULT_UPGRADE_RULES]),
});

export interface CreateImportContextOptions {
  /** External cancellation. */
  signal?: AbortSignal;
  limits?: Partial<ImportLimits>;
  /** Receives every log entry. */
  onLog?: (entry: LogEntry) => void;
  /** Millisecond clock; inject a fake one in tests. Defaults to `performance.now()`. */
  clock?: () => number;
}

/**
 * An {@link ImportContext} plus the controls its owner needs. `ImporterHost.run` creates one
 * per run; importer unit tests can create their own with {@link createImportContext}.
 */
export interface ImportContextHandle {
  readonly context: ImportContext;
  /** True once the wall-time limit fired (as opposed to an external abort). */
  timedOut(): boolean;
  /** Fires the wall-time limit if the clock has passed the deadline. */
  checkDeadline(): void;
  /** Clears the timer and listeners. Call when the run is over. */
  dispose(): void;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function createImportContext(options: CreateImportContextOptions = {}): ImportContextHandle {
  const limits = resolveImportLimits(options.limits);
  const clock = options.clock ?? (() => performance.now());
  const startedAt = clock();
  const deadline = startedAt + limits.maxWallTimeMs;
  const controller = new AbortController();
  let timedOut = false;

  const timeout = (): void => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(
      new DOMException(`Import exceeded its ${limits.maxWallTimeMs} ms wall-time limit`, 'TimeoutError'),
    );
  };
  const checkDeadline = (): void => {
    if (clock() > deadline) timeout();
  };

  const external = options.signal;
  const onExternalAbort = (): void => controller.abort(external?.reason);
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(timeout, limits.maxWallTimeMs);
  // Never keep the process alive just for this timer (a forgotten dispose() in a test
  // would otherwise delay exit by up to maxWallTimeMs).
  timer.unref?.();

  const log = (level: LogLevel, message: unknown, fields?: LogFields): void => {
    const entry: LogEntry = {
      level,
      message: typeof message === 'string' ? message : String(message),
      ...(fields !== undefined ? { fields } : {}),
      elapsedMs: clock() - startedAt,
    };
    options.onLog?.(entry);
  };
  const logger = Object.fromEntries(
    LOG_LEVELS.map((level) => [level, (message: string, fields?: LogFields) => log(level, message, fields)]),
  ) as unknown as ImporterLogger;

  const throwIfAborted = (): void => {
    checkDeadline();
    controller.signal.throwIfAborted();
  };
  // upgradeSource is synchronous and can run for a long time on a large file; the host's
  // timer cannot fire while it runs. Passing throwIfAborted as its checkpoint lets the
  // wall-time limit and caller aborts stop it part-way (wormhole#5).
  const migrate: MigrateToolkit = Object.freeze({
    upgradeSource: (content: string, upgradeOptions: UpgradeOptions, rules?: UpgradeRule[]) =>
      migrateToolkit.upgradeSource(
        content,
        {
          ...upgradeOptions,
          checkpoint: () => {
            throwIfAborted();
            upgradeOptions.checkpoint?.();
          },
        },
        rules,
      ),
    defaultRules: migrateToolkit.defaultRules,
  });

  const context: ImportContext = Object.freeze({
    signal: controller.signal,
    limits,
    logger: Object.freeze(logger),
    migrate,
    throwIfAborted,
    remainingMs: () => Math.max(0, deadline - clock()),
  });

  return {
    context,
    timedOut: () => timedOut,
    checkDeadline,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}
