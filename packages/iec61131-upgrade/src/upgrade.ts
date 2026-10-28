import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import {
  buildDiagnosticsReport,
  buildImporterResultArchive,
  fingerprintSource,
  IEC61131_ED4_UPGRADE_CAPABILITY,
  type ImporterDiagnostic,
  type ImporterDiagnosticsReport,
  type ImporterUnsupportedSemantic,
} from '@wormhole/contract';
import { upgradeSource, type UpgradeOptions, type UpgradeResult } from '@wormhole/migrate';

export const IMPORTER_ID = IEC61131_ED4_UPGRADE_CAPABILITY.id;
export const IMPORTER_VERSION = '0.1.0';
export const VENDOR_FAMILY = IEC61131_ED4_UPGRADE_CAPABILITY.vendorFamily;

export interface Iec61131UpgradeOptions extends UpgradeOptions {}

export interface Iec61131UpgradeResult extends UpgradeResult {
  diagnosticsReport: ImporterDiagnosticsReport;
}

export function inferSourceKind(fileName: string): 'plc' | 'st' {
  const ext = extname(fileName).toLowerCase();
  return ext === '.st' ? 'st' : 'plc';
}

export function upgradeIec61131Source(
  content: string,
  options: Iec61131UpgradeOptions,
): Iec61131UpgradeResult {
  const result = upgradeSource(content, options);
  return {
    ...result,
    diagnosticsReport: buildDiagnosticsReport(result.diagnostics),
  };
}

export async function upgradeIec61131File(
  inputPath: string,
  options: Omit<Iec61131UpgradeOptions, 'fileName'>,
): Promise<Iec61131UpgradeResult & { fileName: string }> {
  const fileName = inputPath.replace(/^.*[/\\]/, '');
  const content = await readFile(inputPath, 'utf8');
  const result = upgradeIec61131Source(content, {
    ...options,
    fileName,
    sourceKind: options.sourceKind ?? inferSourceKind(fileName),
  });
  return { ...result, fileName };
}

/** Warnings and errors become the result manifest's `unsupportedSemantics`. */
export function unsupportedSemanticsFrom(
  diagnostics: readonly ImporterDiagnostic[],
): ImporterUnsupportedSemantic[] {
  return diagnostics
    .filter((item) => item.severity === 'warning' || item.severity === 'error')
    .map((item) => ({
      code: item.code,
      message: item.message,
      severity: item.severity,
    }));
}

export function buildIec61131ImporterArchive(
  fileName: string,
  result: Iec61131UpgradeResult,
  sourceContent: string,
) {
  return buildImporterResultArchive({
    manifest: {
      importerId: IMPORTER_ID,
      importerVersion: IMPORTER_VERSION,
      vendorFamily: VENDOR_FAMILY,
      sourceFingerprint: fingerprintSource(sourceContent),
      unsupportedSemantics: unsupportedSemanticsFrom(result.diagnostics),
    },
    sourcePath: fileName,
    sourceContent: result.source,
    diagnostics: result.diagnosticsReport,
    preservation: result.preservation,
  });
}

export async function writeUpgradeOutput(
  outputPath: string,
  result: Iec61131UpgradeResult,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.source, 'utf8');
}

export async function upgradePath(
  inputPath: string,
  outputPath: string,
  options: Omit<Iec61131UpgradeOptions, 'fileName'>,
): Promise<Iec61131UpgradeResult | Iec61131UpgradeResult[]> {
  const inputStat = await stat(inputPath);
  if (inputStat.isDirectory()) {
    await mkdir(outputPath, { recursive: true });
    const entries = await readdir(inputPath);
    const results: Iec61131UpgradeResult[] = [];
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (ext !== '.plc' && ext !== '.st') continue;
      const fileResult = await upgradeIec61131File(join(inputPath, entry), options);
      await writeUpgradeOutput(join(outputPath, entry), fileResult);
      results.push(fileResult);
    }
    return results;
  }

  const fileResult = await upgradeIec61131File(inputPath, options);
  await writeUpgradeOutput(outputPath, fileResult);
  return fileResult;
}

export { upgradeSource };
export type { UpgradeOptions, UpgradeResult };
