/**
 * A small, explicit CSV parser (RFC 4180 flavour) for tag lists.
 *
 * Why hand-written instead of a CSV library: an importer runs inside a host on untrusted
 * input, so every dependency is code the host has to trust and ship. The subset needed here
 * is tiny (comma separator, double-quoted fields, `""` escapes, newlines inside quotes),
 * and owning it lets us report malformed records with line numbers and keep their raw text
 * for the rejected-rows sidecar, which general-purpose parsers rarely expose. If your
 * format needs more (other separators, comments, BOM-per-record oddities), a maintained
 * library such as `csv-parse` is a fine swap; keep the "never throw" contract.
 *
 * Input must already be decoded and newline-normalised (`\n` only).
 */

export interface CsvRecord {
  /** 1-based line on which the record starts (records with quoted newlines span lines). */
  line: number;
  fields: string[];
  /** The record's text exactly as it appeared (without its trailing newline). */
  raw: string;
}

export interface CsvProblem {
  line: number;
  message: string;
  /** The malformed record's text, so it can be preserved verbatim. */
  raw: string;
}

export interface CsvParseResult {
  /** Well-formed records in input order. Blank lines are skipped. */
  records: CsvRecord[];
  /** Malformed records, in input order. They are not in `records`. */
  problems: CsvProblem[];
}

/** Parses CSV text. Never throws: malformed records become `problems`. */
export function parseCsv(text: string): CsvParseResult {
  const records: CsvRecord[] = [];
  const problems: CsvProblem[] = [];
  let index = 0;
  let line = 1;

  while (index < text.length) {
    const recordStart = index;
    const recordLine = line;
    const fields: string[] = [];
    let problem: string | undefined;

    // One iteration per field; `atRecordEnd` turns true at `\n` or end of input.
    let atRecordEnd = false;
    while (!atRecordEnd) {
      let value = '';
      if (text[index] === '"') {
        // Quoted field: runs to the next lone `"`; `""` is an escaped quote and newlines
        // are part of the value.
        index += 1;
        let closed = false;
        while (index < text.length) {
          const char = text[index] as string;
          if (char === '"') {
            if (text[index + 1] === '"') {
              value += '"';
              index += 2;
              continue;
            }
            index += 1;
            closed = true;
            break;
          }
          if (char === '\n') line += 1;
          value += char;
          index += 1;
        }
        if (!closed) {
          problem = 'unterminated quoted field (missing closing ")';
          break;
        }
        const next = text[index];
        if (next !== undefined && next !== ',' && next !== '\n') {
          problem = `unexpected ${JSON.stringify(next)} after a closing quote`;
          break;
        }
      } else {
        // Unquoted field: runs to the next comma or newline. A `"` here is malformed
        // (RFC 4180 only allows quotes in quoted fields), and silently keeping it would
        // hide a broken export.
        while (index < text.length && text[index] !== ',' && text[index] !== '\n') {
          if (text[index] === '"') problem ??= 'double quote inside an unquoted field';
          value += text[index];
          index += 1;
        }
        if (problem) break;
      }
      fields.push(value);
      if (text[index] === ',') {
        index += 1;
      } else {
        atRecordEnd = true;
      }
    }

    if (problem !== undefined) {
      // Resynchronise at the next newline; an unterminated quote swallows the rest.
      const newline = text.indexOf('\n', index);
      const end = newline === -1 ? text.length : newline;
      problems.push({ line: recordLine, message: problem, raw: text.slice(recordStart, end).replace(/\n$/, '') });
      index = newline === -1 ? text.length : newline + 1;
      line = recordLine + countNewlines(text.slice(recordStart, index));
      continue;
    }

    const raw = text.slice(recordStart, index);
    if (text[index] === '\n') {
      index += 1;
      line += 1;
    }
    // A blank line parses as one empty field; skip it rather than reporting a bad row.
    if (!(fields.length === 1 && fields[0] === '')) {
      records.push({ line: recordLine, fields, raw });
    }
  }

  return { records, problems };
}

function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) if (char === '\n') count += 1;
  return count;
}

