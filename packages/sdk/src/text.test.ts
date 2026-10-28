import { describe, expect, it } from 'vitest';

import { decodeText, looksBinary, normalizeNewlines } from './text.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i += 1) view.setUint16(i * 2, text.charCodeAt(i), littleEndian);
  return out;
}

describe('decodeText', () => {
  it('decodes plain UTF-8', () => {
    expect(decodeText(utf8('PROGRAM café \u{1f37a}'))).toEqual({
      text: 'PROGRAM café \u{1f37a}',
      encoding: 'utf-8',
      bom: false,
      lossy: false,
    });
  });

  it('decodes pure ASCII as UTF-8', () => {
    expect(decodeText(utf8('abc'))).toMatchObject({ text: 'abc', encoding: 'utf-8', bom: false, lossy: false });
  });

  it('strips a UTF-8 BOM', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('xé')]))).toEqual({
      text: 'xé',
      encoding: 'utf-8',
      bom: true,
      lossy: false,
    });
  });

  it('decodes a lone UTF-8 BOM as empty text', () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf))).toEqual({ text: '', encoding: 'utf-8', bom: true, lossy: false });
  });

  it('strips only the first BOM (a second one is content)', () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61)).text).toBe('﻿a');
  });

  it('decodes UTF-16LE with a BOM', () => {
    const input = new Uint8Array([0xff, 0xfe, ...utf16('Aé€', true)]);
    expect(decodeText(input)).toEqual({ text: 'Aé€', encoding: 'utf-16le', bom: true, lossy: false });
  });

  it('decodes UTF-16BE with a BOM', () => {
    const input = new Uint8Array([0xfe, 0xff, ...utf16('Aé€', false)]);
    expect(decodeText(input)).toEqual({ text: 'Aé€', encoding: 'utf-16be', bom: true, lossy: false });
  });

  it('decodes UTF-16 surrogate pairs', () => {
    const input = new Uint8Array([0xff, 0xfe, ...utf16('\u{1f37a}', true)]);
    expect(decodeText(input).text).toBe('\u{1f37a}');
  });

  it('marks odd-length UTF-16 as lossy', () => {
    const result = decodeText(bytes(0xff, 0xfe, 0x41, 0x00, 0x42));
    expect(result.encoding).toBe('utf-16le');
    expect(result.lossy).toBe(true);
    expect(result.text.startsWith('A')).toBe(true);
    expect(result.text).toContain('�');
  });

  it('falls back to Windows-1252 for invalid UTF-8 (0xE9 -> é)', () => {
    expect(decodeText(bytes(0x63, 0x61, 0x66, 0xe9))).toEqual({
      text: 'café',
      encoding: 'windows-1252',
      bom: false,
      lossy: false,
    });
  });

  it('maps 0x80 to the euro sign in the Windows-1252 fallback', () => {
    expect(decodeText(bytes(0x80, 0x20, 0x31, 0x30)).text).toBe('€ 10');
  });

  it('maps other C1-range bytes per Windows-1252 (0x92 -> right single quote, 0x9f -> Ÿ)', () => {
    expect(decodeText(bytes(0x92, 0x9f, 0xff)).text).toBe('’Ÿÿ');
  });

  it('uses U+FFFD and lossy: true with fallback "replace"', () => {
    expect(decodeText(bytes(0x63, 0xe9, 0x64), { fallback: 'replace' })).toEqual({
      text: 'c�d',
      encoding: 'utf-8',
      bom: false,
      lossy: true,
    });
  });

  it('fallback "replace" does not change valid UTF-8', () => {
    expect(decodeText(utf8('é'), { fallback: 'replace' })).toMatchObject({ text: 'é', lossy: false });
  });

  it('decodes empty bytes as empty UTF-8 text', () => {
    expect(decodeText(new Uint8Array(0))).toEqual({ text: '', encoding: 'utf-8', bom: false, lossy: false });
  });

  it('treats a truncated multi-byte sequence at the end as invalid UTF-8 (Windows-1252 fallback)', () => {
    // "é" is C3 A9; only C3 is present.
    expect(decodeText(bytes(0x61, 0x62, 0xc3))).toEqual({
      text: 'abÃ',
      encoding: 'windows-1252',
      bom: false,
      lossy: false,
    });
  });

  it('replaces a truncated multi-byte sequence at the end with U+FFFD in "replace" mode', () => {
    expect(decodeText(bytes(0x61, 0xe2, 0x82), { fallback: 'replace' })).toEqual({
      text: 'a�',
      encoding: 'utf-8',
      bom: false,
      lossy: true,
    });
  });

  it('decodes invalid UTF-8 after a UTF-8 BOM as lossy UTF-8 (the BOM wins over the fallback)', () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0xe9))).toEqual({
      text: '�',
      encoding: 'utf-8',
      bom: true,
      lossy: true,
    });
  });

  it('decodes a subarray view without reading outside it', () => {
    const backing = utf8('xxHELLOxx');
    expect(decodeText(backing.subarray(2, 7)).text).toBe('HELLO');
  });

  it('never throws on arbitrary bytes', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(() => decodeText(all)).not.toThrow();
    expect(() => decodeText(all, { fallback: 'replace' })).not.toThrow();
  });
});

describe('normalizeNewlines', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeNewlines('a\r\nb\r\n')).toEqual({ text: 'a\nb\n', changed: true });
  });

  it('converts a lone CR to LF', () => {
    expect(normalizeNewlines('a\rb\r')).toEqual({ text: 'a\nb\n', changed: true });
  });

  it('converts mixed line endings', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd\r\r\ne')).toEqual({ text: 'a\nb\nc\nd\n\ne', changed: true });
  });

  it('reports changed: false when there is nothing to convert', () => {
    expect(normalizeNewlines('a\nb\n')).toEqual({ text: 'a\nb\n', changed: false });
    expect(normalizeNewlines('')).toEqual({ text: '', changed: false });
  });

  it('does not treat LF CR as a single break', () => {
    expect(normalizeNewlines('a\n\rb').text).toBe('a\n\nb');
  });
});

describe('looksBinary', () => {
  it('is true when the sample contains a NUL byte', () => {
    expect(looksBinary(bytes(0x41, 0x00, 0x42))).toBe(true);
  });

  it('is false for UTF-16LE and UTF-16BE text with a BOM (which contains NULs)', () => {
    expect(looksBinary(new Uint8Array([0xff, 0xfe, ...utf16('ABC', true)]))).toBe(false);
    expect(looksBinary(new Uint8Array([0xfe, 0xff, ...utf16('ABC', false)]))).toBe(false);
  });

  it('is false for plain text', () => {
    expect(looksBinary(utf8('PROGRAM Main\nEND_PROGRAM\n'))).toBe(false);
  });

  it('is false for CRLF text with tabs and form feeds', () => {
    expect(looksBinary(utf8('a\tb\r\nc\fd\r\n'))).toBe(false);
  });

  it('is false for UTF-8 non-ASCII text', () => {
    expect(looksBinary(utf8('café \u{1f37a} €'.repeat(10)))).toBe(false);
  });

  it('is true when more than 10% of the sample is control characters', () => {
    // 2 control bytes in 10 = 20%.
    expect(looksBinary(bytes(0x01, 0x02, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41))).toBe(true);
  });

  it('is false at exactly 10% control characters', () => {
    expect(looksBinary(bytes(0x01, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41))).toBe(false);
  });

  it('is false for empty input', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  it('only looks at the sample: a NUL after the sample is ignored', () => {
    const data = new Uint8Array(100).fill(0x41);
    data[50] = 0;
    expect(looksBinary(data, 50)).toBe(false);
    expect(looksBinary(data, 51)).toBe(true);
  });

  it('only looks at the default 8 KiB sample', () => {
    const data = new Uint8Array(10_000).fill(0x41);
    data[9000] = 0;
    expect(looksBinary(data)).toBe(false);
    data[100] = 0;
    expect(looksBinary(data)).toBe(true);
  });

  it('only looks at the sample: control characters after the sample are ignored', () => {
    const data = new Uint8Array(200).fill(0x41);
    data.fill(0x01, 100);
    expect(looksBinary(data, 100)).toBe(false);
    expect(looksBinary(data)).toBe(true);
  });
});
