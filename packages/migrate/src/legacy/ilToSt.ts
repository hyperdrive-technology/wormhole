// IEC 61131-10:2019 still carries an `<IL>` body element, while IEC 61131-3
// Edition 4 (2025) deleted Instruction List from the core language. The XML
// importer therefore translates the *simple accumulator subset* of IL into
// equivalent ST so imported projects compile under the canonical profile, and
// leaves anything richer untouched (preserved losslessly, flagged by
// `IEC61131-IMPORT-IL`) for a human rewrite.
//
// Supported subset (straight-line, no labels / jumps / calls / parentheses):
//   LD  x / LDN x         accumulator := x / NOT x
//   ST  x / STN x         x := acc / x := NOT acc     (acc is unchanged)
//   AND ANDN OR ORN XOR XORN x
//   NOT                   (no operand)
//   ADD SUB MUL DIV x
//   GT GE EQ NE LE LT x
//
// The translation tracks the accumulator ("current result", IEC 61131-3:2013
// §7.1) as an ST expression. Every `ST x` emits `x := <acc>;`. After a store
// the accumulator is re-expressed as the stored variable (`x`, or `NOT x` for
// STN) — that keeps the output short and, more importantly, keeps it correct
// when a later instruction reads a variable the store just overwrote
// (`LD a  ADD b  ST a  ADD c  ST y` must yield `y := a + c`, not
// `y := (a + b) + c` evaluated against the *new* `a`).

export type IlToStResult =
  | { kind: 'translated'; st: string; instructionCount: number }
  | { kind: 'unsupported'; reason: string; line: number };

interface IlInstruction {
  operator: string;
  operand?: string;
  line: number;
}

const OPERAND_OPERATORS = new Set([
  'LD',
  'LDN',
  'ST',
  'STN',
  'AND',
  'ANDN',
  'OR',
  'ORN',
  'XOR',
  'XORN',
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'GT',
  'GE',
  'EQ',
  'NE',
  'LE',
  'LT',
]);

const NO_OPERAND_OPERATORS = new Set(['NOT']);

const BINARY_ST_OPERATOR: Record<string, string> = {
  AND: 'AND',
  ANDN: 'AND NOT',
  OR: 'OR',
  ORN: 'OR NOT',
  XOR: 'XOR',
  XORN: 'XOR NOT',
  ADD: '+',
  SUB: '-',
  MUL: '*',
  DIV: '/',
  GT: '>',
  GE: '>=',
  EQ: '=',
  NE: '<>',
  LE: '<=',
  LT: '<',
};

// Identifiers, dotted member paths, array subscripts, typed literals
// (`INT#3`, `T#5s`, `16#FF`), string literals, and direct addresses
// (`%IX0.0`; those then trip IEC61131-ED4-DIRECT-ADDRESS-IN-BODY downstream,
// which is the right place to report them).
const OPERAND_PATTERN =
  /^(?:-?[A-Za-z_%][A-Za-z0-9_.#%]*(?:\[[A-Za-z0-9_, +-]*\])*|-?[0-9][0-9_.eE+-]*|'[^']*'|"[^"]*")$/;

const SIMPLE_OPERAND_PATTERN = /^-?[A-Za-z0-9_.#%'"[\]]+$/;

export function translateIlToSt(il: string): IlToStResult {
  const parsed = parseIlInstructions(il);
  if (parsed.kind === 'unsupported') return parsed;

  const statements: string[] = [];
  let accumulator: string | undefined;

  for (const instruction of parsed.instructions) {
    const { operator, operand, line } = instruction;
    switch (operator) {
      case 'LD':
        accumulator = operand;
        break;
      case 'LDN':
        accumulator = `NOT ${operand}`;
        break;
      case 'ST':
      case 'STN': {
        if (accumulator === undefined) {
          return unsupported(line, `${operator} before any LD`);
        }
        const value = operator === 'STN' ? negate(accumulator) : accumulator;
        statements.push(`${operand} := ${value};`);
        // The store leaves the accumulator untouched, but `x` now holds it.
        accumulator = operator === 'STN' ? `NOT ${operand}` : operand;
        break;
      }
      case 'NOT':
        if (accumulator === undefined) {
          return unsupported(line, 'NOT before any LD');
        }
        accumulator = negate(accumulator);
        break;
      default: {
        const stOperator = BINARY_ST_OPERATOR[operator];
        if (stOperator === undefined) {
          return unsupported(line, `unsupported IL operator '${operator}'`);
        }
        if (accumulator === undefined) {
          return unsupported(line, `${operator} before any LD`);
        }
        // Wrap the left side so chained operators keep IL's strict
        // left-to-right evaluation (`LD a ADD b MUL c` is `(a + b) * c`).
        accumulator = `${parenthesize(accumulator)} ${stOperator} ${operand}`;
        break;
      }
    }
  }

  return {
    kind: 'translated',
    st: statements.join('\n'),
    instructionCount: parsed.instructions.length,
  };
}

function parseIlInstructions(
  il: string,
):
  | { kind: 'ok'; instructions: IlInstruction[] }
  | { kind: 'unsupported'; reason: string; line: number } {
  const instructions: IlInstruction[] = [];
  const lines = il.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index] ?? '';
    const text = stripIlComment(raw).trim();
    if (text === '') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(text)) {
      return unsupported(line, 'labels are not translated');
    }
    // `\s*` (not `\s+`) so the deferred form `AND(` is recognised as
    // operator `AND` + operand `(` and reported as such below.
    const match = text.match(/^([A-Za-z]+)\s*(.*)$/);
    if (!match) {
      return unsupported(line, `unrecognised IL instruction '${text}'`);
    }
    const operator = (match[1] ?? '').toUpperCase();
    const operand = match[2]?.trim();
    if (NO_OPERAND_OPERATORS.has(operator)) {
      if (operand !== undefined && operand !== '') {
        return unsupported(line, `${operator} does not take an operand`);
      }
      instructions.push({ operator, line });
      continue;
    }
    if (!OPERAND_OPERATORS.has(operator)) {
      // JMP/JMPC/JMPCN, CAL/CALC/CALCN, S/R, RET, MOD, deferred `AND(` …
      return unsupported(line, `unsupported IL operator '${operator}'`);
    }
    if (operand === undefined || operand === '') {
      return unsupported(line, `${operator} requires an operand`);
    }
    if (operand.endsWith('(') || operand === '(') {
      return unsupported(line, 'deferred (parenthesised) operators are not translated');
    }
    if (!OPERAND_PATTERN.test(operand)) {
      return unsupported(line, `operand '${operand}' is not a simple variable or literal`);
    }
    instructions.push({ operator, operand, line });
  }
  return { kind: 'ok', instructions };
}

function stripIlComment(line: string): string {
  // IL supports `(* … *)` and, in vendor dialects, `//` trailing comments.
  return line.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\/\/.*$/, '');
}

function negate(expression: string): string {
  if (expression.startsWith('NOT ')) return expression.slice('NOT '.length);
  return `NOT ${parenthesize(expression)}`;
}

function parenthesize(expression: string): string {
  return SIMPLE_OPERAND_PATTERN.test(expression) ? expression : `(${expression})`;
}

function unsupported(
  line: number,
  reason: string,
): { kind: 'unsupported'; reason: string; line: number } {
  return { kind: 'unsupported', reason, line };
}
