import { describe, expect, it } from 'vitest';

import { octalLiteralRule } from './rules/octalLiteralRule.js';

const options = (apply: boolean) => ({ sourceKind: 'st' as const, fileName: 'a.st', apply });

describe('octalLiteralRule', () => {
  it('rewrites octal literals in code', () => {
    const result = octalLiteralRule.run('X := 8#17;\nY := 8#1_0;', options(true));
    expect(result.source).toBe('X := 16#F;\nY := 16#8;');
    expect(result.changed).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.source?.startLine)).toEqual([1, 2]);
  });

  it.each([
    ['a (* *) comment', 'X := 1; (* was 8#17 *)'],
    ['a /* */ comment', 'X := 1; /* was 8#17 */'],
    ['a // comment', 'X := 1; // was 8#17'],
    ["a '…' string", "S := 'code 8#17';"],
    ['a "…" string', 'S := "code 8#17";'],
    ['a string with an escaped quote', "S := 'it$'s 8#17';"],
    ['a pragma', '{ attribute value := 8#17 } X := 1;'],
  ])('leaves 8# inside %s untouched (regression)', (_, source) => {
    const result = octalLiteralRule.run(source, options(true));
    expect(result.source).toBe(source);
    expect(result.changed).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(octalLiteralRule.run(source, options(false)).diagnostics).toEqual([]);
  });

  it('rewrites code around comments and strings, with correct line numbers', () => {
    const source = "(* 8#1 *)\nA := 8#10; S := '8#2';\n// 8#3\nB := 8#11;";
    const result = octalLiteralRule.run(source, options(true));
    expect(result.source).toBe("(* 8#1 *)\nA := 16#8; S := '8#2';\n// 8#3\nB := 16#9;");
    expect(result.diagnostics.map((diagnostic) => diagnostic.source?.startLine)).toEqual([2, 4]);
  });

  it('reports without rewriting in report-only mode, skipping comments', () => {
    const result = octalLiteralRule.run('A := 8#10; (* 8#7 *)', options(false));
    expect(result.source).toBe('A := 8#10; (* 8#7 *)');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe('warning');
  });

  it('ignores invalid octal digits', () => {
    expect(octalLiteralRule.run('A := 8#19;', options(true)).source).toBe('A := 8#19;');
  });
});
