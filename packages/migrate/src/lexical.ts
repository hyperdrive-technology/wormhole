/**
 * Minimal IEC 61131-3 lexical scan: splits source text into "code" and "non-code" spans so
 * text rewrites (octal literals, ...) never touch comments, strings or pragmas.
 *
 * Non-code spans:
 * - `(* ... *)` and `/* ... *\/` block comments. Not nested: IEC 61131-3 Ed. 3 leaves
 *   nested comments implementation-dependent and most tools do not nest, so the first
 *   closing delimiter ends the comment. An unclosed comment runs to end of input (we then
 *   leave the rest untouched rather than rewrite text that might be commentary).
 * - `// ...` line comments, up to (not including) the line break.
 * - `'...'` and `"..."` string literals. `$` escapes the next character (`$'`, `$$`,
 *   `$N`, ...), so `'it$'s'` is one string. Unclosed strings run to end of line, since
 *   IEC strings cannot span lines.
 * - `{ ... }` pragmas (vendor attributes), not nested.
 */
export interface SourceSpan {
  start: number;
  end: number;
  code: boolean;
}

export function scanSourceSpans(source: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let codeStart = 0;
  let index = 0;

  const pushNonCode = (start: number, end: number): void => {
    if (start > codeStart) spans.push({ start: codeStart, end: start, code: true });
    spans.push({ start, end, code: false });
    codeStart = end;
    index = end;
  };
  const endOf = (closer: string, from: number): number => {
    const found = source.indexOf(closer, from);
    return found === -1 ? source.length : found + closer.length;
  };
  // A global regex searched from `from`: `source.slice(from).search(...)` copied
  // the rest of the input for every line comment, which is O(n^2) on `// c\n` repeated
  // (wormhole#5).
  const lineBreak = /[\r\n]/g;
  const endOfLine = (from: number): number => {
    lineBreak.lastIndex = from;
    const found = lineBreak.exec(source);
    return found === null ? source.length : found.index;
  };
  const endOfString = (quote: string, from: number): number => {
    let cursor = from + 1;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === '$') cursor += 2;
      else if (char === quote) return cursor + 1;
      else if (char === '\n' || char === '\r') return cursor;
      else cursor += 1;
    }
    return source.length;
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '(' && next === '*') pushNonCode(index, endOf('*)', index + 2));
    else if (char === '/' && next === '*') pushNonCode(index, endOf('*/', index + 2));
    else if (char === '/' && next === '/') pushNonCode(index, endOfLine(index));
    else if (char === "'" || char === '"') pushNonCode(index, endOfString(char, index));
    else if (char === '{') pushNonCode(index, endOf('}', index + 1));
    else index += 1;
  }
  if (codeStart < source.length) spans.push({ start: codeStart, end: source.length, code: true });
  return spans;
}

/**
 * `String.prototype.replace` restricted to code spans. `replacer` receives the match, its
 * capture groups and its offset in the *whole* source, like a normal replace callback.
 */
export function replaceInCode(
  source: string,
  pattern: RegExp,
  replacer: (match: string, groups: string[], offset: number) => string,
): string {
  if (!pattern.global) throw new Error('replaceInCode needs a global RegExp');
  return scanSourceSpans(source)
    .map((span) => {
      const text = source.slice(span.start, span.end);
      if (!span.code) return text;
      return text.replace(pattern, (match: string, ...rest: unknown[]) => {
        const offsetIndex = rest.findIndex((value) => typeof value === 'number');
        const groups = rest.slice(0, offsetIndex) as string[];
        return replacer(match, groups, span.start + (rest[offsetIndex] as number));
      });
    })
    .join('');
}

/** Matches of a global `pattern` in code spans only, with offsets into the whole source. */
export function matchAllInCode(source: string, pattern: RegExp): Array<{ match: string; offset: number }> {
  if (!pattern.global) throw new Error('matchAllInCode needs a global RegExp');
  const found: Array<{ match: string; offset: number }> = [];
  for (const span of scanSourceSpans(source)) {
    if (!span.code) continue;
    for (const match of source.slice(span.start, span.end).matchAll(pattern)) {
      found.push({ match: match[0], offset: span.start + (match.index ?? 0) });
    }
  }
  return found;
}
