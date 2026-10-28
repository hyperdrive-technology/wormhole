import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { upgradeIec61131Source } from './upgrade.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/legacy');

describe('@wormhole/iec61131-upgrade golden fixtures', () => {
  it('matches expected tier-a upgrade snapshot', () => {
    const content = readFileSync(join(fixturesDir, 'tier-a-legacy.plc'), 'utf8');
    const result = upgradeIec61131Source(content, {
      sourceKind: 'st',
      fileName: 'tier-a-legacy.plc',
      apply: true,
    });

    expect(result.source).toMatchInlineSnapshot(`
      "(* HD_BCD migration shim: replace with domain logic or explicit import before canonical export. *)
      PROGRAM OctalTruncBcd
      VAR
        Value : INT := 0;
        Raw : REAL := 1.9;
        Thumbwheel : WORD := WORD#16#0001;
        Display : INT := 0;
      END_VAR
      Value := 16#39188;
      Display := TRUNC_INT(Raw);
      Display := HD_BCD.WORD_BCD_TO_INT(Thumbwheel);
      END_PROGRAM
      "
    `);
  });
});

describe('@wormhole/iec61131-upgrade pollution guard', () => {
  it('does not leave deleted octal, bare TRUNC, or native IL bodies after upgrade', () => {
    const tierA = readFileSync(join(fixturesDir, 'tier-a-legacy.plc'), 'utf8');
    const il = readFileSync(join(fixturesDir, 'il-legacy.st'), 'utf8');

    for (const [fileName, content] of [
      ['tier-a-legacy.plc', tierA],
      ['il-legacy.st', il],
    ] as const) {
      const result = upgradeIec61131Source(content, {
        sourceKind: 'st',
        fileName,
        apply: true,
      });
      expect(result.source).not.toMatch(/\b8#/);
      expect(result.source).not.toMatch(/\bTRUNC\s*\(/);
      expect(result.source).not.toMatch(/^\s*LD\s/m);
    }
  });
});
