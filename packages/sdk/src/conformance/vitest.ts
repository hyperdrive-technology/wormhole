/**
 * `@wormhole/sdk/conformance/vitest`: registers the conformance kit as vitest tests, one
 * test per check, so a failure names the exact check and its problems.
 *
 * ```ts
 * import { describeImporterConformance } from '@wormhole/sdk/conformance/vitest';
 * describeImporterConformance(importer, { fixtures: [{ name: 'basic', files: { 'a.st': src } }] });
 * ```
 */
import { beforeAll, describe, it } from 'vitest';

import type { WormholeImporter } from '../importer.js';
import {
  CONFORMANCE_CHECKS,
  formatConformanceReport,
  runImporterConformance,
  type ConformanceOptions,
  type ConformanceReport,
} from './index.js';

export interface DescribeConformanceOptions {
  /** Timeout for running the whole kit once (default 120 s). */
  timeoutMs?: number;
}

export function describeImporterConformance(
  importer: WormholeImporter,
  options: ConformanceOptions,
  { timeoutMs = 120_000 }: DescribeConformanceOptions = {},
): void {
  const label = (importer as Partial<WormholeImporter> | undefined)?.manifest?.id ?? 'importer';
  describe(`${label} conformance`, () => {
    let report: ConformanceReport;
    beforeAll(async () => {
      report = await runImporterConformance(importer, options);
    }, timeoutMs);

    for (const name of CONFORMANCE_CHECKS) {
      it(name, (context) => {
        const check = report.checks.find((item) => item.name === name);
        if (!check) throw new Error(`conformance check ${name} did not run`);
        if (check.status === 'skip') {
          context.skip();
          return;
        }
        if (check.status === 'fail') {
          throw new Error(`${name} failed:\n  ${check.details.join('\n  ')}\n\n${formatConformanceReport(report)}`);
        }
      });
    }
  });
}

/** Single assertion form: throws with the formatted report unless every check passes. */
export async function expectImporterConformance(
  importer: WormholeImporter,
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const report = await runImporterConformance(importer, options);
  if (!report.ok) throw new Error(formatConformanceReport(report));
  return report;
}
