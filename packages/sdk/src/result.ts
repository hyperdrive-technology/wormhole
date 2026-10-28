/**
 * Structural checks on values an importer hands back. Shared by `ImporterHost.run` and the
 * conformance kit, so both judge importer output the same way.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const STAT_KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Structural checks on an importer's return value; the JSON parts are schema-checked later. */
export function importResultShapeProblems(value: unknown): string[] {
  if (!isPlainRecord(value)) return ['import() must return a plain object'];
  const problems: string[] = [];
  const checkContentRecord = (key: string, allowBytes: boolean, required: boolean): void => {
    const record = value[key];
    if (record === undefined && !required) return;
    if (!isPlainRecord(record)) {
      problems.push(`${key} must be a plain object of path → ${allowBytes ? 'string or Uint8Array' : 'string'}`);
      return;
    }
    for (const [path, content] of Object.entries(record)) {
      const ok = typeof content === 'string' || (allowBytes && content instanceof Uint8Array);
      if (!ok) problems.push(`${key}[${JSON.stringify(path)}] must be ${allowBytes ? 'a string or Uint8Array' : 'a string'}`);
    }
  };
  checkContentRecord('sources', false, true);
  checkContentRecord('preservation', true, false);
  checkContentRecord('assets', true, false);
  if (!Array.isArray(value.diagnostics)) problems.push('diagnostics must be an array');
  if (value.unsupportedSemantics !== undefined && !Array.isArray(value.unsupportedSemantics)) {
    problems.push('unsupportedSemantics must be an array when present');
  }
  const summary = value.summary;
  if (!isPlainRecord(summary)) {
    problems.push('summary must be an object with a message');
  } else {
    if (typeof summary.message !== 'string' || summary.message.length === 0) {
      problems.push('summary.message must be a non-empty string');
    }
    if (summary.stats !== undefined) {
      if (!isPlainRecord(summary.stats)) {
        problems.push('summary.stats must be a plain object');
      } else {
        for (const [key, count] of Object.entries(summary.stats)) {
          if (!STAT_KEY.test(key)) problems.push(`summary.stats key ${JSON.stringify(key)} must match ${STAT_KEY.source}`);
          if (!Number.isSafeInteger(count) || (count as number) < 0) {
            problems.push(`summary.stats.${key} must be a non-negative integer`);
          }
        }
      }
    }
    for (const key of Object.keys(summary)) {
      if (key !== 'message' && key !== 'stats') problems.push(`summary has unknown field "${key}"`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!['sources', 'diagnostics', 'preservation', 'assets', 'unsupportedSemantics', 'summary'].includes(key)) {
      problems.push(`unknown result field "${key}"`);
    }
  }
  return problems;
}
