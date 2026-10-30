/**
 * Linear-time scanning helpers for the upgrade rules (wormhole#5).
 *
 * The rules used to call `source.slice(0, offset).split('\n')` for every diagnostic and to
 * run regexes like `HEAD[\s\S]*?TAIL` or `HEAD\s*\([^)]*\)` over the whole file. Each of
 * those is O(n) per match attempt, so hostile input (many heads, no tail) took O(n^2): a
 * 10 MB upload meant tens of minutes of synchronous work that no wall-time limit could
 * interrupt. The helpers here find the head with a regex and the tail with a forward-only
 * cached search, so every character is scanned a bounded number of times.
 */

/** Maps offsets to 1-based line numbers in O(log lines) after one O(n) pass. */
export class LineIndex {
  readonly #starts: number[] = [0];

  constructor(source: string) {
    for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
      this.#starts.push(index + 1);
    }
  }

  /** 1-based line of `offset`: the number of line starts at or before it. */
  lineAt(offset: number): number {
    let low = 0;
    let high = this.#starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.#starts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }
}

let cachedSource: string | undefined;
let cachedIndex: LineIndex | undefined;

/**
 * Same answer as `source.slice(0, offset).split('\n').length`, but builds the line table once
 * per source string and reuses it, so a rule that reports one diagnostic per match stays
 * linear. One-entry cache: rules ask about the same source many times in a row. Comparing a
 * different string of equal length costs at most one O(n) compare per cache miss.
 */
export function lineNumberAt(source: string, offset: number): number {
  if (cachedSource !== source || cachedIndex === undefined) {
    cachedIndex = new LineIndex(source);
    cachedSource = source;
  }
  return cachedIndex.lineAt(offset);
}

/**
 * The first match of a global `pattern` starting at or after a position, with the last answer
 * cached. When positions only grow (the way a left-to-right scan asks), repeated calls cost
 * O(n) in total instead of O(n) each: a cached match that still lies ahead is reused, and a
 * cached "no match" stays valid for every later position.
 */
export class ForwardSearch {
  readonly #source: string;
  readonly #pattern: RegExp;
  #from = -1;
  #found: RegExpExecArray | null | undefined;

  constructor(source: string, pattern: RegExp) {
    if (!pattern.global) throw new Error('ForwardSearch needs a global RegExp');
    this.#source = source;
    // Own copy: lastIndex is mutable state and the caller's regex may be shared.
    this.#pattern = new RegExp(pattern.source, pattern.flags);
  }

  /** First match whose start is >= `from`, or null if there is none. */
  from(from: number): RegExpExecArray | null {
    if (this.#found !== undefined && from >= this.#from) {
      if (this.#found === null) return null;
      if (this.#found.index >= from) return this.#found;
    }
    this.#pattern.lastIndex = from;
    this.#found = this.#pattern.exec(this.#source);
    this.#from = from;
    return this.#found;
  }
}

/** Forward-only search for a fixed string; see {@link ForwardSearch}. */
export class ForwardIndexOf {
  readonly #source: string;
  readonly #needle: string;
  #from = -1;
  #found = -2;

  constructor(source: string, needle: string) {
    this.#source = source;
    this.#needle = needle;
  }

  /** `source.indexOf(needle, from)`, amortised O(1) per call when `from` only grows. */
  from(from: number): number {
    if (this.#found !== -2 && from >= this.#from) {
      if (this.#found === -1 || this.#found >= from) return this.#found;
    }
    this.#found = this.#source.indexOf(this.#needle, from);
    this.#from = from;
    return this.#found;
  }
}

/**
 * A call site `NAME(...)`: an identifier, optional whitespace, `(`, then everything up to the
 * first `)`. This is what `\bNAME\s*\([^)]*\)` matches, found without rescanning: the
 * identifier comes from a regex (linear, one attempt per word start) and the `)` from a
 * cached forward search, so an input full of unclosed `NAME(` stays linear.
 */
export interface CallSite {
  /** Offset of the identifier. */
  start: number;
  name: string;
  /** Offset just after `(`. */
  argsStart: number;
  /** Offset of the closing `)`. */
  close: number;
  /** `source.slice(start, close + 1)`. */
  text: string;
}

const CALL_HEAD = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/**
 * Every call site whose name passes `accept`, left to right and non-overlapping (scanning
 * resumes after an accepted call's `)`, as a global regex would). `accept` may also inspect
 * the arguments and reject; scanning then resumes after the rejected call's `(`.
 * `checkpoint` runs every 1024 heads so a caller can stop a long scan.
 */
export function findCallSites(
  source: string,
  accept: (site: CallSite) => boolean,
  checkpoint?: () => void,
): CallSite[] {
  const sites: CallSite[] = [];
  const head = new RegExp(CALL_HEAD.source, CALL_HEAD.flags);
  const closeParen = new ForwardIndexOf(source, ')');
  let heads = 0;
  for (let match = head.exec(source); match !== null; match = head.exec(source)) {
    if (++heads % 1024 === 0) checkpoint?.();
    const argsStart = head.lastIndex;
    const close = closeParen.from(argsStart);
    // No `)` anywhere after this head means none after any later head either.
    if (close === -1) break;
    const site: CallSite = {
      start: match.index,
      name: match[1] as string,
      argsStart,
      close,
      text: source.slice(match.index, close + 1),
    };
    if (accept(site)) {
      sites.push(site);
      head.lastIndex = close + 1;
    }
  }
  return sites;
}

/**
 * Rebuilds `source` with each `[start, end)` range replaced. Ranges must be sorted and
 * non-overlapping. O(n) in the source and replacement sizes (no repeated `replace` calls).
 */
export function spliceRanges(source: string, edits: ReadonlyArray<{ start: number; end: number; text: string }>): string {
  if (edits.length === 0) return source;
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}
