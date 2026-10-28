#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

import { Command } from 'commander';

import {
  buildIec61131ImporterArchive,
  IMPORTER_ID,
  upgradeIec61131File,
  upgradePath,
} from './upgrade.js';

const program = new Command();

program
  .name('wormhole')
  .description('Wormhole IEC 61131 import and migration tools')
  .version('0.1.0');

program
  .command('upgrade')
  .description('Upgrade legacy IEC 61131 source toward Edition 4 canonical form')
  .requiredOption('--input <path>', 'Legacy .plc/.st file or directory')
  .requiredOption('--output <path>', 'Upgraded output file or directory')
  .option('--diagnostics <path>', 'Write diagnostics JSON to path')
  .option('--archive <path>', 'Write importer-result.v1 zip archive')
  .option('--apply', 'Apply auto-fix transforms (default: true)', true)
  .option('--report-only', 'Report diagnostics without applying transforms')
  .action(async (options) => {
    const apply = options.reportOnly ? false : options.apply !== false;
    const inputPath = options.input as string;
    const outputPath = options.output as string;

    const result = await upgradePath(inputPath, outputPath, { apply, sourceKind: 'plc' });

    if (Array.isArray(result)) {
      console.log(`Upgraded ${result.length} files to ${outputPath}`);
      return;
    }

    if (options.diagnostics) {
      await writeFile(options.diagnostics, `${JSON.stringify(result.diagnosticsReport, null, 2)}\n`, 'utf8');
    }

    if (options.archive) {
      const fileResult = await upgradeIec61131File(inputPath, { apply, sourceKind: 'plc' });
      const archive = buildIec61131ImporterArchive(fileResult.fileName, fileResult, fileResult.source);
      await writeFile(options.archive, archive.zipBytes);
    }

    console.log(
      `${IMPORTER_ID}: ${result.changed ? 'changed' : 'unchanged'} (${result.diagnostics.length} diagnostics)`,
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
