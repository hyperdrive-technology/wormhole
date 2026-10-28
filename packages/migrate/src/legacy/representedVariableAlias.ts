export interface RepresentedVariableAliasResult {
  originalAddress: string;
  variableName: string;
  dataType: string;
  declaration: string;
}

const REPRESENTED_ADDRESS_PATTERN =
  /^%(?:[IQM][XBWDL]?|[XBWDL])(?:\*|[0-9][0-9._]*)$/i;

export function representedVariableAlias(
  address: string,
  dataType = 'WORD',
  variableName?: string,
): RepresentedVariableAliasResult | undefined {
  const normalizedAddress = address.trim().toUpperCase();
  if (!REPRESENTED_ADDRESS_PATTERN.test(normalizedAddress)) {
    return undefined;
  }

  const name = variableName?.trim() || aliasNameForAddress(normalizedAddress);
  const normalizedType = dataType.trim().toUpperCase();
  return {
    originalAddress: normalizedAddress,
    variableName: name,
    dataType: normalizedType,
    declaration: `${name} AT ${normalizedAddress} : ${normalizedType};`,
  };
}

function aliasNameForAddress(address: string): string {
  const body = address
    .replace(/^%/, '')
    .replace(/\*/g, 'STAR')
    .replace(/[^A-Z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  return `Io_${body || 'Address'}`;
}
