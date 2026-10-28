import type { ImporterDiagnosticsReport } from '@wormhole/contract';

export interface WormholeUpgradeJob {
  id: string;
  fileName: string;
  apply: boolean;
  createdAt: string;
  source: string;
  upgradedSource: string;
  changed: boolean;
  diagnostics: ImporterDiagnosticsReport;
  preservation: Record<string, string>;
}

const jobs = new Map<string, WormholeUpgradeJob>();

export function saveUpgradeJob(job: WormholeUpgradeJob): void {
  jobs.set(job.id, job);
}

export function getUpgradeJob(jobId: string): WormholeUpgradeJob | undefined {
  return jobs.get(jobId);
}

export function listUpgradeJobs(): WormholeUpgradeJob[] {
  return [...jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
