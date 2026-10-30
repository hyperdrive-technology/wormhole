import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { mergeUpgradeResults, upgradeSource, type UpgradeRule } from './index.js';

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

// wormhole#4: upgradeSource merged rule sidecars with Object.assign, so a rule (or a custom
// rule set) that reused a path silently replaced logic an earlier rule had already moved out
// of the source.
describe('upgradeSource preservation sidecar collisions (wormhole#4)', () => {
  function sidecarRule(id: string, preservation: Record<string, string>): UpgradeRule {
    return { id, tier: 'C', run: (source) => ({ source, changed: false, diagnostics: [], preservation }) };
  }
  const options = { sourceKind: 'st' as const, fileName: 'a.st', apply: true };

  it('keeps both sidecars when two rules write the same path, and warns', () => {
    const result = upgradeSource('x', options, [
      sidecarRule('first', { 'preservation/il/a-Main.il.txt': 'LD TRUE' }),
      sidecarRule('second', { 'preservation/il/a-Main.il.txt': 'LD FALSE' }),
    ]);
    expect(result.preservation).toEqual({
      'preservation/il/a-Main.il.txt': 'LD TRUE',
      'preservation/il/a-Main.collision-2.il.txt': 'LD FALSE',
    });
    const warning = result.diagnostics.find((item) => item.code === 'WORMHOLE_PRESERVATION_COLLISION');
    expect(warning).toMatchObject({ severity: 'warning', source: { path: 'a.st' } });
    expect(warning?.message).toContain('preservation/il/a-Main.collision-2.il.txt');
  });

  it('treats case-only and NFC/NFD differences as collisions, like the archive does', () => {
    const result = upgradeSource('x', options, [
      sidecarRule('first', { 'preservation/café.txt': '1' }),
      sidecarRule('second', { 'preservation/CAFÉ.txt': '2' }),
      sidecarRule('third', { 'preservation/Café.txt': '3', 'preservation/café.collision-2.txt': '4' }),
    ]);
    expect(Object.values(result.preservation).sort()).toEqual(['1', '2', '3', '4']);
    const keys = Object.keys(result.preservation).map((key) => key.normalize('NFC').toLowerCase());
    expect(new Set(keys).size).toBe(4);
  });

  it('suffixes names without an extension and in nested folders', () => {
    const result = upgradeSource('x', options, [
      sidecarRule('first', { 'preservation/x/raw': 'a', 'preservation/.hidden': 'b' }),
      sidecarRule('second', { 'preservation/x/raw': 'c', 'preservation/.hidden': 'd' }),
    ]);
    expect(result.preservation).toEqual({
      'preservation/x/raw': 'a',
      'preservation/.hidden': 'b',
      'preservation/x/raw.collision-2': 'c',
      'preservation/.hidden.collision-2': 'd',
    });
  });

  it('mergeUpgradeResults keeps colliding sidecars too', () => {
    const result = mergeUpgradeResults('x', [
      { source: 'x', changed: false, diagnostics: [], preservation: { 'preservation/p.txt': 'one' } },
      { source: 'y', changed: true, diagnostics: [], preservation: { 'preservation/p.txt': 'two' } },
    ]);
    expect(result.preservation).toEqual({ 'preservation/p.txt': 'one', 'preservation/p.collision-2.txt': 'two' });
    expect(result.diagnostics.map((item) => item.code)).toEqual(['WORMHOLE_PRESERVATION_COLLISION']);
  });

  it('keeps every IL body of a file that declares one POU many times', () => {
    const pou = (il: string) => `PROGRAM Dup\nVAR\n  A : BOOL;\nEND_VAR\n${il}\nEND_PROGRAM\n`;
    const result = upgradeSource(`${pou('LD TRUE')}${pou('LD FALSE')}${pou('LDN A')}`, options);
    expect(Object.values(result.preservation)).toEqual([
      expect.stringContaining('LD TRUE'),
      expect.stringContaining('LD FALSE'),
      expect.stringContaining('LDN A'),
    ]);
  });
});
