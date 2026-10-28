import { createServer } from 'node:http';

import {
  IEC61131_ED4_UPGRADE_CAPABILITY,
  type ImporterDiagnosticsReport,
} from '@wormhole/contract';
import {
  buildIec61131ImporterArchive,
  IMPORTER_ID,
  IMPORTER_VERSION,
  upgradeIec61131Source,
} from '@wormhole/iec61131-upgrade';

export interface ImporterJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  capabilityId: string;
  fileName: string;
  createdAt: string;
  completedAt?: string;
  result?: {
    source: string;
    changed: boolean;
    diagnostics: ImporterDiagnosticsReport;
    preservation: Record<string, string>;
    archiveBase64?: string;
  };
  error?: string;
}

export interface ServiceOptions {
  port?: number;
}

const jobs = new Map<string, ImporterJob>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readJson<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

export function createWormholeServiceApp() {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === '/importers/capabilities' && request.method === 'GET') {
      return jsonResponse(200, {
        schemaVersion: 'hyperdrive.importer-capabilities.v1',
        importers: [IEC61131_ED4_UPGRADE_CAPABILITY],
      });
    }

    if (url.pathname === '/importers/jobs' && request.method === 'POST') {
      const vendorFamily = request.headers.get('X-Hyperdrive-Vendor-Family');
      const sourceFileName = request.headers.get('X-Hyperdrive-Source-Filename') ?? 'legacy.plc';
      if (vendorFamily !== IEC61131_ED4_UPGRADE_CAPABILITY.vendorFamily) {
        return jsonResponse(400, { error: `Unsupported vendor family: ${vendorFamily}` });
      }

      const content = await request.text();
      const id = crypto.randomUUID();
      const job: ImporterJob = {
        id,
        status: 'running',
        capabilityId: IMPORTER_ID,
        fileName: sourceFileName,
        createdAt: new Date().toISOString(),
      };
      jobs.set(id, job);

      try {
        const upgraded = upgradeIec61131Source(content, {
          fileName: sourceFileName,
          sourceKind: sourceFileName.endsWith('.st') ? 'st' : 'plc',
          apply: true,
        });
        const archive = buildIec61131ImporterArchive(sourceFileName, upgraded, content);
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        job.result = {
          source: upgraded.source,
          changed: upgraded.changed,
          diagnostics: upgraded.diagnosticsReport,
          preservation: upgraded.preservation,
          archiveBase64: Buffer.from(archive.zipBytes).toString('base64'),
        };
      } catch (error) {
        job.status = 'failed';
        job.completedAt = new Date().toISOString();
        job.error = error instanceof Error ? error.message : String(error);
      }

      return jsonResponse(202, {
        schemaVersion: 'hyperdrive.importer-job.v1',
        id: job.id,
        status: job.status,
        capabilityId: job.capabilityId,
        importerVersion: IMPORTER_VERSION,
      });
    }

    const jobMatch = url.pathname.match(/^\/importers\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === 'GET') {
      const job = jobs.get(jobMatch[1] ?? '');
      if (!job) {
        return jsonResponse(404, { error: 'Job not found' });
      }
      return jsonResponse(200, {
        schemaVersion: 'hyperdrive.importer-job.v1',
        id: job.id,
        status: job.status,
        capabilityId: job.capabilityId,
        importerVersion: IMPORTER_VERSION,
        completedAt: job.completedAt,
        error: job.error,
        result: job.result
          ? {
              changed: job.result.changed,
              diagnostics: job.result.diagnostics,
              preservationPaths: Object.keys(job.result.preservation),
            }
          : undefined,
      });
    }

    const resultMatch = url.pathname.match(/^\/importers\/jobs\/([^/]+)\/result$/);
    if (resultMatch && request.method === 'GET') {
      const job = jobs.get(resultMatch[1] ?? '');
      if (!job?.result?.archiveBase64) {
        return jsonResponse(404, { error: 'Result archive not found' });
      }
      const bytes = Buffer.from(job.result.archiveBase64, 'base64');
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${job.fileName.replace(/\.(plc|st)$/i, '')}-importer-result.zip"`,
        },
      });
    }

    return jsonResponse(404, { error: 'Not found' });
  };
}

export function startWormholeService(options: ServiceOptions = {}) {
  const handler = createWormholeServiceApp();
  const server = createServer(async (incoming, outgoing) => {
    const host = incoming.headers.host ?? 'localhost';
    const url = `http://${host}${incoming.url ?? '/'}`;
    const body =
      incoming.method === 'GET' || incoming.method === 'HEAD'
        ? undefined
        : await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            incoming.on('end', () => resolve(Buffer.concat(chunks)));
            incoming.on('error', reject);
          });

    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body: body && body.length > 0 ? body.toString('utf8') : undefined,
    });
    const response = await handler(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });

  const port = options.port ?? 8787;
  server.listen(port);
  return server;
}
