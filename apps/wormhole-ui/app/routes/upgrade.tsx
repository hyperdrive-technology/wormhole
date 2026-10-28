import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { runIec61131Upgrade } from '@/server/run-iec61131-upgrade';

export const Route = createFileRoute('/upgrade')({
  component: UpgradePage,
});

function UpgradePage() {
  const navigate = useNavigate();
  const [fileName, setFileName] = useState('legacy.plc');
  const [content, setContent] = useState(
    'PROGRAM Legacy\nVAR\n  Value : INT := 0;\nEND_VAR\nValue := 8#377;\nEND_PROGRAM\n',
  );
  const [apply, setApply] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const job = await runIec61131Upgrade({ data: { fileName, content, apply } });
      await navigate({ to: '/upgrade/$jobId', params: { jobId: job.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upgrade failed');
    } finally {
      setBusy(false);
    }
  }

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    file.text().then(setContent);
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-3xl font-semibold">IEC 61131 upgrade</h1>
        <p className="mt-2 text-muted-foreground">
          Upload or paste legacy `.plc` / `.st` source. Wormhole applies safe auto-fixes and reports
          constructs that still need review.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <label className="flex flex-col gap-2 text-sm font-medium">
          Source file
          <input type="file" accept=".plc,.st" onChange={onFileChange} className="text-sm" />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium">
          File name
          <input
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
            className="rounded-md border px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium">
          Source text
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={14}
            className="rounded-md border px-3 py-2 font-mono text-sm"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={apply} onChange={(event) => setApply(event.target.checked)} />
          Apply auto-fix transforms
        </label>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Running upgrade…' : 'Run upgrade'}
          </button>
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
