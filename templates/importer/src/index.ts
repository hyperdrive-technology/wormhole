/**
 * Example Wormhole importer: CSV tag lists → IEC 61131-3 `VAR_GLOBAL` blocks.
 *
 * Copy this project, rename it (see README.md) and replace the CSV specifics with your
 * format. The parts worth keeping whatever the format:
 * - `detect()` only sniffs headers with `files.head()`, never parses whole files;
 * - `import()` never throws for bad input: every problem becomes a diagnostic with a path
 *   (and line where known), and anything that could not be converted is kept verbatim in a
 *   `preservation/` sidecar;
 * - `ctx.throwIfAborted()` runs at the start and regularly inside loops;
 * - output is deterministic: files in `files.paths()` order (already sorted), rows in input
 *   order, no timestamps, no `Math.random()`, no environment lookups.
 */
import {
  checkRelativePath,
  decodeText,
  defineImporter,
  looksBinary,
  normalizeNewlines,
  parseImporterManifest,
  type DetectResult,
  type ImportContext,
  type ImportResult,
  type ImporterDiagnostic,
  type UpgradeRule,
} from '@wormhole/sdk';

import manifestJson from '../wormhole.importer.json';
import { parseCsv, type CsvRecord } from './csv.js';
import {
  checkType,
  initialValueProblem,
  nameProblem,
  renderDeclaration,
  sanitizeComment,
  type TagDeclaration,
} from './tags.js';

/** Validated at module load: a broken manifest fails fast, before any host registers it. */
export const manifest = parseImporterManifest(manifestJson);

export const CAPABILITY_ID = 'example.csv-tags';

/** Bytes sniffed per file in detect(): far more than any header row needs. */
const DETECT_SNIFF_BYTES = 4096;
/** Files sniffed in detect(); keeps detect() cheap on directories with many CSVs. */
const DETECT_SNIFF_FILES = 4;
/** Rows between abort checks: often enough to stop quickly, rare enough to cost nothing. */
const ROWS_PER_ABORT_CHECK = 256;

/** Diagnostic codes. Prefix them with your vendor/format so they are unique in a host. */
export const Code = {
  NO_INPUT: 'EXAMPLE_CSV_NO_INPUT',
  EMPTY_FILE: 'EXAMPLE_CSV_EMPTY_FILE',
  BINARY_FILE: 'EXAMPLE_CSV_BINARY_FILE',
  ENCODING_GUESSED: 'EXAMPLE_CSV_ENCODING_GUESSED',
  ENCODING_LOSSY: 'EXAMPLE_CSV_ENCODING_LOSSY',
  LINE_ENDINGS_NORMALIZED: 'EXAMPLE_CSV_LINE_ENDINGS_NORMALIZED',
  UNPORTABLE_PATH: 'EXAMPLE_CSV_UNPORTABLE_PATH',
  OUTPUT_COLLISION: 'EXAMPLE_CSV_OUTPUT_COLLISION',
  MISSING_COLUMNS: 'EXAMPLE_CSV_MISSING_COLUMNS',
  DUPLICATE_COLUMN: 'EXAMPLE_CSV_DUPLICATE_COLUMN',
  MALFORMED_ROW: 'EXAMPLE_CSV_MALFORMED_ROW',
  INVALID_ROW: 'EXAMPLE_CSV_INVALID_ROW',
  DUPLICATE_TAG: 'EXAMPLE_CSV_DUPLICATE_TAG',
  COMMENT_SANITIZED: 'EXAMPLE_CSV_COMMENT_SANITIZED',
  NO_TAGS: 'EXAMPLE_CSV_NO_TAGS',
} as const;

const COLUMNS = ['name', 'type', 'initial', 'comment'] as const;
type Column = (typeof COLUMNS)[number];
const REQUIRED_COLUMNS: readonly Column[] = ['name', 'type'];

function diagnostic(
  code: string,
  severity: ImporterDiagnostic['severity'],
  message: string,
  path?: string,
  startLine?: number,
): ImporterDiagnostic {
  return {
    code,
    severity,
    message,
    ...(path !== undefined ? { source: { path, ...(startLine !== undefined ? { startLine } : {}) } } : {}),
  };
}

/** Maps each known column to its index in the header row (first occurrence wins). */
function columnIndexes(header: CsvRecord): { indexes: Partial<Record<Column, number>>; duplicates: Column[] } {
  const indexes: Partial<Record<Column, number>> = {};
  const duplicates: Column[] = [];
  header.fields.forEach((field, index) => {
    const column = field.trim().toLowerCase() as Column;
    if (!COLUMNS.includes(column)) return; // extra columns are allowed and ignored
    if (indexes[column] === undefined) indexes[column] = index;
    else if (!duplicates.includes(column)) duplicates.push(column);
  });
  return { indexes, duplicates };
}

function hasRequiredColumns(header: CsvRecord | undefined): boolean {
  if (!header) return false;
  const { indexes } = columnIndexes(header);
  return REQUIRED_COLUMNS.every((column) => indexes[column] !== undefined);
}

/**
 * Legacy-literal upgrade, borrowed from `@wormhole/migrate` through `ctx.migrate`.
 *
 * IEC 61131-3 Edition 4 deleted octal literals (`8#17`). Old tag exports still contain
 * them, so each initial value goes through the shared `octal-to-hex` rule (`8#17` →
 * `16#F`). Only that rule is used: the full default pipeline also rewrites IL bodies,
 * TRUNC calls and so on, which cannot occur in a single literal. An importer that emits
 * whole POUs would call `ctx.migrate.upgradeSource(text, options)` with every default rule,
 * like `@wormhole/iec61131-upgrade` does.
 */
function literalUpgradeRules(ctx: ImportContext): UpgradeRule[] {
  return ctx.migrate.defaultRules.filter((rule) => rule.id === 'octal-to-hex');
}

interface Rejected {
  line: number;
  raw: string;
}

export const csvTagsImporter = defineImporter({
  manifest,

  detect({ files }): DetectResult | null {
    const candidates = files.pathsWithExtension('.csv');
    if (candidates.length === 0) return null;
    for (const path of candidates.slice(0, DETECT_SNIFF_FILES)) {
      const head = files.head(path, DETECT_SNIFF_BYTES);
      if (!head || looksBinary(head)) continue;
      // `replace`: the sniff may cut a multi-byte character in half; that must not matter.
      const text = normalizeNewlines(decodeText(head, { fallback: 'replace' }).text).text;
      const { records, problems } = parseCsv(text.split('\n', 1)[0] ?? '');
      if (problems.length === 0 && hasRequiredColumns(records[0])) {
        return { capabilityId: CAPABILITY_ID, confidence: 0.9, reason: `${path} has a name,type tag-list header` };
      }
    }
    return {
      capabilityId: CAPABILITY_ID,
      confidence: 0.2,
      reason: `found ${candidates.length} .csv file(s) without a name,type header`,
    };
  },

  import({ files }, ctx): ImportResult {
    ctx.throwIfAborted();
    const diagnostics: ImporterDiagnostic[] = [];
    const sources: Record<string, string> = {};
    const preservation: Record<string, string> = {};
    const usedOutputPaths = new Set<string>();
    /** Upper-case tag name → where it was first declared. IEC identifiers ignore case. */
    const declared = new Map<string, { path: string; line: number }>();
    const upgradeRules = literalUpgradeRules(ctx);
    const stats = { csvFiles: 0, filesConverted: 0, filesSkipped: 0, tags: 0, rowsRejected: 0, valuesUpgraded: 0 };

    const paths = files.pathsWithExtension('.csv');
    stats.csvFiles = paths.length;
    if (paths.length === 0) {
      diagnostics.push(diagnostic(Code.NO_INPUT, 'error', 'The input contains no .csv files.'));
    }

    for (const path of paths) {
      ctx.throwIfAborted();
      const skip = (code: string, severity: ImporterDiagnostic['severity'], message: string, line?: number): void => {
        diagnostics.push(diagnostic(code, severity, message, path, line));
        stats.filesSkipped += 1;
      };

      const stem = path.replace(/\.csv$/i, '');
      if (stem.length === 0 || stem.endsWith('/')) {
        skip(Code.UNPORTABLE_PATH, 'error', `${path} has no file name before ".csv", so it has no output name; it was skipped.`);
        continue;
      }
      const outputPath = `sources/${stem}.plc`;
      const sidecarPath = `preservation/${path}.rejected.csv`;
      const unportable = [outputPath, sidecarPath]
        .map((candidate) => checkRelativePath(candidate, { portable: true }))
        .find((checked) => !checked.ok);
      if (unportable && !unportable.ok) {
        skip(Code.UNPORTABLE_PATH, 'error', `${path} cannot be converted: its output path ${unportable.reason}.`);
        continue;
      }
      // `a.csv` and `A.CSV` would produce the same file on Windows and macOS.
      if (usedOutputPaths.has(outputPath.toLowerCase())) {
        skip(Code.OUTPUT_COLLISION, 'error', `${path} would overwrite another file's output ${outputPath} and was skipped.`);
        continue;
      }
      usedOutputPaths.add(outputPath.toLowerCase());

      const bytes = files.read(path) ?? new Uint8Array(0);
      if (bytes.byteLength === 0) {
        skip(Code.EMPTY_FILE, 'warning', `${path} is empty and was skipped.`);
        continue;
      }
      if (looksBinary(bytes)) {
        skip(Code.BINARY_FILE, 'error', `${path} is binary, not a CSV text file, and was skipped.`);
        continue;
      }
      const decoded = decodeText(bytes);
      if (decoded.encoding === 'windows-1252') {
        diagnostics.push(diagnostic(Code.ENCODING_GUESSED, 'warning', `${path} is not valid UTF-8; decoded as Windows-1252. Check non-ASCII characters in names and comments.`, path));
      } else if (decoded.lossy) {
        diagnostics.push(diagnostic(Code.ENCODING_LOSSY, 'warning', `${path} has bytes that are invalid in ${decoded.encoding}; they were replaced with U+FFFD.`, path));
      }
      const newlines = normalizeNewlines(decoded.text);
      if (newlines.changed) {
        diagnostics.push(diagnostic(Code.LINE_ENDINGS_NORMALIZED, 'info', `${path}: CRLF/CR line endings were converted to LF.`, path));
      }

      const { records, problems } = parseCsv(newlines.text);
      // The header is the first well-formed record, unless a malformed record comes first.
      const header = records[0] !== undefined && records[0].line < (problems[0]?.line ?? Infinity) ? records[0] : undefined;
      if (!header || !hasRequiredColumns(header)) {
        skip(Code.MISSING_COLUMNS, 'error', `${path} has no header row with "name" and "type" columns; nothing was converted.`, header?.line ?? 1);
        // Keep the whole file: nothing in it was converted.
        preservation[sidecarPath] = newlines.text;
        stats.rowsRejected += records.length + problems.length - (header ? 1 : 0);
        continue;
      }
      const { indexes, duplicates } = columnIndexes(header);
      for (const column of duplicates) {
        diagnostics.push(diagnostic(Code.DUPLICATE_COLUMN, 'warning', `${path}: column "${column}" appears more than once; the first one is used.`, path, header.line));
      }

      // Row-level diagnostics are collected per file and sorted by line before they are
      // added, so malformed records (found by the parser) and invalid rows interleave in
      // the order a user reads the file.
      const rowDiagnostics: ImporterDiagnostic[] = [];
      // Rejected rows for the sidecar, so a user can fix and re-import them. "Verbatim" means
      // the row's text as decoded: UTF-8 with LF line endings, whatever the input used.
      const rejected: Rejected[] = problems.map((problem) => {
        rowDiagnostics.push(diagnostic(Code.MALFORMED_ROW, 'error', `${path}:${problem.line}: ${problem.message}; the row was not converted.`, path, problem.line));
        return { line: problem.line, raw: problem.raw };
      });
      const declarations: string[] = [];
      const field = (record: CsvRecord, column: Column): string => {
        const index = indexes[column];
        return index === undefined ? '' : (record.fields[index] ?? '').trim();
      };

      for (const [rowIndex, record] of records.slice(1).entries()) {
        if (rowIndex % ROWS_PER_ABORT_CHECK === 0) ctx.throwIfAborted();
        const name = field(record, 'name');
        const type = checkType(field(record, 'type'));
        let initial = field(record, 'initial');
        const reasons = [
          nameProblem(name),
          type.ok ? undefined : type.reason,
          initialValueProblem(initial),
        ].filter((reason): reason is string => reason !== undefined);
        if (reasons.length > 0) {
          rowDiagnostics.push(diagnostic(Code.INVALID_ROW, 'error', `${path}:${record.line}: ${reasons.join('; ')}; the row was not converted.`, path, record.line));
          rejected.push({ line: record.line, raw: record.raw });
          continue;
        }
        const first = declared.get(name.toUpperCase());
        if (first) {
          rowDiagnostics.push(diagnostic(Code.DUPLICATE_TAG, 'error', `${path}:${record.line}: tag ${name} is already declared at ${first.path}:${first.line}; the first declaration was kept.`, path, record.line));
          rejected.push({ line: record.line, raw: record.raw });
          continue;
        }
        declared.set(name.toUpperCase(), { path, line: record.line });

        // String literals are left alone: the octal rule is not string-aware and would turn
        // the text '8#17' into '16#F'.
        const isStringLiteral = initial.startsWith("'") || initial.startsWith('"');
        if (initial.length > 0 && !isStringLiteral && upgradeRules.length > 0) {
          const upgraded = ctx.migrate.upgradeSource(initial, { sourceKind: 'st', fileName: path, apply: true }, upgradeRules);
          if (upgraded.changed) {
            initial = upgraded.source;
            stats.valuesUpgraded += 1;
          }
          // migrate numbers lines within the literal (always 1); point at the CSV row instead.
          rowDiagnostics.push(...upgraded.diagnostics.map((d) => ({ ...d, source: { path, startLine: record.line } })));
        }
        const comment = sanitizeComment(field(record, 'comment'));
        if (comment.changed) {
          rowDiagnostics.push(diagnostic(Code.COMMENT_SANITIZED, 'info', `${path}:${record.line}: the comment for ${name} contained line breaks or comment delimiters; they were neutralised.`, path, record.line));
        }
        const tag: TagDeclaration = { name, type: type.ok ? type.type : '', initial, comment: comment.text };
        declarations.push(`    ${renderDeclaration(tag)}`);
      }

      // Array.prototype.sort is stable, so diagnostics on the same line keep their order.
      diagnostics.push(...rowDiagnostics.sort((a, b) => (a.source?.startLine ?? 0) - (b.source?.startLine ?? 0)));
      if (rejected.length > 0) {
        rejected.sort((a, b) => a.line - b.line);
        preservation[sidecarPath] = [header.raw, ...rejected.map((row) => row.raw)].join('\n') + '\n';
        stats.rowsRejected += rejected.length;
      }
      if (declarations.length === 0) {
        skip(Code.NO_TAGS, 'warning', `${path} contains no convertible tags.`);
        continue;
      }
      const origin = sanitizeComment(path).text;
      sources[outputPath] = [
        `(* Generated by ${manifest.id} ${manifest.version} from ${origin}. *)`,
        'VAR_GLOBAL',
        ...declarations,
        'END_VAR',
        '',
      ].join('\n');
      stats.filesConverted += 1;
      stats.tags += declarations.length;
      ctx.logger.debug('converted tag list', { path, tags: declarations.length, rejected: rejected.length });
    }

    return {
      sources,
      diagnostics,
      ...(Object.keys(preservation).length > 0 ? { preservation } : {}),
      summary: {
        message:
          paths.length === 0
            ? 'No CSV tag lists found.'
            : `Converted ${stats.tags} tag(s) from ${stats.filesConverted} of ${paths.length} CSV file(s); ${stats.rowsRejected} row(s) rejected, ${stats.filesSkipped} file(s) skipped.`,
        stats,
      },
    };
  },
});

export default csvTagsImporter;
