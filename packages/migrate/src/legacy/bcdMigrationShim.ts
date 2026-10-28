export interface BcdMigrationShimResult {
  original: string;
  helperName: string;
  shimCall: string;
  note: string;
}

const BCD_HELPER_PATTERN =
  /^((?:IS_VALID_BCD)|(?:[A-Z][A-Z0-9_]*_BCD_TO_[A-Z][A-Z0-9_]*)|(?:[A-Z][A-Z0-9_]*_TO_BCD))\s*\((.*)\)$/i;

export function bcdMigrationShim(
  callExpression: string,
): BcdMigrationShimResult | undefined {
  const trimmed = callExpression.trim();
  const match = trimmed.match(BCD_HELPER_PATTERN);
  if (!match?.[1]) {
    return undefined;
  }

  const helperName = match[1].toUpperCase();
  const args = match[2]?.trim() ?? '';
  return {
    original: trimmed,
    helperName,
    shimCall: `HD_BCD.${helperName}(${args})`,
    note: 'BCD helpers are import-only in IEC 61131-3:2025 canonical code; route through an explicit migration shim or replace with domain logic.',
  };
}
