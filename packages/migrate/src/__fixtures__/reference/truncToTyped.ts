export interface TruncToTypedResult {
  original: string;
  typedCall: string;
  targetType: string;
}

const UNtypedTruncPattern = /^TRUNC\s*\(\s*([^)]+?)\s*\)$/i;

export function truncToTyped(
  callExpression: string,
  targetType = 'INT',
): TruncToTypedResult | undefined {
  const trimmed = callExpression.trim();
  const match = trimmed.match(UNtypedTruncPattern);
  if (!match?.[1]) {
    return undefined;
  }

  const normalizedType = targetType.trim().toUpperCase();
  const operand = match[1].trim();
  return {
    original: trimmed,
    targetType: normalizedType,
    typedCall: `TRUNC_${normalizedType}(${operand})`,
  };
}
