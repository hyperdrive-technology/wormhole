import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { upgradeSource } from './index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/legacy');

describe('@wormhole/migrate upgradeSource', () => {
  it('applies tier A transforms on octal, TRUNC, and BCD legacy source', () => {
    const content = readFileSync(join(fixturesDir, 'tier-a-legacy.plc'), 'utf8');
    const result = upgradeSource(content, {
      sourceKind: 'st',
      fileName: 'tier-a-legacy.plc',
      apply: true,
    });

    expect(result.changed).toBe(true);
    expect(result.source).toContain('16#39188');
    expect(result.source).toContain('TRUNC_INT(Raw)');
    expect(result.source).toContain('HD_BCD.WORD_BCD_TO_INT(Thumbwheel)');
    expect(result.source).not.toMatch(/\b8#/);
    expect(result.source).not.toMatch(/\bTRUNC\s*\(/);
  });

  it('preserves IL in sidecar and replaces body with ST placeholder', () => {
    const content = readFileSync(join(fixturesDir, 'il-legacy.st'), 'utf8');
    const result = upgradeSource(content, {
      sourceKind: 'st',
      fileName: 'il-legacy.st',
      apply: true,
    });

    expect(result.source).toContain('migration review');
    expect(result.source).not.toMatch(/^\s*LD\s/m);
    expect(Object.keys(result.preservation).some((key) => key.startsWith('preservation/il/'))).toBe(
      true,
    );
  });

  it('emits deprecated construct diagnostics without mutating source when apply=false', () => {
    const content = `
PROGRAM LegacyGlobals
VAR_GLOBAL
  SharedCounter : DINT := 0;
END_VAR
VAR_ACCESS
  SharedAlias : SharedCounter : DINT;
END_VAR
END_PROGRAM
`;
    const result = upgradeSource(content, {
      sourceKind: 'st',
      fileName: 'legacy-globals.st',
      apply: false,
    });

    expect(result.changed).toBe(false);
    expect(result.source).toBe(content);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['WORMHOLE_DEPRECATED_VAR_ACCESS', 'WORMHOLE_DEPRECATED_VAR_GLOBAL']),
    );
  });
});
