import { describe, expect, it } from 'vitest';

import { matchAllInCode, replaceInCode, scanSourceSpans } from './lexical.js';

function nonCode(source: string): string[] {
  return scanSourceSpans(source)
    .filter((span) => !span.code)
    .map((span) => source.slice(span.start, span.end));
}

describe('scanSourceSpans', () => {
  it('covers the whole source with contiguous spans', () => {
    const source = "A := 1; (* c *) B := 'x'; // tail\nC := \"y\"; { pragma } /* b */ D;";
    const spans = scanSourceSpans(source);
    expect(spans[0]?.start).toBe(0);
    expect(spans.at(-1)?.end).toBe(source.length);
    spans.slice(1).forEach((span, index) => expect(span.start).toBe(spans[index]?.end));
  });

  it.each([
    ['(* block *)', 'X (* block *) Y'],
    ['/* block */', 'X /* block */ Y'],
    ['// line', 'X // line\nY'],
    ["'single'", "X := 'single'; Y"],
    ['"double"', 'X := "double"; Y'],
    ['{ attribute }', 'X {attribute} Y'.replace('{attribute}', '{ attribute }')],
  ])('recognises %s', (expected, source) => {
    expect(nonCode(source)).toEqual([expected]);
  });

  it('treats $ as an escape inside strings', () => {
    expect(nonCode("S := 'it$'s 8#17'; T := 8#7;")).toEqual(["'it$'s 8#17'"]);
    expect(nonCode("S := 'cost $$'; T;")).toEqual(["'cost $$'"]);
    expect(nonCode('S := "say $"hi$""; T;')).toEqual(['"say $"hi$""']);
  });

  it('does not nest block comments', () => {
    expect(nonCode('(* a (* b *) c *)')).toEqual(['(* a (* b *)']);
  });

  it('runs an unclosed comment to end of input and an unclosed string to end of line', () => {
    expect(nonCode('X (* never closed\n8#17')).toEqual(['(* never closed\n8#17']);
    expect(nonCode("X := 'open\nY := 8#17;")).toEqual(["'open"]);
  });

  it('handles CRLF line comments and empty input', () => {
    expect(nonCode('X // c\r\nY')).toEqual(['// c']);
    expect(scanSourceSpans('')).toEqual([]);
  });

  it('does not mistake division or a lone parenthesis for a comment', () => {
    expect(nonCode('X := A / B; Y := (C * D);')).toEqual([]);
  });
});

describe('replaceInCode / matchAllInCode', () => {
  it('rewrites only code and reports whole-source offsets', () => {
    const source = "A := 8#7; (* 8#7 *) B := '8#7'; C := 8#7;";
    const offsets: number[] = [];
    const out = replaceInCode(source, /8#7/g, (match, _groups, offset) => {
      offsets.push(offset);
      expect(source.slice(offset, offset + match.length)).toBe(match);
      return 'X';
    });
    expect(out).toBe("A := X; (* 8#7 *) B := '8#7'; C := X;");
    expect(matchAllInCode(source, /8#7/g).map((found) => found.offset)).toEqual(offsets);
  });

  it('passes capture groups', () => {
    expect(replaceInCode('a1 b2', /([a-z])(\d)/g, (_match, groups) => `${groups[1]}${groups[0]}`)).toBe('1a 2b');
  });

  it('requires a global pattern', () => {
    expect(() => replaceInCode('x', /x/, () => 'y')).toThrow('global');
    expect(() => matchAllInCode('x', /x/)).toThrow('global');
  });
});
