import { describe, expect, it } from 'vitest';

import { ilPreservationRule, ilSidecarStem } from './ilPreservationRule.js';

function pou(name: string, il: string, kind = 'PROGRAM'): string {
  return `${kind} ${name}\nVAR\n  A : BOOL;\nEND_VAR\n${il}\nEND_${kind}\n`;
}

function run(source: string, fileName: string, apply = true) {
  return ilPreservationRule.run(source, { sourceKind: 'st', fileName, apply });
}

describe('ilSidecarStem', () => {
  it.each([
    ['main.st', 'main'],
    ['MAIN.ST', 'MAIN'],
    ['x/main.st', 'x/main'],
    ['x\\y\\main.plc', 'x/y/main'],
    ['./x//main.st', 'x/main'],
    ['../x/main.st', 'x/main'],
    ['/abs/main.st', 'abs/main'],
    ['notes.txt', 'notes.txt'],
    ['', 'source'],
    ['.st', 'source'],
  ])('%s -> %s', (fileName, stem) => {
    expect(ilSidecarStem(fileName)).toBe(stem);
  });
});

describe('ilPreservationRule sidecar naming', () => {
  it('keeps the historical name for a bare file name', () => {
    const result = run(pou('Legacy', 'LD A\nST A'), 'il-legacy.st');
    expect(Object.keys(result.preservation)).toEqual(['preservation/il/il-legacy-Legacy.il.txt']);
  });

  it('derives the sidecar name from the full relative path, so same-named files in different folders do not collide', () => {
    const x = run(pou('Main', 'LD TRUE\nST A'), 'x/main.st');
    const y = run(pou('Main', 'LD FALSE\nST A'), 'y/main.st');
    expect(Object.keys(x.preservation)).toEqual(['preservation/il/x/main-Main.il.txt']);
    expect(Object.keys(y.preservation)).toEqual(['preservation/il/y/main-Main.il.txt']);
    expect(Object.values(x.preservation)[0]).toContain('LD TRUE');
    expect(Object.values(y.preservation)[0]).toContain('LD FALSE');
  });

  it('normalises Windows separators the same way as forward slashes', () => {
    const result = run(pou('Main', 'LD TRUE\nST A'), 'x\\main.st');
    expect(Object.keys(result.preservation)).toEqual(['preservation/il/x/main-Main.il.txt']);
  });

  // wormhole#4: two POUs with the same name in one file used to overwrite each other.
  it('keeps both bodies when one file declares the same POU name twice, and warns', () => {
    const source = `${pou('Dup', 'LD TRUE\nST A')}${pou('Dup', 'LD FALSE\nST A')}`;
    const result = run(source, 'dup.st');
    expect(Object.keys(result.preservation)).toEqual(['preservation/il/dup-Dup.il.txt', 'preservation/il/dup-Dup-2.il.txt']);
    expect(result.preservation['preservation/il/dup-Dup.il.txt']).toContain('LD TRUE');
    expect(result.preservation['preservation/il/dup-Dup-2.il.txt']).toContain('LD FALSE');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'WORMHOLE_IL_PRESERVATION',
      'WORMHOLE_IL_DUPLICATE_POU',
      'WORMHOLE_IL_PRESERVATION',
    ]);
    expect(result.diagnostics[1]?.source?.startLine).toBe(8);
  });

  it('treats POU names that differ only by case as duplicates (IEC identifiers are case-insensitive)', () => {
    const source = `${pou('Dup', 'LD TRUE\nST A')}${pou('DUP', 'LD FALSE\nST A', 'FUNCTION_BLOCK')}${pou('dup', 'LDN A\nST A')}`;
    const result = run(source, 'dup.st');
    expect(Object.keys(result.preservation)).toEqual([
      'preservation/il/dup-Dup.il.txt',
      'preservation/il/dup-DUP-2.il.txt',
      'preservation/il/dup-dup-3.il.txt',
    ]);
    const lowered = Object.keys(result.preservation).map((path) => path.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it('reports the same sidecar paths with apply:false, without changing the source', () => {
    const source = `${pou('Dup', 'LD TRUE\nST A')}${pou('Dup', 'LD FALSE\nST A')}`;
    const result = run(source, 'dup.st', false);
    expect(result.source).toBe(source);
    expect(result.changed).toBe(false);
    expect(Object.keys(result.preservation)).toEqual(['preservation/il/dup-Dup.il.txt', 'preservation/il/dup-Dup-2.il.txt']);
  });
});
