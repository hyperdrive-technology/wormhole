import { Link, createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';

import { buildImporterResultArchive, getIec61131UpgradeJob } from '@/server/run-iec61131-upgrade';

export const Route = createFileRoute('/upgrade/$jobId')({
  loader: ({ params }) => getIec61131UpgradeJob({ data: params.jobId }),
  component: UpgradeResultPage,
});

function UpgradeResultPage() {
  const job = Route.useLoaderData();
  const diagnostics = job.diagnostics.diagnostics;

  const summary = useMemo(() => {
    return diagnostics.reduce(
      (counts, item) => {
        counts[item.severity] += 1;
        return counts;
      },
      { info: 0, warning: 0, error: 0 },
    );
  }, [diagnostics]);

  async function downloadSource() {
    const blob = new Blob([job.upgradedSource], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = job.fileName.replace(/\.(plc|st)$/i, '') + '.upgraded.plc';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadDiagnostics() {
    const blob = new Blob([JSON.stringify(job.diagnostics, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'diagnostics.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadArchive() {
    const archive = await buildImporterResultArchive({ data: job.id });
    const bytes = Uint8Array.from(atob(archive.base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = archive.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Job {job.id}</p>
          <h1 className="text-3xl font-semibold">{job.fileName}</h1>
          <p className="mt-2 text-muted-foreground">
            {job.changed ? 'Source changed' : 'No textual changes'} · {diagnostics.length} diagnostics
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={downloadSource}
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            Download upgraded source
          </button>
          <button
            type="button"
            onClick={downloadDiagnostics}
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            Download diagnostics
          </button>
          <button
            type="button"
            onClick={downloadArchive}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            Download importer-result zip
          </button>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        {(['info', 'warning', 'error'] as const).map((severity) => (
          <div key={severity} className="rounded-lg border p-4">
            <p className="text-sm uppercase text-muted-foreground">{severity}</p>
            <p className="text-3xl font-semibold">{summary[severity]}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl border p-4">
          <h2 className="font-medium">Upgraded source</h2>
          <pre className="mt-3 max-h-[28rem] overflow-auto rounded-md bg-muted p-3 text-xs">{job.upgradedSource}</pre>
        </article>
        <article className="rounded-xl border p-4">
          <h2 className="font-medium">Diagnostics</h2>
          <ul className="mt-3 max-h-[28rem] space-y-3 overflow-auto text-sm">
            {diagnostics.map((item, index) => (
              <li key={`${item.code}-${index}`} className="rounded-md border p-3">
                <p className="font-medium">{item.code}</p>
                <p className="text-muted-foreground">{item.message}</p>
                {item.details ? <p className="mt-1 text-xs">{item.details}</p> : null}
              </li>
            ))}
          </ul>
        </article>
      </section>

      {Object.keys(job.preservation).length > 0 ? (
        <section className="rounded-xl border p-4">
          <h2 className="font-medium">Preservation sidecars</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {Object.entries(job.preservation).map(([path, sidecarContent]) => (
              <li key={path} className="rounded-md border p-3">
                <p className="font-medium">{path}</p>
                <pre className="mt-2 overflow-auto text-xs">{sidecarContent}</pre>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Link to="/upgrade" className="text-sm text-muted-foreground hover:text-foreground">
        Run another upgrade
      </Link>
    </main>
  );
}
