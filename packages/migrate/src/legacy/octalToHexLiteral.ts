export interface OctalToHexLiteralResult {
  original: string;
  hexLiteral: string;
}

const OCTAL_LITERAL_PATTERN = /^8#([0-9_]+)$/i;

export function octalToHexLiteral(
  literal: string,
): OctalToHexLiteralResult | undefined {
  const trimmed = literal.trim();
  const match = trimmed.match(OCTAL_LITERAL_PATTERN);
  if (!match?.[1]) {
    return undefined;
  }

  const digits = match[1].replace(/_/g, '');
  if (!/^[0-7]+$/.test(digits)) {
    return undefined;
  }

  const value = Number.parseInt(digits, 8);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return {
    original: trimmed,
    hexLiteral: `16#${value.toString(16).toUpperCase()}`,
  };
}
