import { describe, expect, it } from 'vitest';

import { createWormholeServiceApp } from './server.js';

describe('@wormhole/service', () => {
  it('lists iec61131-ed4-upgrade capability', async () => {
    const app = createWormholeServiceApp();
    const response = await app(new Request('http://localhost/importers/capabilities'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.importers[0].id).toBe('iec61131-ed4-upgrade');
  });

  it('creates and completes an upgrade job', async () => {
    const app = createWormholeServiceApp();
    const create = await app(
      new Request('http://localhost/importers/jobs', {
        method: 'POST',
        headers: {
          'X-Hyperdrive-Vendor-Family': 'iec61131-legacy',
          'X-Hyperdrive-Source-Filename': 'legacy.plc',
          'Content-Type': 'text/plain',
        },
        body: 'PROGRAM P\nVAR\n  Value : INT := 0;\nEND_VAR\nValue := 8#377;\nEND_PROGRAM\n',
      }),
    );
    expect(create.status).toBe(202);
    const job = await create.json();
    expect(job.status).toBe('completed');

    const result = await app(new Request(`http://localhost/importers/jobs/${job.id}/result`));
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Type')).toBe('application/zip');
  });
});
