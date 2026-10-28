import { describe, expect, it } from 'vitest';

import { upgradeIec61131Source } from '@wormhole/iec61131-upgrade';

describe('wormhole-ui server upgrade round trip', () => {
  it('returns changed source and diagnostics for legacy octal input', () => {
    const result = upgradeIec61131Source(
      'PROGRAM P\nVAR\n  Value : INT := 0;\nEND_VAR\nValue := 8#377;\nEND_PROGRAM\n',
      {
        fileName: 'legacy.plc',
        sourceKind: 'st',
        apply: true,
      },
    );

    expect(result.changed).toBe(true);
    expect(result.source).toContain('16#FF');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
