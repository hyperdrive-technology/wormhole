import type { ImporterDiagnostic } from '@wormhole/contract';
import { ilPreservationSidecar } from '../migration-helpers.js';
import { ForwardSearch, spliceRanges } from '../scan.js';
import {
  diagnostic,
  lineNumberAt,
  type UpgradeOptions,
  type UpgradeRule,
  type UpgradeRuleResult,
} from '../types.js';

const IL_KEYWORD = /^(?:LD|LDN|ST|STN|AND|ANDN|OR|ORN|XOR|XORN|NOT|ADD|SUB|MUL|DIV|MOD|GT|GE|EQ|NE|LE|LT|JMP|JMPC|CAL|RET|S|R)\b/i;
const LINE_TERMINATOR = /[\r\u2028\u2029]/;
const POU_HEADER = /(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+[A-Za-z_][A-Za-z0-9_]*/gi;
const POU_END = /END_(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)/gi;

/**
 * Whether a `\n`-separated line holds an IL instruction: what
 * `/^\s*(?:LD|...|R)\b/im.test(line)` answers. With `m`, `^` also matches after `\r`, U+2028 and
 * U+2029, so the line is split on those and each piece checked once. The regex retried `\s*`
 * from every one of those line starts, O(n^2) on a run of `\r` (wormhole#5).
 */
function isIlInstructionLine(line: string): boolean {
  return line.split(LINE_TERMINATOR).some((piece) => IL_KEYWORD.test(piece.trimStart()));
}

function extractIlBody(pouBody: string): string | undefined {
  const lines = pouBody.split('\n');
  const ilLines = lines.filter(isIlInstructionLine);
  if (ilLines.length === 0) return undefined;
  return ilLines.join('\n').trim();
}

function pouNameFromHeader(header: string): string {
  const match = header.match(/(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  return match?.[1] ?? 'LegacyPou';
}

interface PouMatch {
  start: number;
  /** Header through the last character before the END_ keyword. */
  bodyPrefix: string;
  endKeyword: string;
  end: number;
}

/**
 * What `/((?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+<ident>[\s\S]*?)(END_(?:PROGRAM|...))/gi`
 * matches, in linear time (wormhole#5). The lazy `[\s\S]*?` rescanned to the end of the input
 * for every header with no END_ after it, O(n^2) on `PROGRAM a LD x\n` repeated.
 *
 * Here the END_ search is forward-only and cached. When no END_ follows the whole identifier,
 * the regex would backtrack into the identifier (`PROGRAM aEND_PROGRAM`): the match then ends
 * at the last END_ that starts inside it after its first character.
 */
function findPous(source: string, checkpoint: (() => void) | undefined): PouMatch[] {
  const pous: PouMatch[] = [];
  const header = new RegExp(POU_HEADER.source, POU_HEADER.flags);
  const end = new ForwardSearch(source, POU_END);
  for (let match = header.exec(source); match !== null; match = header.exec(source)) {
    checkpoint?.();
    const identEnd = header.lastIndex;
    let endMatch: { index: number; 0: string } | null = end.from(identEnd);
    if (endMatch === null) {
      let identStart = identEnd;
      while (/[A-Za-z0-9_]/.test(source[identStart - 1] as string)) identStart -= 1;
      endMatch = lastMatchIn(source, POU_END, identStart + 1, identEnd);
    }
    if (endMatch === null) {
      // No match starts here; like a global regex, try again one character later.
      header.lastIndex = match.index + 1;
      continue;
    }
    const matchEnd = endMatch.index + endMatch[0].length;
    pous.push({
      start: match.index,
      bodyPrefix: source.slice(match.index, endMatch.index),
      endKeyword: endMatch[0],
      end: matchEnd,
    });
    header.lastIndex = matchEnd;
  }
  return pous;
}

/**
 * The last match of global `pattern` that starts in `[from, to)`, where `[from, to)` lies inside
 * one identifier. Searches only that identifier: a search of `source` from `from` would scan
 * to the end of the input whenever nothing matches (wormhole#5). END_ keywords are word
 * characters, so a match starting inside the identifier also ends inside it.
 */
function lastMatchIn(source: string, pattern: RegExp, from: number, to: number): { index: number; 0: string } | null {
  const word = source.slice(from, to);
  const search = new RegExp(pattern.source, pattern.flags);
  let last: { index: number; 0: string } | null = null;
  for (let match = search.exec(word); match !== null; match = search.exec(word)) {
    last = { index: from + match.index, 0: match[0] };
    search.lastIndex = match.index + 1;
  }
  return last;
}

export const ilPreservationRule: UpgradeRule = {
  id: 'il-preservation',
  tier: 'C',
  run(source, options): UpgradeRuleResult {
    const diagnostics: ImporterDiagnostic[] = [];
    const preservation: Record<string, string> = {};
    let changed = false;
    const pouOccurrences = new Map<string, number>();

    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const pou of findPous(source, options.checkpoint)) {
      const { bodyPrefix, endKeyword } = pou;
      const ilBody = extractIlBody(bodyPrefix);
      if (!ilBody) continue;

      const pouName = pouNameFromHeader(bodyPrefix);
      const sidecar = ilPreservationSidecar(ilBody, pouName);
      // IEC identifiers are case-insensitive, so `Dup` and `DUP` in one file are the same POU
      // declared twice (invalid, but legacy input does it). Number the repeats instead of
      // letting the second body overwrite the first.
      const pouKey = pouName.toLowerCase();
      const occurrence = (pouOccurrences.get(pouKey) ?? 0) + 1;
      pouOccurrences.set(pouKey, occurrence);
      const preservationPath = ilSidecarPath(options.fileName, pouName, occurrence);
      const startLine = lineNumberAt(source, pou.start);

      if (occurrence > 1) {
        diagnostics.push(
          diagnostic(
            'WORMHOLE_IL_DUPLICATE_POU',
            `${pouName} is declared more than once in this file; this copy's IL was preserved at ${preservationPath}`,
            'warning',
            options,
            'IEC 61131-3 POU names are case-insensitive and must be unique; rename or remove the duplicate.',
            startLine,
          ),
        );
      }

      preservation[preservationPath] = sidecar.preservationBlob;

      diagnostics.push(
        diagnostic(
          'WORMHOLE_IL_PRESERVATION',
          `Preserved native IL for ${pouName} at ${preservationPath}`,
          'warning',
          options,
          'Replace ST placeholder with migrated logic before canonical export.',
          startLine,
        ),
      );

      if (!options.apply) continue;

      changed = true;
      const headerEnd = bodyPrefix.search(/END_VAR\s*\n/i);
      const insertionPoint = headerEnd >= 0 ? headerEnd + 'END_VAR'.length + 1 : bodyPrefix.length;
      const preservedPrefix = bodyPrefix.slice(0, insertionPoint);
      edits.push({ start: pou.start, end: pou.end, text: `${preservedPrefix}\n${sidecar.stPlaceholder}\n${endKeyword}` });
    }
    const next = spliceRanges(source, edits);

    return { source: next, changed, diagnostics, preservation };
  },
};

/**
 * The source's relative path without its `.plc`/`.st` extension, NFC-normalised, with `/`
 * separators and no empty, `.` or `..` segments: `x\\main.st` -> `x/main`. Using the whole path (not just
 * the base name) is what keeps `x/main.st` and `y/main.st` from sharing a sidecar, the same
 * way `sources/x/main.plc` and `sources/y/main.plc` stay apart.
 */
export function ilSidecarStem(fileName: string): string {
  // NFC, like checkRelativePath and the archive builder: macOS hands out decomposed (NFD)
  // names, and a sidecar named from the raw form would not match its own normalised path
  // (wormhole#9).
  const segments = fileName.normalize('NFC').split(/[/\\]+/).filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return segments.join('/').replace(/\.(plc|st)$/i, '') || 'source';
}

/**
 * `preservation/il/<stem>-<POU>[-<n>].il.txt`. Collision-free for distinct (case-insensitive)
 * source stems: POU names are identifiers (no `-`, never starting with a digit), so the last
 * `-<identifier>` and the optional `-<n>` repeat counter are unambiguous.
 */
export function ilSidecarPath(fileName: string, pouName: string, occurrence = 1): string {
  const repeat = occurrence > 1 ? `-${occurrence}` : '';
  return `preservation/il/${ilSidecarStem(fileName)}-${pouName}${repeat}.il.txt`;
}
