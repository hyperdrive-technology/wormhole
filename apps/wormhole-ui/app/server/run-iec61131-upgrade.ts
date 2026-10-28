import { createServerFn } from '@tanstack/react-start';

import {
  buildIec61131ImporterArchive,
  upgradeIec61131Source,
} from '@wormhole/iec61131-upgrade';

import { getUpgradeJob, saveUpgradeJob } from './job-store';

export interface RunIec61131UpgradeInput {
  fileName: string;
  content: string;
  apply: boolean;
}

export const runIec61131Upgrade = createServerFn({ method: 'POST' })
  .inputValidator((payload: RunIec61131UpgradeInput) => payload)
  .handler(async ({ data }) => {
    const result = upgradeIec61131Source(data.content, {
      fileName: data.fileName,
      sourceKind: data.fileName.endsWith('.st') ? 'st' : 'plc',
      apply: data.apply,
    });

    const id = crypto.randomUUID();
    const job = {
      id,
      fileName: data.fileName,
      apply: data.apply,
      createdAt: new Date().toISOString(),
      source: data.content,
      upgradedSource: result.source,
      changed: result.changed,
      diagnostics: result.diagnosticsReport,
      preservation: result.preservation,
    };
    saveUpgradeJob(job);
    return job;
  });

export const getIec61131UpgradeJob = createServerFn({ method: 'GET' })
  .inputValidator((jobId: string) => jobId)
  .handler(async ({ data: jobId }) => {
    const job = getUpgradeJob(jobId);
    if (!job) {
      throw new Error(`Upgrade job not found: ${jobId}`);
    }
    return job;
  });

export const buildImporterResultArchive = createServerFn({ method: 'POST' })
  .inputValidator((jobId: string) => jobId)
  .handler(async ({ data: jobId }) => {
    const job = getUpgradeJob(jobId);
    if (!job) {
      throw new Error(`Upgrade job not found: ${jobId}`);
    }

    const archive = buildIec61131ImporterArchive(job.fileName, {
      source: job.upgradedSource,
      changed: job.changed,
      diagnostics: job.diagnostics.diagnostics,
      preservation: job.preservation,
      diagnosticsReport: job.diagnostics,
    }, job.source);

    return {
      fileName: `${job.fileName.replace(/\.(plc|st)$/i, '')}-importer-result.zip`,
      base64: Buffer.from(archive.zipBytes).toString('base64'),
      manifest: archive.manifest,
    };
  });
