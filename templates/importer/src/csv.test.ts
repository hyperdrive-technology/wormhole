import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('splits plain records and keeps their raw text and line', () => {
    const { records, problems } = parseCsv('a,b,c\n1,2,3\n');
    expect(problems).toEqual([]);
    expect(records).toEqual([
      { line: 1, fields: ['a', 'b', 'c'], raw: 'a,b,c' },
      { line: 2, fields: ['1', '2', '3'], raw: '1,2,3' },
    ]);
  });

  it('handles a last record without a trailing newline', () => {
    expect(parseCsv('a,b\n1,2').records.map((r) => r.fields)).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps empty fields, including trailing ones', () => {
    expect(parseCsv('a,,c,\n').records[0]?.fields).toEqual(['a', '', 'c', '']);
  });

  it('skips blank lines but keeps line numbers right', () => {
    const { records } = parseCsv('a\n\n\nb\n');
    expect(records.map((r) => [r.line, r.fields])).toEqual([[1, ['a']], [4, ['b']]]);
  });

  it('unquotes fields with commas, doubled quotes and newlines', () => {
    const { records, problems } = parseCsv('"x, y","say ""hi""","two\nlines"\nnext\n');
    expect(problems).toEqual([]);
    expect(records[0]).toEqual({ line: 1, fields: ['x, y', 'say "hi"', 'two\nlines'], raw: '"x, y","say ""hi""","two\nlines"' });
    expect(records[1]).toEqual({ line: 3, fields: ['next'], raw: 'next' });
  });

  it('accepts an empty quoted field', () => {
    expect(parseCsv('"",a\n').records[0]?.fields).toEqual(['', 'a']);
  });

  it('reports text after a closing quote and resynchronises at the next line', () => {
    const { records, problems } = parseCsv('ok,1\n"bad"x,2\nok,3\n');
    expect(problems).toEqual([{ line: 2, message: 'unexpected "x" after a closing quote', raw: '"bad"x,2' }]);
    expect(records.map((r) => r.fields[1])).toEqual(['1', '3']);
    expect(records[1]?.line).toBe(3);
  });

  it('reports a quote inside an unquoted field', () => {
    const { records, problems } = parseCsv('a,b"c\nd\n');
    expect(problems).toEqual([{ line: 1, message: 'double quote inside an unquoted field', raw: 'a,b"c' }]);
    expect(records).toEqual([{ line: 2, fields: ['d'], raw: 'd' }]);
  });

  it('reports an unterminated quote, which swallows the rest of the input', () => {
    const { records, problems } = parseCsv('a\n"open,1\nb,2\n');
    expect(records.map((r) => r.fields)).toEqual([['a']]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(2);
    expect(problems[0]?.message).toMatch(/unterminated/);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual({ records: [], problems: [] });
  });
});
