/**
 * Validation and ST rendering for one tag (one CSV row). Pure functions, no SDK imports,
 * so they are easy to unit-test and to reuse.
 */

/** IEC 61131-3 identifier, ASCII subset. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keywords that cannot be used as a tag name. Not the full IEC keyword list, just the ones a
 * tag list plausibly contains by mistake and that would break the generated declaration.
 */
const RESERVED_WORDS = new Set([
  'AND', 'AT', 'CASE', 'CONSTANT', 'DO', 'ELSE', 'ELSIF', 'END_CASE', 'END_FOR', 'END_IF',
  'END_REPEAT', 'END_VAR', 'END_WHILE', 'EXIT', 'FALSE', 'FOR', 'FUNCTION', 'FUNCTION_BLOCK',
  'IF', 'MOD', 'NOT', 'OF', 'OR', 'PROGRAM', 'REPEAT', 'RETAIN', 'RETURN', 'THEN', 'TO', 'TRUE',
  'UNTIL', 'VAR', 'VAR_GLOBAL', 'WHILE', 'XOR',
]);

/** Elementary types the example accepts (compared upper-case). Extend for your format. */
export const ELEMENTARY_TYPES: ReadonlySet<string> = new Set([
  'BOOL',
  'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
  'TIME', 'LTIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
  'STRING', 'WSTRING', 'CHAR', 'WCHAR',
]);

/** `STRING[80]` / `WSTRING[80]`: sized strings, 1..65535 characters. */
const SIZED_STRING = /^(W?STRING)\[([1-9][0-9]{0,4})\]$/;

/**
 * What an initial value may look like. Deliberately conservative, because the value is
 * pasted into generated source: anything that could end the declaration (`;`), open or
 * close a comment, or span lines is refused rather than escaped.
 *
 * - a single-quoted STRING literal or double-quoted WSTRING literal, with IEC `$` escapes
 *   (`'it$'s'`, `"$N"`);
 * - or one bare literal token: numbers (`-1.5E3`, `16#FF`, `8#17`), `TRUE`/`FALSE`, typed
 *   and duration literals (`T#5s`, `TIME#1h_2m`, `DT#2026-01-01-00:00:00`).
 *
 * It does not check that the value fits the type (`BOOL := 42`); the Hyperdrive compiler
 * reports that with a precise location, so duplicating it here would only drift.
 */
const INITIAL_VALUE = /^(?:'(?:[^'$\n]|\$.)*'|"(?:[^"$\n]|\$.)*"|[A-Za-z0-9_#.:+-]+)$/;

export type TypeCheck = { ok: true; type: string } | { ok: false; reason: string };

/** Returns the reason a name is not usable, or `undefined` when it is fine. */
export function nameProblem(name: string): string | undefined {
  if (name.length === 0) return 'the name is empty';
  if (!IDENTIFIER.test(name)) return `${JSON.stringify(name)} is not a valid IEC 61131-3 identifier (letters, digits and _; must not start with a digit)`;
  if (RESERVED_WORDS.has(name.toUpperCase()) || ELEMENTARY_TYPES.has(name.toUpperCase())) {
    return `${JSON.stringify(name)} is a reserved word`;
  }
  return undefined;
}

/** Normalises a type name to upper case, or explains why it is not supported. */
export function checkType(type: string): TypeCheck {
  const upper = type.toUpperCase();
  if (upper.length === 0) return { ok: false, reason: 'the type is empty' };
  if (ELEMENTARY_TYPES.has(upper)) return { ok: true, type: upper };
  if (SIZED_STRING.test(upper)) return { ok: true, type: upper };
  return { ok: false, reason: `type ${JSON.stringify(type)} is not a supported elementary type` };
}

/** Returns the reason an initial value is not usable, or `undefined` when it is fine. */
export function initialValueProblem(initial: string): string | undefined {
  if (initial.length === 0) return undefined; // no initialiser
  if (!INITIAL_VALUE.test(initial)) {
    return `initial value ${JSON.stringify(initial)} is not a single literal (quotes, ;, comments and line breaks are not allowed outside a string literal)`;
  }
  return undefined;
}

/**
 * Makes free text safe inside an ST `(* ... *)` comment: control characters (including line
 * breaks from quoted CSV fields) become spaces, and the comment delimiters are split with a
 * space so `*)` in a description cannot end the comment early and turn the rest of the line
 * into code. `(*` is split too because some IEC dialects nest comments.
 *
 * Order matters: splitting `(*` first and `*)` second handles overlaps such as `(*)`, and
 * inserting a space after `*` can never create a new `(*`.
 */
export function sanitizeComment(text: string): { text: string; changed: boolean } {
  const sanitized = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\(\*/g, '( *')
    .replace(/\*\)/g, '* )')
    .trim();
  return { text: sanitized, changed: sanitized !== text.trim() };
}

export interface TagDeclaration {
  name: string;
  type: string;
  initial: string;
  comment: string;
}

/** `Name : TYPE := initial; (* comment *)`, with the optional parts left out when empty. */
export function renderDeclaration(tag: TagDeclaration): string {
  const initializer = tag.initial.length > 0 ? ` := ${tag.initial}` : '';
  const comment = tag.comment.length > 0 ? ` (* ${tag.comment} *)` : '';
  return `${tag.name} : ${tag.type}${initializer};${comment}`;
}
