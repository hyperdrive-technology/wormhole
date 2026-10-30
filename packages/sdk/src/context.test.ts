import { describe, expect, it } from 'vitest';

import { createImportContext } from './context.js';
import type { LogEntry } from './importer.js';

describe('createImportContext', () => {
  it('exposes resolved limits, the migrate toolkit and the remaining time', () => {
    let now = 1_000;
    const handle = createImportContext({ limits: { maxWallTimeMs: 500 }, clock: () => now });
    expect(handle.context.limits.maxWallTimeMs).toBe(500);
    expect(handle.context.limits.maxInputFiles).toBe(10_000);
    expect(handle.context.migrate.defaultRules.length).toBeGreaterThan(0);
    expect(handle.context.remainingMs()).toBe(500);
    now = 1_300;
    expect(handle.context.remainingMs()).toBe(200);
    now = 9_999;
    expect(handle.context.remainingMs()).toBe(0);
    handle.dispose();
  });

  it('throwIfAborted throws a TimeoutError once the clock passes the deadline', () => {
    let now = 0;
    const handle = createImportContext({ limits: { maxWallTimeMs: 100 }, clock: () => now });
    expect(() => handle.context.throwIfAborted()).not.toThrow();
    now = 101;
    expect(() => handle.context.throwIfAborted()).toThrow(expect.objectContaining({ name: 'TimeoutError' }));
    expect(handle.timedOut()).toBe(true);
    expect(handle.context.signal.aborted).toBe(true);
    handle.dispose();
  });

  // wormhole#5: ctx.migrate.upgradeSource is synchronous, so only a checkpoint inside it can
  // stop a long upgrade at the wall-time limit.
  it('stops ctx.migrate.upgradeSource part-way once the deadline passes', () => {
    let now = 0;
    const handle = createImportContext({ limits: { maxWallTimeMs: 100 }, clock: () => now });
    const source = 'PROGRAM a\nLD x\nEND_PROGRAM\n'.repeat(1_000);
    let ownCheckpoints = 0;
    const run = () =>
      handle.context.migrate.upgradeSource(source, {
        sourceKind: 'st',
        fileName: 'a.st',
        apply: true,
        checkpoint: () => {
          ownCheckpoints += 1;
          if (ownCheckpoints === 20) now = 101;
        },
      });
    expect(run).toThrow(expect.objectContaining({ name: 'TimeoutError' }));
    // Stopped at the first checkpoint after the deadline, not after all 1,000 POUs.
    expect(ownCheckpoints).toBe(20);
    expect(handle.timedOut()).toBe(true);
    handle.dispose();
  });

  it('forwards an external abort with its reason', () => {
    const controller = new AbortController();
    const handle = createImportContext({ signal: controller.signal });
    const reason = new Error('user cancelled');
    controller.abort(reason);
    expect(handle.context.signal.reason).toBe(reason);
    expect(() => handle.context.throwIfAborted()).toThrow(reason);
    expect(handle.timedOut()).toBe(false);
    handle.dispose();
  });

  it('starts aborted when the external signal already is', () => {
    const controller = new AbortController();
    controller.abort('stop');
    const handle = createImportContext({ signal: controller.signal });
    expect(handle.context.signal.aborted).toBe(true);
    expect(handle.context.signal.reason).toBe('stop');
    handle.dispose();
  });

  it('fires the wall-time limit from a real timer', async () => {
    const handle = createImportContext({ limits: { maxWallTimeMs: 10 } });
    await new Promise((resolve) => handle.context.signal.addEventListener('abort', resolve, { once: true }));
    expect(handle.timedOut()).toBe(true);
    handle.dispose();
  });

  it('stops listening to the external signal after dispose', () => {
    const controller = new AbortController();
    const handle = createImportContext({ signal: controller.signal });
    handle.dispose();
    controller.abort();
    expect(handle.context.signal.aborted).toBe(false);
  });

  it('logs structured entries with elapsed time', () => {
    let now = 50;
    const entries: LogEntry[] = [];
    const handle = createImportContext({ clock: () => now, onLog: (entry) => entries.push(entry) });
    now = 75;
    handle.context.logger.warn('slow file', { path: 'a.st', bytes: 10, ok: false, note: null });
    handle.context.logger.debug('no fields');
    expect(entries).toEqual([
      { level: 'warn', message: 'slow file', fields: { path: 'a.st', bytes: 10, ok: false, note: null }, elapsedMs: 25 },
      { level: 'debug', message: 'no fields', elapsedMs: 25 },
    ]);
    handle.dispose();
  });

  it('is frozen so importers cannot swap out its members', () => {
    const handle = createImportContext();
    expect(Object.isFrozen(handle.context)).toBe(true);
    expect(Object.isFrozen(handle.context.logger)).toBe(true);
    expect(Object.isFrozen(handle.context.migrate)).toBe(true);
    handle.dispose();
  });

  it('rejects invalid limits', () => {
    expect(() => createImportContext({ limits: { maxWallTimeMs: 0 } })).toThrow(RangeError);
  });
});
