import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowRight, UploadCloud } from 'lucide-react';

import { IEC61131_ED4_UPGRADE_CAPABILITY } from '@wormhole/contract';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
      <div className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Wormhole</p>
        <h1 className="text-4xl font-semibold tracking-tight">Import and migrate legacy PLC source</h1>
        <p className="text-lg text-muted-foreground">
          Upgrade IEC 61131 Edition 3 constructs toward Edition 4 canonical `.plc`, with diagnostics and
          preservation sidecars.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-medium">Available importers</h2>
        <ul className="mt-4 space-y-3">
          <li className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div>
              <p className="font-medium">{IEC61131_ED4_UPGRADE_CAPABILITY.displayName}</p>
              <p className="text-sm text-muted-foreground">
                Capability `{IEC61131_ED4_UPGRADE_CAPABILITY.id}` ·{' '}
                {IEC61131_ED4_UPGRADE_CAPABILITY.fileExtensions.join(', ')}
              </p>
            </div>
            <Link
              to="/upgrade"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              <UploadCloud className="size-4" />
              Upgrade
              <ArrowRight className="size-4" />
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
