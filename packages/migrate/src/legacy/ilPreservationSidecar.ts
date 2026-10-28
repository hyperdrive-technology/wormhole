export interface IlPreservationSidecar {
  stPlaceholder: string;
  preservationBlob: string;
  addDataXml: string;
}

export function ilPreservationSidecar(
  source: string,
  pouName = 'LegacyPou',
): IlPreservationSidecar {
  const trimmed = source.trim();
  const stPlaceholder = [
    '(* IEC 61131-3:2025 blocks native IL in canonical export; preserved IL requires migration review. *)',
    `(* POU: ${pouName} *)`,
  ].join('\n');

  return {
    stPlaceholder,
    preservationBlob: trimmed,
    addDataXml: `        <addData><data name="hyperdrive:il-preservation"><![CDATA[${encodeCdata(trimmed)}]]></data></addData>`,
  };
}

function encodeCdata(text: string): string {
  return text.replace(/\]\]>/g, ']]]]><![CDATA[>');
}
