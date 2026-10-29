import { describe, expect, it } from 'vitest';

import { TOY_CAPABILITY_ID, TOY_FIXTURES, toyImport, toyImporter, toyManifest } from '../__fixtures__/importers.js';
import type { ImportResult, WormholeImporter } from '../importer.js';
import type { ImporterManifest } from '../manifest.js';
import {
  CONFORMANCE_CHECKS,
  formatConformanceReport,
  runImporterConformance,
  type ConformanceCheckName,
  type ConformanceReport,
} from './index.js';
import { describeImporterConformance, expectImporterConformance } from './vitest.js';

const fixtures = TOY_FIXTURES.map((fixture) => ({ ...fixture, files: { ...fixture.files } }));

/** A toy importer that behaves except for `patch`, applied to every successful result. */
function patchedToy(patch: (result: ImportResult) => ImportResult): WormholeImporter {
  return toyImporter({
    import: ({ files }, ctx) => {
      const result = toyImport(files, () => ctx.throwIfAborted());
      return Object.keys(result.sources).length > 0 ? patch(result) : result;
    },
  });
}

function statusOf(report: ConformanceReport, name: ConformanceCheckName) {
  return report.checks.find((check) => check.name === name);
}

/** Runs the kit and asserts exactly which checks fail. */
async function expectFailing(importer: WormholeImporter, failing: ConformanceCheckName[], options = { fixtures }) {
  const report = await runImporterConformance(importer, options);
  const failed = report.checks.filter((check) => check.status === 'fail').map((check) => check.name);
  expect(failed, formatConformanceReport(report)).toEqual(failing);
  expect(report.ok).toBe(failing.length === 0);
  return report;
}

describe('runImporterConformance', () => {
  it('passes a well-behaved importer on every check, in a fixed order', async () => {
    const report = await expectFailing(toyImporter(), []);
    expect(report.importerId).toBe('toy.text-importer');
    expect(report.checks.map((check) => check.name)).toEqual([...CONFORMANCE_CHECKS]);
    expect(report.checks.every((check) => check.status === 'pass' && check.details.length === 0)).toBe(true);
  });

  it('fails manifest-valid (and everything that needs registration) for an invalid manifest', async () => {
    const report = await expectFailing(toyImporter({ manifest: { ...toyManifest(), id: 'NOPE' } as ImporterManifest }), [...CONFORMANCE_CHECKS]);
    expect(statusOf(report, 'detect-cheap')?.details).toEqual(['skipped because manifest-valid failed; the importer cannot be registered']);
  });

  it('fails manifest-valid for an incompatible sdk range', async () => {
    const report = await expectFailing(toyImporter({ manifest: toyManifest({ sdk: '^2.0.0' }) }), [...CONFORMANCE_CHECKS]);
    expect(statusOf(report, 'manifest-valid')?.details.join('\n')).toContain('does not include');
  });

  it('fails manifest-valid when a fixture names an unknown capability', async () => {
    const report = await runImporterConformance(toyImporter(), { fixtures: [{ ...fixtures[0]!, capabilityId: 'nope' }] });
    expect(statusOf(report, 'manifest-valid')?.status).toBe('fail');
  });

  it('fails every fixture-driven check when no fixtures are given', async () => {
    const report = await runImporterConformance(toyImporter(), { fixtures: [] });
    expect(statusOf(report, 'manifest-valid')?.status).toBe('pass');
    expect(report.checks.filter((check) => check.status === 'fail')).toHaveLength(CONFORMANCE_CHECKS.length - 1);
  });

  it('fails detect-deterministic for a detect() with hidden state', async () => {
    let calls = 0;
    await expectFailing(
      toyImporter({ detect: () => ({ capabilityId: TOY_CAPABILITY_ID, confidence: (calls++ % 2) ? 0.5 : 0.6, reason: 'flaky' }) }),
      ['detect-deterministic'],
    );
  });

  it('fails detect-deterministic when a known-good fixture is not recognised', async () => {
    await expectFailing(toyImporter({ detect: () => null }), ['detect-deterministic']);
  });

  it('fails detect-deterministic (and the garbage sweep, which re-checks detect) for out-of-range confidence', async () => {
    await expectFailing(toyImporter({ detect: () => ({ capabilityId: TOY_CAPABILITY_ID, confidence: 2, reason: 'sure' }) }), [
      'detect-deterministic',
      'garbage-input-diagnosed',
    ]);
  });

  it('fails detect-cheap for a detect() that reads whole files', async () => {
    const report = await expectFailing(
      toyImporter({
        detect({ files }) {
          for (const path of files.paths()) files.read(path);
          return { capabilityId: TOY_CAPABILITY_ID, confidence: 0.5, reason: 'read everything' };
        },
      }),
      ['detect-cheap'],
    );
    expect(statusOf(report, 'detect-cheap')?.details[0]).toContain('files.head()');
  });

  it('fails outputs-schema-valid and output-paths-safe for unsafe output paths', async () => {
    await expectFailing(
      patchedToy((result) => ({ ...result, sources: { 'sources/../x.plc': 'x' } })),
      ['outputs-schema-valid', 'output-paths-safe', 'archive-deterministic'],
    );
  });

  it('fails output-paths-safe for paths that are safe but not in normal form', async () => {
    await expectFailing(
      patchedToy((result) => ({ ...result, sources: { './sources/x.plc': 'x' } })),
      ['output-paths-safe'],
    );
  });

  it('fails outputs-schema-valid for diagnostics that break the schema', async () => {
    await expectFailing(
      patchedToy((result) => ({ ...result, diagnostics: [...result.diagnostics, { code: 'X', message: 'bad', severity: 'fatal' as never }] })),
      ['outputs-schema-valid', 'archive-deterministic', 'limits-honoured', 'garbage-input-diagnosed'],
    );
  });

  it('fails archive-deterministic for output that depends on the clock or call count', async () => {
    let run = 0;
    await expectFailing(
      patchedToy((result) => ({ ...result, sources: { ...result.sources, 'sources/run.plc': `run ${(run += 1)}` } })),
      ['archive-deterministic'],
    );
  });

  it('fails abort-honoured for an importer that ignores the signal', async () => {
    const report = await expectFailing(
      toyImporter({ import: ({ files }) => toyImport(files, () => undefined) }),
      ['abort-honoured'],
    );
    expect(statusOf(report, 'abort-honoured')?.details[0]).toContain('ctx.throwIfAborted()');
  });

  it('fails abort-honoured for an importer that turns the abort into another error', async () => {
    await expectFailing(
      toyImporter({
        import: ({ files }, ctx) => {
          if (ctx.signal.aborted) throw new Error('wrapped');
          return toyImport(files, () => undefined);
        },
      }),
      ['abort-honoured'],
    );
  });

  it('fails garbage-input-diagnosed for an importer that throws on bad input', async () => {
    const report = await expectFailing(
      toyImporter({
        import: ({ files }, ctx) => {
          const result = toyImport(files, () => ctx.throwIfAborted());
          if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error('cannot parse');
          return result;
        },
      }),
      ['garbage-input-diagnosed'],
    );
    expect(statusOf(report, 'garbage-input-diagnosed')?.details.join('\n')).toContain('threw instead of returning diagnostics');
  });

  it('fails garbage-input-diagnosed for an importer that silently accepts garbage', async () => {
    const report = await expectFailing(
      toyImporter({
        import: ({ files }, ctx) => {
          ctx.throwIfAborted();
          return { sources: { 'sources/x.plc': `(* ${files.fileCount} *)` }, diagnostics: [], summary: { message: 'ok' } };
        },
      }),
      ['garbage-input-diagnosed'],
    );
    expect(statusOf(report, 'garbage-input-diagnosed')?.details.join('\n')).toContain('no warning or error for unusable input');
  });

  it('fails garbage-input-diagnosed when detect() throws on garbage', async () => {
    await expectFailing(
      toyImporter({
        detect: ({ files }) => {
          if (files.fileCount === 0) throw new Error('no files');
          return { capabilityId: TOY_CAPABILITY_ID, confidence: 0.5, reason: 'files' };
        },
      }),
      ['detect-deterministic', 'garbage-input-diagnosed'],
    );
  });

  it('reports a crashing check as failed instead of throwing', async () => {
    const hostile = toyImporter();
    Object.defineProperty(hostile, 'detect', { get: () => { throw new Error('getter exploded'); } });
    const report = await runImporterConformance(hostile, { fixtures });
    expect(report.ok).toBe(false);
  });

  it('never throws, even for a non-object importer', async () => {
    const report = await runImporterConformance(undefined as unknown as WormholeImporter, { fixtures });
    expect(report.ok).toBe(false);
    expect(report.importerId).toBe('(unknown)');
  });

  it('formats a readable report', async () => {
    const report = await runImporterConformance(toyImporter({ detect: () => null }), { fixtures });
    const text = formatConformanceReport(report);
    expect(text).toContain('NOT conformant');
    expect(text).toContain('FAIL detect-deterministic');
    expect(text).toContain('PASS manifest-valid');
  });

  it('expectImporterConformance resolves for a good importer and rejects for a bad one', async () => {
    await expect(expectImporterConformance(toyImporter(), { fixtures })).resolves.toMatchObject({ ok: true });
    await expect(expectImporterConformance(toyImporter({ detect: () => null }), { fixtures })).rejects.toThrow('detect-deterministic');
  });
});

// The vitest helper itself, run against the toy importer.
describeImporterConformance(toyImporter(), { fixtures });

// Keep `ImportResult` referenced for readers of this file: fixtures return it.
export type { ImportResult };
