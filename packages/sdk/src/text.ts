/**
 * Text helpers for untrusted PLC exports, which arrive as UTF-8, UTF-8 with a BOM, UTF-16
 * (some Windows tools) or a legacy 8-bit code page (Windows-1252 is by far the most common).
 */

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  text: string;
  /** Encoding actually used. */
  encoding: TextEncodingName;
  /** A byte-order mark was present and stripped. */
  bom: boolean;
  /**
   * Some bytes could not be decoded and became U+FFFD. Never true for Windows-1252, which
   * maps every byte; the importer should still warn that the encoding was guessed.
   */
  lossy: boolean;
}

export interface DecodeTextOptions {
  /**
   * What to do with bytes that are not valid UTF-8 (and have no BOM):
   * - `windows-1252` (default): decode as Windows-1252, the usual legacy PLC code page.
   * - `replace`: decode as UTF-8 with U+FFFD replacement characters (`lossy: true`).
   */
  fallback?: 'windows-1252' | 'replace';
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function decode(encoding: TextEncodingName, bytes: Uint8Array): { text: string; lossy: boolean } {
  try {
    return {
      text: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes),
      lossy: false,
    };
  } catch {
    return {
      text: new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(bytes),
      lossy: true,
    };
  }
}

/** Decodes bytes as text. Never throws. */
export function decodeText(bytes: Uint8Array, options: DecodeTextOptions = {}): DecodedText {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return { ...decode('utf-8', bytes.subarray(3)), encoding: 'utf-8', bom: true };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return { ...decode('utf-16le', bytes.subarray(2)), encoding: 'utf-16le', bom: true };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return { ...decode('utf-16be', bytes.subarray(2)), encoding: 'utf-16be', bom: true };
  }
  const utf8 = decode('utf-8', bytes);
  if (!utf8.lossy || options.fallback === 'replace') {
    return { ...utf8, encoding: 'utf-8', bom: false };
  }
  return {
    text: new TextDecoder('windows-1252').decode(bytes),
    encoding: 'windows-1252',
    bom: false,
    lossy: false,
  };
}

/** Converts CRLF and lone CR line endings to LF. */
export function normalizeNewlines(text: string): { text: string; changed: boolean } {
  const normalized = text.replace(/\r\n?/g, '\n');
  return { text: normalized, changed: normalized !== text };
}

/**
 * Cheap binary sniff over the first `sampleBytes` bytes: true when the sample contains a
 * NUL byte (unless it starts with a UTF-16 BOM) or more than 10% of it is C0 control
 * characters other than tab, LF, FF and CR. Empty input is not binary.
 */
export function looksBinary(bytes: Uint8Array, sampleBytes = 8192): boolean {
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return false;
  const sample = bytes.subarray(0, sampleBytes);
  if (sample.length === 0) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      controls += 1;
    }
  }
  return controls / sample.length > 0.1;
}
