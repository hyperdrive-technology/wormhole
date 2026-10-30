export interface TruncToTypedResult {
  original: string;
  typedCall: string;
  targetType: string;
}

// Only the head is a regex. The old whole-call pattern `^TRUNC\s*\(\s*([^)]+?)\s*\)$` gave
// the same answer but backtracked quadratically on `TRUNC(a<many spaces>b)` (wormhole#5).
const TRUNC_HEAD = /^TRUNC\s*\(/i;

export function truncToTyped(
  callExpression: string,
  targetType = 'INT',
): TruncToTypedResult | undefined {
  const trimmed = callExpression.trim();
  const head = TRUNC_HEAD.exec(trimmed);
  if (!head || !trimmed.endsWith(')')) {
    return undefined;
  }
  // Everything between `(` and the final `)`: at least one character and no other `)`.
  const inner = trimmed.slice(head[0].length, -1);
  if (inner.length === 0 || inner.includes(')')) {
    return undefined;
  }

  const normalizedType = targetType.trim().toUpperCase();
  const operand = inner.trim();
  return {
    original: trimmed,
    targetType: normalizedType,
    typedCall: `TRUNC_${normalizedType}(${operand})`,
  };
}
